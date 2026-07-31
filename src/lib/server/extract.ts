import { MEAL_TYPES, CUISINES, PROTEINS, EFFORTS, DAMAGES } from '$lib/tags';
import { hasRecipe, type RecipeDraft } from '$lib/extract';
import type { Database } from 'better-sqlite3';
import { claudeCall } from './claude';
import { JobError, type JobHandler } from './jobs';

// The extract call (SPEC 5.4): one prompt for all three capture paths. This
// file ships the paste and URL paths; photos reuse EXTRACT_SYSTEM and the
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

/** Shared tail of every extract handler: one Claude call, then the gate. */
async function extract(db: Database, content: string): Promise<RecipeDraft> {
	const draft = await claudeCall<RecipeDraft>(db, {
		system: EXTRACT_SYSTEM,
		messages: [{ role: 'user', content }],
		schema: RECIPE_DRAFT_SCHEMA
	});
	if (!hasRecipe(draft)) throw new JobError('no_recipe_found');
	return draft;
}

/** Handler for the extract_paste job kind: input_json is { text }. */
export const extractPaste: JobHandler = (job, db) =>
	extract(db, (JSON.parse(job.input_json) as { text: string }).text);

// SPEC 7.1 URL path, steps 1-2: 10 s timeout, desktop UA, up to 5 redirects
// followed manually (native fetch allows 20). 403/401 is fetch_blocked and
// never retried or escalated (ADR-010); everything else broken is fetch_failed.
const DESKTOP_UA =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export async function fetchPage(url: string, fetchFn: typeof fetch = fetch): Promise<string> {
	// One 10 s deadline for the whole fetch, redirects included, not per hop.
	const signal = AbortSignal.timeout(10_000);
	let current = url;
	for (let hop = 0; hop <= 5; hop++) {
		let res: Response;
		try {
			res = await fetchFn(current, {
				headers: { 'user-agent': DESKTOP_UA },
				redirect: 'manual',
				signal
			});
		} catch (e) {
			throw new JobError('fetch_failed', e instanceof Error ? e.message : String(e));
		}
		if (res.status === 403 || res.status === 401) throw new JobError('fetch_blocked');
		if (res.status >= 300 && res.status < 400) {
			const loc = res.headers.get('location');
			if (!loc) throw new JobError('fetch_failed', `Redirect without Location from ${current}`);
			current = new URL(loc, current).href;
			continue;
		}
		if (!res.ok) throw new JobError('fetch_failed', `HTTP ${res.status} from ${current}`);
		return res.text();
	}
	throw new JobError('fetch_failed', `Too many redirects from ${url}`);
}

const isRecipeType = (d: unknown): boolean => {
	const t = (d as { '@type'?: unknown })?.['@type'];
	return t === 'Recipe' || (Array.isArray(t) && t.includes('Recipe'));
};

/** SPEC 7.1 step 3: first schema.org Recipe object, including inside @graph. */
export function findRecipeJsonLd(html: string): object | null {
	const re = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
	for (const [, block] of html.matchAll(re)) {
		let data: unknown;
		try {
			data = JSON.parse(block);
		} catch {
			continue; // real sites ship broken blocks; the stripped text still works
		}
		const nodes = [data].flat();
		const graphs = nodes.flatMap((d) => [(d as { '@graph'?: unknown })?.['@graph'] ?? []].flat());
		const recipe = [...nodes, ...graphs].find(isRecipeType);
		if (recipe) return recipe as object;
	}
	return null;
}

// ponytail: regex HTML stripping, swap in a real parser if a site defeats it.
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', nbsp: ' ' };

/** SPEC 7.1 step 4: 300 kB of blog HTML down to the readable text. */
export function stripHtml(html: string): string {
	return html
		.replace(/<!--[\s\S]*?-->/g, ' ')
		.replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
		.replace(/<(?:\/?(?:p|div|li|ul|ol|h[1-6]|tr|table|section|article|header|footer)\b[^>]*|br\s*\/?)>/gi, '\n')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) =>
			e[0] === '#'
				? String.fromCodePoint(parseInt(e.slice(e[1] === 'x' ? 2 : 1), e[1] === 'x' ? 16 : 10))
				: (ENTITIES[e.toLowerCase()] ?? m)
		)
		.replace(/[^\S\n]+/g, ' ')
		.replace(/\s*\n\s*/g, '\n')
		.trim();
}

// SPEC 5.4 user content, URL path: the JSON-LD preamble, verbatim.
const JSONLD_PREAMBLE =
	'Authoritative structured data from the page (schema.org Recipe JSON-LD), use these ingredients and steps verbatim: ';

/** Handler for the extract_url job kind: input_json is { url }. */
export const extractUrl: JobHandler = async (job, db) => {
	const { url } = JSON.parse(job.input_json) as { url: string };
	const html = await fetchPage(url);
	const jsonLd = findRecipeJsonLd(html);
	// ponytail: 100k-char cap so a pathological page cannot blow the context.
	let content = stripHtml(html).slice(0, 100_000);
	if (jsonLd) content += `\n\n${JSONLD_PREAMBLE}${JSON.stringify(jsonLd)}`;
	return extract(db, content);
};
