// Real-network latency benchmark for recipe creation. Not part of the suite.
// Runs the real extract_paste and generate handlers N times against the model
// given as the first argument, using ANTHROPIC_API_KEY from server/.env, and
// prints wall time per call. Each run costs real API calls.
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
	console.error('usage: node server/scripts/model-bench.mjs <model> [runs] [extract_paste,generate,cover]');
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

process.chdir(root);
const vite = await createServer({ logLevel: 'error', server: { middlewareMode: true }, appType: 'custom' });
try {
	const { extractPaste } = await vite.ssrLoadModule('/src/lib/server/extract.ts');
	const { generate } = await vite.ssrLoadModule('/src/lib/server/generate.ts');
	const { migrate } = await vite.ssrLoadModule('/src/lib/server/migrate.ts');
	const db = new Database(':memory:');
	migrate(db, `${root}migrations`);

	const job = (input) => ({ id: 'bench', input_json: JSON.stringify(input) });
	const cases = [
		['extract_paste', () => extractPaste(job({ text: PASTE }), db)],
		['generate', () => generate(job(GENERATE), db)]
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
