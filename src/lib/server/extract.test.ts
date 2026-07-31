import { describe, expect, it } from 'vitest';
import { draftToInput, hasRecipe, type RecipeDraft } from '$lib/extract';
import { fetchPage, findRecipeJsonLd, stripHtml } from './extract';
import { JobError } from './jobs';
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

	it('maps 5xx and network errors to fetch_failed', async () => {
		expect(await code(fetchPage('https://x.com', async () => resp(500)))).toBe('fetch_failed');
		expect(
			await code(
				fetchPage('https://x.com', () => Promise.reject(new TypeError('getaddrinfo ENOTFOUND')))
			)
		).toBe('fetch_failed');
	});
});

describe('findRecipeJsonLd (SPEC 7.1 step 3)', () => {
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

describe('stripHtml (SPEC 7.1 step 4)', () => {
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
