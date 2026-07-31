import type { Database } from 'better-sqlite3';
import { ulid } from './ids';
import {
	MEAL_TYPES,
	CUISINES,
	PROTEINS,
	EFFORTS,
	DAMAGES,
	type RecipeInput,
	type IngredientGroup
} from '$lib/tags';

const now = () => new Date().toISOString();

/** Drop empty lines and empty groups; a heading of '' becomes null. */
export function cleanIngredients(groups: IngredientGroup[]): IngredientGroup[] {
	return groups
		.map((g) => ({
			heading: g.heading?.trim() || null,
			items: g.items.map((i) => i.trim()).filter(Boolean)
		}))
		.filter((g) => g.items.length > 0);
}

/**
 * SPEC 7.2 save rules. Returns the normalised input or throws with a message
 * fit for the form banner. Validation at the trust boundary: the client also
 * checks, but the server decides.
 */
export function validateInput(raw: RecipeInput): RecipeInput {
	const title = raw.title?.trim();
	if (!title) throw new Error('Title is required.');
	const yield_count = Math.round(Number(raw.yield_count) * 10) / 10;
	if (!Number.isFinite(yield_count) || yield_count <= 0)
		throw new Error('Yield must be a positive number.');
	const ingredients = cleanIngredients(raw.ingredients ?? []);
	if (ingredients.length === 0) throw new Error('At least one ingredient line is required.');
	if (!EFFORTS.includes(raw.effort)) throw new Error('Effort is required.');
	if (!DAMAGES.includes(raw.damage)) throw new Error('Damage is required.');
	if (raw.cuisine !== null && !CUISINES.includes(raw.cuisine)) throw new Error('Unknown cuisine.');
	if (raw.protein !== null && !PROTEINS.includes(raw.protein)) throw new Error('Unknown protein.');
	const meal_types = (raw.meal_types ?? []).filter((m) => MEAL_TYPES.includes(m));
	if (raw.source_units !== 'us' && raw.source_units !== 'metric')
		throw new Error('Unknown unit system.');
	return {
		title,
		yield_count,
		yield_unit: raw.yield_unit?.trim() || 'servings',
		prep_minutes: raw.prep_minutes ?? null,
		cook_minutes: raw.cook_minutes ?? null,
		source_text: raw.source_text?.trim() || null,
		source_url: raw.source_url?.trim() || null,
		notes: raw.notes?.trim() || null,
		source_units: raw.source_units,
		meal_types,
		cuisine: raw.cuisine,
		protein: raw.protein,
		effort: raw.effort,
		damage: raw.damage,
		ingredients,
		steps: (raw.steps ?? []).map((s) => s.trim()).filter(Boolean) // steps may be empty
	};
}

/** SPEC 4: FTS row is rebuilt from the source-unit body of the original variation. */
export function rebuildFts(db: Database, recipeId: string): void {
	const r = db
		.prepare(
			`SELECT r.title, r.cuisine, r.protein, r.effort, r.damage, b.ingredients_json
			 FROM recipe r
			 JOIN variation v ON v.recipe_id = r.id AND v.is_original = 1 AND v.deleted_at IS NULL
			 JOIN body b ON b.variation_id = v.id AND b.is_source = 1
			 WHERE r.id = ?`
		)
		.get(recipeId) as
		| { title: string; cuisine: string | null; protein: string | null; effort: string; damage: string; ingredients_json: string }
		| undefined;
	db.prepare('DELETE FROM recipe_fts WHERE recipe_id = ?').run(recipeId);
	if (!r) return;
	const meals = db
		.prepare('SELECT meal_type FROM recipe_meal_type WHERE recipe_id = ?')
		.all(recipeId) as { meal_type: string }[];
	const groups = JSON.parse(r.ingredients_json) as IngredientGroup[];
	const ingredients = groups.flatMap((g) => [g.heading ?? '', ...g.items]).join('\n');
	const tags = [r.cuisine, r.protein, r.effort, r.damage, ...meals.map((m) => m.meal_type)]
		.filter(Boolean)
		.join(' ');
	db.prepare(
		'INSERT INTO recipe_fts (recipe_id, title, ingredients, tags) VALUES (?, ?, ?, ?)'
	).run(recipeId, r.title, ingredients, tags);
}

/** Create recipe + original variation + source body, rebuild FTS. Returns the recipe id. */
export function createRecipe(db: Database, raw: RecipeInput): string {
	const input = validateInput(raw);
	const id = ulid();
	const ts = now();
	db.transaction(() => {
		db.prepare(
			`INSERT INTO recipe (id, title, source_text, source_url, yield_unit, prep_minutes,
			   cook_minutes, notes, source_units, cuisine, protein, effort, damage,
			   content_version, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
		).run(
			id,
			input.title,
			input.source_text,
			input.source_url,
			input.yield_unit,
			input.prep_minutes,
			input.cook_minutes,
			input.notes,
			input.source_units,
			input.cuisine,
			input.protein,
			input.effort,
			input.damage,
			ts,
			ts
		);
		const insertMeal = db.prepare(
			'INSERT INTO recipe_meal_type (recipe_id, meal_type) VALUES (?, ?)'
		);
		for (const m of input.meal_types) insertMeal.run(id, m);
		const variationId = ulid();
		db.prepare(
			`INSERT INTO variation (id, recipe_id, yield_count, is_original, hand_edited,
			   based_on_content_version, created_at, updated_at)
			 VALUES (?, ?, ?, 1, 0, 1, ?, ?)`
		).run(variationId, id, input.yield_count, ts, ts);
		db.prepare(
			`INSERT INTO body (id, variation_id, unit_system, is_source, ingredients_json,
			   steps_json, created_at, updated_at)
			 VALUES (?, ?, ?, 1, ?, ?, ?, ?)`
		).run(
			ulid(),
			variationId,
			input.source_units,
			JSON.stringify(input.ingredients),
			JSON.stringify(input.steps),
			ts,
			ts
		);
		rebuildFts(db, id);
	})();
	return id;
}

/**
 * Update recipe + original variation + source body. Bumps content_version only
 * when ingredients, steps, or the original yield changed (ADR-012, ADR-030);
 * title, tags, notes, source do not bump it.
 */
export function updateRecipe(db: Database, recipeId: string, raw: RecipeInput): void {
	const input = validateInput(raw);
	const ts = now();
	db.transaction(() => {
		const cur = db
			.prepare(
				`SELECT r.content_version, v.id AS variation_id, v.yield_count,
				        b.id AS body_id, b.ingredients_json, b.steps_json
				 FROM recipe r
				 JOIN variation v ON v.recipe_id = r.id AND v.is_original = 1 AND v.deleted_at IS NULL
				 JOIN body b ON b.variation_id = v.id AND b.is_source = 1
				 WHERE r.id = ? AND r.deleted_at IS NULL`
			)
			.get(recipeId) as
			| {
					content_version: number;
					variation_id: string;
					yield_count: number;
					body_id: string;
					ingredients_json: string;
					steps_json: string;
			  }
			| undefined;
		if (!cur) throw new Error('Recipe not found.');

		const substantive =
			cur.yield_count !== input.yield_count ||
			cur.ingredients_json !== JSON.stringify(input.ingredients) ||
			cur.steps_json !== JSON.stringify(input.steps);
		const version = cur.content_version + (substantive ? 1 : 0);

		db.prepare(
			`UPDATE recipe SET title = ?, source_text = ?, source_url = ?, yield_unit = ?,
			   prep_minutes = ?, cook_minutes = ?, notes = ?, source_units = ?, cuisine = ?,
			   protein = ?, effort = ?, damage = ?, content_version = ?, updated_at = ?
			 WHERE id = ?`
		).run(
			input.title,
			input.source_text,
			input.source_url,
			input.yield_unit,
			input.prep_minutes,
			input.cook_minutes,
			input.notes,
			input.source_units,
			input.cuisine,
			input.protein,
			input.effort,
			input.damage,
			version,
			ts,
			recipeId
		);
		db.prepare('DELETE FROM recipe_meal_type WHERE recipe_id = ?').run(recipeId);
		const insertMeal = db.prepare(
			'INSERT INTO recipe_meal_type (recipe_id, meal_type) VALUES (?, ?)'
		);
		for (const m of input.meal_types) insertMeal.run(recipeId, m);
		db.prepare(
			`UPDATE variation SET yield_count = ?, based_on_content_version = ?, updated_at = ?
			 WHERE id = ?`
		).run(input.yield_count, version, ts, cur.variation_id);
		db.prepare(
			`UPDATE body SET unit_system = ?, ingredients_json = ?, steps_json = ?, updated_at = ?
			 WHERE id = ?`
		).run(
			input.source_units,
			JSON.stringify(input.ingredients),
			JSON.stringify(input.steps),
			ts,
			cur.body_id
		);
		rebuildFts(db, recipeId);
	})();
}

export type RecipeDetail = {
	id: string;
	title: string;
	source_text: string | null;
	source_url: string | null;
	yield_unit: string;
	yield_count: number;
	prep_minutes: number | null;
	cook_minutes: number | null;
	notes: string | null;
	source_units: 'us' | 'metric';
	meal_types: RecipeInput['meal_types'];
	cuisine: RecipeInput['cuisine'];
	protein: RecipeInput['protein'];
	effort: RecipeInput['effort'];
	damage: RecipeInput['damage'];
	ingredients: IngredientGroup[];
	steps: string[];
};

/** The original variation's source body plus recipe metadata, for view and edit. */
export function getRecipe(db: Database, id: string): RecipeDetail | null {
	const r = db
		.prepare(
			`SELECT r.id, r.title, r.source_text, r.source_url, r.yield_unit, r.prep_minutes,
			        r.cook_minutes, r.notes, r.source_units, r.cuisine, r.protein, r.effort,
			        r.damage, v.yield_count, b.ingredients_json, b.steps_json
			 FROM recipe r
			 JOIN variation v ON v.recipe_id = r.id AND v.is_original = 1 AND v.deleted_at IS NULL
			 JOIN body b ON b.variation_id = v.id AND b.is_source = 1
			 WHERE r.id = ? AND r.deleted_at IS NULL`
		)
		.get(id) as (Omit<RecipeDetail, 'meal_types' | 'ingredients' | 'steps'> & {
		ingredients_json: string;
		steps_json: string;
	}) | undefined;
	if (!r) return null;
	const meal_types = (
		db.prepare('SELECT meal_type FROM recipe_meal_type WHERE recipe_id = ?').all(id) as {
			meal_type: RecipeInput['meal_types'][number];
		}[]
	).map((m) => m.meal_type);
	const { ingredients_json, steps_json, ...rest } = r;
	return {
		...rest,
		meal_types,
		ingredients: JSON.parse(ingredients_json),
		steps: JSON.parse(steps_json)
	};
}

export type BrowseFilters = {
	q?: string;
	meal_type?: string[];
	cuisine?: string[];
	protein?: string[];
	effort?: string[];
	damage?: string[];
};

export type BrowseRow = {
	id: string;
	title: string;
	effort: string;
	damage: string;
};

/**
 * SPEC 7.3: newest first, FTS search, AND across tag groups, OR within a group.
 * All filter values are checked against the closed vocabulary, so they never
 * reach SQL as raw user input.
 */
export function listRecipes(db: Database, f: BrowseFilters = {}): BrowseRow[] {
	const where: string[] = ['r.deleted_at IS NULL'];
	const params: unknown[] = [];

	const q = f.q?.trim();
	if (q) {
		// Quote each token and prefix-match, so "chick tom" finds chickpea tomato.
		const match = q
			.split(/\s+/)
			.map((t) => `"${t.replace(/"/g, '""')}"*`)
			.join(' ');
		where.push('r.id IN (SELECT recipe_id FROM recipe_fts WHERE recipe_fts MATCH ?)');
		params.push(match);
	}

	const inGroup = (col: string, values: string[] | undefined, vocab: readonly string[]) => {
		const valid = (values ?? []).filter((v) => vocab.includes(v));
		if (valid.length === 0) return;
		where.push(`r.${col} IN (${valid.map(() => '?').join(',')})`);
		params.push(...valid);
	};
	inGroup('cuisine', f.cuisine, CUISINES);
	inGroup('protein', f.protein, PROTEINS);
	inGroup('effort', f.effort, EFFORTS);
	inGroup('damage', f.damage, DAMAGES);

	const meals = (f.meal_type ?? []).filter((v) => (MEAL_TYPES as readonly string[]).includes(v));
	if (meals.length > 0) {
		where.push(
			`EXISTS (SELECT 1 FROM recipe_meal_type m WHERE m.recipe_id = r.id
			   AND m.meal_type IN (${meals.map(() => '?').join(',')}))`
		);
		params.push(...meals);
	}

	return db
		.prepare(
			`SELECT r.id, r.title, r.effort, r.damage FROM recipe r
			 WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC`
		)
		.all(...params) as BrowseRow[];
}
