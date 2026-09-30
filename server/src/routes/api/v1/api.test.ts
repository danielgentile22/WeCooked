import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { hash } from '@node-rs/argon2';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '$env/dynamic/private';
import { migrate } from '$lib/server/migrate';
import { dispatch, type Method } from '$lib/server/api/dispatch';
import { routes } from '$lib/server/api/v1';
import { bearerToken, gate } from '$lib/server/gate';
import { issueSessionToken, verifySession, REISSUE_AFTER_MS } from '$lib/server/session';
import { claudeCall } from '$lib/server/claude';
import { scale } from '$lib/server/scale';
import { applyMerge, getListId } from '$lib/server/shopping';
import type { JobRow } from '$lib/server/jobs';
import type { RecipeDraft } from '$lib/extract';
import type { RecipeInput } from '$lib/tags';

// Integration tests for every /api/v1 route, through the same dispatch the
// SvelteKit route uses, against a temporary SQLite file. Ids and clocks are
// fixed so the replies double as decoding fixtures for WeCookedKit.

vi.mock('$env/dynamic/private', () => ({
	env: {
		SESSION_SECRET: 'test-secret',
		APP_PASSWORD_HASH: '',
		R2_ACCOUNT_ID: 'account',
		R2_BUCKET: 'bucket',
		R2_ACCESS_KEY_ID: 'access-key',
		R2_SECRET_ACCESS_KEY: 'secret-key'
	}
}));
vi.mock('$app/environment', () => ({ dev: true }));
vi.mock('$lib/server/ids', () => {
	let n = 0;
	return { ulid: () => `01TEST${String(++n).padStart(20, '0')}` };
});
vi.mock('$lib/server/r2', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/r2')>()),
	putObject: vi.fn(async () => {}),
	getObject: vi.fn()
}));
vi.mock('$lib/server/claude', () => ({ claudeCall: vi.fn() }));

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../WeCookedKit/Tests/Fixtures');
const PASSWORD = 'correct horse';
const START = new Date('2026-09-28T12:00:00.000Z');

let dir: string;
let db: Database.Database;

beforeAll(async () => {
	env.APP_PASSWORD_HASH = await hash(PASSWORD);
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(START);
	dir = mkdtempSync(join(tmpdir(), 'wecooked-api-'));
	db = new Database(join(dir, 'test.db'));
	db.pragma('journal_mode = WAL');
	db.pragma('foreign_keys = ON');
	migrate(db, 'migrations');
	mkdirSync(FIXTURES, { recursive: true });
});

afterAll(() => {
	vi.useRealTimers();
	db.close();
	rmSync(dir, { recursive: true, force: true });
});

/** Move the clock on, so created_at orders rows the way real use would. */
const tick = () => vi.setSystemTime(Date.now() + 60_000);

type Call = { body?: unknown; query?: string; bytes?: Buffer; ip?: string };

async function call(method: Method, path: string, opts: Call = {}) {
	const reply = await dispatch(db, routes, method, path, {
		query: new URLSearchParams(opts.query),
		ip: opts.ip ?? '10.0.0.1',
		json: async () => opts.body,
		bytes: async () => opts.bytes ?? Buffer.alloc(0)
	});
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return reply as { status: number; body: any };
}

async function ok(method: Method, path: string, opts: Call = {}) {
	const r = await call(method, path, opts);
	expect(r, `${method} ${path}`).toMatchObject({ status: 200 });
	return r.body;
}

async function fails(method: Method, path: string, status: number, error: string, opts: Call = {}) {
	expect(await call(method, path, opts)).toEqual({ status, body: { error } });
}

function sortKeys(v: unknown): unknown {
	if (Array.isArray(v)) return v.map(sortKeys);
	if (v && typeof v === 'object')
		return Object.fromEntries(
			Object.keys(v)
				.sort()
				.map((k) => [k, sortKeys((v as Record<string, unknown>)[k])])
		);
	return v;
}

/** Record a reply body as a fixture for the Swift decoding tests. */
function fixture<T>(name: string, body: T): T {
	writeFileSync(join(FIXTURES, `${name}.json`), JSON.stringify(sortKeys(body), null, 2) + '\n');
	return body;
}

const job = (id: string) => db.prepare('SELECT * FROM job WHERE id = ?').get(id) as JobRow | undefined;

function finishJob(id: string, result: unknown) {
	db.prepare(`UPDATE job SET status = 'done', result_json = ?, finished_at = ? WHERE id = ?`).run(
		JSON.stringify(result),
		new Date().toISOString(),
		id
	);
}

const jpeg = () =>
	sharp({ create: { width: 40, height: 30, channels: 3, background: '#c86432' } })
		.jpeg()
		.toBuffer();

const input = (over: Partial<RecipeInput> = {}): RecipeInput => ({
	title: 'Chickpea stew',
	yield_count: 4,
	yield_unit: 'servings',
	prep_minutes: 10,
	cook_minutes: 30,
	source_text: 'Ottolenghi, Simple, p.112',
	source_url: null,
	notes: 'Better the next day.',
	source_units: 'metric',
	meal_types: ['dinner'],
	cuisine: 'middle-eastern',
	protein: 'beans',
	effort: 'weeknight',
	damage: 'messy',
	ingredients: [
		{ heading: null, items: ['1 onion, finely diced', '400 g tinned chickpeas'] },
		{ heading: 'For the sauce', items: ['400 g tinned tomatoes'] }
	],
	steps: ['Fry the onion.', 'Add everything else and simmer.'],
	counterpart: {
		ingredients: [
			{ heading: null, items: ['1 onion, finely diced', '14 oz canned chickpeas'] },
			{ heading: 'For the sauce', items: ['14 oz canned tomatoes'] }
		],
		steps: ['Fry the onion.', 'Add everything else and simmer.']
	},
	image_ids: [],
	cover_image_id: null,
	...over
});

const draftResult = (): RecipeDraft => ({
	title: 'Lemon drizzle cake',
	yield_count: 8,
	yield_unit: 'slices',
	prep_minutes: 20,
	cook_minutes: 45,
	source_text: 'Grandma, handwritten card',
	body: {
		source_units: 'metric',
		us: {
			ingredients: [{ heading: null, items: ['1 cup sugar', '2 lemons'] }],
			steps: ['Bake.']
		},
		metric: {
			ingredients: [{ heading: null, items: ['200 g sugar', '2 lemons'] }],
			steps: ['Bake.']
		}
	},
	tags: { meal_type: ['dessert'], cuisine: 'british', protein: null, effort: 'project', damage: 'tidy' },
	damage_reasoning: 'One bowl and a tin.',
	extraction_warnings: ['Step 3 was cut off in the photo.']
});

describe('auth gate (hooks.server.ts)', () => {
	const token = () => issueSessionToken(Date.now());

	it('answers 401 for /api without a token, and redirects pages to /login', () => {
		expect(gate('/api/v1/recipes', undefined)).toEqual({ kind: 'unauthorized' });
		expect(gate('/api/images', 'garbage.token')).toEqual({ kind: 'unauthorized' });
		expect(gate('/shopping', undefined)).toEqual({ kind: 'redirect', location: '/login' });
	});

	it('lets a valid token through, and marks an old one for reissue', () => {
		expect(gate('/api/v1/recipes', token())).toEqual({ kind: 'pass', reissue: false });
		const old = issueSessionToken(Date.now() - REISSUE_AFTER_MS - 1);
		expect(gate('/api/v1/recipes', old)).toEqual({ kind: 'pass', reissue: true });
	});

	it('keeps /login, /healthz and /api/v1/login public', () => {
		for (const p of ['/login', '/healthz', '/api/v1/login'])
			expect(gate(p, undefined)).toEqual({ kind: 'pass', reissue: false });
		expect(gate('/login', token())).toEqual({ kind: 'redirect', location: '/' });
	});

	it('reads the bearer header', () => {
		expect(bearerToken('Bearer abc.def')).toBe('abc.def');
		expect(bearerToken('bearer abc.def')).toBe('abc.def');
		expect(bearerToken('Basic abc')).toBeUndefined();
		expect(bearerToken(null)).toBeUndefined();
	});
});

describe('/api/v1', () => {
	let recipeId: string;
	let variationId: string;
	let photoId: string;

	it('POST /login: wrong password, rate limit, success', async () => {
		await fails('POST', '/login', 400, 'Wrong password.', { body: { password: 'nope' } });
		await fails('POST', '/login', 400, 'Malformed JSON.', { body: undefined });
		for (let i = 0; i < 5; i++)
			await fails('POST', '/login', 400, 'Wrong password.', { body: { password: 'x' }, ip: '9.9.9.9' });
		await fails('POST', '/login', 429, 'Too many attempts. Try again in 15 minutes.', {
			body: { password: PASSWORD },
			ip: '9.9.9.9'
		});
		const { token } = fixture('login', await ok('POST', '/login', { body: { password: PASSWORD } }));
		expect(verifySession(token)).toBe(START.getTime());
	});

	it('GET /session and GET /tags', async () => {
		expect(fixture('session', await ok('GET', '/session'))).toEqual({ ok: true });
		const tags = fixture('tags', await ok('GET', '/tags'));
		expect(tags.efforts).toEqual(['quick', 'weeknight', 'project']);
		expect(tags.section_order.at(-1)).toBe('staples');
		expect(tags.error_copy.interrupted).toMatch(/restart/);
	});

	it('unknown paths and methods are JSON errors', async () => {
		await fails('GET', '/nope', 404, 'Not found.');
		await fails('PATCH', '/recipes', 405, 'Method not allowed.');
	});

	it('POST /images', async () => {
		await fails('POST', '/images', 400, 'Unknown image role.', { query: 'role=avatar' });
		await fails('POST', '/images', 400, 'Empty upload.');
		await fails('POST', '/images', 413, 'Image too large.', { bytes: Buffer.alloc(8 * 1024 * 1024 + 1) });
		await fails('POST', '/images', 400, 'Could not process image.', { bytes: Buffer.from('not a jpeg') });
		const img = fixture('image-upload', await ok('POST', '/images', { bytes: await jpeg() }));
		expect(img).toMatchObject({ width: 40, height: 30 });
		expect(img.url).toMatch(/^https:\/\/account\.r2\.cloudflarestorage\.com\/bucket\/images\//);
		photoId = img.id;
	});

	it('POST /recipes', async () => {
		await fails('POST', '/recipes', 400, 'Title is required.', { body: input({ title: ' ' }) });
		await fails('POST', '/recipes', 400, 'Malformed JSON.', { body: [1] });
		tick();
		const created = fixture(
			'recipe-create',
			await ok('POST', '/recipes', { body: input({ image_ids: [photoId], cover_image_id: photoId }) })
		);
		recipeId = created.id;
		tick();
		await ok('POST', '/recipes', {
			body: input({ title: 'Quick omelette', effort: 'quick', protein: 'egg', cuisine: 'french' })
		});
	});

	it('GET /recipes/:id', async () => {
		const view = fixture('recipe-get', await ok('GET', `/recipes/${recipeId}`));
		expect(view.recipe).toMatchObject({ title: 'Chickpea stew', is_original: true, reconvert: null });
		expect(view.recipe.images[0]).toMatchObject({ id: photoId, width: 40, height: 30 });
		expect(view.recipe.images[0].r2_key_full).toBeUndefined();
		expect(view).toMatchObject({ refresh: null, calcJob: null });
		variationId = view.recipe.variation_id;
		await fails('GET', '/recipes/missing', 404, 'Recipe not found');
	});

	it('PUT /recipes/:id with a body edit enqueues a reconvert', async () => {
		const reconverts = () =>
			db.prepare(`SELECT COUNT(*) AS n FROM job WHERE kind = 'reconvert' AND variation_id = ?`).get(variationId) as {
				n: number;
			};
		expect(reconverts().n).toBe(0);
		const edited = input({
			image_ids: [photoId],
			cover_image_id: photoId,
			steps: ['Fry the onion slowly.', 'Add everything else and simmer.'],
			counterpart: null
		});
		await fails('PUT', `/recipes/${recipeId}`, 400, 'Malformed submission.', { body: { payload: 'x' } });
		await fails('PUT', `/recipes/missing`, 400, 'Recipe not found.', { body: { payload: edited } });
		const reply = fixture('recipe-update', await ok('PUT', `/recipes/${recipeId}`, { body: { payload: edited } }));
		expect(reply).toEqual({ id: recipeId, variation_id: null });
		expect(reconverts().n).toBe(1);
	});

	it('POST /recipes/:id/calculate enqueues a scale job, then reuses the variation', async () => {
		await fails('POST', `/recipes/${recipeId}/calculate`, 400, 'Yield must be a positive number.', {
			body: { to_count: 0 }
		});
		tick();
		const { job_id } = fixture(
			'recipe-calculate-job',
			await ok('POST', `/recipes/${recipeId}/calculate`, { body: { to_count: 8 } })
		);
		expect(job(job_id)).toMatchObject({ kind: 'scale', status: 'queued', recipe_id: recipeId });
		expect(JSON.parse(job(job_id)!.input_json)).toEqual({ recipe_id: recipeId, to_count: 8 });
		fixture('job-get-queued', await ok('GET', `/jobs/${job_id}`));

		const busy = fixture('recipe-get-busy', await ok('GET', `/recipes/${recipeId}`));
		expect(busy.calcJob).toEqual({ job_id, status: 'pending', error_text: null, to_count: 8 });
		expect(busy.recipe.reconvert).toMatchObject({ status: 'pending' });

		vi.mocked(claudeCall).mockResolvedValueOnce({
			body: {
				source_units: 'metric',
				us: { ingredients: [{ heading: null, items: ['2 onions', '28 oz canned chickpeas'] }], steps: ['Fry.'] },
				metric: { ingredients: [{ heading: null, items: ['2 onions', '800 g tinned chickpeas'] }], steps: ['Fry.'] }
			},
			scaling_note: 'Doubled; simmer a little longer.'
		});
		finishJob(job_id, await scale(job(job_id)!, db));
		const poll = fixture('job-get', await ok('GET', `/jobs/${job_id}`));
		expect(poll).toMatchObject({ status: 'done', error_code: null });
		const scaled = poll.result_ref as string;
		await fails('GET', '/jobs/missing', 404, 'No such job.');

		expect(
			fixture('recipe-calculate-existing', await ok('POST', `/recipes/${recipeId}/calculate`, { body: { to_count: 8 } }))
		).toEqual({ variation_id: scaled });
		const v = fixture('recipe-get-variation', await ok('GET', `/recipes/${recipeId}`, { query: `v=${scaled}` }));
		expect(v.recipe).toMatchObject({ variation_id: scaled, is_original: false, yield_count: 8 });
		expect(v.recipe.variations).toHaveLength(2);
	});

	it('POST /recipes/:id/retry-reconvert', async () => {
		expect(await ok('POST', `/recipes/${recipeId}/retry-reconvert`)).toEqual({ ok: true });
		expect(await ok('POST', `/recipes/${recipeId}/retry-reconvert`, { body: { variation_id: variationId } })).toEqual({
			ok: true
		});
		await fails('POST', '/recipes/missing/retry-reconvert', 400, 'Recipe not found.');
	});

	it('variations: retry-scale, keep-mine, delete, restore, recalculate', async () => {
		const { recipe } = await ok('GET', `/recipes/${recipeId}`);
		const scaled = recipe.variations.find((c: { is_original: boolean }) => !c.is_original).id as string;

		const retry = await ok('POST', `/variations/${scaled}/retry-scale`);
		expect(job(retry.job_id)).toMatchObject({ kind: 'scale', variation_id: scaled });
		expect(await ok('POST', `/variations/${scaled}/keep-mine`)).toEqual({ ok: true });

		await fails('DELETE', `/variations/${variationId}`, 400, 'The original variation cannot be deleted.');
		expect(await ok('DELETE', `/variations/${scaled}`)).toEqual({ ok: true });
		await fails('DELETE', `/variations/${scaled}`, 400, 'Variation not found.');
		expect(fixture('trash-restore-variation', await ok('POST', `/trash/variations/${scaled}/restore`))).toEqual({
			restored: true,
			displaced: false
		});
		await fails('POST', `/trash/variations/${scaled}/restore`, 400, 'Variation not found in Trash.');

		await fails('POST', `/variations/${variationId}/recalculate`, 400, 'The original variation cannot be recalculated.');
		const recalc = await ok('POST', `/variations/${scaled}/recalculate`);
		expect(JSON.parse(job(recalc.job_id)!.input_json)).toEqual({ recipe_id: recipeId, to_count: 8 });
	});

	it('POST /captures: paste, URL and photos', async () => {
		await fails('POST', '/captures', 400, 'Paste some recipe text first.', { body: { text: '  ' } });
		await fails('POST', '/captures', 400, 'Add at least one photo first.', { body: { image_ids: [] } });
		await fails('POST', '/captures', 400, 'Add at least one photo first.', { body: { image_ids: [1] } });
		await fails('POST', '/captures', 400, 'At most 10 pages per recipe.', {
			body: { image_ids: Array.from({ length: 11 }, (_, i) => `p${i}`) }
		});
		await fails('POST', '/captures', 400, 'That is not a link. Share a web page instead.', { body: { url: 'not a link' } });
		await fails('POST', '/captures', 400, 'Share one thing at a time: a link, text or photos.', {
			body: { url: 'https://example.com', image_ids: ['p'] }
		});
		tick();
		const url = await ok('POST', '/captures', { body: { text: 'www.example.com/soup' } });
		expect(job(url.job_id)).toMatchObject({ kind: 'extract_url', input_json: '{"url":"https://www.example.com/soup"}' });
		tick();
		const paste = fixture('captures', await ok('POST', '/captures', { body: { text: 'Toast\nToast the bread.' } }));
		expect(job(paste.job_id)).toMatchObject({ kind: 'extract_paste' });
		tick();
		const page = await ok('POST', '/images', { query: 'role=capture', bytes: await jpeg() });
		const photos = await ok('POST', '/captures', { body: { image_ids: [page.id] } });
		expect(JSON.parse(job(photos.job_id)!.input_json)).toEqual({ image_ids: [page.id] });
	});

	it('drafts: browse cards, review, retry, save, discard', async () => {
		const drafts = db
			.prepare(`SELECT id, kind FROM job WHERE kind LIKE 'extract_%' ORDER BY created_at`)
			.all() as { id: string; kind: string }[];
		const [urlJob, pasteJob, photoJob] = drafts.map((d) => d.id);

		db.prepare(
			`UPDATE job SET status = 'failed', error_code = 'fetch_blocked', error_text = ?, finished_at = ? WHERE id = ?`
		).run('This site blocks automated readers.', new Date().toISOString(), urlJob);
		finishJob(photoJob, draftResult());

		const browse = fixture('recipes-list', await ok('GET', '/recipes'));
		expect(browse.drafts.map((d: { status: string }) => d.status)).toEqual(['ready', 'extracting', 'failed']);
		expect(browse.recipes.map((r: { title: string }) => r.title)).toEqual(['Quick omelette', 'Chickpea stew']);
		expect(browse.recipes[1].cover_url).toMatch(/display\.jpg/);
		expect((await ok('GET', '/recipes', { query: 'effort=quick' })).recipes).toHaveLength(1);
		expect((await ok('GET', '/recipes', { query: 'q=stew' })).recipes[0].id).toBe(recipeId);

		const ready = fixture('draft-get-ready', await ok('GET', `/drafts/${photoJob}`));
		expect(ready).toMatchObject({ status: 'done', warnings: ['Step 3 was cut off in the photo.'] });
		expect(ready.initial).toMatchObject({ title: 'Lemon drizzle cake', source_url: null });
		expect(ready.initial.images).toHaveLength(1);
		const failed = fixture('draft-get-failed', await ok('GET', `/drafts/${urlJob}`));
		expect(failed).toMatchObject({ status: 'failed', initial: { source_url: 'https://www.example.com/soup', images: [] } });
		await fails('GET', '/drafts/missing', 404, 'No such draft.');
		await fails('GET', `/drafts/${recipeId}`, 404, 'No such draft.');

		await fails('POST', `/drafts/${pasteJob}/discard`, 400, 'Still extracting; wait for it to finish.');
		expect(await ok('POST', `/drafts/${urlJob}/retry`)).toEqual({ ok: true });
		expect(job(urlJob)).toMatchObject({ status: 'queued', error_code: null });

		const { images, ...seed } = ready.initial;
		const payload = { ...input(), ...seed, image_ids: images.map((i: { id: string }) => i.id), cover_image_id: null };
		await fails('POST', `/drafts/${photoJob}/save`, 400, 'Damage is required.', { body: { ...payload, damage: null } });
		tick();
		const saved = fixture('draft-save', await ok('POST', `/drafts/${photoJob}/save`, { body: payload }));
		expect(job(photoJob)!.recipe_id).toBe(saved.recipe_id);
		expect(fixture('draft-get-saved', await ok('GET', `/drafts/${photoJob}`))).toEqual(saved);
		expect(await ok('POST', `/drafts/${photoJob}/save`, { body: payload })).toEqual(saved);

		finishJob(pasteJob, draftResult());
		expect(await ok('POST', `/drafts/${pasteJob}/discard`)).toEqual({ ok: true });
		expect(job(pasteJob)).toBeUndefined();
	});

	it('shopping: build, retry, manual, tick, done', async () => {
		fixture('shopping-get-empty', await ok('GET', '/shopping'));
		await fails('POST', '/shopping/build', 400, 'Pick at least one recipe.', { body: { picks: [] } });
		await fails('POST', '/shopping/build', 400, 'Malformed submission.', { body: { picks: [{ yield_count: 2 }] } });
		await fails('POST', '/shopping/build', 400, 'Yield must be a positive number.', {
			body: { picks: [{ recipe_id: recipeId, yield_count: -1 }] }
		});
		const { job_id } = fixture(
			'shopping-build',
			await ok('POST', '/shopping/build', { body: { picks: [{ recipe_id: recipeId, yield_count: 6 }] } })
		);
		expect(job(job_id)).toMatchObject({ kind: 'shopping_merge', status: 'queued' });

		const listId = getListId(db);
		finishJob(
			job_id,
			applyMerge(db, listId, [
				{ section: 'produce', text_us: '2 onions', text_metric: '2 onions', from_recipes: [recipeId], is_staple: false },
				{ section: 'dry-goods', text_us: '21 oz canned chickpeas', text_metric: '600 g tinned chickpeas', from_recipes: [recipeId], is_staple: false },
				{ section: 'staples', text_us: 'olive oil', text_metric: 'olive oil', from_recipes: [recipeId], is_staple: true }
			])
		);
		await fails('POST', '/shopping/manual', 400, 'Nothing to add.', { body: { text: ' ' } });
		expect(await ok('POST', '/shopping/manual', { body: { text: 'bin bags' } })).toEqual({ ok: true });

		const onions = (await ok('GET', '/shopping')).list.items[0].id;
		expect(await ok('PATCH', `/shopping/items/${onions}`, { body: { ticked: true } })).toEqual({ ok: true });
		const state = fixture('shopping-get', await ok('GET', '/shopping'));
		expect(state.list.items).toHaveLength(4);
		expect(state.list.items[0]).toMatchObject({ id: onions, ticked: true, from_titles: ['Chickpea stew'] });
		expect(state.list.build).toMatchObject({ job_id, status: 'done', result: { kept: 0, reset: [] } });
		expect(state.list.picks).toEqual([{ recipe_id: recipeId, yield_count: 6, title: 'Chickpea stew', yield_unit: 'servings' }]);
		expect(state.recipes.map((r: { title: string }) => r.title)).toContain('Lemon drizzle cake');

		const retry = await ok('POST', '/shopping/retry');
		expect(job(retry.job_id)).toMatchObject({ kind: 'shopping_merge', status: 'queued' });
		expect(await ok('POST', '/shopping/done')).toEqual({ ok: true });
		const after = await ok('GET', '/shopping');
		expect(after.list).toMatchObject({ items: [], picks: [] });
	});

	it('trash: delete a recipe, list, restore', async () => {
		const omelette = (await ok('GET', '/recipes', { query: 'q=omelette' })).recipes[0].id as string;
		tick();
		expect(await ok('DELETE', `/recipes/${omelette}`)).toEqual({ ok: true });
		await fails('GET', `/recipes/${omelette}`, 404, 'Recipe not found');
		const { trash } = fixture('trash-get', await ok('GET', '/trash'));
		expect(trash.recipes.map((r: { id: string }) => r.id)).toEqual([omelette]);
		expect(trash.variations).toEqual([
			expect.objectContaining({ title: 'Chickpea stew', yield_count: 8, yield_unit: 'servings' })
		]);
		expect(fixture('trash-restore-recipe', await ok('POST', `/trash/recipes/${omelette}/restore`))).toEqual({
			restored: true,
			displaced: false
		});
		expect((await ok('GET', '/trash')).trash.recipes).toHaveLength(0);
		expect((await ok('GET', '/recipes')).recipes.map((r: { id: string }) => r.id)).toContain(omelette);
	});

	// Last so its job id and draft card shift no earlier fixture the Kit pins.
	it('POST /captures: shared link with caption (issue #39)', async () => {
		const shared = fixture(
			'captures-url',
			await ok('POST', '/captures', { body: { url: 'https://www.example.com/reel', text: 'Caption: 2 eggs...' } })
		);
		expect(job(shared.job_id)).toMatchObject({
			kind: 'extract_url',
			input_json: '{"url":"https://www.example.com/reel","text":"Caption: 2 eggs..."}'
		});
	});

	it('POST /captures: phone-rendered page (issue #43)', async () => {
		await fails('POST', '/captures', 400, 'Malformed submission.', {
			body: { url: 'https://www.example.com/r', html: 42 }
		});
		const html =
			'<meta property="og:description" content="Caption: 2 eggs &amp; toast">' +
			'<p>Fried eggs</p><script>window.tracker = 1</script>';
		const rendered = await ok('POST', '/captures', { body: { url: 'https://www.example.com/r', html } });
		const page = 'Fried eggs\n\nPage description: Caption: 2 eggs & toast';
		expect(JSON.parse(job(rendered.job_id)!.input_json)).toEqual({ url: 'https://www.example.com/r', page });
		expect(job(rendered.job_id)!.input_json).not.toContain('<script');

		const captioned = await ok('POST', '/captures', {
			body: { url: 'https://www.example.com/r', html, text: ' My note ' }
		});
		expect(JSON.parse(job(captioned.job_id)!.input_json)).toEqual({
			url: 'https://www.example.com/r',
			page,
			text: 'My note'
		});

		const blank = await ok('POST', '/captures', { body: { url: 'https://www.example.com/r', html: '' } });
		expect(JSON.parse(job(blank.job_id)!.input_json)).toEqual({ url: 'https://www.example.com/r' });

		const empty = await ok('POST', '/captures', {
			body: { url: 'https://www.example.com/r', html: '<html><body><script>x()</script></body></html>' }
		});
		expect(JSON.parse(job(empty.job_id)!.input_json)).toEqual({ url: 'https://www.example.com/r' });
	});

	it('records an error body', async () => {
		fixture('error', (await call('GET', '/recipes/missing')).body);
	});
});
