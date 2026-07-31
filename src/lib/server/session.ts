import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { dev } from '$app/environment';
import type { Cookies } from '@sveltejs/kit';

// Signed HttpOnly session cookie: HMAC over an issued-at timestamp (SPEC 8.5).
// No session table; rotating SESSION_SECRET logs everyone out.

export const SESSION_COOKIE = 'session';
const YEAR_S = 365 * 24 * 3600;
export const REISSUE_AFTER_MS = 30 * 24 * 3600 * 1000; // slide the year monthly (ADR-031)

function sign(payload: string): string {
	return createHmac('sha256', env.SESSION_SECRET ?? '').update(payload).digest('base64url');
}

/** Returns the issued-at epoch ms, or null if missing/invalid. */
export function verifySession(cookie: string | undefined): number | null {
	if (!cookie) return null;
	const dot = cookie.indexOf('.');
	if (dot < 1) return null;
	const payload = cookie.slice(0, dot);
	const mac = cookie.slice(dot + 1);
	const expected = sign(payload);
	if (mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected)))
		return null;
	const iat = Number(payload);
	return Number.isFinite(iat) ? iat : null;
}

export function setSessionCookie(cookies: Cookies, iat: number): void {
	const payload = String(iat);
	cookies.set(SESSION_COOKIE, `${payload}.${sign(payload)}`, {
		path: '/',
		httpOnly: true,
		secure: !dev,
		sameSite: 'lax',
		maxAge: YEAR_S
	});
}
