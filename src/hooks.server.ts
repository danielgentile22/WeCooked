import { redirect, type Handle } from '@sveltejs/kit';
import {
	SESSION_COOKIE,
	REISSUE_AFTER_MS,
	verifySession,
	setSessionCookie
} from '$lib/server/session';
import '$lib/server/db'; // open the database and run migrations at boot

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
