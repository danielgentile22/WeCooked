import { env } from '$env/dynamic/private';

// ADR-043: the cover search. Brave Image Search, one GET per cover job that
// found nothing on the source page. Only the query (the recipe title) leaves
// the server.

export type ImageHit = { image_url: string; title: string; page_url: string };

const ENDPOINT = 'https://api.search.brave.com/res/v1/images/search';

let warned = false;

/** Parse Brave's results tolerantly: a hit without a usable image URL is skipped. */
export function parseImageResults(data: unknown): ImageHit[] {
	const results = (data as { results?: unknown })?.results;
	if (!Array.isArray(results)) return [];
	return results.flatMap((r) => {
		const hit = (r ?? {}) as {
			title?: unknown;
			url?: unknown;
			properties?: { url?: unknown };
			thumbnail?: { src?: unknown };
		};
		const image = hit.properties?.url ?? hit.thumbnail?.src;
		if (typeof image !== 'string' || !image) return [];
		return [
			{
				image_url: image,
				title: typeof hit.title === 'string' ? hit.title : '',
				page_url: typeof hit.url === 'string' ? hit.url : ''
			}
		];
	});
}

/** Image hits for query, best first. No key means no search, never a failure. */
export async function searchImages(
	query: string,
	key = env.BRAVE_SEARCH_API_KEY,
	fetchFn: typeof fetch = fetch
): Promise<ImageHit[]> {
	if (!key) {
		if (!warned) console.warn('BRAVE_SEARCH_API_KEY is not set; cover search is off.');
		warned = true;
		return [];
	}
	const params = new URLSearchParams({ q: query, count: '10', safesearch: 'strict', country: 'us' });
	const res = await fetchFn(`${ENDPOINT}?${params}`, {
		headers: { 'X-Subscription-Token': key, Accept: 'application/json' },
		signal: AbortSignal.timeout(10_000)
	});
	if (!res.ok) throw new Error(`Brave image search: HTTP ${res.status} ${await res.text()}`);
	return parseImageResults(await res.json());
}
