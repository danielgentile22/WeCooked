import { MEAL_TYPES, CUISINES, PROTEINS, EFFORTS, DAMAGES } from '$lib/tags';
import { hasRecipe, type AsWrittenBody, type CaptureInput, type RecipeDraft } from '$lib/extract';
import type { Database } from 'better-sqlite3';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages/messages';
import type { ErrorCode } from '$lib/jobs';
import { claudeCall } from './claude';
import { deriveClaude } from './images';
import { getObject } from './r2';
import { createJob, JobError, type JobHandler, type JobRow } from './jobs';

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
		// Issue #67: the as-written body only. The counterpart is the draft's
		// conversion job's work (enqueueDraftConversion).
		body: {
			type: 'object',
			additionalProperties: false,
			properties: {
				source_units: { enum: ['us', 'metric'] },
				...BODY_SCHEMA.properties
			},
			required: ['source_units', ...BODY_SCHEMA.required]
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

// SPEC 5.3: the conversion rules apply everywhere a body is converted, so
// reconvert, generate and scale share them verbatim.
export const CONVERSION_RULES = `Conversion rules:
1. Convert quantities ingredient-aware: a cup of flour is about 120 g, a cup
   of honey is about 340 g. Never apply a generic volume-to-weight ratio.
2. Convert inside step text too, not just the ingredient list.
3. Convert every temperature: oven, internal, oil, sugar. Round oven
   temperatures to real oven settings (375°F becomes 190°C, not 190.6°C) and
   other temperatures to the nearest whole degree.
4. Convert pan and tin sizes (9 inch becomes 23 cm).
5. Each body uses only its own units. When the source gives both, as in
   "225°F (110°C)" or "1 lb (450 g)", keep only the matching one: the US body
   says "225°F" and the metric body says "110°C". This overrides faithful
   transcription.
6. Convert nothing else: leave ingredient names, technique, and phrasing
   identical between the two bodies. The two versions must read as the same
   recipe.
7. Round to quantities a cook can measure. Prefer "1/3 cup" over "0.33 cups"
   and "500 g" over "497 g".`;

// SPEC 3.4 vocabulary and rubric: everything that shapes a recipe, whether it
// was transcribed or generated (issue #41). The conversion rules are not
// here: extraction writes one body (issue #67).
export const RECIPE_SHAPE_RULES = `- Ingredients stay as human-readable strings, exactly as a cook would read them.
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
is carnage.`;

// SPEC 5.4 system prompt skeleton.
export const EXTRACT_SYSTEM = `You extract recipes into structured data for a private two-person recipe book.

Rules:
- Transcribe ingredients and steps faithfully. Do not improve, shorten, or
  modernise the recipe. Do not add ingredients that are not stated.
- Preserve ingredient section headings ("For the sauce") as groups. If the
  recipe has no sections, return one group with a null heading.
- Write the body once, in the units the source uses, and name them in
  source_units. Convert nothing. When the source gives both, as in
  "225°F (110°C)" or "1 lb (450 g)", keep only the source_units one.
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

/** A draft's conversion job's input_json (issue #67): a reconvert keyed to
 *  the draft instead of a variation. The as-written body rides along because
 *  a draft's body never changes on the server; the cook's edits only reach
 *  it on save, which discards this job. */
export type DraftConversionInput = { draft_id: string; source: AsWrittenBody };

/** ADR-019 as amended by issue #67: the counterpart is queued the moment its
 *  source body exists. The job's result_json is the counterpart body. */
export function enqueueDraftConversion(db: Database, draftId: string, source: AsWrittenBody): string {
	const input: DraftConversionInput = { draft_id: draftId, source };
	return createJob(db, 'reconvert', input);
}

/** One Claude call, then the gate. An empty extraction from photos means the
 *  page could not be read (SPEC 6.4: image_unreadable), not that no recipe
 *  exists. */
async function extractOnce(
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

/** Shared tail of every extract handler: the draft, with its conversion queued. */
async function extracted(db: Database, job: JobRow, draft: Promise<RecipeDraft>): Promise<RecipeDraft> {
	const d = await draft;
	enqueueDraftConversion(db, job.id, d.body);
	return d;
}

/** Handler for the extract_paste job kind: input_json is { text }. */
export const extractPaste: JobHandler = (job, db) =>
	extracted(db, job, extractOnce(db, (JSON.parse(job.input_json) as { text: string }).text));

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

/** GET url with the desktop UA, following up to 5 redirects by hand and
 *  checking every hop is public. Returns the first non-redirect response. */
export async function fetchPublic(
	url: string,
	signal: AbortSignal,
	fetchFn: typeof fetch = fetch,
	resolve: ResolveFn = resolveAll
): Promise<{ res: Response; url: string }> {
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
		if (res.status >= 300 && res.status < 400) {
			const loc = res.headers.get('location');
			if (!loc) throw new JobError('fetch_failed', `Redirect without Location from ${current}`);
			current = trimTrailingPunctuation(new URL(loc, current).href);
			continue;
		}
		return { res, url: current };
	}
	throw new JobError('fetch_failed', `Too many redirects from ${url}`);
}

export async function fetchPage(
	url: string,
	fetchFn: typeof fetch = fetch,
	resolve: ResolveFn = resolveAll
): Promise<string> {
	// One 10 s deadline for the whole fetch, redirects included, not per hop.
	const { res, url: final } = await fetchPublic(url, AbortSignal.timeout(10_000), fetchFn, resolve);
	if (BLOCKED_STATUSES.includes(res.status)) throw new JobError('fetch_blocked');
	if (!res.ok) throw new JobError('fetch_failed', `HTTP ${res.status} from ${final}`);
	return res.text();
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

type MetaTag = Record<string, string | undefined>;

/** Every <meta> tag's attributes, names lowercased, values as written. */
function metaTags(html: string): MetaTag[] {
	return [...html.matchAll(/<meta\b[^>]*>/gi)].map(([tag]) =>
		Object.fromEntries(
			[...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(([, k, dq, sq]) => [
				k.toLowerCase(),
				dq ?? sq
			])
		)
	);
}

/** The decoded content of every meta tag whose attr is one of names, in page order. */
const metaContents = (metas: MetaTag[], attr: string, names: string[]) =>
	metas
		.filter((m) => names.includes(m[attr]?.toLowerCase() ?? ''))
		.map((m) => decodeEntities(m.content ?? '').trim())
		.filter(Boolean);

/** og:description, else name=description: a reel page's whole caption lives there. */
function metaDescription(html: string): string {
	const metas = metaTags(html);
	return (
		metaContents(metas, 'property', ['og:description'])[0] ??
		metaContents(metas, 'name', ['description'])[0] ??
		''
	);
}

const MAX_PAGE_IMAGES = 6;

/** schema.org image: a URL, an ImageObject, or an array of either. */
function jsonLdImages(image: unknown): string[] {
	if (typeof image === 'string') return [image];
	if (Array.isArray(image)) return image.flatMap(jsonLdImages);
	if (image && typeof image === 'object') {
		const { url, contentUrl } = image as { url?: unknown; contentUrl?: unknown };
		return jsonLdImages(url ?? contentUrl);
	}
	return [];
}

/** Issue #44: the page's own photos, best first. Recipe JSON-LD image, then
 *  og:image, then twitter:image. Relative URLs resolve against base when given;
 *  anything that is not absolute http(s) is dropped. */
export function pageImages(html: string, base?: string): string[] {
	const metas = metaTags(html);
	const recipe = findRecipeJsonLd(html) as { image?: unknown } | null;
	const raw = [
		...jsonLdImages(recipe?.image),
		...metaContents(metas, 'property', ['og:image']),
		...metaContents(metas, 'name', ['twitter:image', 'twitter:image:src'])
	];
	const urls = new Set<string>();
	for (const r of raw.map((r) => r.trim()).filter(Boolean)) {
		let url: URL;
		try {
			url = new URL(r, base);
		} catch {
			continue;
		}
		if (url.protocol === 'http:' || url.protocol === 'https:') urls.add(url.href);
		if (urls.size === MAX_PAGE_IMAGES) break;
	}
	return [...urls];
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
 *  server never fetches (issue #43). When the server does fetch, it reports
 *  the page's photos through onPageImages, or none if the fetch failed, so
 *  the cover job does not fetch the page a second time (issue #72). */
export const extractUrl = async (
	job: JobRow,
	db: Database,
	{
		fetchPage: fetchPageFn = fetchPage,
		onPageImages
	}: { fetchPage?: (url: string) => Promise<string>; onPageImages?: (urls: string[]) => void } = {}
): Promise<RecipeDraft> => {
	const { url, page, text } = JSON.parse(job.input_json) as CaptureInput & { url: string };
	const readPage = async () => {
		let html: string;
		try {
			html = await fetchPageFn(url);
		} catch (e) {
			onPageImages?.([]);
			throw e;
		}
		onPageImages?.(pageImages(html, url));
		return pageContent(html);
	};
	const draft = async () => {
		try {
			return await extractOnce(db, page ?? (await readPage()));
		} catch (e) {
			if (!text?.trim() || !(e instanceof JobError) || !FALLBACK_CODES.includes(e.code)) throw e;
			return extractOnce(db, text);
		}
	};
	return extracted(db, job, draft());
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
			`SELECT id, r2_key_full, r2_key_claude FROM image
			 WHERE id IN (${image_ids.map(() => '?').join(',')}) AND deleted_at IS NULL`
		)
		.all(...image_ids) as { id: string; r2_key_full: string; r2_key_claude: string | null }[];
	const byId = new Map(rows.map((r) => [r.id, r]));
	const images = image_ids.map((id) => byId.get(id));
	if (image_ids.length === 0 || images.some((i) => !i))
		throw new JobError('api_error', 'Capture images are missing.');
	// Issue #71: the copy was built at upload. A capture uploaded before that
	// has none, so derive it from the full as before.
	const copies = await Promise.all(
		images.map(async (i) =>
			i!.r2_key_claude ? getObject(i!.r2_key_claude) : deriveClaude(await getObject(i!.r2_key_full))
		)
	);
	return extracted(db, job, extractOnce(db, photoBlocks(copies), 'image_unreadable'));
};
