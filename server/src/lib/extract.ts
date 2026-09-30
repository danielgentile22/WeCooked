// RecipeDraft: the extract job's result_json shape (SPEC 5.4), and the
// mapping that seeds the review form from it. Shared so the drafts page
// (client) never has to import server code for types.

import { otherUnits } from '$lib/tags';
import type {
	BodyText,
	IngredientGroup,
	MealType,
	Cuisine,
	Protein,
	Effort,
	Damage,
	RecipeInput
} from '$lib/tags';

/** A capture job's input_json: pasted text, a url, or image ids. page is the
 *  reduced content of the HTML the phone rendered for url (issue #43). */
export type CaptureInput = { text?: string; url?: string; page?: string; image_ids?: string[] };

/** A generate job's input_json (issue #41). picked stays null until the cook
 *  picks a candidate; it is what turns the generation into a draft. */
export type GenerateInput = { description: string; yield_count: number; picked: number | null };

/**
 * SPEC 7.1 text-or-URL detection: a lone link takes the URL path, anything
 * else is recipe text. Returns the fetchable URL, or null for prose. Bare
 * "www.site.com/..." counts: that is what copy-a-link flows often produce.
 */
export function asUrl(text: string): string | null {
	if (/^https?:\/\/\S+$/.test(text)) return text;
	if (/^www\.\S+$/.test(text)) return `https://${text}`;
	return null;
}

export type BodyPair = {
	source_units: 'us' | 'metric';
	us: BodyText;
	metric: BodyText;
};

export type RecipeDraft = {
	title: string;
	yield_count: number;
	yield_unit: string;
	prep_minutes: number | null;
	cook_minutes: number | null;
	source_text: string | null;
	body: BodyPair;
	tags: {
		meal_type: MealType[];
		cuisine: Cuisine | null;
		protein: Protein | null;
		effort: Effort;
		damage: Damage;
	};
	damage_reasoning: string;
	extraction_warnings: string[];
};

/** A done generate job's result_json: exactly three candidates. */
export type GenerateResult = { candidates: RecipeDraft[] };

/** True when the draft's source body actually contains ingredient lines. */
export function hasRecipe(d: RecipeDraft): boolean {
	return d.body[d.body.source_units].ingredients.some((g) =>
		g.items.some((i) => i.trim() !== '')
	);
}

/**
 * Seed the review form from a done extraction: the body matching
 * source_units becomes the editable body, the other one rides along as the
 * known-good counterpart (ADR-019). If the user edits before saving, the form
 * drops the counterpart and the server reconverts instead.
 */
export function draftToInput(d: RecipeDraft): Partial<RecipeInput> {
	const body = d.body[d.body.source_units];
	const counterpart = d.body[otherUnits(d.body.source_units)];
	return {
		counterpart,
		title: d.title,
		yield_count: d.yield_count,
		yield_unit: d.yield_unit,
		prep_minutes: d.prep_minutes,
		cook_minutes: d.cook_minutes,
		source_text: d.source_text,
		source_units: d.body.source_units,
		meal_types: d.tags.meal_type,
		cuisine: d.tags.cuisine,
		protein: d.tags.protein,
		effort: d.tags.effort,
		damage: d.tags.damage,
		ingredients: body.ingredients,
		steps: body.steps
	};
}
