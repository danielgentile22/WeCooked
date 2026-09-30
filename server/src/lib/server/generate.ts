import { hasRecipe, type GenerateInput, type GenerateResult } from '$lib/extract';
import { claudeCall } from './claude';
import { RECIPE_DRAFT_SCHEMA, RECIPE_RULES, RECIPE_SHAPE_RULES } from './extract';
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
${RECIPE_SHAPE_RULES}
- source_text is null. extraction_warnings is empty.

${RECIPE_RULES}`;

const GENERATE_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: { candidates: { type: 'array', items: RECIPE_DRAFT_SCHEMA } },
	required: ['candidates']
};

/** Handler for the generate job kind: input_json is GenerateInput. */
export const generate: JobHandler = async (job, db) => {
	const { description, yield_count } = JSON.parse(job.input_json) as GenerateInput;
	const result = await claudeCall<GenerateResult>(db, {
		system: GENERATE_SYSTEM,
		messages: [{ role: 'user', content: `Description: ${description}\nYield: ${yield_count}` }],
		schema: GENERATE_SCHEMA
	});
	const { candidates } = result;
	if (candidates.length !== 3 || !candidates.every(hasRecipe))
		throw new JobError(
			'api_error',
			`Expected three recipes, got ${candidates.length} with ${candidates.filter(hasRecipe).length} usable.`
		);
	return result;
};
