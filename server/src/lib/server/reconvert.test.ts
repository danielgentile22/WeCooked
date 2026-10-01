import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './migrate';
import { claudeCall } from './claude';
import { createRecipe } from './recipes';
import { reconvert, RECONVERT_SYSTEM } from './reconvert';
import type { JobRow } from './jobs';
import type { RecipeInput } from '$lib/tags';

vi.mock('./claude', () => ({ claudeCall: vi.fn() }));
vi.mock('./r2', () => ({ getObject: vi.fn(), presignGet: vi.fn(), putObject: vi.fn() }));

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
	ingredients: [{ heading: null, items: ['400 g tinned chickpeas'] }],
	steps: ['Bake at 190°C for 30 minutes.'],
	counterpart: null,
	image_ids: [],
	cover_image_id: null
});

const usBody = () => ({
	ingredients: [{ heading: null, items: ['14 oz tinned chickpeas'] }],
	steps: ['Bake at 375°F for 30 minutes.']
});

/** createRecipe queues the real job; run the handler on that row. */
function queuedJob(): JobRow {
	return db.prepare(`SELECT * FROM job WHERE kind = 'reconvert'`).get() as JobRow;
}

const bodies = (variationId: string) =>
	db
		.prepare(
			`SELECT unit_system, is_source, ingredients_json, steps_json FROM body
			 WHERE variation_id = ? ORDER BY unit_system`
		)
		.all(variationId) as {
		unit_system: string;
		is_source: number;
		ingredients_json: string;
		steps_json: string;
	}[];

describe('reconvert handler (SPEC 5.6, ADR-019)', () => {
	it('reads the source body at run time and writes the counterpart, never the source', async () => {
		createRecipe(db, input());
		vi.mocked(claudeCall).mockResolvedValue(usBody());
		const job = queuedJob();
		await reconvert(job, db);

		const [metric, us] = bodies(job.variation_id!);
		expect(metric).toMatchObject({ unit_system: 'metric', is_source: 1 });
		expect(us).toMatchObject({ unit_system: 'us', is_source: 0 });
		expect(JSON.parse(us.steps_json)).toEqual(['Bake at 375°F for 30 minutes.']);

		const call = vi.mocked(claudeCall).mock.calls[0][1];
		expect(call.system).toBe(RECONVERT_SYSTEM);
		expect(call.system).toContain('Convert every temperature'); // shared conversion rules
		const content = call.messages[0].content as string;
		expect(content).toContain('from metric to US units');
		expect(content).toContain('400 g tinned chickpeas');
		expect(content).toContain('Bake at 190°C');
	});

	it('overwrites an existing counterpart in place (edit after edit)', async () => {
		createRecipe(db, { ...input(), counterpart: usBody() });
		// simulate an edit having queued a reconvert of the US body
		const vid = (db.prepare(`SELECT id FROM variation`).get() as { id: string }).id;
		db.prepare(
			`INSERT INTO job (id, kind, status, variation_id, input_json, created_at)
			 VALUES ('j1', 'reconvert', 'queued', ?, ?, '2026-01-01T00:00:00Z')`
		).run(vid, JSON.stringify({ variation_id: vid, target_units: 'us' }));
		vi.mocked(claudeCall).mockResolvedValue({
			ingredients: [{ heading: null, items: ['15 oz tinned chickpeas'] }],
			steps: ['Bake at 375°F.']
		});
		await reconvert(queuedJob(), db);
		const [metric, us] = bodies(vid);
		expect(metric.is_source).toBe(1);
		expect(us.is_source).toBe(0);
		expect(JSON.parse(us.ingredients_json)[0].items).toEqual(['15 oz tinned chickpeas']);
		expect(bodies(vid)).toHaveLength(2);
	});

	it('is a no-op when is_source moved onto the target while the job was in flight', async () => {
		// ADR-028: a superseded job must never overwrite the human-authored body.
		createRecipe(db, { ...input(), counterpart: usBody() });
		const vid = (db.prepare(`SELECT id FROM variation`).get() as { id: string }).id;
		db.prepare(
			`INSERT INTO job (id, kind, status, variation_id, input_json, created_at)
			 VALUES ('j1', 'reconvert', 'queued', ?, ?, '2026-01-01T00:00:00Z')`
		).run(vid, JSON.stringify({ variation_id: vid, target_units: 'metric' }));
		await reconvert(queuedJob(), db);
		expect(claudeCall).not.toHaveBeenCalled();
		const [metric] = bodies(vid);
		expect(metric).toMatchObject({ unit_system: 'metric', is_source: 1 });
		expect(JSON.parse(metric.ingredients_json)[0].items).toEqual(['400 g tinned chickpeas']);
	});

	it('fails cleanly when the variation has no source body', async () => {
		db.prepare(
			`INSERT INTO job (id, kind, status, input_json, created_at)
			 VALUES ('j1', 'reconvert', 'queued', ?, '2026-01-01T00:00:00Z')`
		).run(JSON.stringify({ variation_id: 'ghost', target_units: 'us' }));
		await expect(reconvert(queuedJob(), db)).rejects.toThrow(/source body/);
		expect(claudeCall).not.toHaveBeenCalled();
	});
});
