import { ApiError, guard, type ApiRequest, type Route } from './dispatch';
import { attemptLogin } from '../login';
import { issueSessionToken } from '../session';
import { browseView, recipeView, shoppingView } from '../views';
import {
	createRecipe,
	deleteRecipe,
	deleteVariation,
	listTrash,
	restoreRecipe,
	restoreVariation,
	retryReconvert,
	updateRecipe
} from '../recipes';
import { keepMine, recalcVariation, requestScale, retryScale } from '../scale';
import { createJob, getJobPoll } from '../jobs';
import {
	discardDraft,
	draftView,
	getDraftJob,
	getGenerationJob,
	pickCandidate,
	retryDraft,
	saveDraft
} from '../drafts';
import {
	SECTION_ORDER,
	addManual,
	doneShopping,
	getListId,
	requestBuild,
	retryBuild,
	setTicked
} from '../shopping';
import { saveImage } from '../images';
import { PUSH_ENVIRONMENTS, registerDevice, type PushEnvironment } from '../devices';
import { BACKFILL_LIMIT, backfillCovers, findDraftCover, findRecipeCover } from '../cover';
import { pageContent, pageImages } from '../extract';
import { asUrl, type CaptureInput, type GenerateInput } from '$lib/extract';
import { ERROR_COPY } from '$lib/jobs';
import { CUISINES, DAMAGES, EFFORTS, MEAL_TYPES, PROTEINS, type RecipeInput } from '$lib/tags';
import type { Database } from 'better-sqlite3';

// The JSON API for the native client (docs/port/PLAN.md, unit 1). Each
// route mirrors a web load or form action and calls the same $lib/server
// function, with the same messages and status codes. The endpoint table
// lives in src/routes/api/v1/README.md.

type Fields = Record<string, unknown>;
const isFields = (v: unknown): v is Fields =>
	typeof v === 'object' && v !== null && !Array.isArray(v);
const bad = (message: string) => new ApiError(400, message);
const OK = { ok: true } as const;

/** A required JSON object body. */
async function body(req: ApiRequest): Promise<Fields> {
	const b = await req.json();
	if (!isFields(b)) throw bad('Malformed JSON.');
	return b;
}

/** An optional JSON object body: empty means {}. */
async function optionalBody(req: ApiRequest): Promise<Fields> {
	const b = await req.json();
	if (b === undefined) return {};
	if (!isFields(b)) throw bad('Malformed JSON.');
	return b;
}

const optionalId = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

function draftJob(db: Database, id: string) {
	const job = getDraftJob(db, id);
	if (!job) throw new ApiError(404, 'No such draft.');
	return job;
}

// Issue #42: every capture and generation remembers the phone that queued it.
async function capture(db: Database, b: Fields, device_id?: string): Promise<{ job_id: string }> {
	const refs = { device_id };
	if ('image_ids' in b && 'url' in b) throw bad('Share one thing at a time: a link, text or photos.');
	if ('image_ids' in b) {
		// SPEC 7.1 photo path: images are already uploaded via POST /images?role=capture.
		const ids = b.image_ids;
		if (!Array.isArray(ids) || ids.length === 0 || ids.some((i) => typeof i !== 'string'))
			throw bad('Add at least one photo first.');
		if (ids.length > 10) throw bad('At most 10 pages per recipe.');
		return { job_id: createJob(db, 'extract_photos', { image_ids: ids }, refs) };
	}
	if ('url' in b) {
		// Issue #39 share sheet: the link is the source; text is a caption to fall back on.
		const url = typeof b.url === 'string' ? asUrl(b.url.trim()) : null;
		if (!url) throw bad('That is not a link. Share a web page instead.');
		const html = b.html ?? '';
		if (typeof html !== 'string') throw bad('Malformed submission.');
		// Issue #43: the phone's rendered HTML (up to 4 MB) is reduced here,
		// so the job row stays small and a retry re-extracts from the stored page.
		// A page that reduces to nothing counts as absent, so the server still fetches.
		const page = (html && pageContent(html)) || undefined;
		const text = String(b.text ?? '').trim() || undefined;
		// Issue #44: the page's own photos, candidates for the cover job.
		const found = html ? pageImages(html, url) : [];
		const input: CaptureInput = { url, page, text, image_urls: found.length ? found : undefined };
		return { job_id: createJob(db, 'extract_url', input, refs) };
	}
	const text = String(b.text ?? '').trim();
	if (!text) throw bad('Paste some recipe text first.');
	const url = asUrl(text);
	return {
		job_id: url
			? createJob(db, 'extract_url', { url }, refs)
			: createJob(db, 'extract_paste', { text }, refs)
	};
}

// Issue #41: the cook sets the yield up front, so quantities come out right
// without a rescale.
function startGeneration(db: Database, b: Fields, device_id?: string): { job_id: string } {
	const description = typeof b.description === 'string' ? b.description.trim() : '';
	if (!description || description.length > 1000) throw bad('Describe what you want to cook.');
	const count = b.yield_count;
	if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 100)
		throw bad('Yield must be a whole number from 1 to 100.');
	const input: GenerateInput = { description, yield_count: count, picked: null };
	return { job_id: createJob(db, 'generate', input, { device_id }) };
}

// Issue #42: the app posts its APNs token after the cook allows notifications.
function device(b: Fields) {
	const device_id = typeof b.device_id === 'string' ? b.device_id.trim() : '';
	if (!device_id || device_id.length > 64) throw bad('Missing device id.');
	const push_token = typeof b.push_token === 'string' ? b.push_token.trim().toLowerCase() : '';
	if (!/^[0-9a-f]{64,200}$/.test(push_token)) throw bad('That push token is not valid.');
	const environment = b.environment as PushEnvironment;
	if (!PUSH_ENVIRONMENTS.includes(environment)) throw bad('Environment must be sandbox or production.');
	return { device_id, push_token, environment };
}

function picks(v: unknown): { recipe_id: string; yield_count: unknown }[] {
	if (!Array.isArray(v) || !v.every((p) => isFields(p) && typeof p.recipe_id === 'string'))
		throw bad('Malformed submission.');
	return v as { recipe_id: string; yield_count: unknown }[];
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export const routes: readonly Route[] = [
	// The login token is the session cookie value; send it as a bearer token.
	{
		method: 'POST',
		path: '/login',
		run: async (_db, req) => {
			const result = await attemptLogin(req.ip, (await body(req)).password);
			if (!result.ok) throw new ApiError(result.status, result.error);
			return { token: issueSessionToken(Date.now()) };
		}
	},
	{ method: 'GET', path: '/session', run: () => OK },
	{
		method: 'GET',
		path: '/tags',
		run: () => ({
			meal_types: MEAL_TYPES,
			cuisines: CUISINES,
			proteins: PROTEINS,
			efforts: EFFORTS,
			damages: DAMAGES,
			section_order: SECTION_ORDER,
			error_copy: ERROR_COPY
		})
	},

	{ method: 'GET', path: '/recipes', run: (db, req) => browseView(db, req.query) },
	{
		method: 'POST',
		path: '/recipes',
		run: async (db, req) => {
			const input = (await body(req)) as RecipeInput;
			return { id: guard(() => createRecipe(db, input)) };
		}
	},
	{
		method: 'GET',
		path: '/recipes/:id',
		run: (db, req) => {
			const view = recipeView(db, req.params.id, req.query.get('v') ?? undefined);
			if (!view) throw new ApiError(404, 'Recipe not found');
			return view;
		}
	},
	{
		method: 'PUT',
		path: '/recipes/:id',
		run: async (db, req) => {
			const b = await body(req);
			if (!isFields(b.payload)) throw bad('Malformed submission.');
			const payload = b.payload as RecipeInput;
			const variationId = optionalId(b.variation_id);
			guard(() => updateRecipe(db, req.params.id, payload, variationId));
			return { id: req.params.id, variation_id: variationId ?? null };
		}
	},
	{
		method: 'DELETE',
		path: '/recipes/:id',
		run: (db, req) => {
			deleteRecipe(db, req.params.id);
			return OK;
		}
	},
	{
		method: 'POST',
		path: '/recipes/:id/calculate',
		run: async (db, req) => {
			const toCount = (await body(req)).to_count;
			return guard(() => requestScale(db, req.params.id, toCount));
		}
	},
	{
		method: 'POST',
		path: '/recipes/:id/retry-reconvert',
		run: async (db, req) => {
			const variationId = optionalId((await optionalBody(req)).variation_id);
			guard(() => retryReconvert(db, req.params.id, variationId));
			return OK;
		}
	},
	// Issue #44 "Find another photo": a cover job past the found cover.
	{
		method: 'POST',
		path: '/recipes/:id/cover',
		run: (db, req) => {
			const jobId = guard(() => findRecipeCover(db, req.params.id));
			if (!jobId) throw new ApiError(404, 'Recipe not found');
			return { job_id: jobId };
		}
	},

	{
		method: 'POST',
		path: '/variations/:id/retry-scale',
		run: (db, req) => ({ job_id: guard(() => retryScale(db, req.params.id)) })
	},
	{
		method: 'POST',
		path: '/variations/:id/recalculate',
		run: (db, req) => ({ job_id: guard(() => recalcVariation(db, req.params.id)) })
	},
	{
		method: 'POST',
		path: '/variations/:id/keep-mine',
		run: (db, req) => {
			keepMine(db, req.params.id);
			return OK;
		}
	},
	{
		method: 'DELETE',
		path: '/variations/:id',
		run: (db, req) => {
			guard(() => deleteVariation(db, req.params.id));
			return OK;
		}
	},

	{ method: 'POST', path: '/captures', run: async (db, req) => capture(db, await body(req), req.deviceId) },
	{
		method: 'GET',
		path: '/drafts/:id',
		run: (db, req) => {
			const job = draftJob(db, req.params.id);
			return job.recipe_id ? { recipe_id: job.recipe_id } : draftView(db, job);
		}
	},
	{
		method: 'POST',
		path: '/drafts/:id/save',
		run: async (db, req) => {
			const job = draftJob(db, req.params.id);
			if (job.recipe_id) return { recipe_id: job.recipe_id };
			const input = (await body(req)) as RecipeInput;
			return { recipe_id: guard(() => saveDraft(db, job, input)) };
		}
	},
	{
		method: 'POST',
		path: '/drafts/:id/discard',
		run: (db, req) => {
			const job = draftJob(db, req.params.id);
			guard(() => discardDraft(db, job));
			return OK;
		}
	},
	{
		method: 'POST',
		path: '/generations',
		run: async (db, req) => startGeneration(db, await body(req), req.deviceId)
	},
	{
		method: 'POST',
		path: '/drafts/:id/pick',
		run: async (db, req) => {
			const job = getGenerationJob(db, req.params.id);
			if (!job) throw new ApiError(404, 'No such generation.');
			const { index } = await body(req);
			guard(() => pickCandidate(db, job, index));
			return OK;
		}
	},
	{
		method: 'POST',
		path: '/drafts/:id/retry',
		run: (db, req) => {
			retryDraft(db, draftJob(db, req.params.id));
			return OK;
		}
	},
	{
		method: 'POST',
		path: '/drafts/:id/cover',
		run: (db, req) => {
			const job = draftJob(db, req.params.id);
			return { job_id: guard(() => findDraftCover(db, job)) };
		}
	},

	// Issue #44: one cover job per saved recipe that has no cover.
	{
		method: 'POST',
		path: '/covers/backfill',
		run: (db, req) => {
			const limit = Number(req.query.get('limit') ?? BACKFILL_LIMIT);
			if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw bad('limit must be 1 to 200.');
			return { queued: backfillCovers(db, limit) };
		}
	},

	{
		method: 'POST',
		path: '/devices',
		run: async (db, req) => {
			registerDevice(db, device(await body(req)));
			return OK;
		}
	},

	{ method: 'GET', path: '/shopping', run: (db) => shoppingView(db) },
	{
		method: 'POST',
		path: '/shopping/build',
		run: async (db, req) => {
			const p = picks((await body(req)).picks);
			return guard(() => requestBuild(db, p));
		}
	},
	{ method: 'POST', path: '/shopping/retry', run: (db) => retryBuild(db, getListId(db)) },
	{
		method: 'POST',
		path: '/shopping/manual',
		run: async (db, req) => {
			const text = (await body(req)).text;
			guard(() => addManual(db, typeof text === 'string' ? text : ''));
			return OK;
		}
	},
	{
		method: 'POST',
		path: '/shopping/done',
		run: (db) => {
			doneShopping(db);
			return OK;
		}
	},
	{
		method: 'PATCH',
		path: '/shopping/items/:id',
		run: async (db, req) => {
			setTicked(db, req.params.id, !!(await body(req)).ticked);
			return OK;
		}
	},

	{ method: 'GET', path: '/trash', run: (db) => ({ trash: listTrash(db) }) },
	{
		method: 'POST',
		path: '/trash/recipes/:id/restore',
		run: (db, req) => {
			restoreRecipe(db, req.params.id);
			return { restored: true, displaced: false };
		}
	},
	{
		method: 'POST',
		path: '/trash/variations/:id/restore',
		run: (db, req) => ({ restored: true, ...guard(() => restoreVariation(db, req.params.id)) })
	},

	{
		method: 'GET',
		path: '/jobs/:id',
		run: (db, req) => {
			const poll = getJobPoll(db, req.params.id);
			if (!poll) throw new ApiError(404, 'No such job.');
			return poll;
		}
	},
	{
		method: 'POST',
		path: '/images',
		run: async (db, req) => {
			// Raw JPEG body; ?role=capture marks cookbook-page uploads (SPEC 7.1).
			const role = req.query.get('role') ?? 'photo';
			if (role !== 'photo' && role !== 'capture') throw bad('Unknown image role.');
			const buf = await req.bytes();
			if (buf.length === 0) throw bad('Empty upload.');
			// A normalised 3000px q90 JPEG is 1-2 MB; anything bigger skipped the
			// client pipeline. 8 MB leaves headroom for very busy pages.
			if (buf.length > MAX_IMAGE_BYTES) throw new ApiError(413, 'Image too large.');
			try {
				return await saveImage(db, buf, role);
			} catch (e) {
				// The message can carry R2 object keys and R2's error body: logs only.
				console.error('image upload failed', e);
				throw bad('Could not process image.');
			}
		}
	}
];
