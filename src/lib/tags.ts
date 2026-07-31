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
	image_ids: string[];
	cover_image_id: string | null;
};
