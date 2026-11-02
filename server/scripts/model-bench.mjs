// Real-network latency benchmark for recipe creation. Not part of the suite.
// Runs the real extract_paste and generate handlers N times against the model
// given as the first argument, using ANTHROPIC_API_KEY from server/.env, and
// prints wall time per call. Each run costs real API calls.
//
//   node server/scripts/model-bench.mjs claude-opus-5 3
//   node server/scripts/model-bench.mjs claude-haiku-5-5 3

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import Database from 'better-sqlite3';

const [model, runsArg = '3'] = process.argv.slice(2);
if (!model) {
	console.error('usage: node server/scripts/model-bench.mjs <model> [runs]');
	process.exit(2);
}
const runs = Number(runsArg);

const root = fileURLToPath(new URL('..', import.meta.url));
const envFile = `${root}.env`;
if (existsSync(envFile)) process.loadEnvFile(envFile);
process.env.CLAUDE_MODEL = model;
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
	for (const [name, fn] of cases) {
		const times = [];
		for (let i = 0; i < runs; i++) {
			const t = performance.now();
			try {
				const out = await fn();
				const s = (performance.now() - t) / 1000;
				times.push(s);
				const n = out.candidates ? out.candidates.length + ' candidates' : out.title;
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
