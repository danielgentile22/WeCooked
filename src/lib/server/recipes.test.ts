import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './migrate';
import { createRecipe, updateRecipe, getRecipe, listRecipes } from './recipes';
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
