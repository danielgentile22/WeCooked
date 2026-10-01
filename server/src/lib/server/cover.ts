import type { Database } from 'better-sqlite3';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages/messages';
import { env } from '$env/dynamic/private';
import type { CaptureInput, CoverInput, CoverResult } from '$lib/extract';
import { claudeCall } from './claude';
import { draftOf, getDraftJob } from './drafts';
import { fetchPage, fetchPublic, pageImages, type ResolveFn } from './extract';
import { deriveThumb, normaliseFound, saveImage } from './images';
import { searchImages, type ImageHit } from './imagesearch';
import { JobError, createJob, type JobHandler } from './jobs';

// Recipe covers (issue #44, ADR-043): a follow-up job per draft that finds a
// photo of the dish, first on the source page, else by image search with
// Claude picking among the hits. A cover job never touches the draft's
// extraction; at most it writes cover_image_id into the draft's input_json.

/** Queue a cover job for a draft that has none yet. */
export function enqueueCover(db: Database, draftId: string): string | null {
	const job = getDraftJob(db, draftId);
	if (!job || (JSON.parse(job.input_json) as CaptureInput).cover_image_id) return null;
	return createJob(db, 'cover', { draft_id: draftId } satisfies CoverInput);
}

/** Wrap an extract handler so a successful extraction queues its cover. The
 *  runner writes result_json in the same microtask chain the handler returns
 *  on, before its next tick can claim the cover job, so the title is there. */
export const withCover =
	(handler: JobHandler): JobHandler =>
	async (job, db) => {
		const result = await handler(job, db);
		enqueueCover(db, job.id);
		return result;
	};

/** Each search-step cover is one Claude call against the daily cap (ADR-027),
 *  and cover jobs queue ahead of fresh captures, so a backfill goes in batches. */
export const BACKFILL_LIMIT = 20;

/** The saved recipes the backfill covers: live, coverless, with no cover job
 *  queued or running for them (directly, or through their draft) and none
 *  that already found one: a cover the cook removed is not put back. */
export function backfillCovers(db: Database, limit = BACKFILL_LIMIT): number {
	const ids = db
		.prepare(
			`SELECT r.id FROM recipe r
			 WHERE r.deleted_at IS NULL AND r.cover_image_id IS NULL
			   AND NOT EXISTS (
			     SELECT 1 FROM job c
			     WHERE c.kind = 'cover'
			       AND (c.status IN ('queued', 'running')
			            OR json_extract(c.result_json, '$.image_id') IS NOT NULL)
			       AND (json_extract(c.input_json, '$.recipe_id') = r.id
			            OR json_extract(c.input_json, '$.draft_id') IN (SELECT id FROM job WHERE recipe_id = r.id)))
			 ORDER BY r.created_at LIMIT ?`
		)
		.all(limit) as { id: string }[];
	for (const { id } of ids) createJob(db, 'cover', { recipe_id: id } satisfies CoverInput);
	return ids.length;
}

// Small enough to be an icon, a tracking pixel or a banner otherwise.
const MIN_LONG_EDGE = 500;
const MIN_SHORT_EDGE = 300;
const MAX_ASPECT = 2;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export const acceptable = (width: number, height: number) =>
	Math.max(width, height) >= MIN_LONG_EDGE &&
	Math.min(width, height) >= MIN_SHORT_EDGE &&
	Math.max(width, height) / Math.min(width, height) <= MAX_ASPECT;

async function readCapped(res: Response, max: number): Promise<Buffer | null> {
	const chunks: Uint8Array[] = [];
	let size = 0;
	for await (const chunk of res.body ?? []) {
		size += chunk.length;
		if (size > max) return null; // leaving the loop cancels the stream
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

/**
 * One candidate as a normalised full, or null when it is unreachable, not an
 * image, too big, or the wrong shape for a cover. Same SSRF rules and
 * redirect handling as a page fetch. Never throws: a dead candidate is normal.
 */
export async function fetchImage(
	url: string,
	fetchFn: typeof fetch = fetch,
	resolve?: ResolveFn
): Promise<Buffer | null> {
	try {
		const { res } = await fetchPublic(url, AbortSignal.timeout(10_000), fetchFn, resolve);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const type = res.headers.get('content-type') ?? '';
		if (!type.toLowerCase().startsWith('image/')) throw new Error(`not an image: ${type}`);
		const buf =
			Number(res.headers.get('content-length') ?? 0) > MAX_IMAGE_BYTES
				? null
				: await readCapped(res, MAX_IMAGE_BYTES);
		if (!buf) throw new Error('over 10 MB');
		const { data, info } = await normaliseFound(buf);
		if (!acceptable(info.width, info.height)) throw new Error(`${info.width}x${info.height} is not cover-shaped`);
		return data;
	} catch (e) {
		console.warn(`cover candidate ${url} skipped:`, e instanceof Error ? e.message : e);
		return null;
	}
}

const PICK_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: { pick: { type: 'integer' }, reason: { type: 'string' } },
	required: ['pick', 'reason']
};

const pickSystem = (title: string) =>
	`These are candidate cover photos for a recipe titled "${title}", numbered from 0. Pick the index of the one that is clearly a real photograph of this dish: not a person, a logo, a collage, a text graphic or a different dish. Answer -1 if none fits.`;

/** One Claude vision call over 512 px thumbs: the index of the dish photo, or -1. */
export async function claudePick(db: Database, title: string, thumbs: Buffer[]): Promise<number> {
	const content: ContentBlockParam[] = thumbs.flatMap((buf, i): ContentBlockParam[] => [
		{ type: 'text', text: `Candidate ${i}:` },
		{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: buf.toString('base64') } }
	]);
	const { pick } = await claudeCall<{ pick: number; reason: string }>(db, {
		// `||`: the .env.example line COVER_MODEL= is set but empty.
		model: env.COVER_MODEL || 'claude-sonnet-5-5',
		max_tokens: 200,
		system: pickSystem(title),
		messages: [{ role: 'user', content }],
		schema: PICK_SCHEMA
	});
	return pick;
}

export type CoverDeps = {
	fetchPage: (url: string) => Promise<string>;
	fetchImage: (url: string) => Promise<Buffer | null>;
	searchImages: (query: string) => Promise<ImageHit[]>;
	claudePick: (db: Database, title: string, thumbs: Buffer[]) => Promise<number>;
};

/** What the cover is for: title to search by, page to read, photos it named. */
type Target = { title: string | null; url: string | null; candidates: string[] };
type Found = { full: Buffer; source_url: string; origin: 'source' | 'search' };

const NONE: CoverResult = { image_id: null, origin: null };
const SEARCH_ATTEMPTS = 8;
const SEARCH_KEEP = 4;

function recipeTarget(db: Database, recipeId: string, capture: CaptureInput = {}): Target | null {
	const recipe = db
		.prepare(`SELECT title, source_url, cover_image_id FROM recipe WHERE id = ? AND deleted_at IS NULL`)
		.get(recipeId) as { title: string; source_url: string | null; cover_image_id: string | null } | undefined;
	if (!recipe || recipe.cover_image_id) return null;
	return {
		title: recipe.title,
		url: capture.url ?? recipe.source_url,
		candidates: capture.image_urls ?? []
	};
}

/** Null when there is nothing to do: the draft is gone, saved with a cover,
 *  or already has one; the recipe is trashed or already has one. */
function resolveTarget(db: Database, input: CoverInput): Target | null {
	if ('recipe_id' in input) return recipeTarget(db, input.recipe_id);
	const job = getDraftJob(db, input.draft_id);
	if (!job) return null;
	const capture = JSON.parse(job.input_json) as CaptureInput;
	if (capture.cover_image_id) return null;
	if (job.recipe_id) return recipeTarget(db, job.recipe_id, capture);
	return {
		title: draftOf(job)?.title ?? null,
		url: capture.url ?? null,
		candidates: capture.image_urls ?? []
	};
}

async function fromSource(deps: CoverDeps, target: Target): Promise<Found | null> {
	let candidates = target.candidates;
	if (candidates.length === 0 && target.url) {
		try {
			candidates = pageImages(await deps.fetchPage(target.url), target.url);
		} catch (e) {
			// Publishers block the server (ADR-010); the search step covers it.
			if (!(e instanceof JobError)) throw e;
		}
	}
	for (const url of candidates) {
		const full = await deps.fetchImage(url);
		if (full) return { full, source_url: url, origin: 'source' };
	}
	return null;
}

/** The image search query for a title. */
export const coverQuery = (title: string) => (/recipe/i.test(title) ? title : `${title} recipe`);

async function fromSearch(db: Database, deps: CoverDeps, title: string): Promise<Found | null> {
	const hits = await deps.searchImages(coverQuery(title));
	const kept: Found[] = [];
	for (const hit of hits.slice(0, SEARCH_ATTEMPTS)) {
		const full = await deps.fetchImage(hit.image_url);
		if (full) kept.push({ full, source_url: hit.image_url, origin: 'search' });
		if (kept.length === SEARCH_KEEP) break;
	}
	if (kept.length === 0) return null;
	const thumbs = await Promise.all(kept.map((k) => deriveThumb(k.full)));
	let pick: number;
	try {
		pick = await deps.claudePick(db, title, thumbs);
	} catch (e) {
		// Quota or API trouble: no cover, the same as a title nothing fits.
		console.warn('cover pick failed:', e instanceof Error ? e.message : e);
		pick = -1;
	}
	return kept[pick] ?? null;
}

/** Attach the stored image to whatever the target is now, re-read inside one
 *  transaction: the cook may have saved or discarded the draft meanwhile.
 *  Returns false, with the image soft-deleted, when nothing takes it. */
function attach(db: Database, input: CoverInput, imageId: string): boolean {
	const drop = (): false => {
		db.prepare(`UPDATE image SET deleted_at = ? WHERE id = ?`).run(new Date().toISOString(), imageId);
		return false;
	};
	return db.transaction(() => {
		let recipeId: string;
		if ('draft_id' in input) {
			const job = db.prepare(`SELECT recipe_id, input_json FROM job WHERE id = ?`).get(input.draft_id) as
				| { recipe_id: string | null; input_json: string }
				| undefined;
			if (!job) return drop();
			if (!job.recipe_id) {
				const draftInput = JSON.parse(job.input_json) as CaptureInput;
				if (draftInput.cover_image_id) return drop();
				db.prepare(`UPDATE job SET input_json = ? WHERE id = ?`).run(
					JSON.stringify({ ...draftInput, cover_image_id: imageId }),
					input.draft_id
				);
				return true;
			}
			recipeId = job.recipe_id;
		} else recipeId = input.recipe_id;
		const claimed = db
			.prepare(
				`UPDATE recipe SET cover_image_id = ? WHERE id = ? AND deleted_at IS NULL AND cover_image_id IS NULL`
			)
			.run(imageId, recipeId).changes;
		if (!claimed) return drop();
		db.prepare(`UPDATE image SET recipe_id = ? WHERE id = ?`).run(recipeId, imageId);
		return true;
	})();
}

export function coverHandler(deps: CoverDeps): JobHandler {
	return async (job, db): Promise<CoverResult> => {
		const input = JSON.parse(job.input_json) as CoverInput;
		const target = resolveTarget(db, input);
		if (!target) return NONE;
		const found =
			(await fromSource(deps, target)) ?? (target.title ? await fromSearch(db, deps, target.title) : null);
		if (!found) return NONE;
		const { id } = await saveImage(db, found.full, 'photo', { source_url: found.source_url });
		return attach(db, input, id) ? { image_id: id, origin: found.origin } : NONE;
	};
}

/** Handler for the cover job kind: input_json is CoverInput. */
export const cover = coverHandler({
	fetchPage: (url) => fetchPage(url),
	fetchImage: (url) => fetchImage(url),
	searchImages: (query) => searchImages(query),
	claudePick
});
