import { MEAL_TYPES, CUISINES, PROTEINS, EFFORTS, DAMAGES } from '$lib/tags';
import { hasRecipe, type RecipeDraft } from '$lib/extract';
import { claudeCall } from './claude';
import { JobError, type JobHandler } from './jobs';

// The extract call (SPEC 5.4): one prompt for all three capture paths. This
// file ships the paste path; URL and photos reuse EXTRACT_SYSTEM and the
// schema with different user content.

const BODY_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		ingredients: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				properties: {
					heading: { type: ['string', 'null'] },
					items: { type: 'array', items: { type: 'string' } }
				},
				required: ['heading', 'items']
			}
		},
		steps: { type: 'array', items: { type: 'string' } }
	},
	required: ['ingredients', 'steps']
};

export const RECIPE_DRAFT_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		title: { type: 'string' },
		yield_count: { type: 'number' },
		yield_unit: { type: 'string' },
		prep_minutes: { type: ['integer', 'null'] },
		cook_minutes: { type: ['integer', 'null'] },
		source_text: { type: ['string', 'null'] },
		body: {
			type: 'object',
			additionalProperties: false,
			properties: {
				source_units: { enum: ['us', 'metric'] },
				us: BODY_SCHEMA,
				metric: BODY_SCHEMA
			},
			required: ['source_units', 'us', 'metric']
		},
		tags: {
			type: 'object',
			additionalProperties: false,
			properties: {
				meal_type: { type: 'array', items: { enum: [...MEAL_TYPES] } },
				cuisine: { enum: [...CUISINES, null] },
				protein: { enum: [...PROTEINS, null] },
				effort: { enum: [...EFFORTS] },
				damage: { enum: [...DAMAGES] }
			},
			required: ['meal_type', 'cuisine', 'protein', 'effort', 'damage']
		},
		damage_reasoning: { type: 'string' },
		extraction_warnings: { type: 'array', items: { type: 'string' } }
	},
	required: [
		'title',
		'yield_count',
		'yield_unit',
		'prep_minutes',
		'cook_minutes',
		'source_text',
		'body',
		'tags',
		'damage_reasoning',
		'extraction_warnings'
	]
};

// SPEC 5.4 system prompt skeleton + 3.4 vocabulary and rubric + 5.3
// conversion rules.
export const EXTRACT_SYSTEM = `You extract recipes into structured data for a private two-person recipe book.

Rules:
- Transcribe ingredients and steps faithfully. Do not improve, shorten, or
  modernise the recipe. Do not add ingredients that are not stated.
- Preserve ingredient section headings ("For the sauce") as groups. If the
  recipe has no sections, return one group with a null heading.
- Ingredients stay as human-readable strings, exactly as a cook would read them.
- Produce the recipe in BOTH US and metric units. Follow the conversion rules.
- Assign tags ONLY from the fixed vocabulary below. Never invent a tag value.
  Leave cuisine or protein null if unsure. effort and damage are required.
- Score damage with the rubric below and show your arithmetic in
  damage_reasoning.
- If part of the source is unreadable, missing, or cut off, transcribe what you
  can and describe the gap in extraction_warnings. Never invent the missing
  part.
- If the input contains no recipe at all, return empty ingredients and steps
  and say what you found instead in extraction_warnings.
- yield is a count plus a unit word ("4 servings", "12 muffins"). Use
  "servings" when the source does not say.
- source_text is a short human citation ("Ottolenghi, Simple, p.112") when the
  source names one, else null.

Tag vocabulary:
- meal_type (zero or more): ${MEAL_TYPES.join(', ')}
- cuisine (at most one): ${CUISINES.join(', ')}
- protein (at most one): ${PROTEINS.join(', ')}
- effort (exactly one): quick (under 30 minutes total), weeknight (30 to 60),
  project (over 60, or overnight rests, or proving)
- damage (exactly one): tidy, messy, carnage

Damage rubric. Count the things that need washing:
- Each pot, pan, baking tray, or mixing bowl: 1 point
- Board and knife together: 1 point
- Blender, food processor, or stand mixer: 2 points
- Deep or shallow frying in oil: +2
- Flour, dough, breading, anything dusted: +1
- More than one heat source running at once: +1
Plates and cutlery you eat off do not count. Anything rinsed and reused
mid-recipe does not count. Total 0 to 2 is tidy, 3 to 5 is messy, 6 or more
is carnage.

Conversion rules:
1. Convert quantities ingredient-aware: a cup of flour is about 120 g, a cup
   of honey is about 340 g. Never apply a generic volume-to-weight ratio.
2. Convert inside step text too, not just the ingredient list.
3. Convert oven temperatures, rounding to real oven settings (375°F becomes
   190°C, not 190.6°C).
4. Convert pan and tin sizes (9 inch becomes 23 cm).
5. Convert nothing else: leave ingredient names, technique, and phrasing
   identical between the two bodies. The two versions must read as the same
   recipe.
6. Round to quantities a cook can measure. Prefer "1/3 cup" over "0.33 cups"
   and "500 g" over "497 g".`;

/** Handler for the extract_paste job kind: input_json is { text }. */
export const extractPaste: JobHandler = async (job, db) => {
	const { text } = JSON.parse(job.input_json) as { text: string };
	const draft = await claudeCall<RecipeDraft>(db, {
		system: EXTRACT_SYSTEM,
		messages: [{ role: 'user', content: text }],
		schema: RECIPE_DRAFT_SCHEMA
	});
	if (!hasRecipe(draft)) throw new JobError('no_recipe_found');
	return draft;
};
