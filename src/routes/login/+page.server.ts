import { fail, redirect } from '@sveltejs/kit';
import { verify } from '@node-rs/argon2';
import { env } from '$env/dynamic/private';
import { setSessionCookie } from '$lib/server/session';
import type { Actions } from './$types';

// 5 failed attempts per IP per 15 minutes, in memory (SPEC 8.5).
// The Map is unbounded and only pruned on read. Fine for two users behind Fly.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const failures = new Map<string, number[]>();

function recentFailures(ip: string): number[] {
	const cutoff = Date.now() - WINDOW_MS;
	const kept = (failures.get(ip) ?? []).filter((t) => t > cutoff);
	failures.set(ip, kept);
	return kept;
}

export const actions: Actions = {
	default: async ({ request, cookies, getClientAddress }) => {
		// Fly-Client-IP, not the socket address, or every attempt is Fly's proxy
		const ip = request.headers.get('fly-client-ip') ?? getClientAddress();
		const attempts = recentFailures(ip);
		if (attempts.length >= MAX_FAILURES) {
			return fail(429, { error: 'Too many attempts. Try again in 15 minutes.' });
		}
		// Count the attempt before the slow verify, so parallel requests all see
		// it. A success clears the slate below.
		attempts.push(Date.now());
		const password = (await request.formData()).get('password');
		const ok =
			typeof password === 'string' &&
			password.length > 0 &&
			(await verify(env.APP_PASSWORD_HASH ?? '', password).catch(() => false));
		if (!ok) return fail(400, { error: 'Wrong password.' });
		failures.delete(ip);
		setSessionCookie(cookies, Date.now());
		redirect(303, '/');
	}
};
