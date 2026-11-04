import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './migrate';
import { claudeCall } from './claude';
import { createRecipe } from './recipes';
import {
	addManual,
	applyMerge,
	doneShopping,
	getListId,
	getShoppingState,
	requestBuild,
	shoppingMerge,
	type MergeItem
} from './shopping';
import type { JobRow } from './jobs';
import type { RecipeInput } from '#lib/tags.js';

vi.mock('./claude', () => ({ claudeCall: vi.fn() }));
vi.mock('./r2', () => ({ getObject: vi.fn(), presignGet: vi.fn(), putObject: vi.fn() }));

let db: Database.Database;
beforeEach(() => {
	db = new Database(':memory:');
	db.pragma('foreign_keys = ON');
	migrate(db, 'migrations');
	vi.mocked(claudeCall).mockReset();
});

const input = (title: string, items: string[]): RecipeInput => ({
	title,
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
	ingredients: [{ heading: null, items }],
	steps: [],
	counterpart: { ingredients: [{ heading: null, items }], steps: [] },
	image_ids: [],
	cover_image_id: null
});

const mergeItem = (over: Partial<MergeItem> = {}): MergeItem => ({
	section: 'produce',
	text_us: '3 onions',
	text_metric: '3 onions',
	from_recipes: [],
	is_staple: false,
	...over
});

/** One line as the merge call returns it: provenance by recipe number. */
const mergeReply = (
	over: Partial<Omit<MergeItem, 'from_recipes'>> & { from_recipes?: number[] } = {}
) => ({ ...mergeItem(), from_recipes: [] as number[], ...over });

const scaleResult = () => ({
	body: { ingredients: [{ heading: null, items: ['500 g chickpeas'] }], steps: [] },
	scaling_note: 'Scaled up.'
});

/** A promise the test settles by hand, to control the order calls finish in. */
function deferred<T>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** Recipes in the order the build reads its picks (by recipe id). */
const byId = (...ids: string[]) => [...ids].sort();

function buildJob(): JobRow {
	return db
		.prepare(`SELECT * FROM job WHERE kind = 'shopping_merge' ORDER BY created_at DESC LIMIT 1`)
		.get() as JobRow;
}

const items = () =>
	db.prepare(`SELECT * FROM shopping_list_item ORDER BY position, id`).all() as {
		id: string;
		section: string;
		text_us: string;
		text_metric: string;
		is_manual: number;
		ticked: number;
	}[];

describe('tick preservation on rebuild (SPEC 8.8 test 3)', () => {
	it('keeps a tick on exact match, resets anything else, names the casualties', () => {
		const listId = getListId(db);
		applyMerge(db, listId, [
			mergeItem({ text_metric: '3 onions', text_us: '3 onions' }),
			mergeItem({ text_metric: '500 g flour', text_us: '1 lb 2 oz flour', section: 'dry-goods' })
		]);
		for (const i of items()) db.prepare(`UPDATE shopping_list_item SET ticked = 1 WHERE id = ?`).run(i.id);

		// Same onions line, flour quantity changed.
		const result = applyMerge(db, listId, [
			mergeItem({ text_metric: '3 onions', text_us: '3 onions' }),
			mergeItem({ text_metric: '600 g flour', text_us: '1 lb 5 oz flour', section: 'dry-goods' })
		]);
		expect(result).toEqual({ kept: 1, reset: ['500 g flour'] });
		const byText = Object.fromEntries(items().map((i) => [i.text_metric, i.ticked]));
		expect(byText['3 onions']).toBe(1);
		expect(byText['600 g flour']).toBe(0);
	});

	it('keeps a tick when only the section moved: identity is the text, not the shelf', () => {
		const listId = getListId(db);
		applyMerge(db, listId, [mergeItem({ section: 'other' })]);
		db.prepare(`UPDATE shopping_list_item SET ticked = 1`).run();
		const result = applyMerge(db, listId, [mergeItem({ section: 'produce' })]);
		expect(result).toEqual({ kept: 1, reset: [] });
	});

	it('resets when either unit text changed', () => {
		const listId = getListId(db);
		applyMerge(db, listId, [mergeItem({ text_us: '1 lb 2 oz flour', text_metric: '500 g flour' })]);
		db.prepare(`UPDATE shopping_list_item SET ticked = 1`).run();
		const result = applyMerge(db, listId, [
			mergeItem({ text_us: '1.1 lb flour', text_metric: '500 g flour' })
		]);
		expect(result).toEqual({ kept: 0, reset: ['500 g flour'] });
	});

	it('manual lines and their ticks survive a rebuild', () => {
		const listId = getListId(db);
		addManual(db, 'bin bags');
		db.prepare(`UPDATE shopping_list_item SET ticked = 1`).run();
		applyMerge(db, listId, [mergeItem()]);
		const manual = items().find((i) => i.is_manual);
		expect(manual?.text_metric).toBe('bin bags');
		expect(manual?.ticked).toBe(1);
	});

	it('stores staple-flagged lines in the staples section, ordered last', () => {
		const listId = getListId(db);
		applyMerge(db, listId, [
			mergeItem({ text_metric: 'salt', text_us: 'salt', section: 'spices', is_staple: true }),
			mergeItem()
		]);
		expect(items().map((i) => i.section)).toEqual(['produce', 'staples']);
	});
});

describe('shoppingMerge job', () => {
	it('generates a missing variation inline, saves it, and merges', async () => {
		const a = createRecipe(db, input('Tagine', ['800 g chicken']));
		const b = createRecipe(db, input('Carbonara', ['200 g spaghetti']));
		requestBuild(db, [
			{ recipe_id: a, yield_count: 6 }, // missing: needs a scale call
			{ recipe_id: b, yield_count: 4 } // the original variation
		]);
		vi.mocked(claudeCall)
			.mockResolvedValueOnce(scaleResult())
			.mockResolvedValueOnce({
				// Short indices, in pick order (by recipe id); 99 is hallucinated.
				items: [mergeReply({ from_recipes: [1, 2, 99] })]
			});

		const result = await shoppingMerge(buildJob(), db);
		expect(result).toEqual({ kept: 0, reset: [] });
		expect(vi.mocked(claudeCall)).toHaveBeenCalledTimes(2);
		// The 6-portion variation is saved and visible on the recipe afterwards.
		const v = db
			.prepare(`SELECT id FROM variation WHERE recipe_id = ? AND yield_count = 6 AND deleted_at IS NULL`)
			.get(a);
		expect(v).toBeTruthy();
		// Hallucinated provenance ids are dropped.
		const state = getShoppingState(db);
		expect(state.items[0].from_titles.sort()).toEqual(['Carbonara', 'Tagine']);
	});

	it('runs every scale a build needs at once, before any of them finishes', async () => {
		const a = createRecipe(db, input('Tagine', ['800 g chicken']));
		const b = createRecipe(db, input('Fish pie', ['400 g haddock']));
		const c = createRecipe(db, input('Dal', ['300 g lentils']));
		requestBuild(db, [
			{ recipe_id: a, yield_count: 6 },
			{ recipe_id: b, yield_count: 8 },
			{ recipe_id: c, yield_count: 2 }
		]);
		const scales = [deferred<unknown>(), deferred<unknown>(), deferred<unknown>()];
		vi.mocked(claudeCall)
			.mockReturnValueOnce(scales[0].promise as never)
			.mockReturnValueOnce(scales[1].promise as never)
			.mockReturnValueOnce(scales[2].promise as never)
			.mockResolvedValueOnce({ items: [mergeItem()] });
		const run = shoppingMerge(buildJob(), db);
		await Promise.resolve();
		// All three scale calls are in flight while none has answered.
		expect(vi.mocked(claudeCall)).toHaveBeenCalledTimes(3);
		// Finish out of order; the merge still runs once, after all of them.
		scales[2].resolve(scaleResult());
		scales[0].resolve(scaleResult());
		scales[1].resolve(scaleResult());
		await run;
		expect(vi.mocked(claudeCall)).toHaveBeenCalledTimes(4);
		expect(
			db.prepare(`SELECT COUNT(*) AS n FROM variation WHERE is_original = 0`).get()
		).toEqual({ n: 3 });
	});

	it('mid-build failure keeps saved variations; retry only pays for what is left', async () => {
		const a = createRecipe(db, input('Tagine', ['800 g chicken']));
		const b = createRecipe(db, input('Fish pie', ['400 g haddock']));
		requestBuild(db, [
			{ recipe_id: a, yield_count: 6 },
			{ recipe_id: b, yield_count: 8 }
		]);
		// One scale fails fast while the other is still running: the build waits
		// for the slow one so its variation is saved, then fails.
		const slow = deferred<unknown>();
		vi.mocked(claudeCall)
			.mockReturnValueOnce(slow.promise as never)
			.mockRejectedValueOnce(new Error('api down'));
		const run = shoppingMerge(buildJob(), db);
		const settled = run.then(
			() => 'resolved',
			() => 'rejected'
		);
		await new Promise((r) => setTimeout(r, 0));
		slow.resolve(scaleResult());
		expect(await settled).toBe('rejected');
		const [first] = byId(a, b);
		expect(
			db
				.prepare(
					`SELECT recipe_id FROM variation
					 WHERE recipe_id IN (?, ?) AND yield_count IN (6, 8) AND deleted_at IS NULL`
				)
				.all(a, b)
		).toEqual([{ recipe_id: first }]);

		// Retry: only the remaining scale plus the merge are paid for.
		vi.mocked(claudeCall)
			.mockReset()
			.mockResolvedValueOnce(scaleResult())
			.mockResolvedValueOnce({ items: [mergeItem()] });
		await shoppingMerge(buildJob(), db);
		expect(vi.mocked(claudeCall)).toHaveBeenCalledTimes(2);
	});

	it('sends recipes by short index with metric lines only, and maps indices back', async () => {
		const a = createRecipe(db, input('Tagine', ['800 g chicken']));
		const b = createRecipe(db, input('Carbonara', ['200 g spaghetti']));
		// A US-sourced recipe whose metric body is not converted yet: its
		// as-written lines are the only ones there are, so they go in.
		const c = createRecipe(db, {
			...input('Chili', ['1 lb ground beef']),
			source_units: 'us',
			counterpart: null
		});
		requestBuild(db, [
			{ recipe_id: a, yield_count: 4 },
			{ recipe_id: b, yield_count: 4 },
			{ recipe_id: c, yield_count: 4 }
		]);
		const order = byId(a, b, c);
		const idx = (id: string) => order.indexOf(id) + 1;
		vi.mocked(claudeCall).mockResolvedValueOnce({
			items: [
				mergeReply({ text_metric: 'chicken', from_recipes: [idx(a)] }),
				mergeReply({ text_metric: 'pasta', from_recipes: [idx(b), 0, 7] })
			]
		});
		await shoppingMerge(buildJob(), db);

		const content = vi.mocked(claudeCall).mock.calls[0][1].messages[0].content as string;
		for (const id of [a, b, c]) expect(content).not.toContain(id);
		expect(content).not.toContain('ingredients_us');
		const sent = JSON.parse(content) as { recipe: number; title: string; ingredients: string[] }[];
		expect(sent.map((r) => r.recipe)).toEqual([1, 2, 3]);
		expect(sent[idx(c) - 1].ingredients).toEqual(['1 lb ground beef']);
		expect(sent[idx(a) - 1].ingredients).toEqual(['800 g chicken']);

		const rows = db
			.prepare(`SELECT text_metric, from_recipes FROM shopping_list_item ORDER BY position`)
			.all() as { text_metric: string; from_recipes: string }[];
		expect(rows.map((r) => [r.text_metric, JSON.parse(r.from_recipes)])).toEqual([
			['chicken', [a]],
			['pasta', [b]]
		]);
	});

	it('a queued build job is reused, not doubled', () => {
		const a = createRecipe(db, input('Tagine', ['800 g chicken']));
		const first = requestBuild(db, [{ recipe_id: a, yield_count: 4 }]);
		const second = requestBuild(db, [{ recipe_id: a, yield_count: 6 }]);
		expect(second.job_id).toBe(first.job_id);
		expect(db.prepare(`SELECT COUNT(*) AS n FROM job WHERE kind = 'shopping_merge'`).get()).toEqual(
			{ n: 1 }
		);
		// The reused job reads the NEW picks at run time.
		expect(
			db.prepare(`SELECT yield_count FROM shopping_list_recipe`).get()
		).toEqual({ yield_count: 6 });
	});
});

describe('done shopping (ADR-034)', () => {
	it('hard-deletes items including manual lines and all picks; the list row stays', () => {
		const a = createRecipe(db, input('Tagine', ['800 g chicken']));
		requestBuild(db, [{ recipe_id: a, yield_count: 4 }]);
		applyMerge(db, getListId(db), [mergeItem()]);
		addManual(db, 'bin bags');
		doneShopping(db);
		expect(items()).toEqual([]);
		expect(db.prepare(`SELECT COUNT(*) AS n FROM shopping_list_recipe`).get()).toEqual({ n: 0 });
		expect(db.prepare(`SELECT COUNT(*) AS n FROM shopping_list`).get()).toEqual({ n: 1 });
	});
});
