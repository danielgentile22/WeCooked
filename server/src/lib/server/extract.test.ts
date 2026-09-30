import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import Database from 'better-sqlite3';
import { asUrl, draftToInput, hasRecipe, type RecipeDraft } from '$lib/extract';
import {
	assertPublicUrl,
	extractPhotos,
	extractUrl,
	fetchPage as realFetchPage,
	findRecipeJsonLd,
	pageContent,
	photoBlocks,
	stripHtml,
	PHOTOS_INSTRUCTION
} from './extract';
import { migrate } from './migrate';
import { JobError, type JobRow } from './jobs';
import { claudeCall } from './claude';
import { getObject } from './r2';

vi.mock('./claude', () => ({ claudeCall: vi.fn() }));
vi.mock('./r2', () => ({ getObject: vi.fn(), presignGet: vi.fn(), putObject: vi.fn() }));
import { validateInput } from './recipes';
import type { RecipeInput } from '$lib/tags';

const draft = (over: Partial<RecipeDraft> = {}): RecipeDraft => ({
	title: 'Shakshuka',
	yield_count: 2,
	yield_unit: 'servings',
	prep_minutes: 10,
	cook_minutes: 25,
	source_text: null,
	body: {
		source_units: 'metric',
		us: {
			ingredients: [{ heading: null, items: ['14 oz tinned tomatoes', '4 eggs'] }],
			steps: ['Simmer the tomatoes.', 'Crack in the eggs.']
		},
		metric: {
			ingredients: [{ heading: null, items: ['400 g tinned tomatoes', '4 eggs'] }],
			steps: ['Simmer the tomatoes.', 'Crack in the eggs.']
		}
	},
	tags: {
		meal_type: ['breakfast', 'dinner'],
		cuisine: 'middle-eastern',
		protein: 'egg',
		effort: 'quick',
		damage: 'tidy'
	},
	damage_reasoning: '1 pan + board and knife = 2 points, tidy.',
	extraction_warnings: [],
	...over
});

describe('draftToInput (SPEC 6.5: result_json seeds the review form)', () => {
	it('picks the body matching source_units and maps tags through', () => {
		const input = draftToInput(draft());
		expect(input.source_units).toBe('metric');
		expect(input.ingredients).toEqual([
			{ heading: null, items: ['400 g tinned tomatoes', '4 eggs'] }
		]);
		expect(input.steps).toEqual(['Simmer the tomatoes.', 'Crack in the eggs.']);
		expect(input.meal_types).toEqual(['breakfast', 'dinner']);
		expect(input.cuisine).toBe('middle-eastern');
		expect(input.effort).toBe('quick');
		expect(input.damage).toBe('tidy');
	});

	it('produces something the save path accepts as-is', () => {
		const input = draftToInput(draft()) as RecipeInput;
		expect(() => validateInput({ ...input, image_ids: [], cover_image_id: null })).not.toThrow();
	});

	it('picks the us body when the source is us', () => {
		const d = draft();
		d.body.source_units = 'us';
		expect(draftToInput(d).ingredients![0].items[0]).toBe('14 oz tinned tomatoes');
	});
});

const resp = (status: number, body = '', headers: Record<string, string> = {}) =>
	new Response(status >= 300 && status < 400 ? null : body, { status, headers });

// Every test host resolves to a public address: no real DNS in unit tests.
const publicDns = async () => ['93.184.216.34'];
const fetchPage = (url: string, fetchFn: typeof fetch) => realFetchPage(url, fetchFn, publicDns);

const code = async (p: Promise<unknown>): Promise<string> =>
	p.then(
		() => 'ok',
		(e) => (e instanceof JobError ? e.code : 'not-a-JobError')
	);

describe('fetchPage (SPEC 7.1 URL path)', () => {
	it('returns the body and sends a desktop UA', async () => {
		let ua: string | undefined;
		const html = await fetchPage('https://example.com/r', async (url, init) => {
			ua = new Headers(init?.headers).get('user-agent') ?? undefined;
			return resp(200, '<html>hi</html>');
		});
		expect(html).toBe('<html>hi</html>');
		expect(ua).toMatch(/Mozilla/);
	});

	it('fails immediately with fetch_blocked on 403 and 401', async () => {
		expect(await code(fetchPage('https://x.com', async () => resp(403)))).toBe('fetch_blocked');
		expect(await code(fetchPage('https://x.com', async () => resp(401)))).toBe('fetch_blocked');
	});

	it('treats 402 and 429 as fetch_blocked too (issue #43)', async () => {
		expect(await code(fetchPage('https://x.com', async () => resp(402)))).toBe('fetch_blocked');
		expect(await code(fetchPage('https://x.com', async () => resp(429)))).toBe('fetch_blocked');
	});

	it('drops the trailing comma Google appends to a redirect target', async () => {
		const seen: string[] = [];
		await fetchPage('https://share.google/abc', async (url) => {
			seen.push(String(url));
			return seen.length === 1
				? resp(302, '', { location: 'https://www.seriouseats.com/eggs-recipe?shem=aimgspe,' })
				: resp(200, 'landed');
		});
		expect(seen[1]).toBe('https://www.seriouseats.com/eggs-recipe?shem=aimgspe');
	});

	it('keeps a trailing parenthesis in a URL', async () => {
		const seen: string[] = [];
		await fetchPage('https://en.wikipedia.org/wiki/Salsa_(sauce)', async (url) => {
			seen.push(String(url));
			return resp(200, 'ok');
		});
		expect(seen).toEqual(['https://en.wikipedia.org/wiki/Salsa_(sauce)']);
	});

	it('follows redirects, resolving relative locations', async () => {
		const seen: string[] = [];
		const html = await fetchPage('https://x.com/a', async (url) => {
			seen.push(String(url));
			return seen.length === 1 ? resp(301, '', { location: '/b' }) : resp(200, 'landed');
		});
		expect(html).toBe('landed');
		expect(seen).toEqual(['https://x.com/a', 'https://x.com/b']);
	});

	it('gives up after 5 redirects with fetch_failed', async () => {
		let n = 0;
		const loop = async () => resp(302, '', { location: `https://x.com/${n++}` });
		expect(await code(fetchPage('https://x.com/0', loop))).toBe('fetch_failed');
		expect(n).toBe(6); // initial + 5 follows
	});

	it('uses one deadline for the whole fetch, not one per redirect hop', async () => {
		const signals: (AbortSignal | null | undefined)[] = [];
		await fetchPage('https://x.com/a', async (url, init) => {
			signals.push(init?.signal);
			return signals.length === 1 ? resp(302, '', { location: '/b' }) : resp(200, 'ok');
		});
		expect(signals[0]).toBeInstanceOf(AbortSignal);
		expect(signals[1]).toBe(signals[0]);
	});

	it('maps 5xx and network errors to fetch_failed', async () => {
		expect(await code(fetchPage('https://x.com', async () => resp(500)))).toBe('fetch_failed');
		expect(
			await code(
				fetchPage('https://x.com', () => Promise.reject(new TypeError('getaddrinfo ENOTFOUND')))
			)
		).toBe('fetch_failed');
	});
});

describe('assertPublicUrl (no fetching into the private network)', () => {
	const check = (url: string, dns: string[] = ['93.184.216.34']) =>
		code(assertPublicUrl(new URL(url), async () => dns));
	const noDns = async (): Promise<string[]> => {
		throw new Error('asked DNS');
	};

	it('refuses loopback, private, link-local, CGNAT and Fly private addresses', async () => {
		const ips = ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254'];
		ips.push('100.64.0.1', '0.0.0.0', '::1', 'fdaa:0:1::3', 'fe80::1', '::ffff:127.0.0.1');
		for (const ip of ips) expect(await check('https://evil.example/', [ip]), ip).toBe('fetch_failed');
	});

	it('refuses when any one of several resolved addresses is private', async () => {
		expect(await check('https://evil.example/', ['93.184.216.34', '10.0.0.1'])).toBe('fetch_failed');
	});

	it('refuses IP literals, localhost, Fly private names and non-http schemes before DNS', async () => {
		const urls = ['http://127.0.0.1:3000/', 'http://[::1]/', 'http://localhost/'];
		urls.push('http://my-app.internal/', 'http://my-app.flycast./', 'file:///etc/passwd');
		for (const url of urls)
			expect(await code(assertPublicUrl(new URL(url), noDns)), url).toBe('fetch_failed');
	});

	it('allows public hosts and public IP literals', async () => {
		expect(await check('https://smittenkitchen.com/soup')).toBe('ok');
		expect(await code(assertPublicUrl(new URL('http://93.184.216.34/'), noDns))).toBe('ok');
	});

	it('maps DNS failures to fetch_failed', async () => {
		expect(await code(assertPublicUrl(new URL('https://nope.example/'), noDns))).toBe('fetch_failed');
	});

	it('fetchPage checks every redirect hop, not just the first', async () => {
		const seen: string[] = [];
		const dns = async (host: string) =>
			host === 'inside.example' ? ['10.0.0.5'] : ['93.184.216.34'];
		const redirectInward = async (url: string | URL | Request) => {
			seen.push(String(url));
			return resp(302, '', { location: 'http://inside.example/secret' });
		};
		expect(await code(realFetchPage('https://x.com/a', redirectInward, dns))).toBe('fetch_failed');
		expect(seen).toEqual(['https://x.com/a']);
	});
});

describe('asUrl (SPEC 7.1 text-or-URL detection)', () => {
	it('passes through http(s) links and upgrades bare www hosts', () => {
		expect(asUrl('https://smittenkitchen.com/soup')).toBe('https://smittenkitchen.com/soup');
		expect(asUrl('www.seriouseats.com/soup')).toBe('https://www.seriouseats.com/soup');
	});

	it('treats prose as text, even prose containing a link', () => {
		expect(asUrl('2 cups flour\n1 egg')).toBeNull();
		expect(asUrl('from https://x.com, the best soup')).toBeNull();
	});
});

describe('findRecipeJsonLd (SPEC 7.1 step 5)', () => {
	const wrap = (json: unknown) =>
		`<html><head><script type="application/ld+json">${JSON.stringify(json)}</script></head></html>`;

	it('finds a top-level Recipe object', () => {
		const r = findRecipeJsonLd(wrap({ '@type': 'Recipe', name: 'Soup' }));
		expect(r).toMatchObject({ name: 'Soup' });
	});

	it('finds a Recipe inside a @graph array', () => {
		const r = findRecipeJsonLd(
			wrap({ '@graph': [{ '@type': 'WebPage' }, { '@type': 'Recipe', name: 'Stew' }] })
		);
		expect(r).toMatchObject({ name: 'Stew' });
	});

	it('finds a Recipe in a top-level array and with an array @type', () => {
		const r = findRecipeJsonLd(wrap([{ '@type': ['Recipe', 'NewsArticle'], name: 'Pie' }]));
		expect(r).toMatchObject({ name: 'Pie' });
	});

	it('skips malformed blocks and non-Recipe types', () => {
		const html =
			'<script type="application/ld+json">{oops</script>' + wrap({ '@type': 'WebSite' });
		expect(findRecipeJsonLd(html)).toBeNull();
	});
});

describe('stripHtml (SPEC 7.1 step 6)', () => {
	it('drops scripts and styles, keeps text, decodes entities', () => {
		const text = stripHtml(
			'<head><style>p{color:red}</style><script>var x=1</script></head>' +
				'<body><h1>Best&nbsp;Soup</h1><p>1 &amp; 2 cups</p><!-- ad --></body>'
		);
		expect(text).toBe('Best Soup\n1 & 2 cups');
	});

	it('turns block boundaries into newlines', () => {
		expect(stripHtml('<ul><li>eggs</li><li>flour</li></ul>')).toBe('eggs\nflour');
	});
});

describe('hasRecipe (no_recipe_found detection)', () => {
	it('rejects a draft whose source body has no ingredient lines', () => {
		const d = draft();
		d.body.metric.ingredients = [{ heading: null, items: ['  '] }];
		expect(hasRecipe(d)).toBe(false);
	});

	it('accepts a normal draft', () => {
		expect(hasRecipe(draft())).toBe(true);
	});
});

describe('extract_photos (SPEC 5.4 photo path, issue #15)', () => {
	const tinyJpeg = () =>
		sharp({ create: { width: 40, height: 30, channels: 3, background: '#888' } })
			.jpeg()
			.toBuffer();

	function photoDb(ids: string[]) {
		const db = new Database(':memory:');
		migrate(db, 'migrations');
		const ins = db.prepare(
			`INSERT INTO image (id, recipe_id, r2_key_full, r2_key_display, width, height, role, created_at)
			 VALUES (?, NULL, ?, ?, 40, 30, 'capture', ?)`
		);
		for (const id of ids) ins.run(id, `images/${id}/full.jpg`, `images/${id}/display.jpg`, '2026');
		return db;
	}

	const jobRow = (image_ids: string[]) =>
		({ kind: 'extract_photos', input_json: JSON.stringify({ image_ids }) }) as JobRow;

	it('sends image blocks in input order, then the spread instruction', async () => {
		const db = photoDb(['b', 'a']);
		vi.mocked(getObject).mockImplementation(async (key) =>
			Buffer.concat([await tinyJpeg(), Buffer.from(key)])
		);
		vi.mocked(claudeCall).mockResolvedValue(draft());
		await extractPhotos(jobRow(['b', 'a']), db);
		const { messages } = vi.mocked(claudeCall).mock.calls.at(-1)![1];
		const blocks = messages[0].content as { type: string; source?: { data: string } }[];
		expect(blocks.map((b) => b.type)).toEqual(['image', 'image', 'text']);
		// getObject was asked for the full keys in the order the ids were captured
		expect(vi.mocked(getObject).mock.calls.map((c) => c[0])).toEqual([
			'images/b/full.jpg',
			'images/a/full.jpg'
		]);
		expect(blocks[2]).toEqual({ type: 'text', text: PHOTOS_INSTRUCTION });
	});

	it('maps an empty extraction to image_unreadable, not no_recipe_found', async () => {
		const db = photoDb(['a']);
		vi.mocked(getObject).mockResolvedValue(await tinyJpeg());
		const empty = draft();
		empty.body.metric.ingredients = [{ heading: null, items: [] }];
		vi.mocked(claudeCall).mockResolvedValue(empty);
		await expect(extractPhotos(jobRow(['a']), db)).rejects.toMatchObject({
			code: 'image_unreadable'
		});
	});

	it('fails with api_error when a referenced image row is missing', async () => {
		await expect(extractPhotos(jobRow(['ghost']), photoDb([]))).rejects.toMatchObject({
			code: 'api_error'
		});
		await expect(extractPhotos(jobRow([]), photoDb([]))).rejects.toBeInstanceOf(JobError);
	});

	it('photoBlocks base64-encodes each page', async () => {
		const buf = await tinyJpeg();
		const blocks = photoBlocks([buf]);
		expect(blocks[0]).toMatchObject({
			type: 'image',
			source: { type: 'base64', media_type: 'image/jpeg', data: buf.toString('base64') }
		});
	});
});

describe('pageContent (issue #43)', () => {
	it('is the stripped text alone when the page has no description or JSON-LD', () => {
		expect(pageContent('<p>Toast the bread.</p><script>track()</script>')).toBe('Toast the bread.');
	});

	it('adds the meta description, decoded, which is all a reel page carries', () => {
		const html = '<meta name="description" content="Caption: 2 eggs &amp; toast &#233;clair"><p>Log in</p>';
		expect(pageContent(html)).toBe('Log in\n\nPage description: Caption: 2 eggs & toast \u00e9clair');
	});

	it('prefers og:description over name=description, in either attribute order', () => {
		const html =
			'<meta name="description" content="short"><meta content="the full caption" property="og:description">';
		expect(pageContent(html)).toBe('Page description: the full caption');
	});

	it('skips an empty description and falls back to the next one', () => {
		const html = '<meta property="og:description" content="  "><meta name="description" content="short">';
		expect(pageContent(html)).toBe('Page description: short');
	});

	it('still appends the JSON-LD preamble after the description', () => {
		const html =
			'<meta property="og:description" content="Soup"><p>Body</p>' +
			'<script type="application/ld+json">{"@type":"Recipe","name":"Soup"}</script>';
		const content = pageContent(html);
		expect(content).toMatch(/^Body\n\nPage description: Soup\n\nAuthoritative structured data/);
		expect(content).toMatch(/\{"@type":"Recipe","name":"Soup"\}$/);
	});

	it('leaves an out-of-range numeric entity alone instead of throwing', () => {
		expect(pageContent('<p>a &#99999999; b</p>')).toBe('a &#99999999; b');
	});
});

describe('extract_url fallback (issue #39)', () => {
	const db = new Database(':memory:');
	const caption = 'Caption: 2 eggs, fry them.';
	const jobRow = (input: { url: string; page?: string; text?: string }) =>
		({ kind: 'extract_url', input_json: JSON.stringify(input) }) as JobRow;
	const blocked = async (): Promise<string> => {
		throw new JobError('fetch_blocked');
	};
	const sentContent = () =>
		vi.mocked(claudeCall).mock.calls.map(([, req]) => req.messages[0].content);

	it('extracts from the page when it is readable, ignoring the caption', async () => {
		vi.mocked(claudeCall).mockReset().mockResolvedValue(draft());
		const page = async () => '<p>Shakshuka from the page</p>';
		await extractUrl(jobRow({ url: 'https://example.com/r', text: caption }), db, page);
		expect(sentContent()).toEqual(['Shakshuka from the page']);
	});

	it('falls back to the text when the page is blocked', async () => {
		vi.mocked(claudeCall).mockReset().mockResolvedValue(draft());
		await extractUrl(jobRow({ url: 'https://example.com/r', text: caption }), db, blocked);
		expect(sentContent()).toEqual([caption]);
	});

	it('fails as before when the page is blocked and there is no text', async () => {
		vi.mocked(claudeCall).mockReset();
		await expect(
			extractUrl(jobRow({ url: 'https://example.com/r' }), db, blocked)
		).rejects.toMatchObject({ code: 'fetch_blocked' });
		expect(claudeCall).not.toHaveBeenCalled();
	});

	it('falls back to the text when the page yields no recipe', async () => {
		const empty = draft();
		empty.body.metric.ingredients = [{ heading: null, items: [] }];
		vi.mocked(claudeCall).mockReset().mockResolvedValueOnce(empty).mockResolvedValueOnce(draft());
		const page = async () => '<p>Log in to see this reel</p>';
		await extractUrl(jobRow({ url: 'https://example.com/r', text: caption }), db, page);
		expect(sentContent()).toEqual(['Log in to see this reel', caption]);
	});

	it('extracts from the phone-rendered page without fetching (issue #43)', async () => {
		vi.mocked(claudeCall).mockReset().mockResolvedValue(draft());
		const fetchSpy = vi.fn(async () => '<p>server copy</p>');
		await extractUrl(jobRow({ url: 'https://example.com/r', page: 'Rendered page' }), db, fetchSpy);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(sentContent()).toEqual(['Rendered page']);
	});

	it('falls back to the text when the rendered page yields no recipe', async () => {
		const empty = draft();
		empty.body.metric.ingredients = [{ heading: null, items: [] }];
		vi.mocked(claudeCall).mockReset().mockResolvedValueOnce(empty).mockResolvedValueOnce(draft());
		const fetchSpy = vi.fn(async () => '<p>server copy</p>');
		await extractUrl(
			jobRow({ url: 'https://example.com/r', page: 'Log in to see this reel', text: caption }),
			db,
			fetchSpy
		);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(sentContent()).toEqual(['Log in to see this reel', caption]);
	});
});
