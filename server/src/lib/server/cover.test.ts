import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import type { CaptureInput, CoverResult, RecipeDraft } from '$lib/extract';
import { migrate } from './migrate';
import { createJob, JobError, type JobRow } from './jobs';
import { acceptable, backfillCovers, coverHandler, enqueueCover, fetchImage, withCover, type CoverDeps } from './cover';
import { parseImageResults } from './imagesearch';

vi.mock('./claude', () => ({ claudeCall: vi.fn() }));
vi.mock('./r2', () => ({ presignGet: (key: string) => `https://r2/${key}`, putObject: vi.fn(), getObject: vi.fn() }));

const jpeg = (width = 800, height = 600) =>
	sharp({ create: { width, height, channels: 3, background: '#c86432' } })
		.jpeg()
		.toBuffer();

const draftResult = { title: 'Shakshuka' } as RecipeDraft;

let db: Database.Database;
beforeEach(() => {
	db = new Database(':memory:');
	db.pragma('foreign_keys = ON');
	migrate(db, 'migrations');
});

const row = (id: string) => db.prepare('SELECT * FROM job WHERE id = ?').get(id) as JobRow | undefined;
const inputOf = (id: string) => JSON.parse(row(id)!.input_json) as CaptureInput;
const image = (id: string) =>
	db.prepare('SELECT recipe_id, source_url, deleted_at, role FROM image WHERE id = ?').get(id) as {
		recipe_id: string | null;
		source_url: string | null;
		deleted_at: string | null;
		role: string;
	};
const coverOf = (recipeId: string) =>
	(db.prepare('SELECT cover_image_id FROM recipe WHERE id = ?').get(recipeId) as { cover_image_id: string | null })
		.cover_image_id;

function draft(input: CaptureInput, kind: JobRow['kind'] = 'extract_url'): string {
	const id = createJob(db, kind, input);
	db.prepare(`UPDATE job SET status = 'done', result_json = ? WHERE id = ?`).run(JSON.stringify(draftResult), id);
	return id;
}

function recipe(id: string, over: { source_url?: string; deleted_at?: string } = {}): string {
	db.prepare(
		`INSERT INTO recipe (id, title, source_url, yield_unit, source_units, effort, damage, created_at, updated_at, deleted_at)
		 VALUES (?, 'Shakshuka', ?, 'servings', 'metric', 'quick', 'tidy', '2026', '2026', ?)`
	).run(id, over.source_url ?? null, over.deleted_at ?? null);
	return id;
}

/** Deps that fail loudly unless a test opts in to the step. */
function deps(over: Partial<CoverDeps> = {}): CoverDeps {
	return {
		fetchPage: vi.fn(async () => {
			throw new Error('fetched a page');
		}),
		fetchImage: vi.fn(async () => {
			throw new Error('fetched an image');
		}),
		searchImages: vi.fn(async () => {
			throw new Error('searched');
		}),
		claudePick: vi.fn(async () => {
			throw new Error('asked Claude');
		}),
		...over
	};
}

const run = async (d: CoverDeps, jobId: string) => (await coverHandler(d)(row(jobId)!, db)) as CoverResult;
const coverJob = (input: object) => createJob(db, 'cover', input);
const hits = (...urls: string[]) => urls.map((u) => ({ image_url: u, title: '', page_url: '' }));

describe('cover handler (issue #44)', () => {
	it('takes the first acceptable image the source page named', async () => {
		const id = draft({ url: 'https://a.com/r', image_urls: ['https://a.com/icon.png', 'https://a.com/dish.jpg'] });
		const full = await jpeg();
		const d = deps({ fetchImage: vi.fn(async (u: string) => (u.endsWith('dish.jpg') ? full : null)) });
		const result = await run(d, coverJob({ draft_id: id }));
		expect(result).toMatchObject({ origin: 'source' });
		expect(inputOf(id).cover_image_id).toBe(result.image_id);
		expect(inputOf(id).url).toBe('https://a.com/r');
		expect(image(result.image_id!)).toEqual({
			recipe_id: null,
			source_url: 'https://a.com/dish.jpg',
			deleted_at: null,
			role: 'photo'
		});
		expect(d.searchImages).not.toHaveBeenCalled();
	});

	it('reads the page for candidates when ingest had none, and searches when it is blocked', async () => {
		const id = draft({ url: 'https://a.com/r' });
		const full = await jpeg();
		const d = deps({
			fetchPage: vi.fn(async () => {
				throw new JobError('fetch_blocked');
			}),
			searchImages: vi.fn(async () => hits('https://img.com/0.jpg', 'https://img.com/1.jpg', 'https://img.com/2.jpg')),
			fetchImage: vi.fn(async () => full),
			claudePick: vi.fn(async () => 1)
		});
		const result = await run(d, coverJob({ draft_id: id }));
		expect(result).toMatchObject({ origin: 'search' });
		expect(image(result.image_id!).source_url).toBe('https://img.com/1.jpg');
		expect(d.searchImages).toHaveBeenCalledWith('Shakshuka recipe');
		const [, title, thumbs] = vi.mocked(d.claudePick).mock.calls[0];
		expect(title).toBe('Shakshuka');
		expect(thumbs).toHaveLength(3);
		expect((await sharp(thumbs[0]).metadata()).width).toBe(512);
	});

	it('uses page images when the page is readable', async () => {
		const id = draft({ url: 'https://a.com/r' });
		const full = await jpeg();
		const d = deps({
			fetchPage: vi.fn(async () => '<meta property="og:image" content="/hero.jpg">'),
			fetchImage: vi.fn(async () => full)
		});
		const result = await run(d, coverJob({ draft_id: id }));
		expect(image(result.image_id!).source_url).toBe('https://a.com/hero.jpg');
	});

	it('keeps at most four acceptable hits from at most eight attempts', async () => {
		const id = draft({ text: 'Shakshuka...' }, 'extract_paste');
		const full = await jpeg();
		const urls = Array.from({ length: 10 }, (_, i) => `https://img.com/${i}.jpg`);
		const accept = new Set([urls[1], urls[7], urls[9]]);
		const d = deps({
			searchImages: vi.fn(async () => hits(...urls)),
			fetchImage: vi.fn(async (u: string) => (accept.has(u) ? full : null)),
			claudePick: vi.fn(async () => 0)
		});
		await run(d, coverJob({ draft_id: id }));
		expect(d.fetchImage).toHaveBeenCalledTimes(8);
		expect(vi.mocked(d.claudePick).mock.calls[0][2]).toHaveLength(2);
	});

	it('does not add "recipe" to a title that has it', async () => {
		const id = createJob(db, 'extract_paste', { text: 'x' });
		db.prepare(`UPDATE job SET status = 'done', result_json = ? WHERE id = ?`).run(
			JSON.stringify({ title: 'Recipe for flapjacks' }),
			id
		);
		const d = deps({ searchImages: vi.fn(async () => []) });
		expect(await run(d, coverJob({ draft_id: id }))).toEqual({ image_id: null, origin: null });
		expect(d.searchImages).toHaveBeenCalledWith('Recipe for flapjacks');
		expect(d.claudePick).not.toHaveBeenCalled();
	});

	it('leaves no cover when Claude picks none, or the pick call fails', async () => {
		const full = await jpeg();
		const picks = [async () => -1, async () => 7, async () => Promise.reject(new JobError('quota_exceeded'))];
		for (const claudePick of picks) {
			const id = draft({ text: 'asdf' }, 'extract_paste');
			const d = deps({
				searchImages: vi.fn(async () => hits('https://img.com/0.jpg')),
				fetchImage: vi.fn(async () => full),
				claudePick
			});
			expect(await run(d, coverJob({ draft_id: id }))).toEqual({ image_id: null, origin: null });
			expect(inputOf(id).cover_image_id).toBeUndefined();
		}
		expect(db.prepare('SELECT COUNT(*) AS n FROM image').get()).toEqual({ n: 0 });
	});

	it('does nothing for a discarded draft, and soft-deletes a cover found after the discard', async () => {
		expect(await run(deps(), coverJob({ draft_id: 'gone' }))).toEqual({ image_id: null, origin: null });

		const id = draft({ url: 'https://a.com/r', image_urls: ['https://a.com/dish.jpg'] });
		const job = coverJob({ draft_id: id });
		const full = await jpeg();
		const d = deps({
			fetchImage: vi.fn(async () => {
				db.prepare('DELETE FROM job WHERE id = ?').run(id);
				return full;
			})
		});
		expect(await run(d, job)).toEqual({ image_id: null, origin: null });
		const stored = db.prepare('SELECT deleted_at FROM image').all() as { deleted_at: string | null }[];
		expect(stored).toHaveLength(1);
		expect(stored[0].deleted_at).not.toBeNull();
	});

	it('attaches to the recipe when the draft was saved before the cover was found', async () => {
		const id = draft({ url: 'https://a.com/r', image_urls: ['https://a.com/dish.jpg'] });
		db.prepare('UPDATE job SET recipe_id = ? WHERE id = ?').run(recipe('r1'), id);
		const full = await jpeg();
		const result = await run(deps({ fetchImage: vi.fn(async () => full) }), coverJob({ draft_id: id }));
		expect(coverOf('r1')).toBe(result.image_id);
		expect(image(result.image_id!)).toMatchObject({ recipe_id: 'r1', deleted_at: null });
		expect(inputOf(id).cover_image_id).toBeUndefined();
	});

	it('attaches to the recipe when the save lands while the cover is being fetched', async () => {
		const id = draft({ url: 'https://a.com/r', image_urls: ['https://a.com/dish.jpg'] });
		recipe('r1');
		const full = await jpeg();
		const d = deps({
			fetchImage: vi.fn(async () => {
				db.prepare('UPDATE job SET recipe_id = ? WHERE id = ?').run('r1', id);
				return full;
			})
		});
		const result = await run(d, coverJob({ draft_id: id }));
		expect(coverOf('r1')).toBe(result.image_id);
	});

	it('backfills a saved recipe from its source page', async () => {
		recipe('r1', { source_url: 'https://a.com/r' });
		const full = await jpeg();
		const d = deps({
			fetchPage: vi.fn(async () => '<meta property="og:image" content="https://a.com/hero.jpg">'),
			fetchImage: vi.fn(async () => full)
		});
		const result = await run(d, coverJob({ recipe_id: 'r1' }));
		expect(result).toMatchObject({ origin: 'source' });
		expect(coverOf('r1')).toBe(result.image_id);
		expect(image(result.image_id!)).toMatchObject({ recipe_id: 'r1', source_url: 'https://a.com/hero.jpg' });
	});

	it('leaves an existing cover alone', async () => {
		recipe('r1');
		db.prepare(
			`INSERT INTO image (id, recipe_id, r2_key_full, r2_key_display, width, height, role, created_at)
			 VALUES ('mine', 'r1', 'f', 'd', 1, 1, 'photo', '2026')`
		).run();
		db.prepare(`UPDATE recipe SET cover_image_id = 'mine' WHERE id = 'r1'`).run();
		const none = { image_id: null, origin: null };
		expect(await run(deps(), coverJob({ recipe_id: 'r1' }))).toEqual(none);
		expect(await run(deps(), coverJob({ recipe_id: 'trashed' }))).toEqual(none);
		recipe('r2', { deleted_at: '2026' });
		expect(await run(deps(), coverJob({ recipe_id: 'r2' }))).toEqual(none);
		const id = draft({ url: 'https://a.com/r', cover_image_id: 'mine' });
		expect(await run(deps(), coverJob({ draft_id: id }))).toEqual(none);

		// Found while the cook set a cover by hand: the recipe keeps theirs.
		recipe('r3');
		const full = await jpeg();
		const d = deps({
			fetchImage: vi.fn(async () => {
				db.prepare(`UPDATE image SET recipe_id = 'r3' WHERE id = 'mine'`).run();
				db.prepare(`UPDATE recipe SET cover_image_id = 'mine' WHERE id = 'r3'`).run();
				return full;
			})
		});
		db.prepare(`UPDATE recipe SET source_url = 'https://a.com/r' WHERE id = 'r3'`).run();
		d.fetchPage = vi.fn(async () => '<meta property="og:image" content="/x.jpg">');
		expect(await run(d, coverJob({ recipe_id: 'r3' }))).toEqual(none);
		expect(coverOf('r3')).toBe('mine');
	});
});

describe('cover triggers (issue #44)', () => {
	it('enqueues one cover job per draft, never for a draft that has a cover', () => {
		const id = draft({ text: 'x' }, 'extract_paste');
		const job = enqueueCover(db, id)!;
		expect(JSON.parse(row(job)!.input_json)).toEqual({ draft_id: id });
		expect(row(job)!.kind).toBe('cover');
		expect(enqueueCover(db, draft({ text: 'x', cover_image_id: 'i' }, 'extract_paste'))).toBeNull();
		expect(enqueueCover(db, 'missing')).toBeNull();
	});

	it('withCover enqueues after a successful extraction only', async () => {
		const id = createJob(db, 'extract_paste', { text: 'x' });
		const ok = withCover(async () => draftResult);
		expect(await ok(row(id)!, db)).toBe(draftResult);
		const covers = () => db.prepare(`SELECT input_json FROM job WHERE kind = 'cover'`).all();
		expect(covers()).toEqual([{ input_json: JSON.stringify({ draft_id: id }) }]);
		const failing = withCover(async () => {
			throw new JobError('no_recipe_found');
		});
		await expect(failing(row(id)!, db)).rejects.toMatchObject({ code: 'no_recipe_found' });
		expect(covers()).toHaveLength(1);
	});

	it('backfills live coverless recipes without a pending cover job', () => {
		recipe('a');
		recipe('b');
		recipe('c', { deleted_at: '2026' });
		recipe('d');
		const saved = draft({ text: 'x' }, 'extract_paste');
		db.prepare(`UPDATE job SET recipe_id = 'd' WHERE id = ?`).run(saved);
		coverJob({ draft_id: saved });
		expect(backfillCovers(db)).toBe(2);
		expect(backfillCovers(db)).toBe(0);
		db.prepare(`UPDATE job SET status = 'done' WHERE kind = 'cover'`).run();
		expect(backfillCovers(db)).toBe(3);
	});

	it('backfills in batches and never puts back a cover the cook removed', () => {
		for (const id of ['a', 'b', 'c']) recipe(id);
		expect(backfillCovers(db, 2)).toBe(2);
		db.prepare(
			`UPDATE job SET status = 'done', result_json = ? WHERE kind = 'cover' AND json_extract(input_json, '$.recipe_id') = 'a'`
		).run(JSON.stringify({ image_id: 'img', origin: 'source' } satisfies CoverResult));
		db.prepare(
			`UPDATE job SET status = 'done', result_json = ? WHERE kind = 'cover' AND json_extract(input_json, '$.recipe_id') = 'b'`
		).run(JSON.stringify({ image_id: null, origin: null } satisfies CoverResult));
		// a found one (since removed by the cook): skipped; b found nothing: tried again.
		expect(backfillCovers(db)).toBe(2);
		const queued = db
			.prepare(`SELECT json_extract(input_json, '$.recipe_id') AS id FROM job WHERE kind = 'cover' AND status = 'queued'`)
			.all() as { id: string }[];
		expect(queued.map((q) => q.id).sort()).toEqual(['b', 'c']);
	});
});

describe('fetchImage (issue #44)', () => {
	const publicDns = async () => ['93.184.216.34'];
	const serve = (body: Buffer | string, headers: Record<string, string> = { 'content-type': 'image/jpeg' }) =>
		vi.fn(async () => new Response(new Uint8Array(Buffer.from(body)), { status: 200, headers }));

	it('accepts a photo-shaped image and returns it as a normalised JPEG', async () => {
		const png = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: '#888' } }).png().toBuffer();
		const out = await fetchImage('https://a.com/x', serve(png, { 'content-type': 'image/png' }), publicDns);
		const m = await sharp(out!).metadata();
		expect([m.format, m.width, m.height]).toEqual(['jpeg', 3000, 2250]);
	});

	it('rejects small, banner-shaped, non-image and oversized responses', async () => {
		expect(await fetchImage('https://a.com/x', serve(await jpeg(400, 300)), publicDns)).toBeNull();
		expect(await fetchImage('https://a.com/x', serve(await jpeg(1500, 500)), publicDns)).toBeNull();
		expect(await fetchImage('https://a.com/x', serve('<html>', { 'content-type': 'text/html' }), publicDns)).toBeNull();
		expect(await fetchImage('https://a.com/x', serve('not a jpeg'), publicDns)).toBeNull();
		const big = Buffer.alloc(10 * 1024 * 1024 + 1);
		expect(await fetchImage('https://a.com/x', serve(big), publicDns)).toBeNull();
	});

	it('refuses private addresses without fetching', async () => {
		const f = serve(await jpeg());
		expect(await fetchImage('http://169.254.169.254/latest', f, publicDns)).toBeNull();
		expect(await fetchImage('https://a.com/x', f, async () => ['10.0.0.1'])).toBeNull();
		expect(f).not.toHaveBeenCalled();
	});

	it('follows redirects, checking each hop', async () => {
		const full = await jpeg();
		const f = vi.fn(async (url: string | URL | Request) =>
			String(url) === 'https://a.com/x'
				? new Response(null, { status: 302, headers: { location: 'https://cdn.a.com/x.jpg' } })
				: new Response(new Uint8Array(full), { headers: { 'content-type': 'image/jpeg' } })
		);
		expect(await fetchImage('https://a.com/x', f, publicDns)).not.toBeNull();
		expect(f).toHaveBeenCalledTimes(2);
	});

	it('bounds the shape: long edge 500, short edge 300, at most 2:1', () => {
		expect(acceptable(500, 300)).toBe(true);
		expect(acceptable(499, 300)).toBe(false);
		expect(acceptable(600, 299)).toBe(false);
		expect(acceptable(1000, 500)).toBe(true);
		expect(acceptable(1001, 500)).toBe(false);
		expect(acceptable(500, 1000)).toBe(true);
	});
});

describe('parseImageResults (Brave Image Search)', () => {
	it('takes properties.url, falls back to thumbnail.src, skips hits without either', () => {
		expect(
			parseImageResults({
				results: [
					{ title: 'Shakshuka', url: 'https://site.com/r', properties: { url: 'https://site.com/full.jpg' } },
					{ thumbnail: { src: 'https://imgs.search.brave.com/t.jpg' } },
					{ title: 'empty' },
					null
				]
			})
		).toEqual([
			{ image_url: 'https://site.com/full.jpg', title: 'Shakshuka', page_url: 'https://site.com/r' },
			{ image_url: 'https://imgs.search.brave.com/t.jpg', title: '', page_url: '' }
		]);
		expect(parseImageResults({})).toEqual([]);
		expect(parseImageResults(null)).toEqual([]);
	});
});
