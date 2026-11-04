import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import candidates from '../../../fixtures/candidates.json';
import type { RecipeInput } from '#lib/tags.js';
import { migrate } from './migrate';
import { createJob, type JobRow } from './jobs';
import { enqueueDraftConversion } from './extract';
import type { BodyPair, RecipeDraft } from '#lib/extract.js';
import {
	discardDraft,
	draftView,
	getGenerationJob,
	listDrafts,
	pickCandidate,
	retryDraftConversion,
	saveDraft,
	type DraftView,
	type GenerationView
} from './drafts';

vi.mock('./r2', () => ({ presignGet: (key: string) => `https://r2/${key}` }));

const DESCRIPTION = 'the chicken thighs and half a cabbage, under 40 minutes';
/** A generation stored before issue #68: each candidate holds both bodies. */
const result = candidates as { candidates: (Omit<RecipeDraft, 'body'> & { body: BodyPair })[] };

let db: Database.Database;
beforeEach(() => {
	db = new Database(':memory:');
	migrate(db, 'migrations');
});

const row = (id: string) => db.prepare('SELECT * FROM job WHERE id = ?').get(id) as JobRow;

/** Since issue #68 a generation's candidates are metric only; the fixture
 *  is the older shape with both bodies, which stored generations still have. */
const metricOnly = {
	candidates: result.candidates.map((c) => ({ ...c, body: { ...c.body.metric, source_units: 'metric' } }))
};

function generation(status: JobRow['status'] = 'done', stored: object = result): string {
	const id = createJob(db, 'generate', { description: DESCRIPTION, yield_count: 2, picked: null });
	db.prepare('UPDATE job SET status = ?, result_json = ? WHERE id = ?').run(
		status,
		status === 'done' ? JSON.stringify(stored) : null,
		id
	);
	return id;
}

describe('generations (issue #41)', () => {
	it('shows a running generation as a generating card titled by its description', () => {
		const id = generation('running');
		expect(listDrafts(db)).toEqual([{ id, status: 'generating', title: DESCRIPTION }]);
		expect(draftView(db, row(id))).toMatchObject({ initial: null, source_text: DESCRIPTION });
	});

	it('looks up a done generation as its three candidates until a pick', () => {
		const id = generation();
		expect(listDrafts(db)).toEqual([{ id, status: 'choosing', title: DESCRIPTION }]);
		const view = draftView(db, row(id)) as GenerationView;
		expect(view).toMatchObject({ id, status: 'done', description: DESCRIPTION, yield_count: 2 });
		expect(view.candidates.map((c) => c.title)).toEqual(result.candidates.map((c) => c.title));
		expect(view.candidates[2].ingredients).toContain('40 g plain flour');
	});

	it('turns into a draft seeded with the picked candidate', () => {
		const id = generation();
		pickCandidate(db, row(id), 1);
		const picked = result.candidates[1];
		const view = draftView(db, row(id)) as DraftView;
		expect(view).not.toHaveProperty('candidates');
		expect(view).toMatchObject({
			id,
			status: 'done',
			source_text: DESCRIPTION,
			warnings: [],
			damage_reasoning: picked.damage_reasoning
		});
		expect(view.initial).toMatchObject({
			title: picked.title,
			source_text: DESCRIPTION,
			source_url: null,
			images: [],
			ingredients: picked.body.metric.ingredients
		});
		expect(listDrafts(db)).toEqual([{ id, status: 'ready', title: picked.title }]);
	});

	it('queues the conversion of the picked candidate, once, and shows it converting (issue #68)', () => {
		const id = generation('done', metricOnly);
		const conversions = () =>
			db
				.prepare(`SELECT id, input_json FROM job WHERE kind = 'reconvert' AND json_extract(input_json, '$.draft_id') = ?`)
				.all(id) as { id: string; input_json: string }[];
		expect(conversions()).toEqual([]);
		pickCandidate(db, row(id), 1);
		pickCandidate(db, row(id), 1);
		const [job, ...more] = conversions();
		expect(more).toEqual([]);
		expect(JSON.parse(job.input_json)).toEqual({ draft_id: id, source: metricOnly.candidates[1].body });
		expect((draftView(db, row(id)) as DraftView).counterpart_state).toEqual({
			status: 'converting',
			job_id: job.id
		});
	});

	it('queues no conversion for a stored candidate that has both bodies', () => {
		const id = generation();
		pickCandidate(db, row(id), 0);
		expect(db.prepare(`SELECT COUNT(*) AS n FROM job WHERE kind = 'reconvert'`).get()).toEqual({ n: 0 });
		expect((draftView(db, row(id)) as DraftView).counterpart_state).toEqual({ status: 'ready', job_id: null });
	});

	it('refuses a pick out of range, before it is done, or of a different candidate', () => {
		const id = generation();
		for (const index of [3, -1, 1.5, '1', undefined])
			expect(() => pickCandidate(db, row(id), index)).toThrow('Pick one of the three.');
		expect(() => pickCandidate(db, row(generation('running')), 0)).toThrow(
			'Still generating; wait for it to finish.'
		);
		pickCandidate(db, row(id), 1);
		pickCandidate(db, row(id), 1);
		expect(() => pickCandidate(db, row(id), 0)).toThrow('Already picked.');
	});

	it('finds only generate jobs as generations', () => {
		const capture = createJob(db, 'extract_paste', { text: 'Toast' });
		expect(getGenerationJob(db, capture)).toBeNull();
		expect(getGenerationJob(db, generation())).not.toBeNull();
	});

	it('refuses to save a generation before a pick', () => {
		const id = generation();
		expect(() => saveDraft(db, row(id), {} as RecipeInput)).toThrow('Pick a recipe first.');
		expect(row(id).recipe_id).toBeNull();
	});
});

describe('found covers in drafts (issue #44)', () => {
	const addImage = (id: string, source_url: string | null = null) =>
		db
			.prepare(
				`INSERT INTO image (id, r2_key_full, r2_key_display, width, height, role, source_url, created_at)
				 VALUES (?, 'f', ?, 1, 1, ?, ?, '2026')`
			)
			.run(id, `images/${id}/display.jpg`, source_url ? 'photo' : 'capture', source_url);

	it('shows the found cover after the capture photos and names it the cover', () => {
		addImage('page');
		addImage('found', 'https://a.com/dish.jpg');
		const id = createJob(db, 'extract_photos', { image_ids: ['page'], cover_image_id: 'found' });
		const view = draftView(db, row(id)) as DraftView;
		expect(view.initial).toEqual({
			source_url: null,
			cover_image_id: 'found',
			images: [
				{ id: 'page', url: 'https://r2/images/page/display.jpg', source_url: null },
				{ id: 'found', url: 'https://r2/images/found/display.jpg', source_url: 'https://a.com/dish.jpg' }
			]
		});
	});

	it('gives a picked generation its found cover, and none before one is found', () => {
		const id = generation();
		pickCandidate(db, row(id), 0);
		expect((draftView(db, row(id)) as DraftView).initial).toMatchObject({ images: [], cover_image_id: null });
		const covers = db.prepare(`SELECT input_json FROM job WHERE kind = 'cover'`).all();
		expect(covers).toEqual([{ input_json: JSON.stringify({ draft_id: id }) }]);

		addImage('found', 'https://img.com/0.jpg');
		const input = JSON.parse(row(id).input_json);
		db.prepare('UPDATE job SET input_json = ? WHERE id = ?').run(
			JSON.stringify({ ...input, cover_image_id: 'found' }),
			id
		);
		expect((draftView(db, row(id)) as DraftView).initial).toMatchObject({
			images: [{ id: 'found', source_url: 'https://img.com/0.jpg' }],
			cover_image_id: 'found'
		});
	});

	it('drops a cover id whose image is gone', () => {
		const id = createJob(db, 'extract_paste', { text: 'x', cover_image_id: 'gone' });
		db.prepare(`UPDATE job SET status = 'done', result_json = ? WHERE id = ?`).run(
			JSON.stringify(result.candidates[0]),
			id
		);
		expect((draftView(db, row(id)) as DraftView).initial).toMatchObject({ images: [], cover_image_id: null });
	});

	const stew = (image_ids: string[], cover_image_id: string | null): RecipeInput => ({
		title: 'Stew',
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
		effort: 'quick',
		damage: 'tidy',
		ingredients: [{ heading: null, items: ['1 onion'] }],
		steps: [],
		counterpart: null,
		image_ids,
		cover_image_id
	});

	it('names the cover job still running for the draft, then none', () => {
		const id = createJob(db, 'extract_paste', { text: 'x' });
		db.prepare(`UPDATE job SET status = 'done', result_json = ? WHERE id = ?`).run(
			JSON.stringify(result.candidates[0]),
			id
		);
		expect((draftView(db, row(id)) as DraftView).cover_job_id).toBeNull();
		const cover = createJob(db, 'cover', { draft_id: id });
		expect((draftView(db, row(id)) as DraftView).cover_job_id).toBe(cover);
		db.prepare(`UPDATE job SET status = 'done' WHERE id = ?`).run(cover);
		expect((draftView(db, row(id)) as DraftView).cover_job_id).toBeNull();
	});

	it('claims a found cover the form kept, and soft-deletes one it left out', () => {
		addImage('found', 'https://a.com/dish.jpg');
		addImage('found2', 'https://a.com/dish2.jpg');
		const kept = createJob(db, 'extract_paste', { text: 'x', cover_image_id: 'found' });
		const recipe = saveDraft(db, row(kept), stew(['found'], 'found'));
		expect(db.prepare('SELECT recipe_id, deleted_at FROM image WHERE id = ?').get('found')).toEqual({
			recipe_id: recipe,
			deleted_at: null
		});
		const stale = createJob(db, 'extract_paste', { text: 'y', cover_image_id: 'found2' });
		saveDraft(db, row(stale), stew([], null));
		expect(db.prepare('SELECT recipe_id, deleted_at FROM image WHERE id = ?').get('found2')).toMatchObject({
			recipe_id: null,
			deleted_at: expect.any(String)
		});
	});

	it('soft-deletes the found cover on discard', () => {
		addImage('page');
		addImage('found', 'https://a.com/dish.jpg');
		const id = createJob(db, 'extract_photos', { image_ids: ['page'], cover_image_id: 'found' });
		db.prepare(`UPDATE job SET status = 'failed' WHERE id = ?`).run(id);
		discardDraft(db, row(id));
		const live = db.prepare('SELECT id FROM image WHERE deleted_at IS NULL').all();
		expect(live).toEqual([]);
	});
});

describe('the draft counterpart (issue #67)', () => {
	const asWritten = {
		source_units: 'us' as const,
		ingredients: [{ heading: null, items: ['1 cup sugar'] }],
		steps: ['Bake at 350°F.']
	};
	const metric = { ingredients: [{ heading: null, items: ['200 g sugar'] }], steps: ['Bake at 180°C.'] };
	const extraction = { ...result.candidates[0], body: asWritten, counterpart: undefined };

	/** A done paste capture whose extraction queued its conversion, as the handler leaves it. */
	function capture(): string {
		const id = createJob(db, 'extract_paste', { text: 'Sugar cake' });
		db.prepare(`UPDATE job SET status = 'done', result_json = ? WHERE id = ?`).run(
			JSON.stringify(extraction),
			id
		);
		enqueueDraftConversion(db, id, asWritten);
		return id;
	}
	const conversion = (draft: string) =>
		db
			.prepare(`SELECT * FROM job WHERE kind = 'reconvert' AND json_extract(input_json, '$.draft_id') = ?`)
			.get(draft) as JobRow | undefined;
	const finish = (job: string, status: 'done' | 'failed', body: unknown = null) =>
		db.prepare(`UPDATE job SET status = ?, result_json = ? WHERE id = ?`).run(status, JSON.stringify(body), job);
	const view = (id: string) => draftView(db, row(id)) as DraftView;
	const save = (id: string, over: Partial<RecipeInput> = {}) =>
		saveDraft(db, row(id), {
			...(view(id).initial as RecipeInput),
			image_ids: [],
			counterpart: null,
			...over
		});
	const bodiesOf = (recipe: string) =>
		db
			.prepare(
				`SELECT b.unit_system, b.is_source, b.ingredients_json FROM body b
				 JOIN variation v ON v.id = b.variation_id WHERE v.recipe_id = ? ORDER BY b.unit_system`
			)
			.all(recipe);
	const variationReconverts = () =>
		db.prepare(`SELECT input_json FROM job WHERE kind = 'reconvert' AND variation_id IS NOT NULL`).all();

	it('reports a queued or running conversion as converting, with no counterpart body', () => {
		const id = capture();
		const job = conversion(id)!;
		expect(view(id).counterpart_state).toEqual({ status: 'converting', job_id: job.id });
		expect(view(id).initial).toMatchObject({ source_units: 'us', counterpart: null });
		db.prepare(`UPDATE job SET status = 'running' WHERE id = ?`).run(job.id);
		expect(view(id).counterpart_state).toEqual({ status: 'converting', job_id: job.id });
	});

	it('reports a finished conversion as ready, carrying its body', () => {
		const id = capture();
		finish(conversion(id)!.id, 'done', metric);
		expect(view(id).counterpart_state).toEqual({ status: 'ready', job_id: null });
		expect(view(id).initial).toMatchObject({ source_units: 'us', counterpart: metric });
	});

	it('reports a failed conversion as failed, and retry requeues it', () => {
		const id = capture();
		const job = conversion(id)!.id;
		finish(job, 'failed');
		expect(view(id).counterpart_state).toEqual({ status: 'failed', job_id: job });
		retryDraftConversion(db, row(id));
		expect(view(id).counterpart_state).toEqual({ status: 'converting', job_id: job });
		expect(row(job).status).toBe('queued');
	});

	it('reads a counterpart the extraction wrote itself as ready, with no job', () => {
		// Drafts stored before issue #67, and generations, carry both bodies.
		const id = createJob(db, 'extract_paste', { text: 'x' });
		finish(id, 'done', result.candidates[0]);
		expect(view(id).counterpart_state).toEqual({ status: 'ready', job_id: null });
		expect(view(id).initial).toMatchObject({
			source_units: 'metric',
			ingredients: result.candidates[0].body.metric.ingredients,
			counterpart: result.candidates[0].body.us
		});
	});

	it('has no counterpart state before the extraction is done', () => {
		const id = createJob(db, 'extract_paste', { text: 'x' });
		expect(view(id).counterpart_state).toBeNull();
	});

	it('saves a ready counterpart even when the form loaded before it was ready', () => {
		const id = capture();
		finish(conversion(id)!.id, 'done', metric);
		const recipe = save(id);
		expect(bodiesOf(recipe)).toEqual([
			{ unit_system: 'metric', is_source: 0, ingredients_json: JSON.stringify(metric.ingredients) },
			{ unit_system: 'us', is_source: 1, ingredients_json: JSON.stringify(asWritten.ingredients) }
		]);
		expect(variationReconverts()).toEqual([]);
		expect(conversion(id)).toBeUndefined();
	});

	it('saves the source body while converting and queues a reconvert on the variation', () => {
		const id = capture();
		const recipe = save(id);
		expect(bodiesOf(recipe)).toEqual([
			{ unit_system: 'us', is_source: 1, ingredients_json: JSON.stringify(asWritten.ingredients) }
		]);
		expect(variationReconverts()).toHaveLength(1);
		expect(conversion(id)).toBeUndefined();
	});

	it('saves the source body when the conversion failed and queues a reconvert', () => {
		const id = capture();
		finish(conversion(id)!.id, 'failed');
		save(id);
		expect(variationReconverts()).toHaveLength(1);
		expect(conversion(id)).toBeUndefined();
	});

	it('discards the pending conversion when the as-written body was edited', () => {
		const id = capture();
		finish(conversion(id)!.id, 'done', metric);
		const recipe = save(id, { ingredients: [{ heading: null, items: ['2 cups sugar'] }] });
		expect(bodiesOf(recipe)).toEqual([
			{ unit_system: 'us', is_source: 1, ingredients_json: JSON.stringify([{ heading: null, items: ['2 cups sugar'] }]) }
		]);
		expect(variationReconverts()).toHaveLength(1);
		expect(conversion(id)).toBeUndefined();
	});

	it('deletes the conversion with the draft on discard', () => {
		const id = capture();
		finish(conversion(id)!.id, 'done', metric);
		discardDraft(db, row(id));
		expect(conversion(id)).toBeUndefined();
	});
});

describe('capture cards', () => {
	it('titles a capture by its extraction, else its first pasted line, else its link', () => {
		const paste = createJob(db, 'extract_paste', {
			text: `\n\n  Brown butter cake\n${'200 g flour\n'.repeat(200)}`
		});
		const long = createJob(db, 'extract_paste', { text: 'x'.repeat(500) });
		const url = createJob(db, 'extract_url', { url: 'https://example.com/stew' });
		const done = createJob(db, 'extract_paste', { text: 'whatever' });
		db.prepare(`UPDATE job SET status = 'done', result_json = ? WHERE id = ?`).run(
			JSON.stringify({ title: 'Chickpea stew' }),
			done
		);
		db.prepare(`UPDATE job SET status = 'failed' WHERE id = ?`).run(url);
		const cards = new Map(listDrafts(db).map((c) => [c.id, c]));
		expect(cards.get(paste)).toEqual({ id: paste, status: 'extracting', title: 'Brown butter cake' });
		expect(cards.get(long)?.title).toBe('x'.repeat(80));
		expect(cards.get(url)).toEqual({ id: url, status: 'failed', title: 'https://example.com/stew' });
		expect(cards.get(done)).toEqual({ id: done, status: 'ready', title: 'Chickpea stew' });
	});
});
