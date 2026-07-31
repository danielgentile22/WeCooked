import { redirect, type Handle } from '@sveltejs/kit';
import {
	SESSION_COOKIE,
	REISSUE_AFTER_MS,
	verifySession,
	setSessionCookie
} from '$lib/server/session';
import { dev } from '$app/environment';
import db from '$lib/server/db'; // opens the database and runs migrations at boot
import { recoverInterrupted, startRunner, JobError, type Handlers } from '$lib/server/jobs';
import { extractPaste, extractUrl } from '$lib/server/extract';

// Job handlers land here as their features are built.
const handlers: Handlers = { extract_paste: extractPaste, extract_url: extractUrl };
if (dev) {
	// Stub for exercising the runner via POST /api/dev/jobs before real
	// handlers exist (issue #12). Rides the 'reconvert' kind because the
	// schema CHECK only admits the six real kinds; ??= so the real reconvert
	// handler wins the slot once it exists, then delete this stub.
	handlers.reconvert ??= async (job) => {
		const input = JSON.parse(job.input_json);
		await new Promise((r) => setTimeout(r, input.delay_ms ?? 0));
		if (input.fail) throw new JobError(input.fail);
		return { echo: input };
	};
}

// Guard against double-starting the runner across dev HMR reloads.
const g = globalThis as typeof globalThis & { __jobRunner?: { stop: () => void } };
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
