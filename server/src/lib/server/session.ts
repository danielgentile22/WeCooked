import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { dev } from '$app/environment';
import type { Cookies } from '@sveltejs/kit';

// Signed HttpOnly session cookie: HMAC over an issued-at timestamp (SPEC 8.5).
// No session table; rotating SESSION_SECRET logs everyone out.

export const SESSION_COOKIE = 'session';
const YEAR_S = 365 * 24 * 3600;
export const REISSUE_AFTER_MS = 30 * 24 * 3600 * 1000; // slide the year monthly (ADR-031)

// Fail closed: signing with a missing secret would mint forgeable cookies.
function secret(): string {
	if (!env.SESSION_SECRET) throw new Error('SESSION_SECRET is not set');
	return env.SESSION_SECRET;
}

function sign(payload: string): string {
	return createHmac('sha256', secret()).update(payload).digest('base64url');
}

/** Returns the issued-at epoch ms, or null if missing/invalid/expired. */
export function verifySession(cookie: string | undefined): number | null {
	if (!cookie) return null;
	const dot = cookie.indexOf('.');
	if (dot < 1) return null;
	const payload = cookie.slice(0, dot);
	const mac = Buffer.from(cookie.slice(dot + 1));
	const expected = Buffer.from(sign(payload));
	if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return null;
	const iat = Number(payload);
	if (!Number.isFinite(iat) || Date.now() - iat > YEAR_S * 1000) return null;
	return iat;
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
