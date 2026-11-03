// RecipeDraft: the extract job's result_json shape (SPEC 5.4, issue #67), and the
// mapping that seeds the review form from it. Shared so the drafts page
// (client) never has to import server code for types.

import { otherUnits } from '$lib/tags';
import type {
	BodyText,
	IngredientGroup,
	MealType,
	UnitSystem,
	Cuisine,
	Protein,
	Effort,
	Damage,
	RecipeInput
} from '$lib/tags';

/** A capture job's input_json: pasted text, a url, or image ids. page is the
 *  reduced content of the HTML the phone rendered for url (issue #43).
 *  image_urls are that page's own photos, best first; cover_image_id is the
 *  cover the cover job found (issue #44). */
export type CaptureInput = {
	text?: string;
	url?: string;
	page?: string;
	image_ids?: string[];
	image_urls?: string[];
	cover_image_id?: string;
};

/** A generate job's input_json (issue #41). picked stays null until the cook
 *  picks a candidate; it is what turns the generation into a draft. */
export type GenerateInput = {
	description: string;
	yield_count: number;
	picked: number | null;
	cover_image_id?: string;
};

/** What a cover job is for (issue #44): a draft-kind job id, or a saved recipe. */
export type CoverTarget = { draft_id: string } | { recipe_id: string };

/** A cover job's input_json. replace is "Find another photo": it searches
 *  past the found cover, skipping exclude (image URLs already tried). */
export type CoverInput = CoverTarget & { replace?: true; exclude?: string[] };

/** A done cover job's result_json. source_url is where the image came from. */
export type CoverResult = {
	image_id: string | null;
	origin: 'source' | 'search' | null;
	source_url: string | null;
};

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

/** A draft's as-written body: the recipe in the units its source uses
 *  (issue #67). This is all an extraction asks Claude for. */
export type AsWrittenBody = BodyText & { source_units: UnitSystem };

/** Both bodies from one call: how generation still writes, and how every
 *  draft was stored before issue #67. */
export type BodyPair = {
	source_units: UnitSystem;
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
	body: AsWrittenBody;
	/** The counterpart, only when the same call wrote it (a generation, or a
	 *  draft stored before issue #67). Otherwise the draft's conversion job
	 *  writes it, and DraftView.counterpart_state reports where that is. */
	counterpart?: BodyText;
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

/** A recipe draft whose body may be a BodyPair. */
export type StoredDraft = Omit<RecipeDraft, 'body'> & { body: AsWrittenBody | BodyPair };

/** Splits a BodyPair into the as-written body and its counterpart. Drafts
 *  stored before issue #67 and generation candidates come in this shape. */
export function parseDraft(d: StoredDraft): RecipeDraft {
	const pair = d.body as Partial<BodyPair> | undefined;
	if (!pair?.us || !pair.metric) return d as RecipeDraft;
	const { source_units } = d.body;
	const both = d.body as BodyPair;
	return {
		...d,
		body: { source_units, ...both[source_units] },
		counterpart: both[otherUnits(source_units)]
	};
}

/** A done generate job's result_json: exactly three candidates. */
export type GenerateResult = { candidates: RecipeDraft[] };

/** True when the draft's source body actually contains ingredient lines. */
export function hasRecipe(d: RecipeDraft): boolean {
	return d.body.ingredients.some((g) =>
		g.items.some((i) => i.trim() !== '')
	);
}

/**
 * Seed the review form from a done extraction: the as-written body becomes
 * the editable body, and the counterpart, once there is one, rides along as
 * known-good (ADR-019). If the user edits before saving, the form drops the
 * counterpart and the server reconverts instead.
 */
export function draftToInput(
	d: RecipeDraft,
	counterpart: BodyText | null = d.counterpart ?? null
): Partial<RecipeInput> {
	const { source_units, ...body } = d.body;
	return {
		counterpart,
		title: d.title,
		yield_count: d.yield_count,
		yield_unit: d.yield_unit,
		prep_minutes: d.prep_minutes,
		cook_minutes: d.cook_minutes,
		source_text: d.source_text,
		source_units,
		meal_types: d.tags.meal_type,
		cuisine: d.tags.cuisine,
		protein: d.tags.protein,
		effort: d.tags.effort,
		damage: d.tags.damage,
		ingredients: body.ingredients,
		steps: body.steps
	};
}
