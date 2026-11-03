// One-off for issue #73: gives every photo stored before thumbnails existed
// its 400px WebP thumbnail, by walking POST /images/thumbnails/backfill one
// page at a time. Safe to rerun: the server only touches images that still
// have no thumbnail, so a second run makes nothing (or only what failed).
//
//   cd server && BACKFILL_PASSWORD=<pw> node scripts/backfill-thumbnails.mjs
//   cd server && BACKFILL_BASE=http://localhost:5173/api/v1 node scripts/backfill-thumbnails.mjs --password <pw>

const BASE = process.env.BACKFILL_BASE ?? 'https://wecooked.kitchen/api/v1';
const PAGE = 25;

function passwordFromArgs() {
	const i = process.argv.indexOf('--password');
	if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
	return process.env.BACKFILL_PASSWORD ?? null;
}

async function api(method, path, body, token) {
	const headers = { 'Content-Type': 'application/json' };
	if (token) headers.Authorization = `Bearer ${token}`;
	const res = await fetch(BASE + path, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	const text = await res.text();
	let json = null;
	try {
		json = JSON.parse(text);
	} catch {
		json = null;
	}
	if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${json?.error ?? text}`);
	return json;
}

const password = passwordFromArgs();
if (!password) {
	console.error('Set BACKFILL_PASSWORD or pass --password.');
	process.exit(2);
}

const { token } = await api('POST', '/login', { password });
let after = '';
let made = 0;
let failed = 0;
for (;;) {
	const q = new URLSearchParams({ limit: String(PAGE) });
	if (after) q.set('after', after);
	const page = await api('POST', `/images/thumbnails/backfill?${q}`, undefined, token);
	made += page.made;
	failed += page.failed;
	console.log(`page after ${after || 'start'}: made ${page.made}, failed ${page.failed}`);
	if (!page.next) break;
	after = page.next;
}
console.log(`done: made ${made}, failed ${failed}${failed ? ' (see server logs; rerun to retry)' : ''}`);
