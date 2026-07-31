import { redirect, type Handle } from '@sveltejs/kit';
import {
	SESSION_COOKIE,
	REISSUE_AFTER_MS,
	verifySession,
	setSessionCookie
} from '$lib/server/session';
import db from '$lib/server/db'; // opens the database and runs migrations at boot
import { recoverInterrupted, startRunner, type Handlers } from '$lib/server/jobs';
import { extractPaste, extractPhotos, extractUrl } from '$lib/server/extract';
import { reconvert } from '$lib/server/reconvert';
import { scale } from '$lib/server/scale';
import { shoppingMerge } from '$lib/server/shopping';

// Job handlers land here as their features are built.
const handlers: Handlers = {
	extract_paste: extractPaste,
	extract_url: extractUrl,
	extract_photos: extractPhotos,
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

const PUBLIC_PATHS = new Set(['/login', '/healthz']);

// The single auth gate (SPEC 8.5): every route except /login and /healthz
// requires the session cookie.
export const handle: Handle = async ({ event, resolve }) => {
	const iat = verifySession(event.cookies.get(SESSION_COOKIE));
	if (!PUBLIC_PATHS.has(event.url.pathname)) {
		if (iat === null) redirect(303, '/login');
		if (Date.now() - iat > REISSUE_AFTER_MS) setSessionCookie(event.cookies, Date.now());
	} else if (event.url.pathname === '/login' && iat !== null) {
		redirect(303, '/');
	}
	return resolve(event);
};
