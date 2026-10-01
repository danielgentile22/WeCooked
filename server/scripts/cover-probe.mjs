// Real-network smoke test for found covers (issue #44, ADR-043). Not part of
// the suite. A URL argument reads that page's own photos; anything else is a
// recipe title sent to Brave Image Search with BRAVE_SEARCH_API_KEY from
// server/.env. Either way each candidate goes through fetchImage, so the
// output shows which ones the cover job would accept.
//
//   node server/scripts/cover-probe.mjs https://www.seriouseats.com/shakshuka-recipe
//   node server/scripts/cover-probe.mjs "Lemon drizzle cake"

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const arg = process.argv.slice(2).join(' ').trim();
if (!arg) {
	console.error('usage: node server/scripts/cover-probe.mjs <url-or-title>');
	process.exit(2);
}

const root = fileURLToPath(new URL('..', import.meta.url));
const envFile = `${root}.env`;
if (existsSync(envFile)) process.loadEnvFile(envFile);

// Vite resolves the $lib and $env imports the server modules use; SvelteKit
// finds its config from the working directory.
process.chdir(root);
const vite = await createServer({ logLevel: 'error', server: { middlewareMode: true }, appType: 'custom' });
try {
	const { fetchPage, pageImages } = await vite.ssrLoadModule('/src/lib/server/extract.ts');
	const { coverQuery, fetchImage } = await vite.ssrLoadModule('/src/lib/server/cover.ts');
	const { searchImages } = await vite.ssrLoadModule('/src/lib/server/imagesearch.ts');

	let candidates;
	if (/^https?:\/\//.test(arg)) {
		candidates = pageImages(await fetchPage(arg), arg).map((url) => ({ url, note: '' }));
		console.log(`${candidates.length} page image(s) on ${arg}`);
	} else {
		const key = process.env.BRAVE_SEARCH_API_KEY;
		if (!key) throw new Error('BRAVE_SEARCH_API_KEY is not set in server/.env');
		const query = coverQuery(arg);
		const hits = await searchImages(query, key);
		candidates = hits.map((h) => ({ url: h.image_url, note: `${h.title} <${h.page_url}>` }));
		console.log(`${candidates.length} image hit(s) for "${query}"`);
	}
	for (const [i, c] of candidates.entries()) {
		const full = await fetchImage(c.url);
		console.log(`${i}  ${full ? `accept ${full.length} B` : 'reject'}  ${c.url}${c.note ? `  ${c.note}` : ''}`);
	}
} finally {
	await vite.close();
}
