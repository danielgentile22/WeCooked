import {
	hasRecipe,
	parseDraft,
	type GenerateInput,
	type GenerateResult,
	type BodyPair,
	type RecipeDraft
} from '$lib/extract';
import { claudeCall } from './claude';
import {
	BODY_SCHEMA,
	CONVERSION_RULES,
	RECIPE_DRAFT_SCHEMA,
	RECIPE_RULES,
	RECIPE_SHAPE_RULES,
	fromReply,
	type ExtractReply
} from './extract';
import { JobError, type JobHandler } from './jobs';

// The generate call (issue #41): three candidate recipes from a description,
// in the extraction's shape and scored by the same rubric.

export const GENERATE_SYSTEM = `You write recipes for a private two-person recipe book, from a description of what the cook has and wants.

Rules:
- Propose exactly three recipes. They must differ from each other in main
  technique, cuisine, or protein, so comparing them is worth doing.
- Every recipe honours the description's constraints: the ingredients on
  hand, the time available, how much mess the cook will tolerate, and any
  diet.
- Write each recipe at exactly the requested yield. yield is a count plus a
  unit word; use "servings" unless another word fits better ("12 muffins").
- Give real quantities and complete steps a cook can follow without guessing.
- Write the recipe as written in metric (source_units "metric"), then convert
  it to US.
- Preserve ingredient section headings ("For the sauce") as groups when a
  recipe has parts. Otherwise return one group with a null heading.
- Produce the recipe in BOTH US and metric units. Follow the conversion rules.
${RECIPE_SHAPE_RULES}
- source_text is null. extraction_warnings is empty.

${CONVERSION_RULES}

${RECIPE_RULES}`;

/** What Claude answers a generation with: candidates with both bodies. */
export type GenerateReply = { candidates: (Omit<ExtractReply, 'body'> & { body: BodyPair })[] };

// Generation still writes both bodies in one call; extraction writes only the
// as-written one (issue #67).
const CANDIDATE_SCHEMA = {
	...RECIPE_DRAFT_SCHEMA,
	properties: {
		...RECIPE_DRAFT_SCHEMA.properties,
		body: {
			type: 'object',
			additionalProperties: false,
			properties: { source_units: { enum: ['us', 'metric'] }, us: BODY_SCHEMA, metric: BODY_SCHEMA },
			required: ['source_units', 'us', 'metric']
		}
	}
};

const GENERATE_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: { candidates: { type: 'array', items: CANDIDATE_SCHEMA } },
	required: ['candidates']
};

export const CANDIDATE_COUNT = 3;

/** Handler for the generate job kind: input_json is GenerateInput. */
export const generate: JobHandler = async (job, db) => {
	const { description, yield_count } = JSON.parse(job.input_json) as GenerateInput;
	const reply = await claudeCall<GenerateReply>(db, {
		system: GENERATE_SYSTEM,
		messages: [{ role: 'user', content: `Description: ${description}\nYield: ${yield_count}` }],
		schema: GENERATE_SCHEMA
	});
	const candidates: RecipeDraft[] = reply.candidates.map((c) => parseDraft(fromReply(c)));
	if (candidates.length !== CANDIDATE_COUNT || !candidates.every(hasRecipe))
		throw new JobError(
			'api_error',
			`Expected three recipes, got ${candidates.length} with ${candidates.filter(hasRecipe).length} usable.`
		);
	const result: GenerateResult = { candidates };
	return result;
};
