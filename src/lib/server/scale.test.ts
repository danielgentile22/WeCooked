import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './migrate';
import { claudeCall } from './claude';
import { createRecipe, updateRecipe, getRecipe } from './recipes';
import {
	scale,
	requestScale,
	ensureFresh,
	retryScale,
	recalcVariation,
	keepMine,
	normaliseYield,
	SCALE_SYSTEM,
	RANGE_WARNING
} from './scale';
import type { JobRow } from './jobs';
import type { RecipeInput } from '$lib/tags';

vi.mock('./claude', () => ({ claudeCall: vi.fn() }));
vi.mock('./r2', () => ({
	getObject: vi.fn(),
	presignGet: vi.fn(),
	putObject: vi.fn()
}));

let db: Database.Database;
beforeEach(() => {
	db = new Database(':memory:');
	db.pragma('foreign_keys = ON');
	migrate(db, 'migrations');
	vi.mocked(claudeCall).mockReset();
});

const input = (): RecipeInput => ({
	title: 'Chickpea stew',
	yield_count: 4,
	yield_unit: 'servings',
	prep_minutes: null,
	cook_minutes: null,
	source_text: null,
	source_url: null,
	notes: null,
	source_units: 'metric',
	meal_types: [],
	cuisine: null,
	protein: null,
	effort: 'weeknight',
	damage: 'messy',
	ingredients: [{ heading: null, items: ['400 g tinned chickpeas', '1 tsp salt'] }],
	steps: ['Bake at 190°C for 30 minutes.'],
	counterpart: {
		ingredients: [{ heading: null, items: ['14 oz tinned chickpeas', '1 tsp salt'] }],
		steps: ['Bake at 375°F for 30 minutes.']
	},
	image_ids: [],
	cover_image_id: null
});

const scaledResult = (n: number) => ({
	body: {
		source_units: 'metric',
		us: {
			ingredients: [{ heading: null, items: [`${n} oz tinned chickpeas`] }],
			steps: ['Bake at 375°F.']
		},
		metric: {
			ingredients: [{ heading: null, items: [`${n * 100} g tinned chickpeas`] }],
			steps: ['Bake at 190°C.']
		}
	},
	scaling_note: 'Salt scaled sublinearly.'
});

const jobRow = (id: string) => db.prepare(`SELECT * FROM job WHERE id = ?`).get(id) as JobRow;
const variations = (recipeId: string) =>
	db
		.prepare(
			`SELECT * FROM variation WHERE recipe_id = ? AND deleted_at IS NULL ORDER BY yield_count`
		)
		.all(recipeId) as {
		id: string;
		yield_count: number;
		is_original: number;
		hand_edited: number;
		based_on_content_version: number;
		scaling_note: string | null;
	}[];

describe('normaliseYield (ADR-037)', () => {
	it('rounds to one decimal and accepts 0.5', () => {
		expect(normaliseYield('0.5')).toBe(0.5);
		expect(normaliseYield(6.66)).toBe(6.7);
	});
	it('rejects zero, negatives, and junk', () => {
		for (const bad of [0, -1, 'nope', NaN]) expect(() => normaliseYield(bad)).toThrow(/positive/);
	});
});

describe('requestScale (SPEC 7.5: only the button spends money)', () => {
	it('switches to an existing yield instead of generating', () => {
		const rid = createRecipe(db, input());
		const res = requestScale(db, rid, 4);
		expect(res).toEqual({ variation_id: variations(rid)[0].id });
		expect(db.prepare(`SELECT count(*) c FROM job WHERE kind='scale'`).get()).toEqual({ c: 0 });
	});

	it('creates one scale job and reuses it on a double tap', () => {
		const rid = createRecipe(db, input());
		const a = requestScale(db, rid, 6);
		const b = requestScale(db, rid, 6);
		expect(a).toEqual(b);
		expect(db.prepare(`SELECT count(*) c FROM job WHERE kind='scale'`).get()).toEqual({ c: 1 });
	});
});

describe('scale handler: new variation (SPEC 5.5)', () => {
	it('saves a real variation with both bodies and the scaling note', async () => {
		const rid = createRecipe(db, input());
		const { job_id } = requestScale(db, rid, 6) as { job_id: string };
		vi.mocked(claudeCall).mockResolvedValue(scaledResult(21));
		const result = await scale(jobRow(job_id), db);

		const [orig, scaled] = variations(rid);
		expect(orig.yield_count).toBe(4);
		expect(scaled).toMatchObject({
			yield_count: 6,
			is_original: 0,
			hand_edited: 0,
			based_on_content_version: 1,
			scaling_note: 'Salt scaled sublinearly.'
		});
		expect(result).toEqual({ variation_id: scaled.id });
		// job row points at the new variation so result_ref resolves to it
		expect(jobRow(job_id).variation_id).toBe(scaled.id);
		const bodies = db
			.prepare(
				`SELECT unit_system, ingredients_json FROM body WHERE variation_id = ? ORDER BY unit_system`
			)
			.all(scaled.id) as { unit_system: string; ingredients_json: string }[];
		expect(bodies.map((b) => b.unit_system)).toEqual(['metric', 'us']);
		expect(bodies[0].ingredients_json).toContain('2100 g');

		const call = vi.mocked(claudeCall).mock.calls[0][1];
		expect(call.system).toBe(SCALE_SYSTEM);
		expect(call.system).toContain('sublinearly');
		const content = call.messages[0].content as string;
		expect(content).toContain('from 4 servings to 6 servings');
		expect(content).toContain('400 g tinned chickpeas'); // metric body, scaling reasons in metric
		expect(content).not.toContain(RANGE_WARNING);
	});

	it('leads with a warning outside 0.25x to 4x', async () => {
		const rid = createRecipe(db, input());
		const { job_id } = requestScale(db, rid, 20) as { job_id: string };
		vi.mocked(claudeCall).mockResolvedValue(scaledResult(70));
		await scale(jobRow(job_id), db);
		expect(vi.mocked(claudeCall).mock.calls[0][1].messages[0].content).toContain(RANGE_WARNING);
	});

	it('returns the existing variation without a Claude call when the yield appeared meanwhile', async () => {
		const rid = createRecipe(db, input());
		const { job_id } = requestScale(db, rid, 4.0001) as { job_id?: string };
		// force a job at a yield that then gets taken: queue at 6, then land 6 first
		const { job_id: jid } = requestScale(db, rid, 6) as { job_id: string };
		db.prepare(
			`INSERT INTO variation (id, recipe_id, yield_count, is_original, hand_edited,
			   based_on_content_version, created_at, updated_at)
			 VALUES ('v6', ?, 6, 0, 0, 1, '2026-01-01', '2026-01-01')`
		).run(rid);
		const result = await scale(jobRow(jid), db);
		expect(result).toEqual({ variation_id: 'v6' });
		expect(claudeCall).not.toHaveBeenCalled();
		expect(job_id).toBeUndefined(); // 4.0001 rounded to 4 → existing original
	});
});

describe('scale handler: stale refresh (SPEC 7.5, ADR-029)', () => {
	function makeStale(rid: string): string {
		// hand-edit-free scaled variation at version 1, then bump the original
		db.prepare(
			`INSERT INTO variation (id, recipe_id, yield_count, is_original, hand_edited,
			   based_on_content_version, created_at, updated_at)
			 VALUES ('v8', ?, 8, 0, 0, 1, '2026-01-01', '2026-01-01')`
		).run(rid);
		const ins = db.prepare(
			`INSERT INTO body (id, variation_id, unit_system, is_source, ingredients_json, steps_json, created_at, updated_at)
			 VALUES (?, 'v8', ?, ?, '[]', '[]', '2026-01-01', '2026-01-01')`
		);
		ins.run('b8m', 'metric', 1);
		ins.run('b8u', 'us', 0);
		updateRecipe(db, rid, {
			...input(),
			ingredients: [{ heading: null, items: ['500 g tinned chickpeas'] }],
			counterpart: null
		});
		return 'v8';
	}

	it('ensureFresh queues one refresh job, not two, and none when current or hand-edited', () => {
		const rid = createRecipe(db, input());
		const vid = makeStale(rid);
		const a = ensureFresh(db, vid);
		const b = ensureFresh(db, vid);
		expect(a).not.toBeNull();
		expect(b).toBe(a);
		// fresh original: nothing queued
		expect(ensureFresh(db, variations(rid)[0].id)).toBeNull();
		// hand-edited: never touched automatically
		db.prepare(`UPDATE variation SET hand_edited = 1 WHERE id = ?`).run(vid);
		db.prepare(`DELETE FROM job WHERE kind = 'scale'`).run();
		expect(ensureFresh(db, vid)).toBeNull();
	});

	it('does not auto-requeue after a failure; retryScale does', () => {
		const rid = createRecipe(db, input());
		const vid = makeStale(rid);
		const jid = ensureFresh(db, vid)!;
		db.prepare(`UPDATE job SET status = 'failed' WHERE id = ?`).run(jid);
		expect(ensureFresh(db, vid)).toBeNull();
		expect(retryScale(db, vid)).toBe(jid);
		expect(jobRow(jid).status).toBe('queued');
	});

	it('replaces the bodies in place and clears staleness', async () => {
		const rid = createRecipe(db, input());
		const vid = makeStale(rid);
		const jid = ensureFresh(db, vid)!;
		vi.mocked(claudeCall).mockResolvedValue(scaledResult(28));
		const result = await scale(jobRow(jid), db);
		expect(result).toEqual({ variation_id: vid });
		const v = variations(rid).find((v) => v.id === vid)!;
		expect(v.based_on_content_version).toBe(2);
		expect(v.scaling_note).toBe('Salt scaled sublinearly.');
		const metric = db
			.prepare(
				`SELECT ingredients_json FROM body WHERE variation_id = ? AND unit_system = 'metric'`
			)
			.get(vid) as { ingredients_json: string };
		expect(metric.ingredients_json).toContain('2800 g');
		// scaled from the CURRENT original (500 g), version 2
		expect(vi.mocked(claudeCall).mock.calls[0][1].messages[0].content).toContain('500 g');
	});

	it('never overwrites a variation hand-edited while the job was queued', async () => {
		const rid = createRecipe(db, input());
		const vid = makeStale(rid);
		const jid = ensureFresh(db, vid)!;
		db.prepare(`UPDATE variation SET hand_edited = 1 WHERE id = ?`).run(vid);
		const result = await scale(jobRow(jid), db);
		expect(result).toBeNull();
		expect(claudeCall).not.toHaveBeenCalled();
	});
});

describe('recalculate and keep mine (SPEC 7.5, ADR-025)', () => {
	it('recalcVariation trashes the old variation and queues a fresh scale at the same yield', async () => {
		const rid = createRecipe(db, input());
		db.prepare(
			`INSERT INTO variation (id, recipe_id, yield_count, is_original, hand_edited,
			   based_on_content_version, created_at, updated_at)
			 VALUES ('v8', ?, 8, 0, 1, 1, '2026-01-01', '2026-01-01')`
		).run(rid);
		const jid = recalcVariation(db, 'v8');
		expect(db.prepare(`SELECT deleted_at FROM variation WHERE id = 'v8'`).get()).not.toEqual({
			deleted_at: null
		});
		expect(JSON.parse(jobRow(jid).input_json)).toEqual({
			recipe_id: rid,
			to_count: 8
		});
		vi.mocked(claudeCall).mockResolvedValue(scaledResult(28));
		await scale(jobRow(jid), db);
		const fresh = variations(rid).find((v) => v.yield_count === 8)!;
		expect(fresh.id).not.toBe('v8');
		expect(fresh.hand_edited).toBe(0);
	});

	it('refuses to recalculate the original', () => {
		const rid = createRecipe(db, input());
		expect(() => recalcVariation(db, variations(rid)[0].id)).toThrow(/original/);
	});

	it('keepMine advances based_on_content_version and dismisses forever', () => {
		const rid = createRecipe(db, input());
		db.prepare(
			`INSERT INTO variation (id, recipe_id, yield_count, is_original, hand_edited,
			   based_on_content_version, created_at, updated_at)
			 VALUES ('v8', ?, 8, 0, 1, 1, '2026-01-01', '2026-01-01')`
		).run(rid);
		updateRecipe(db, rid, {
			...input(),
			ingredients: [{ heading: null, items: ['500 g tinned chickpeas'] }],
			counterpart: null
		});
		keepMine(db, 'v8');
		expect(variations(rid).find((v) => v.id === 'v8')!.based_on_content_version).toBe(2);
	});
});

describe('getRecipe with variations (SPEC 7.4/7.5)', () => {
	it('lists variations with staleness and selects one by id', async () => {
		const rid = createRecipe(db, input());
		const { job_id } = requestScale(db, rid, 6) as { job_id: string };
		vi.mocked(claudeCall).mockResolvedValue(scaledResult(21));
		const { variation_id } = (await scale(jobRow(job_id), db)) as {
			variation_id: string;
		};

		const r = getRecipe(db, rid)!;
		expect(r.yield_count).toBe(4);
		expect(r.is_original).toBe(true);
		expect(r.variations.map((v) => ({ yield_count: v.yield_count, stale: v.stale }))).toEqual([
			{ yield_count: 4, stale: false },
			{ yield_count: 6, stale: false }
		]);

		const scaled = getRecipe(db, rid, variation_id)!;
		expect(scaled.yield_count).toBe(6);
		expect(scaled.is_original).toBe(false);
		expect(scaled.scaling_note).toBe('Salt scaled sublinearly.');
		expect(scaled.bodies.metric?.ingredients[0].items).toEqual(['2100 g tinned chickpeas']);

		// editing the original marks the scaled variation stale, not the original
		updateRecipe(db, rid, {
			...input(),
			ingredients: [{ heading: null, items: ['500 g tinned chickpeas'] }],
			counterpart: null
		});
		const after = getRecipe(db, rid, variation_id)!;
		expect(after.stale).toBe(true);
		expect(after.variations.find((v) => v.is_original)!.stale).toBe(false);
	});

	it('falls back to the original for an unknown or trashed variation id', () => {
		const rid = createRecipe(db, input());
		expect(getRecipe(db, rid, 'ghost')!.yield_count).toBe(4);
	});
});
