// SPEC 8.5: /api answers a lost session with 401 JSON, which only page loads
// turn into the login redirect. The browser's own calls (job polls, the
// shopping poll, ticks, uploads) go through this wrapper, installed once in
// hooks.client.ts, so a 401 from any of them returns to login as on iOS.
export function onUnauthorized(
	inner: typeof fetch,
	origin: string,
	signedOut: () => void
): typeof fetch {
	return async (...args) => {
		const res = await inner(...args);
		if (res.status === 401) {
			const url = new URL(res.url, origin);
			if (url.origin === origin && url.pathname.startsWith('/api/')) signedOut();
		}
		return res;
	};
}
