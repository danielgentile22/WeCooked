// Real-network latency benchmark for recipe creation. Not part of the suite.
// Runs the real extract_paste, generate, extract_photos, scale and
// shopping_merge handlers N times against the model given as the first
// argument, using ANTHROPIC_API_KEY from server/.env, and prints wall time per
// case. Each run costs real API calls (a build of three new yields is four
// calls).
//
// Pick cases with the third argument (scale,shopping_build). BENCH_SHOW=1
// prints the merge output, for comparing list quality across changes.
//
//   node server/scripts/model-bench.mjs claude-opus-5 3
//   node server/scripts/model-bench.mjs claude-haiku-5-5 3
//
// The optional third argument is a comma list of cases to run; the default is
// extract_paste,generate,extract_photos.
//
// extract_photos uploads pages through saveImage into a throwaway local image
// store, then runs the job, so it measures what the cook waits on after the
// upload. Pages come from BENCH_PAGES (a directory of JPEGs, in page order);
// without it the script renders a two-page cookbook spread with small print
// and scores the extraction against the recipe it printed. BENCH_PHOTO_EDGES
// (for example 2576,1568) replaces the stored Claude copy at each long edge in
// turn, to compare sizes (issue #71).
//
//   BENCH_PHOTO_EDGES=2576,1568 node server/scripts/model-bench.mjs claude-sonnet-5-5 3 extract_photos
//
// The cover case (issue #72) runs only when asked for. It times the cover
// pick and scores it against sets whose right answer is known, built from
// Brave image hits (BRAVE_SEARCH_API_KEY): one photo of the dish among photos
// of near-miss dishes, and sets where nothing fits. The candidate images are
// fetched once into /tmp/cover-bench and reused by later invocations, so
// every run and every model sees the same images.
//
//   node server/scripts/model-bench.mjs claude-haiku-5-5 3 cover

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import Database from 'better-sqlite3';
import sharp from 'sharp';

const [model, runsArg = '3', casesArg = 'extract_paste,generate,extract_photos'] = process.argv.slice(2);
if (!model) {
	console.error('usage: node server/scripts/model-bench.mjs <model> [runs] [extract_paste,generate,extract_photos,scale,shopping_build,cover]');
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
const imageDir = mkdtempSync(join(tmpdir(), 'bench-images-'));
process.env.IMAGE_STORE = 'local';
process.env.IMAGE_STORE_DIR = imageDir;

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

// The rendered spread: a metric focaccia set like a cookbook, ingredients on
// the left page and method on the right, with a footnote in smaller type.
// Each needle is a fact the extraction must carry over; the footnote ones test
// small print.
const SPREAD = {
	title: 'Rosemary Focaccia',
	intro: [
		'A soft, dimpled bread that asks for patience more than skill.',
		'Start it the night before if you can: the dough improves with time.'
	],
	serves: 'Makes one 30 x 20 cm tray, serves 8',
	ingredients: [
		'385 g strong white bread flour',
		'7 g fast-action dried yeast',
		'9 g fine sea salt',
		'18 g caster sugar',
		'290 ml lukewarm water',
		'35 ml extra virgin olive oil, plus 4 tbsp for the tin',
		'3 sprigs rosemary, leaves picked',
		'1 tsp flaky salt'
	],
	method: [
		'Whisk the flour, yeast, fine salt and sugar in a large bowl.',
		'Add the water and the 35 ml oil and mix to a shaggy, sticky dough.',
		'Cover and leave for 45 minutes, then stretch and fold 4 times.',
		'Oil the tin, tip in the dough and press it gently to the corners.',
		'Prove for 50 minutes, until puffy and nearly doubled.',
		'Dimple deeply with oiled fingers, scatter with rosemary and flaky salt.',
		'Bake at 230C for 22 minutes, until deep golden.'
	],
	footnote:
		'Note: the dough keeps in the fridge for up to 72 hours. Add 15 minutes to the prove if it is cold.',
	needles: [/385/, /\b7 ?g/, /\b9 ?g/, /\b18 ?g/, /290/, /\b35 ?ml/, /45 min/, /\b4 times/, /50 min/, /230/, /22 min/],
	fine: [/72 hours/, /15 min/]
};

const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
/** A 3000 x 2000 photo of an open book: two cream pages on a dark table,
 *  turned slightly and softened, the way a phone captures a spread. */
async function renderSpread() {
	// Body and footnote sizes match a phone shot of a whole spread: about 9.5pt
	// and 7pt type on a 24 cm page that fills half the frame.
	const W = 3000, H = 2000, BODY = 24, FINE = 17;
	const lines = [];
	const text = (x, y, size, t, weight = 'normal') =>
		lines.push(`<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}">${esc(t)}</text>`);
	let y = 260;
	text(260, y, 64, SPREAD.title, 'bold');
	y += 80;
	for (const t of SPREAD.intro) text(260, (y += BODY * 1.45), BODY, t);
	text(260, (y += BODY * 2.2), BODY, SPREAD.serves, 'bold');
	y += 30;
	for (const t of SPREAD.ingredients) text(260, (y += BODY * 1.6), BODY, t);
	y = 260;
	text(1620, y, 40, 'Method', 'bold');
	SPREAD.method.forEach((t, i) => text(1620, (y += BODY * 2), BODY, `${i + 1}. ${t}`));
	text(1620, 1640, FINE, SPREAD.footnote);
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
		<rect width="100%" height="100%" fill="#3b3631"/>
		<rect x="140" y="110" width="1350" height="1780" fill="#f4eedf"/>
		<rect x="1510" y="110" width="1350" height="1780" fill="#f1ebdb"/>
		<rect x="1480" y="110" width="40" height="1780" fill="#d8cfbb"/>
		<g font-family="Georgia" fill="#2a2622">${lines.join('')}</g></svg>`;
	return sharp(Buffer.from(svg))
		.rotate(1.5, { background: '#3b3631' })
		.resize(W, H, { fit: 'cover' })
		.blur(0.7)
		.jpeg({ quality: 88 })
		.toBuffer();
}

const scoreSpread = (out) => {
	const s = JSON.stringify(out);
	const hit = (rs) => rs.filter((r) => r.test(s)).length;
	return `${hit(SPREAD.needles)}/${SPREAD.needles.length} facts, ${hit(SPREAD.fine)}/${SPREAD.fine.length} small print`;
};

process.chdir(root);
const vite = await createServer({ logLevel: 'error', server: { middlewareMode: true }, appType: 'custom' });
try {
	const { extractPaste, extractPhotos } = await vite.ssrLoadModule('/src/lib/server/extract.ts');
	const { generate } = await vite.ssrLoadModule('/src/lib/server/generate.ts');
	const { saveImage, deriveClaude, CLAUDE_EDGE } = await vite.ssrLoadModule('/src/lib/server/images.ts');
	const { putObject } = await vite.ssrLoadModule('/src/lib/server/r2.ts');
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
	if (wanted.includes('extract_photos')) {
		const dir = process.env.BENCH_PAGES;
		const pages = dir
			? readdirSync(dir).filter((f) => /\.jpe?g$/i.test(f)).sort().map((f) => readFileSync(join(dir, f)))
			: [await renderSpread()];
		const ids = [];
		const t = performance.now();
		for (const page of pages) ids.push((await saveImage(db, page, 'capture')).id);
		console.log(`${model}\tupload\t${pages.length} page(s)\t${((performance.now() - t) / 1000).toFixed(1)}s`);
		const edges = (process.env.BENCH_PHOTO_EDGES || String(CLAUDE_EDGE)).split(',').map(Number);
		for (const edge of edges) {
			// Untimed setup: store each page's Claude copy at this edge, as the
			// upload would have.
			const setup = async () => {
				let bytes = 0;
				for (const id of ids) {
					const { r2_key_full, r2_key_claude } = db
						.prepare('SELECT r2_key_full, r2_key_claude FROM image WHERE id = ?')
						.get(id);
					const copy = await deriveClaude(readFileSync(join(imageDir, r2_key_full)), edge);
					await putObject(r2_key_claude, copy);
					bytes += copy.length;
				}
				return `${Math.round(bytes / 1024)} KB sent`;
			};
			cases.push([`extract_photos@${edge}`, () => extractPhotos(job({ image_ids: ids }), db), setup, !dir]);
		}
	}
	for (const [name, fn, setup, scored] of cases.filter(([n]) => wanted.some((w) => n.startsWith(w)))) {
		const times = [];
		const note = setup ? `\t${await setup()}` : '';
		for (let i = 0; i < runs; i++) {
			const t = performance.now();
			try {
				const out = await fn();
				const s = (performance.now() - t) / 1000;
				times.push(s);
				const n = out.candidates ? out.candidates.length + ' candidates' : (out.title ?? out.note);
				const q = scored ? `\t${scoreSpread(out)}` : '';
				console.log(`${model}\t${name}\trun ${i + 1}\t${s.toFixed(1)}s\t${n}${note}${q}`);
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
	rmSync(imageDir, { recursive: true, force: true });
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
