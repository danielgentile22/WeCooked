import { hasRecipe, type GenerateInput, type GenerateResult, type RecipeDraft } from '$lib/extract';
import { CUISINES, PROTEINS } from '$lib/tags';
import { claudeCall } from './claude';
import { RECIPE_DRAFT_SCHEMA, RECIPE_RULES, RECIPE_SHAPE_RULES, fromReply, type ExtractReply } from './extract';
import { JobError, type JobHandler } from './jobs';

// The generate call (issues #41, #68): three candidate recipes from a
// description, in the extraction's shape and scored by the same rubric. Each
// candidate is its own parallel call, written in metric only, around an angle
// chosen here so the three stay different without seeing each other.

export const GENERATE_SYSTEM = `You write a recipe for a private two-person recipe book, from a description of what the cook has and wants.

Rules:
- Write exactly one recipe, built around the angle in the request. Two other
  recipes are being written from the same description with other angles, so
  lean into yours. If the angle conflicts with the description, the
  description wins; stay as close to the angle as it allows.
- The recipe honours the description's constraints: the ingredients on
  hand, the time available, how much mess the cook will tolerate, and any
  diet.
- Write the recipe at exactly the requested yield. yield is a count plus a
  unit word; use "servings" unless another word fits better ("12 muffins").
- Give real quantities and complete steps a cook can follow without guessing.
- Write the body in metric units only (source_units "metric"): grams,
  millilitres, °C, cm. Small amounts may be teaspoons and tablespoons.
- Preserve ingredient section headings ("For the sauce") as groups when the
  recipe has parts. Otherwise return one group with a null heading.
${RECIPE_SHAPE_RULES}
- source_text is null. extraction_warnings is empty.

${RECIPE_RULES}`;

/** One candidate's schema: the extraction's, with the body pinned to metric.
 *  The US body is the picked draft's conversion job (issue #68). */
const CANDIDATE_SCHEMA = {
	...RECIPE_DRAFT_SCHEMA,
	properties: {
		...RECIPE_DRAFT_SCHEMA.properties,
		body: {
			...RECIPE_DRAFT_SCHEMA.properties.body,
			properties: { ...RECIPE_DRAFT_SCHEMA.properties.body.properties, source_units: { enum: ['metric'] } }
		}
	}
};

export const CANDIDATE_COUNT = 3;

/** What an angle varies. One axis per generation, so the three candidates
 *  differ along the same line and compare cleanly. */
export type Axis = 'protein' | 'cuisine' | 'technique';
export type Angle = { axis: Axis; text: string };

const label = (tag: string) => tag.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

const AXES: Record<Axis, string[]> = {
	protein: PROTEINS.filter((p) => p !== 'none').map(
		(p) => `Main protein: ${p === 'beans' ? 'beans or pulses' : p === 'egg' ? 'eggs' : p}`
	),
	cuisine: CUISINES.map((c) => `Cuisine: ${label(c)}`),
	technique: [
		'roasted or baked in the oven',
		'braised or stewed in one pot',
		'stir-fried or wok-cooked',
		'grilled, griddled or seared hard',
		'simmered as a soup or curry',
		'raw, dressed or barely cooked',
		'fried crisp, shallow or in a pan',
		'steamed or poached',
		'baked into a gratin, pie or bake'
	].map((t) => `Technique: ${t}`)
};

// Words that show the description already settles an axis, so varying it
// would fight the cook. A diet settles protein.
const words = (list: string[]) => new RegExp(`\\b(?:${list.join('|')})s?\\b`, 'i');
const NAMES_PROTEIN = words([
	...PROTEINS.filter((p) => p !== 'none'),
	'eggs', 'turkey', 'duck', 'thigh', 'breast', 'drumstick', 'steak', 'mince', 'brisket',
	'bacon', 'ham', 'sausage', 'chorizo', 'mutton', 'salmon', 'cod', 'tuna', 'trout', 'haddock',
	'mackerel', 'prawn', 'shrimp', 'mussel', 'clam', 'squid', 'scallop', 'crab', 'lobster',
	'tempeh', 'lentil', 'chickpea', 'halloumi', 'feta', 'paneer', 'mozzarella', 'meat',
	'vegetarian', 'vegan', 'veggie', 'meat-free', 'meatless', 'plant-based', 'pescatarian'
]);
const NAMES_CUISINE = words([
	...CUISINES.map((c) => c.replace(/-/g, '[- ]?')),
	'asian', 'mediterranean', 'english', 'german', 'scandinavian', 'levantine', 'lebanese',
	'turkish', 'persian', 'moroccan', 'cajun', 'tex-mex', 'sichuan', 'cantonese'
]);

/** A small stable hash, so a description always gets the same angles and
 *  different descriptions start at different places in the lists. */
function hash(s: string): number {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
	return h >>> 0;
}

/** Three distinct angles for a description (issue #68): vary the main
 *  protein unless the description names one or a diet, else the cuisine
 *  unless it names one, else the technique. Values are spread across the
 *  list so neighbours (French, Spanish) are not chosen together. */
export function anglesFor(description: string): Angle[] {
	const axis: Axis = !NAMES_PROTEIN.test(description)
		? 'protein'
		: !NAMES_CUISINE.test(description)
			? 'cuisine'
			: 'technique';
	const pool = AXES[axis];
	const step = Math.floor(pool.length / CANDIDATE_COUNT);
	const start = hash(description.trim().toLowerCase()) % pool.length;
	return Array.from({ length: CANDIDATE_COUNT }, (_, i) => ({
		axis,
		text: pool[(start + i * step) % pool.length]
	}));
}

/** Handler for the generate job kind: input_json is GenerateInput. Three
 *  parallel calls; any one failing fails the job, and each counts against
 *  the daily cap. */
export const generate: JobHandler = async (job, db) => {
	const { description, yield_count } = JSON.parse(job.input_json) as GenerateInput;
	const candidates: RecipeDraft[] = await Promise.all(
		anglesFor(description).map(async (angle) =>
			fromReply(
				await claudeCall<ExtractReply>(db, {
					system: GENERATE_SYSTEM,
					messages: [
						{ role: 'user', content: `Description: ${description}\nYield: ${yield_count}\nAngle: ${angle.text}` }
					],
					schema: CANDIDATE_SCHEMA
				})
			)
		)
	);
	if (!candidates.every(hasRecipe))
		throw new JobError('api_error', `Expected three recipes, got ${candidates.filter(hasRecipe).length} usable.`);
	const result: GenerateResult = { candidates };
	return result;
};
