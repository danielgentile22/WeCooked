import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import candidates from '../../../fixtures/candidates.json';
import type { GenerateResult } from '$lib/extract';
import type { RecipeInput } from '$lib/tags';
import { migrate } from './migrate';
import { createJob, type JobRow } from './jobs';
import {
	draftView,
	getGenerationJob,
	listDrafts,
	pickCandidate,
	saveDraft,
	type DraftView,
	type GenerationView
} from './drafts';

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
