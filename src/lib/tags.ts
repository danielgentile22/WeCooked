// SPEC 3.4: five groups, fixed closed vocabulary. Shared by the form chips,
// browse filters, and server-side validation.

export const MEAL_TYPES = [
	'breakfast',
	'lunch',
	'dinner',
	'side',
	'salad',
	'soup',
	'bread',
	'dessert',
	'snack',
	'sauce',
	'drink'
] as const;

export const CUISINES = [
	'italian',
	'french',
	'spanish',
	'greek',
	'middle-eastern',
	'north-african',
	'indian',
	'thai',
	'vietnamese',
	'chinese',
	'japanese',
	'korean',
	'mexican',
	'american',
	'british',
	'central-european',
	'nordic',
	'caribbean',
	'west-african'
] as const;

export const PROTEINS = [
	'chicken',
	'beef',
	'pork',
	'lamb',
	'fish',
	'seafood',
	'egg',
	'tofu',
	'beans',
	'cheese',
	'none'
] as const;

export const EFFORTS = ['quick', 'weeknight', 'project'] as const;

export const DAMAGES = ['tidy', 'messy', 'carnage'] as const;

export type MealType = (typeof MEAL_TYPES)[number];
export type Cuisine = (typeof CUISINES)[number];
export type Protein = (typeof PROTEINS)[number];
export type Effort = (typeof EFFORTS)[number];
export type Damage = (typeof DAMAGES)[number];

export type IngredientGroup = { heading: string | null; items: string[] };

export type UnitSystem = 'us' | 'metric';
export const otherUnits = (u: UnitSystem): UnitSystem => (u === 'us' ? 'metric' : 'us');

/** One body's text: what the form edits and reconvert regenerates. */
export type BodyText = { ingredients: IngredientGroup[]; steps: string[] };

/** Drop empty lines and empty groups; a heading of '' becomes null. Shared by
 *  server validation and the form's edited-body detection, so both sides
 *  compare the same normalised shape. */
export function cleanIngredients(groups: IngredientGroup[]): IngredientGroup[] {
	return groups
		.map((g) => ({
			heading: g.heading?.trim() || null,
			items: g.items.map((i) => i.trim()).filter(Boolean)
		}))
		.filter((g) => g.items.length > 0);
}

export function cleanBody(b: BodyText): BodyText {
	return {
		ingredients: cleanIngredients(b.ingredients),
		steps: b.steps.map((s) => s.trim()).filter(Boolean)
	};
}

/** Everything the review form submits; also the shape updateRecipe compares. */
export type RecipeInput = {
	title: string;
	yield_count: number;
	yield_unit: string;
	prep_minutes: number | null;
	cook_minutes: number | null;
	source_text: string | null;
	source_url: string | null;
	notes: string | null;
	source_units: 'us' | 'metric';
	meal_types: MealType[];
	cuisine: Cuisine | null;
	protein: Protein | null;
	effort: Effort;
	damage: Damage;
	ingredients: IngredientGroup[];
	steps: string[];
	/** The other unit system's body, when it is known-good (unedited since the
	 *  extraction or last reconvert). Null means "stale or unknown": the server
	 *  stores only the source body and enqueues a reconvert (ADR-019). */
	counterpart: BodyText | null;
	image_ids: string[];
	cover_image_id: string | null;
};
