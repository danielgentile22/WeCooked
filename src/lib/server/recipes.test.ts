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
	listTrash,
	retryReconvert
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
	steps: ['Fry the onion.', 'Add everything else and simmer.'],
	counterpart: null,
	image_ids: [],
	cover_image_id: null
});

/** An uploaded-but-unclaimed image row (ADR-024), as /api/images creates it. */
function insertImage(id: string, recipeId: string | null = null) {
	db.prepare(
		`INSERT INTO image (id, recipe_id, r2_key_full, r2_key_display, width, height, role, created_at)
		 VALUES (?, ?, ?, ?, 3000, 2000, 'photo', '2026-07-30T00:00:00Z')`
	).run(id, recipeId, `images/${id}/full.jpg`, `images/${id}/display.jpg`);
}

const imageRow = (id: string) =>
	db.prepare('SELECT recipe_id, deleted_at FROM image WHERE id = ?').get(id) as {
		recipe_id: string | null;
		deleted_at: string | null;
	};

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

	it('rejects an edit aimed at a body that does not exist yet', () => {
		const id = createRecipe(db, base()); // metric only; US reconvert still queued
		expect(() => updateRecipe(db, id, { ...base(), source_units: 'us' })).toThrow(
			/unit system/
		);
		expect(getRecipe(db, id)?.source_units).toBe('metric');
	});
});

describe('dual bodies and reconvert (ADR-019, ADR-028)', () => {
	const usBody = () => ({
		ingredients: [
			{ heading: null, items: ['1 onion, finely diced', '14 oz tinned chickpeas'] },
			{ heading: 'For the sauce', items: ['14 oz tinned tomatoes'] }
		],
		steps: ['Fry the onion.', 'Add everything else and simmer.']
	});
	const jobs = (variationId?: string) =>
		db
			.prepare(
				`SELECT * FROM job WHERE kind = 'reconvert'${variationId ? ' AND variation_id = ?' : ''}`
			)
			.all(...(variationId ? [variationId] : [])) as {
			id: string;
			status: string;
			variation_id: string;
			input_json: string;
		}[];
	const bodyRows = (recipeId: string) =>
		db
			.prepare(
				`SELECT b.unit_system, b.is_source FROM body b
				 JOIN variation v ON v.id = b.variation_id
				 WHERE v.recipe_id = ? ORDER BY b.unit_system`
			)
			.all(recipeId) as { unit_system: string; is_source: number }[];

	it('create without a counterpart enqueues one reconvert for the other system', () => {
		const id = createRecipe(db, base());
		const r = getRecipe(db, id)!;
		expect(r.bodies.metric).not.toBeNull();
		expect(r.bodies.us).toBeNull();
		const j = jobs(r.variation_id);
		expect(j).toHaveLength(1);
		expect(JSON.parse(j[0].input_json)).toEqual({
			variation_id: r.variation_id,
			target_units: 'us'
		});
		expect(r.reconvert?.status).toBe('pending');
	});

	it('create with a known-good counterpart stores both bodies and no job', () => {
		const id = createRecipe(db, { ...base(), counterpart: usBody() });
		const r = getRecipe(db, id)!;
		expect(r.bodies.us?.ingredients[1].items).toEqual(['14 oz tinned tomatoes']);
		expect(r.reconvert).toBeNull();
		expect(jobs()).toHaveLength(0);
		expect(bodyRows(id)).toEqual([
			{ unit_system: 'metric', is_source: 1 },
			{ unit_system: 'us', is_source: 0 }
		]);
	});

	it('editing the source body keeps is_source and enqueues a reconvert of the counterpart', () => {
		const id = createRecipe(db, { ...base(), counterpart: usBody() });
		updateRecipe(db, id, { ...base(), steps: ['Fry the onion slowly.'] });
		const r = getRecipe(db, id)!;
		expect(r.source_units).toBe('metric');
		expect(r.hand_edited).toBe(true);
		expect(JSON.parse(jobs(r.variation_id)[0].input_json).target_units).toBe('us');
		expect(r.reconvert?.status).toBe('pending');
	});

	it('editing the counterpart body moves is_source to it (ADR-028)', () => {
		const id = createRecipe(db, { ...base(), counterpart: usBody() });
		const edited = usBody();
		edited.steps[0] = 'Fry the onion in butter.';
		updateRecipe(db, id, { ...base(), source_units: 'us', ...edited });
		const r = getRecipe(db, id)!;
		expect(r.source_units).toBe('us');
		expect(r.steps[0]).toBe('Fry the onion in butter.');
		expect(bodyRows(id)).toEqual([
			{ unit_system: 'metric', is_source: 0 },
			{ unit_system: 'us', is_source: 1 }
		]);
		expect(JSON.parse(jobs(r.variation_id)[0].input_json).target_units).toBe('metric');
	});

	it('an unchanged save neither moves is_source nor spends a reconvert', () => {
		const id = createRecipe(db, { ...base(), counterpart: usBody() });
		updateRecipe(db, id, { ...base(), source_units: 'us', ...usBody() }); // client false positive
		expect(getRecipe(db, id)!.source_units).toBe('metric');
		expect(jobs()).toHaveLength(0);
	});

	it('a second edit does not stack a second queued job', () => {
		const id = createRecipe(db, { ...base(), counterpart: usBody() });
		updateRecipe(db, id, { ...base(), steps: ['Edit one.'] });
		updateRecipe(db, id, { ...base(), steps: ['Edit two.'] });
		expect(jobs()).toHaveLength(1);
	});

	it('search follows is_source: the edited body is what FTS indexes', () => {
		const id = createRecipe(db, { ...base(), counterpart: usBody() });
		const edited = usBody();
		edited.ingredients[0].items[1] = '14 oz tinned garbanzos';
		updateRecipe(db, id, { ...base(), source_units: 'us', ...edited });
		expect(listRecipes(db, { q: 'garbanzo' })).toHaveLength(1);
	});

	it('getRecipe maps job states: queued is pending, failed is failed, done is null', () => {
		const id = createRecipe(db, base());
		const r = getRecipe(db, id)!;
		expect(r.reconvert).toEqual({ job_id: jobs()[0].id, status: 'pending' });
		db.prepare(`UPDATE job SET status = 'failed' WHERE id = ?`).run(jobs()[0].id);
		expect(getRecipe(db, id)!.reconvert?.status).toBe('failed');
		// what the reconvert handler would do on success
		db.prepare(
			`INSERT INTO body (id, variation_id, unit_system, is_source, ingredients_json, steps_json, created_at, updated_at)
			 VALUES ('b-us', ?, 'us', 0, '[]', '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`
		).run(r.variation_id);
		db.prepare(`UPDATE job SET status = 'done' WHERE id = ?`).run(jobs()[0].id);
		expect(getRecipe(db, id)!.reconvert).toBeNull();
	});

	it('a missing counterpart with no job reads as failed, so retry can rebuild it', () => {
		const id = createRecipe(db, base());
		db.prepare(`DELETE FROM job`).run();
		expect(getRecipe(db, id)!.reconvert).toEqual({ job_id: null, status: 'failed' });
		retryReconvert(db, id);
		expect(jobs()).toHaveLength(1);
		expect(jobs()[0].status).toBe('queued');
	});

	it('retryReconvert requeues a failed job in place', () => {
		const id = createRecipe(db, base());
		db.prepare(`UPDATE job SET status = 'failed', error_code = 'api_error'`).run();
		retryReconvert(db, id);
		const j = jobs();
		expect(j).toHaveLength(1);
		expect(j[0].status).toBe('queued');
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

describe('images and cover (issue #11, ADR-024, D17)', () => {
	it('claims uploaded images and sets the cover on create', () => {
		insertImage('img1');
		insertImage('img2');
		const id = createRecipe(db, { ...base(), image_ids: ['img1', 'img2'], cover_image_id: 'img2' });
		expect(imageRow('img1').recipe_id).toBe(id);
		expect(imageRow('img2').recipe_id).toBe(id);
		const r = getRecipe(db, id)!;
		expect(r.cover_image_id).toBe('img2');
		expect(r.images.map((i) => i.id)).toEqual(['img1', 'img2']);
	});

	it('rejects a cover that is not one of the submitted images (falls back to coverless)', () => {
		insertImage('img1');
		const id = createRecipe(db, { ...base(), image_ids: ['img1'], cover_image_id: 'ghost' });
		expect(getRecipe(db, id)!.cover_image_id).toBeNull();
	});

	it('cannot claim an image that belongs to another recipe', () => {
		const other = createRecipe(db, { ...base(), title: 'Pancakes' });
		insertImage('theirs', other);
		const id = createRecipe(db, { ...base(), image_ids: ['theirs'], cover_image_id: 'theirs' });
		expect(imageRow('theirs').recipe_id).toBe(other);
		expect(getRecipe(db, id)!.cover_image_id).toBeNull();
	});

	it('soft-deletes images removed in an edit and clears a removed cover', () => {
		insertImage('img1');
		insertImage('img2');
		const id = createRecipe(db, { ...base(), image_ids: ['img1', 'img2'], cover_image_id: 'img1' });
		updateRecipe(db, id, { ...base(), image_ids: ['img2'], cover_image_id: null });
		expect(imageRow('img1').deleted_at).toBeTruthy();
		expect(imageRow('img2').deleted_at).toBeNull();
		const r = getRecipe(db, id)!;
		expect(r.cover_image_id).toBeNull();
		expect(r.images.map((i) => i.id)).toEqual(['img2']);
	});

	it('browse rows carry the cover display key, NULL when coverless (D17)', () => {
		insertImage('img1');
		const withCover = createRecipe(db, { ...base(), image_ids: ['img1'], cover_image_id: 'img1' });
		const coverless = createRecipe(db, { ...base(), title: 'Pancakes' });
		const rows = Object.fromEntries(listRecipes(db).map((r) => [r.id, r.cover_key]));
		expect(rows[withCover]).toBe('images/img1/display.jpg');
		expect(rows[coverless]).toBeNull();
	});

	it('images do not bump content_version (SPEC 7.2)', () => {
		insertImage('img1');
		const id = createRecipe(db, base());
		updateRecipe(db, id, { ...base(), image_ids: ['img1'], cover_image_id: 'img1' });
		expect(version(id)).toBe(1);
	});
});
