import { MEAL_TYPES, CUISINES, PROTEINS, EFFORTS, DAMAGES } from '$lib/tags';
import { hasRecipe, type CaptureInput, type RecipeDraft } from '$lib/extract';
import type { Database } from 'better-sqlite3';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages/messages';
import type { ErrorCode } from '$lib/jobs';
import { claudeCall } from './claude';
import { deriveClaude } from './images';
import { getObject } from './r2';
import { JobError, type JobHandler, type JobRow } from './jobs';

// The extract call (SPEC 5.4): one prompt for all three capture paths, with
// per-path user content.

export const BODY_SCHEMA = {
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

// SPEC 5.3: the conversion rules apply everywhere a body pair is produced,
// so extract and reconvert share them verbatim.
export const CONVERSION_RULES = `Conversion rules:
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

// SPEC 3.4 vocabulary and rubric + 5.3 conversion rules: everything that
// shapes a recipe, whether it was transcribed or generated (issue #41).
export const RECIPE_SHAPE_RULES = `- Ingredients stay as human-readable strings, exactly as a cook would read them.
- Produce the recipe in BOTH US and metric units. Follow the conversion rules.
- Assign tags ONLY from the fixed vocabulary below. Never invent a tag value.
  Leave cuisine or protein null if unsure. effort and damage are required.
- Score damage with the rubric below and show your arithmetic in
  damage_reasoning.`;

export const RECIPE_RULES = `Tag vocabulary:
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

${CONVERSION_RULES}`;

// SPEC 5.4 system prompt skeleton.
export const EXTRACT_SYSTEM = `You extract recipes into structured data for a private two-person recipe book.

Rules:
- Transcribe ingredients and steps faithfully. Do not improve, shorten, or
  modernise the recipe. Do not add ingredients that are not stated.
- Preserve ingredient section headings ("For the sauce") as groups. If the
  recipe has no sections, return one group with a null heading.
${RECIPE_SHAPE_RULES}
- If part of the source is unreadable, missing, or cut off, transcribe what you
  can and describe the gap in extraction_warnings. Never invent the missing
  part.
- If the input contains no recipe at all, return empty ingredients and steps
  and say what you found instead in extraction_warnings.
- yield is a count plus a unit word ("4 servings", "12 muffins"). Use
  "servings" when the source does not say.
- source_text is a short human citation ("Ottolenghi, Simple, p.112") when the
  source names one, else null.

${RECIPE_RULES}`;

/** Shared tail of every extract handler: one Claude call, then the gate.
 *  An empty extraction from photos means the page could not be read
 *  (SPEC 6.4: image_unreadable), not that no recipe exists. */
async function extract(
	db: Database,
	content: string | ContentBlockParam[],
	emptyCode: ErrorCode = 'no_recipe_found'
): Promise<RecipeDraft> {
	const draft = await claudeCall<RecipeDraft>(db, {
		system: EXTRACT_SYSTEM,
		messages: [{ role: 'user', content }],
		schema: RECIPE_DRAFT_SCHEMA
	});
	if (!hasRecipe(draft)) throw new JobError(emptyCode);
	return draft;
}

/** Handler for the extract_paste job kind: input_json is { text }. */
export const extractPaste: JobHandler = (job, db) =>
	extract(db, (JSON.parse(job.input_json) as { text: string }).text);

// SPEC 7.1 URL path, steps 3-4: 10 s timeout, desktop UA, up to 5 redirects
// followed manually (native fetch allows 20). 401, 402, 403 and 429 are
// fetch_blocked and never retried or escalated (ADR-010); publishers answer
// bots with all four. Everything else broken is fetch_failed.
const DESKTOP_UA =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// The pasted URL is untrusted: refuse anything that reaches the app's own
// network. Loopback, private ranges, link-local (169.254.*, cloud metadata),
// carrier-grade NAT and Fly's private network (fdaa::/16, inside fc00::/7).
// IPv4 rules also match IPv4-mapped IPv6 such as ::ffff:127.0.0.1.
const PRIVATE = new BlockList();
for (const [net, bits] of [
	['0.0.0.0', 8],
	['10.0.0.0', 8],
	['100.64.0.0', 10],
	['127.0.0.0', 8],
	['169.254.0.0', 16],
	['172.16.0.0', 12],
	['192.168.0.0', 16]
] as const)
	PRIVATE.addSubnet(net, bits, 'ipv4');
PRIVATE.addAddress('::', 'ipv6');
PRIVATE.addAddress('::1', 'ipv6');
PRIVATE.addSubnet('fc00::', 7, 'ipv6');
PRIVATE.addSubnet('fe80::', 10, 'ipv6');

// Fly's private DNS names (*.internal, *.flycast) and localhost never leave the box.
const PRIVATE_HOST = /(^|\.)(localhost|internal|flycast)$/;

const BLOCKED_STATUSES = [401, 402, 403, 429];

// Google's share.google redirects append a stray comma (seen: "?shem=aimgspe,").
// Parentheses stay: Wikipedia-style paths end in one.
const trimTrailingPunctuation = (url: string) => url.replace(/[,.;]+$/, '');

export type ResolveFn = (host: string) => Promise<string[]>;
const resolveAll: ResolveFn = async (host) =>
	(await lookup(host, { all: true })).map((a) => a.address);

/** Throws fetch_failed unless the URL is http(s) and every address its host resolves to is public. */
export async function assertPublicUrl(url: URL, resolve: ResolveFn = resolveAll): Promise<void> {
	if (url.protocol !== 'http:' && url.protocol !== 'https:')
		throw new JobError('fetch_failed', `Refusing ${url.protocol} URL`);
	const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
	if (PRIVATE_HOST.test(host)) throw new JobError('fetch_failed', `Refusing private host ${host}`);
	let addrs: string[];
	try {
		addrs = isIP(host) ? [host] : await resolve(host);
	} catch (e) {
		throw new JobError('fetch_failed', e instanceof Error ? e.message : String(e));
	}
	if (addrs.length === 0) throw new JobError('fetch_failed', `No address for ${host}`);
	for (const a of addrs)
		if (PRIVATE.check(a, isIP(a) === 6 ? 'ipv6' : 'ipv4'))
			throw new JobError('fetch_failed', `Refusing private address ${a} for ${host}`);
}

export async function fetchPage(
	url: string,
	fetchFn: typeof fetch = fetch,
	resolve: ResolveFn = resolveAll
): Promise<string> {
	// One 10 s deadline for the whole fetch, redirects included, not per hop.
	const signal = AbortSignal.timeout(10_000);
	let current = url;
	for (let hop = 0; hop <= 5; hop++) {
		// Every hop, not just the first: a public page can redirect inward.
		let target: URL;
		try {
			target = new URL(current);
		} catch {
			throw new JobError('fetch_failed', `Not a URL: ${current}`);
		}
		await assertPublicUrl(target, resolve);
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
		if (BLOCKED_STATUSES.includes(res.status)) throw new JobError('fetch_blocked');
		if (res.status >= 300 && res.status < 400) {
			const loc = res.headers.get('location');
			if (!loc) throw new JobError('fetch_failed', `Redirect without Location from ${current}`);
			current = trimTrailingPunctuation(new URL(loc, current).href);
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

/** SPEC 7.1 step 5: first schema.org Recipe object, including inside @graph. */
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

// HTML is stripped with regexes. Swap in a real parser if a site defeats them.
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', nbsp: ' ' };

const decodeEntities = (s: string) =>
	s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) => {
		if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
		const code = parseInt(e.slice(e[1] === 'x' ? 2 : 1), e[1] === 'x' ? 16 : 10);
		// fromCodePoint throws past U+10FFFF, and the HTML is untrusted.
		return code <= 0x10ffff ? String.fromCodePoint(code) : m;
	});

/** SPEC 7.1 step 6: 300 kB of blog HTML down to the readable text. */
export function stripHtml(html: string): string {
	return decodeEntities(
		html
			.replace(/<!--[\s\S]*?-->/g, ' ')
			.replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
			.replace(/<(?:\/?(?:p|div|li|ul|ol|h[1-6]|tr|table|section|article|header|footer)\b[^>]*|br\s*\/?)>/gi, '\n')
			.replace(/<[^>]+>/g, ' ')
	)
		.replace(/[^\S\n]+/g, ' ')
		.replace(/\s*\n\s*/g, '\n')
		.trim();
}

// SPEC 5.4 user content, URL path: the JSON-LD preamble, verbatim.
const JSONLD_PREAMBLE =
	'Authoritative structured data from the page (schema.org Recipe JSON-LD), use these ingredients and steps verbatim: ';

/** og:description, else name=description: a reel page's whole caption lives there. */
function metaDescription(html: string): string {
	const metas = [...html.matchAll(/<meta\b[^>]*>/gi)].map(([tag]) =>
		Object.fromEntries(
			[...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(([, k, dq, sq]) => [
				k.toLowerCase(),
				dq ?? sq
			])
		)
	);
	const content = (attr: string, value: string) =>
		decodeEntities(metas.find((m) => m[attr]?.toLowerCase() === value)?.content ?? '').trim();
	return content('property', 'og:description') || content('name', 'description');
}

/** The extract_url user content for a page's HTML (SPEC 5.4): the readable
 *  text, the page description, then the JSON-LD preamble. Runs on fetched
 *  HTML and, at ingest, on the HTML the phone rendered (issue #43). */
export function pageContent(html: string): string {
	const description = metaDescription(html);
	const jsonLd = findRecipeJsonLd(html);
	return [
		// Cap at 100k characters so a pathological page cannot blow the context.
		stripHtml(html).slice(0, 100_000),
		description && `Page description: ${description}`,
		jsonLd && `${JSONLD_PREAMBLE}${JSON.stringify(jsonLd)}`
	]
		.filter(Boolean)
		.join('\n\n');
}

// Issue #39: a reel page blocks fetchers or strips to a login wall, but the
// caption the cook pasted alongside the link still holds the recipe.
const FALLBACK_CODES: readonly ErrorCode[] = ['fetch_failed', 'fetch_blocked', 'no_recipe_found'];

/** Handler for the extract_url job kind: input_json is { url, page?, text? }.
 *  page is pageContent of the HTML the phone rendered; when present the
 *  server never fetches (issue #43). */
export const extractUrl = async (
	job: JobRow,
	db: Database,
	fetchPageFn: (url: string) => Promise<string> = fetchPage
): Promise<RecipeDraft> => {
	const { url, page, text } = JSON.parse(job.input_json) as CaptureInput & { url: string };
	try {
		return await extract(db, page ?? pageContent(await fetchPageFn(url)));
	} catch (e) {
		if (!text?.trim() || !(e instanceof JobError) || !FALLBACK_CODES.includes(e.code)) throw e;
		return extract(db, text);
	}
};

// SPEC 5.4 user content, photo path: image blocks in page order, then this
// instruction, verbatim.
export const PHOTOS_INSTRUCTION =
	'These images are pages of a printed cookbook, in order. They may be a two-page spread or a recipe continued on a later page. Treat them as one recipe.';

/** SPEC 5.8: base64 image blocks for Claude, one per capture, in input order. */
export function photoBlocks(claudeCopies: Buffer[]): ContentBlockParam[] {
	return [
		...claudeCopies.map(
			(buf): ContentBlockParam => ({
				type: 'image',
				source: { type: 'base64', media_type: 'image/jpeg', data: buf.toString('base64') }
			})
		),
		{ type: 'text', text: PHOTOS_INSTRUCTION }
	];
}

/** Handler for the extract_photos job kind: input_json is { image_ids }. */
export const extractPhotos: JobHandler = async (job, db) => {
	const { image_ids } = JSON.parse(job.input_json) as { image_ids: string[] };
	const rows = db
		.prepare(
			`SELECT id, r2_key_full FROM image
			 WHERE id IN (${image_ids.map(() => '?').join(',')}) AND deleted_at IS NULL`
		)
		.all(...image_ids) as { id: string; r2_key_full: string }[];
	const byId = new Map(rows.map((r) => [r.id, r.r2_key_full]));
	const keys = image_ids.map((id) => byId.get(id));
	if (image_ids.length === 0 || keys.some((k) => !k))
		throw new JobError('api_error', 'Capture images are missing.');
	const copies = await Promise.all(
		keys.map(async (key) => deriveClaude(await getObject(key!)))
	);
	return extract(db, photoBlocks(copies), 'image_unreadable');
};
