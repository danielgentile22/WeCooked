import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './migrate';
import {
	createRecipe,
	updateRecipe,
	getRecipe,
	listRecipes,
	deleteRecipe,
	restoreRecipe,
	deleteVariation,
	restoreVariation,
	listTrash
} from './recipes';
import { ulid } from './ids';
import type { RecipeInput } from '$lib/tags';

let db: Database.Database;
beforeEach(() => {
	db = new Database(':memory:');
	db.pragma('foreign_keys = ON');
	migrate(db, 'migrations');
});

const base = (): RecipeInput => ({
	title: 'Chickpea stew',
	yield_count: 4,
	yield_unit: 'servings',
	prep_minutes: 10,
	cook_minutes: 30,
	source_text: 'Ottolenghi, Simple, p.112',
	source_url: null,
	notes: null,
	source_units: 'metric',
	meal_types: ['dinner'],
	cuisine: 'middle-eastern',
	protein: 'beans',
	effort: 'weeknight',
	damage: 'messy',
	ingredients: [
		{ heading: null, items: ['1 onion, finely diced', '400 g tinned chickpeas'] },
		{ heading: 'For the sauce', items: ['400 g tinned tomatoes'] }
	],
	steps: ['Fry the onion.', 'Add everything else and simmer.']
});

const version = (id: string) =>
	(db.prepare('SELECT content_version FROM recipe WHERE id = ?').get(id) as {
		content_version: number;
	}).content_version;

describe('save rules (SPEC 7.2)', () => {
	it('requires title, yield, one ingredient line', () => {
		expect(() => createRecipe(db, { ...base(), title: '  ' })).toThrow(/Title/);
		expect(() => createRecipe(db, { ...base(), yield_count: 0 })).toThrow(/Yield/);
		expect(() =>
			createRecipe(db, { ...base(), ingredients: [{ heading: 'x', items: ['  '] }] })
		).toThrow(/ingredient/);
	});

	it('requires effort and damage (no defaults)', () => {
		expect(() => createRecipe(db, { ...base(), effort: null as never })).toThrow(/Effort/);
		expect(() => createRecipe(db, { ...base(), damage: null as never })).toThrow(/Damage/);
	});

	it('saves a steps-free recipe (a spice mix is a legal recipe)', () => {
		const id = createRecipe(db, { ...base(), steps: [] });
		expect(getRecipe(db, id)?.steps).toEqual([]);
	});

	it('creates recipe, original variation, and source body', () => {
		const id = createRecipe(db, base());
		const v = db
			.prepare('SELECT * FROM variation WHERE recipe_id = ? AND is_original = 1')
			.get(id) as { id: string; yield_count: number; based_on_content_version: number };
		expect(v.yield_count).toBe(4);
		expect(v.based_on_content_version).toBe(1);
		const b = db
			.prepare('SELECT * FROM body WHERE variation_id = ? AND is_source = 1')
			.get(v.id) as { unit_system: string };
		expect(b.unit_system).toBe('metric');
		expect(version(id)).toBe(1);
	});
});

describe('content_version bump rules (ADR-012, ADR-030)', () => {
	it('bumps on ingredient edits', () => {
		const id = createRecipe(db, base());
		const input = base();
		input.ingredients[0].items[0] = '2 onions, finely diced';
		updateRecipe(db, id, input);
		expect(version(id)).toBe(2);
	});

	it('bumps on step edits', () => {
		const id = createRecipe(db, base());
		updateRecipe(db, id, { ...base(), steps: ['Fry the onion slowly.'] });
		expect(version(id)).toBe(2);
	});

	it('bumps on original yield change', () => {
		const id = createRecipe(db, base());
		updateRecipe(db, id, { ...base(), yield_count: 6 });
		expect(version(id)).toBe(2);
		const v = db
			.prepare('SELECT yield_count, based_on_content_version FROM variation WHERE recipe_id = ?')
			.get(id) as { yield_count: number; based_on_content_version: number };
		expect(v.yield_count).toBe(6);
		expect(v.based_on_content_version).toBe(2);
	});

	it('does not bump on title, tags, notes, or source edits', () => {
		const id = createRecipe(db, base());
		updateRecipe(db, id, {
			...base(),
			title: 'Renamed stew',
			notes: 'less salt next time',
			source_text: 'somewhere else',
			cuisine: 'greek',
			protein: 'none',
			effort: 'quick',
			damage: 'tidy',
			meal_types: ['lunch', 'dinner']
		});
		expect(version(id)).toBe(1);
		expect(getRecipe(db, id)?.title).toBe('Renamed stew');
	});

	it('does not bump when saved unchanged', () => {
		const id = createRecipe(db, base());
		updateRecipe(db, id, base());
		expect(version(id)).toBe(1);
	});

	it('marks the variation hand_edited on body edits, not on yield or metadata edits', () => {
		const id = createRecipe(db, base());
		const handEdited = () =>
			(db.prepare('SELECT hand_edited FROM variation WHERE recipe_id = ?').get(id) as {
				hand_edited: number;
			}).hand_edited;
		updateRecipe(db, id, { ...base(), title: 'Renamed', yield_count: 6 });
		expect(handEdited()).toBe(0);
		updateRecipe(db, id, { ...base(), yield_count: 6, steps: ['New step.'] });
		expect(handEdited()).toBe(1);
	});

	it('never relabels the body unit system on edit', () => {
		const id = createRecipe(db, base());
		updateRecipe(db, id, { ...base(), source_units: 'us' });
		const b = db
			.prepare(
				`SELECT b.unit_system FROM body b
				 JOIN variation v ON v.id = b.variation_id WHERE v.recipe_id = ?`
			)
			.get(id) as { unit_system: string };
		expect(b.unit_system).toBe('metric');
		expect(getRecipe(db, id)?.source_units).toBe('metric');
	});
});

describe('browse and search (SPEC 7.3)', () => {
	it('newest first', () => {
		const a = createRecipe(db, { ...base(), title: 'First' });
		db.prepare("UPDATE recipe SET created_at = '2020-01-01T00:00:00Z' WHERE id = ?").run(a);
		createRecipe(db, { ...base(), title: 'Second' });
		expect(listRecipes(db).map((r) => r.title)).toEqual(['Second', 'First']);
	});

	it('searches title, ingredients, and tags with prefixes', () => {
		createRecipe(db, base());
		createRecipe(db, { ...base(), title: 'Pancakes', ingredients: [{ heading: null, items: ['flour'] }], cuisine: 'american', protein: 'egg' });
		expect(listRecipes(db, { q: 'chickp' }).map((r) => r.title)).toEqual(['Chickpea stew']);
		expect(listRecipes(db, { q: 'tinned tom' }).map((r) => r.title)).toEqual(['Chickpea stew']);
		expect(listRecipes(db, { q: 'american' }).map((r) => r.title)).toEqual(['Pancakes']);
		expect(listRecipes(db, { q: '"quoted' })).toEqual([]); // no FTS syntax error
	});

	it('search index follows edits', () => {
		const id = createRecipe(db, base());
		updateRecipe(db, id, { ...base(), title: 'Harissa braise' });
		expect(listRecipes(db, { q: 'harissa' })).toHaveLength(1);
		expect(listRecipes(db, { q: 'stew' })).toHaveLength(0); // old title gone
	});

	it('filters AND across groups, OR within', () => {
		createRecipe(db, base()); // dinner, weeknight, messy
		createRecipe(db, { ...base(), title: 'Cake', meal_types: ['dessert'], effort: 'project' });
		expect(listRecipes(db, { meal_type: ['dinner', 'dessert'] })).toHaveLength(2); // OR within
		expect(listRecipes(db, { meal_type: ['dessert'], effort: ['weeknight'] })).toHaveLength(0); // AND across
		expect(listRecipes(db, { meal_type: ['dessert'], effort: ['project'] })).toHaveLength(1);
	});

	it('ignores filter values outside the vocabulary', () => {
		createRecipe(db, base());
		expect(listRecipes(db, { effort: ["'; DROP TABLE recipe;--"] })).toHaveLength(1);
	});
});

describe('soft delete and trash (SPEC 7.7, ADR-025)', () => {
	// No scale job exists yet, so plant a non-original variation by hand.
	const addVariation = (recipeId: string, yield_count: number) => {
		const id = ulid();
		db.prepare(
			`INSERT INTO variation (id, recipe_id, yield_count, is_original, hand_edited,
			   based_on_content_version, created_at, updated_at)
			 VALUES (?, ?, ?, 0, 0, 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`
		).run(id, recipeId, yield_count);
		return id;
	};

	it('deleted recipe vanishes from browse and search, restore brings it back intact', () => {
		const id = createRecipe(db, base());
		deleteRecipe(db, id);
		expect(listRecipes(db)).toHaveLength(0);
		expect(listRecipes(db, { q: 'chickp' })).toHaveLength(0);
		expect(getRecipe(db, id)).toBeNull();
		restoreRecipe(db, id);
		expect(listRecipes(db, { q: 'chickp' })).toHaveLength(1);
		expect(getRecipe(db, id)?.ingredients).toEqual(base().ingredients);
	});

	it('the original variation cannot be deleted', () => {
		const id = createRecipe(db, base());
		const v = db
			.prepare('SELECT id FROM variation WHERE recipe_id = ? AND is_original = 1')
			.get(id) as { id: string };
		expect(() => deleteVariation(db, v.id)).toThrow(/original/);
	});

	it('delete and restore a variation round-trips', () => {
		const id = createRecipe(db, base());
		const v = addVariation(id, 8);
		deleteVariation(db, v);
		expect(listTrash(db).variations).toHaveLength(1);
		expect(restoreVariation(db, v).displaced).toBe(false);
		expect(listTrash(db).variations).toHaveLength(0);
	});

	it('restore always wins: a live same-yield variation is displaced into Trash', () => {
		const id = createRecipe(db, base());
		const old = addVariation(id, 8);
		deleteVariation(db, old);
		const replacement = addVariation(id, 8); // what Recalculate would have created
		expect(restoreVariation(db, old).displaced).toBe(true);
		const live = db
			.prepare('SELECT id FROM variation WHERE recipe_id = ? AND yield_count = 8 AND deleted_at IS NULL')
			.all(id) as { id: string }[];
		expect(live.map((r) => r.id)).toEqual([old]);
		expect(listTrash(db).variations.map((v) => v.id)).toEqual([replacement]);
	});

	it('never displaces the original: restore fails cleanly instead (ADR-025)', () => {
		const id = createRecipe(db, base()); // original at yield 4
		const v = addVariation(id, 8);
		deleteVariation(db, v);
		updateRecipe(db, id, { ...base(), yield_count: 8 }); // original now holds yield 8
		expect(() => restoreVariation(db, v)).toThrow(/original/);
		const original = db
			.prepare('SELECT deleted_at FROM variation WHERE recipe_id = ? AND is_original = 1')
			.get(id) as { deleted_at: string | null };
		expect(original.deleted_at).toBeNull();
		expect(getRecipe(db, id)).not.toBeNull();
	});

	it('trash lists both groups with titles and dates, hides variations of deleted recipes', () => {
		const id = createRecipe(db, base());
		const v = addVariation(id, 8);
		deleteVariation(db, v);
		const other = createRecipe(db, { ...base(), title: 'Pancakes' });
		deleteRecipe(db, other);
		let t = listTrash(db);
		expect(t.recipes.map((r) => r.title)).toEqual(['Pancakes']);
		expect(t.variations[0]).toMatchObject({ id: v, title: 'Chickpea stew', yield_count: 8 });
		expect(t.variations[0].deleted_at).toBeTruthy();
		deleteRecipe(db, id);
		expect(listTrash(db).variations).toHaveLength(0);
	});
});
