import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import candidates from '../../../fixtures/candidates.json';
import type { GenerateResult } from '$lib/extract';
import type { RecipeInput } from '$lib/tags';
import { migrate } from './migrate';
import { createJob, type JobRow } from './jobs';
import {
	discardDraft,
	draftView,
	getGenerationJob,
	listDrafts,
	pickCandidate,
	saveDraft,
	type DraftView,
	type GenerationView
} from './drafts';

vi.mock('./r2', () => ({ presignGet: (key: string) => `https://r2/${key}` }));

const DESCRIPTION = 'the chicken thighs and half a cabbage, under 40 minutes';
const result = candidates as GenerateResult;

let db: Database.Database;
beforeEach(() => {
	db = new Database(':memory:');
	migrate(db, 'migrations');
});

const row = (id: string) => db.prepare('SELECT * FROM job WHERE id = ?').get(id) as JobRow;

function generation(status: JobRow['status'] = 'done'): string {
	const id = createJob(db, 'generate', { description: DESCRIPTION, yield_count: 2, picked: null });
	db.prepare('UPDATE job SET status = ?, result_json = ? WHERE id = ?').run(
		status,
		status === 'done' ? JSON.stringify(result) : null,
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
