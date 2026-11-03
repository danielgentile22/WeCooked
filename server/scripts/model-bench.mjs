// Real-network latency benchmark for recipe creation. Not part of the suite.
// Runs the real extract_paste, generate, scale and shopping_merge handlers N
// times against the model given as the first argument, using ANTHROPIC_API_KEY
// from server/.env, and prints wall time per case. Each run costs real API
// calls (a build of three new yields is four calls).
//
// Pick cases with the third argument (scale,shopping_build). BENCH_SHOW=1
// prints the merge output, for comparing list quality across changes.
//
//   node server/scripts/model-bench.mjs claude-opus-5 3
//   node server/scripts/model-bench.mjs claude-haiku-5-5 3
//
// The cover case (issue #72) runs only when asked for. It times the cover
// pick and scores it against sets whose right answer is known, built from
// Brave image hits (BRAVE_SEARCH_API_KEY): one photo of the dish among photos
// of near-miss dishes, and sets where nothing fits. The candidate images are
// fetched once into /tmp/cover-bench and reused by later invocations, so
// every run and every model sees the same images.
//
//   node server/scripts/model-bench.mjs claude-haiku-5-5 3 cover

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import Database from 'better-sqlite3';

const [model, runsArg = '3', casesArg = 'extract_paste,generate'] = process.argv.slice(2);
if (!model) {
	console.error('usage: node server/scripts/model-bench.mjs <model> [runs] [extract_paste,generate,scale,shopping_build,cover]');
	process.exit(2);
}
const runs = Number(runsArg);

const root = fileURLToPath(new URL('..', import.meta.url));
const envFile = `${root}.env`;
if (existsSync(envFile)) process.loadEnvFile(envFile);
process.env.CLAUDE_MODEL = model;
process.env.COVER_MODEL = model;
const wanted = casesArg.split(',');
process.env.DAILY_CALL_CAP = '1000';

const PASTE = `Lemon Garlic Chicken Thighs with Potatoes
Serves 4. Prep 15 min, cook 45 min.

For the marinade:
3 tbsp olive oil
4 cloves garlic, minced
Zest and juice of 1 lemon
1 tsp dried oregano
1 tsp kosher salt
1/2 tsp black pepper

For the tray:
8 bone-in, skin-on chicken thighs (about 2 1/2 lb)
1 1/2 lb baby potatoes, halved
1 red onion, cut into wedges
1/2 cup chicken stock
2 tbsp chopped parsley

1. Heat the oven to 425F. Whisk the marinade ingredients together in a large bowl.
2. Add the chicken and potatoes and toss to coat. Let sit 10 minutes.
3. Spread the potatoes and onion in a roasting tin and set the chicken on top, skin side up. Pour the stock around the edges.
4. Roast 40 to 45 minutes, until the skin is crisp and the chicken reaches 175F.
5. Rest 5 minutes, scatter with parsley and serve with the pan juices.`;

// Each set: the dish, then near misses a careless pick could take for it.
const COVER_SETS = [
	['Shakshuka', 'Huevos rancheros', 'Tomato soup', 'Eggs Benedict'],
	['Lemon drizzle cake', 'Victoria sponge', 'Banana bread', 'Lemon meringue pie'],
	['Chicken tikka masala', 'Chicken biryani', 'Beef rendang', 'Chana masala'],
	['Pad thai', 'Chow mein', 'Spaghetti carbonara', 'Pho'],
	['Beef stew', 'Chilli con carne', 'French onion soup', 'Shepherds pie'],
	['Caesar salad', 'Greek salad', 'Coleslaw', 'Club sandwich']
];
// Usable hits to pass over because they are not a plain photo of the dish
// (a step collage, a spread of raw ingredients), checked by eye.
const COVER_SKIP = { Shakshuka: 1, 'Pad thai': 2 };

const GENERATE = {
	description: 'Something vegetarian with chickpeas and spinach, about 30 minutes, cosy for a weeknight',
	yield_count: 2,
	picked: null
};

// Three recipes for scale and the build: one metric, one US-sourced, one
// sharing ingredients with the first so the merge has lines to combine.
const recipe = (title, source_units, items, counterpart, steps) => ({
	title,
	yield_count: 4,
	yield_unit: 'servings',
	prep_minutes: 15,
	cook_minutes: 40,
	source_text: null,
	source_url: null,
	notes: null,
	source_units,
	meal_types: [],
	cuisine: null,
	protein: null,
	effort: 'weeknight',
	damage: 'messy',
	ingredients: [{ heading: null, items }],
	steps,
	counterpart: { ingredients: [{ heading: null, items: counterpart }], steps },
	image_ids: [],
	cover_image_id: null
});
const RECIPES = [
	recipe(
		'Chickpea and spinach stew',
		'metric',
		['2 tbsp olive oil', '1 onion, diced', '3 cloves garlic', '1 tsp ground cumin', '800 g tinned chickpeas', '400 g tinned tomatoes', '200 g spinach', '1 tsp salt'],
		['2 tbsp olive oil', '1 onion, diced', '3 cloves garlic', '1 tsp ground cumin', '28 oz canned chickpeas', '14 oz canned tomatoes', '7 oz spinach', '1 tsp salt'],
		['Soften the onion and garlic in the oil, 8 minutes.', 'Add cumin, chickpeas and tomatoes; simmer 20 minutes in a 24 cm pan.', 'Wilt in the spinach and season.']
	),
	recipe(
		'Weeknight chili',
		'us',
		['1 lb ground beef', '1 onion, diced', '2 cloves garlic', '2 tbsp chili powder', '1 (15 oz) can kidney beans', '1 (14.5 oz) can diced tomatoes', '1 tsp kosher salt'],
		['450 g beef mince', '1 onion, diced', '2 cloves garlic', '2 tbsp chilli powder', '400 g tinned kidney beans', '400 g tinned chopped tomatoes', '1 tsp kosher salt'],
		['Brown the beef with the onion in a Dutch oven, 10 minutes.', 'Stir in garlic and chili powder, then beans and tomatoes.', 'Simmer 30 minutes until thick.']
	),
	recipe(
		'Garlic roast potatoes',
		'metric',
		['1 kg potatoes', '3 tbsp olive oil', '6 cloves garlic', '1 tsp salt', '2 sprigs rosemary'],
		['2 1/4 lb potatoes', '3 tbsp olive oil', '6 cloves garlic', '1 tsp salt', '2 sprigs rosemary'],
		['Parboil the potatoes 8 minutes.', 'Toss with oil, garlic and rosemary in a 30 x 40 cm tin.', 'Roast at 220°C for 45 minutes.']
	)
];

process.chdir(root);
const vite = await createServer({ logLevel: 'error', server: { middlewareMode: true }, appType: 'custom' });
try {
	const { extractPaste } = await vite.ssrLoadModule('/src/lib/server/extract.ts');
	const { generate } = await vite.ssrLoadModule('/src/lib/server/generate.ts');
	const { migrate } = await vite.ssrLoadModule('/src/lib/server/migrate.ts');
	const { scale } = await vite.ssrLoadModule('/src/lib/server/scale.ts');
	const { shoppingMerge, requestBuild, getShoppingState } = await vite.ssrLoadModule(
		'/src/lib/server/shopping.ts'
	);
	const { createRecipe } = await vite.ssrLoadModule('/src/lib/server/recipes.ts');
	const db = new Database(':memory:');
	migrate(db, `${root}migrations`);

	const job = (input) => ({ id: 'bench', input_json: JSON.stringify(input) });
	// Each run scales to a yield no earlier run made, so nothing is reused.
	let yieldStep = 0;
	const nextYield = () => 5 + ++yieldStep;
	const ids = RECIPES.map((r) => createRecipe(db, r));
	const cases = [
		['extract_paste', () => extractPaste(job({ text: PASTE }), db)],
		['generate', () => generate(job(GENERATE), db)],
		[
			'scale',
			async () => {
				await scale(job({ recipe_id: ids[0], to_count: nextYield() }), db);
				return { title: 'scaled' };
			}
		],
		[
			'shopping_build',
			async () => {
				const n = nextYield();
				const { job_id } = requestBuild(db, ids.map((recipe_id) => ({ recipe_id, yield_count: n })));
				await shoppingMerge(db.prepare('SELECT * FROM job WHERE id = ?').get(job_id), db);
				db.prepare(`UPDATE job SET status = 'done' WHERE id = ?`).run(job_id);
				const items = getShoppingState(db).items;
				if (process.env.BENCH_SHOW)
					for (const i of items)
						console.log(`\t${i.section}\t${i.text_metric}\t|\t${i.text_us}\t|\t${i.from_titles.join(', ')}`);
				return { title: `${items.length} lines` };
			}
		]
	];
	if (wanted.includes('cover')) cases.push(...(await coverCases(db)));
	for (const [name, fn] of cases.filter(([n]) => wanted.some((w) => n.startsWith(w)))) {
		const times = [];
		for (let i = 0; i < runs; i++) {
			const t = performance.now();
			try {
				const out = await fn();
				const s = (performance.now() - t) / 1000;
				times.push(s);
				const n = out.candidates ? out.candidates.length + ' candidates' : (out.title ?? out.note);
				console.log(`${model}\t${name}\trun ${i + 1}\t${s.toFixed(1)}s\t${n}`);
			} catch (e) {
				console.log(`${model}\t${name}\trun ${i + 1}\tFAILED\t${e.code ?? ''} ${e.message}`);
			}
		}
		if (times.length) {
			const avg = times.reduce((a, b) => a + b, 0) / times.length;
			console.log(`${model}\t${name}\tmean ${avg.toFixed(1)}s over ${times.length}`);
		}
	}
} finally {
	await vite.close();
}

/** One case per known-answer set: [name, fn] where fn reports the pick, the
 *  expected index and whether they match. Prints the score as it goes. */
async function coverCases(db) {
	const { claudePick, coverQuery, fetchImage } = await vite.ssrLoadModule('/src/lib/server/cover.ts');
	const { searchImages } = await vite.ssrLoadModule('/src/lib/server/imagesearch.ts');
	const { deriveThumb } = await vite.ssrLoadModule('/src/lib/server/images.ts');
	const { mkdirSync, readFileSync, writeFileSync } = await import('node:fs');
	const dir = '/tmp/cover-bench';
	mkdirSync(dir, { recursive: true });
	const firstPhoto = async (title) => {
		let skip = COVER_SKIP[title] ?? 0;
		for (const hit of await searchImages(coverQuery(title), 10)) {
			const full = await fetchImage(hit.image_url);
			if (full && skip-- === 0) return deriveThumb(full);
		}
		throw new Error(`no usable image for ${title}`);
	};
	const photos = new Map();
	// Kept between invocations so every model is scored on the same images.
	for (const title of COVER_SETS.flat()) {
		const file = `${dir}/${title.replaceAll(' ', '-')}.jpg`;
		if (!existsSync(file)) writeFileSync(file, await firstPhoto(title));
		photos.set(title, readFileSync(file));
	}
	const sets = COVER_SETS.flatMap(([dish, ...misses], i) => {
		// The dish moves through every position across the sets.
		const at = i % (misses.length + 1);
		const withDish = [...misses.slice(0, at), dish, ...misses.slice(at)];
		return [
			{ title: dish, images: withDish, expect: at },
			// Nothing fits: the near misses alone, asked for the dish.
			...(i % 2 === 0 ? [{ title: dish, images: misses, expect: -1 }] : [])
		];
	});
	const score = new Map();
	return sets.map((set, i) => [
		`cover ${i} ${set.title}${set.expect < 0 ? ' (none)' : ''}`,
		async () => {
			const pick = await claudePick(
				db,
				set.title,
				set.images.map((t) => photos.get(t))
			);
			const ok = pick === set.expect;
			const s = score.get(model) ?? { ok: 0, n: 0 };
			score.set(model, { ok: s.ok + (ok ? 1 : 0), n: s.n + 1 });
			const { ok: right, n } = score.get(model);
			return { note: `pick ${pick} expected ${set.expect} ${ok ? 'right' : 'WRONG'} (${right}/${n} so far)` };
		}
	]);
}
