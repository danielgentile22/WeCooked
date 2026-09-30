import { json, redirect, type Handle } from '@sveltejs/kit';
import { SESSION_COOKIE, issueSessionToken, setSessionCookie } from '$lib/server/session';
import { bearerToken, gate } from '$lib/server/gate';
import db from '$lib/server/db'; // opens the database and runs migrations at boot
import { recoverInterrupted, startRunner, type Handlers } from '$lib/server/jobs';
import { extractPaste, extractPhotos, extractUrl } from '$lib/server/extract';
import { generate } from '$lib/server/generate';
import { reconvert } from '$lib/server/reconvert';
import { scale } from '$lib/server/scale';
import { shoppingMerge } from '$lib/server/shopping';

const handlers: Handlers = {
	extract_paste: extractPaste,
	extract_url: extractUrl,
	extract_photos: extractPhotos,
	generate,
	reconvert,
	scale,
	shopping_merge: shoppingMerge
};

// Guard against double-starting the runner across dev HMR reloads.
const g = globalThis as typeof globalThis & {
	__jobRunner?: { stop: () => void };
};
if (!g.__jobRunner) {
	recoverInterrupted(db); // SPEC 6.2
	g.__jobRunner = startRunner(db, handlers);
}

// The single auth gate (SPEC 8.5): every route except /login, /healthz and
// /api/v1/login requires the session, as a cookie or as a bearer token.
export const handle: Handle = async ({ event, resolve }) => {
	const bearer = bearerToken(event.request.headers.get('authorization'));
	const access = gate(event.url.pathname, bearer ?? event.cookies.get(SESSION_COOKIE));
	if (access.kind === 'unauthorized') return json({ error: 'unauthorized' }, { status: 401 });
	if (access.kind === 'redirect') redirect(303, access.location);
	if (access.reissue) {
		if (bearer) event.setHeaders({ 'x-session-token': issueSessionToken(Date.now()) });
		else setSessionCookie(event.cookies, Date.now());
	}
	return resolve(event);
};
