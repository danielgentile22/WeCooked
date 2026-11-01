// The recipe form's payload rule, out of RecipeForm.svelte so it can be unit
// tested against the same cases as iOS's EditorPayloadTests ("Payload rule
// matches the web app exactly" in PARITY.md).
import type { FormImage } from './images';
import { cleanBody, otherUnits, type BodyText, type RecipeInput, type UnitSystem } from './tags';

// Effort and damage start unselected: they are required, scored choices
// (SPEC 3.4), and a pre-picked default would ship wrong without the
// required-ness ever surfacing. The server rejects a null.
export type FormState = Omit<RecipeInput, 'effort' | 'damage' | 'image_ids' | 'counterpart'> & {
	effort: RecipeInput['effort'] | null;
	damage: RecipeInput['damage'] | null;
	images: FormImage[]; // ids + presigned display URLs; ids go in the payload
	shown_units: UnitSystem; // which body ingredients/steps display
	other: BodyText | null; // the body not being shown (SPEC 7.2 field 6)
};

/** Shows the other body, keeping typed work in the hidden one (SPEC 7.2). */
export function swapBodies(s: FormState, u: UnitSystem): void {
	const current = { ingredients: s.ingredients, steps: s.steps };
	s.ingredients = s.other!.ingredients;
	s.steps = s.other!.steps;
	s.other = current;
	s.shown_units = u;
}

/** What the server holds right now, for edited-body detection at submit:
 *  whichever body diverges from this is the one the human authored. */
export type LoadedBodies = { source_units: UnitSystem; source: string; other: string | null };

export function loadedBodies(loaded: FormState): LoadedBodies {
	return {
		source_units: loaded.source_units,
		source: JSON.stringify(cleanBody({ ingredients: loaded.ingredients, steps: loaded.steps })),
		other: loaded.other ? JSON.stringify(cleanBody(loaded.other)) : null
	};
}

/**
 * Which body is submitted, in which units, and whether the other rides
 * along (SPEC 7.2, ADR-028). The submitted body is the one the human
 * edited, and source_units names it; the counterpart rides along only
 * while it is known-good (nothing changed), else it is null and the server
 * queues a reconvert. If both bodies were edited, the visible one wins as
 * "last authored". The server re-diffs, so a false positive here cannot
 * move is_source.
 */
export function selection(
	draft: FormState,
	loaded: LoadedBodies,
	editing: boolean
): { source_units: UnitSystem; body: BodyText; counterpart: BodyText | null } {
	const shown: BodyText = { ingredients: draft.ingredients, steps: draft.steps };
	if (!editing) return { source_units: draft.source_units, body: shown, counterpart: null };
	const bodyFor = (u: UnitSystem) => (u === draft.shown_units ? shown : draft.other);
	const src = bodyFor(loaded.source_units)!;
	const oth = bodyFor(otherUnits(loaded.source_units));
	const srcChanged = JSON.stringify(cleanBody(src)) !== loaded.source;
	const othChanged =
		oth !== null && loaded.other !== null && JSON.stringify(cleanBody(oth)) !== loaded.other;
	if (srcChanged && othChanged)
		return { source_units: draft.shown_units, body: shown, counterpart: null };
	if (othChanged)
		return { source_units: otherUnits(loaded.source_units), body: oth!, counterpart: null };
	return { source_units: loaded.source_units, body: src, counterpart: srcChanged ? null : oth };
}

/** The submitted body, in the shape the save action parses. Effort and
 *  damage may still be null; the form's checks and the server refuse that. */
export function payload(draft: FormState, loaded: LoadedBodies, editing: boolean) {
	const { other, shown_units, images, ...rest } = draft;
	const sel = selection(draft, loaded, editing);
	return {
		...rest,
		source_units: sel.source_units,
		ingredients: sel.body.ingredients,
		steps: sel.body.steps,
		counterpart: sel.counterpart,
		image_ids: images.map((i) => i.id)
	};
}
