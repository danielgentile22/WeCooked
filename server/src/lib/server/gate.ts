import { REISSUE_AFTER_MS, verifySession } from './session';

// The single auth gate (SPEC 8.5), as data: hooks.server.ts performs it.
// Pages redirect to /login; /api answers 401 JSON so a native client can tell
// "log in again" from a network failure.

export type Gate =
	| { kind: 'pass'; reissue: boolean }
	| { kind: 'unauthorized' }
	| { kind: 'redirect'; location: '/login' | '/' };

const PUBLIC_PATHS = new Set(['/login', '/healthz', '/api/v1/login']);

/** token: the bearer token if the request sent one, else the cookie value. */
export function gate(pathname: string, token: string | undefined, now = Date.now()): Gate {
	const iat = verifySession(token);
	if (PUBLIC_PATHS.has(pathname)) {
		return pathname === '/login' && iat !== null
			? { kind: 'redirect', location: '/' }
			: { kind: 'pass', reissue: false };
	}
	if (iat === null)
		return pathname.startsWith('/api/')
			? { kind: 'unauthorized' }
			: { kind: 'redirect', location: '/login' };
	return { kind: 'pass', reissue: now - iat > REISSUE_AFTER_MS };
}

/** The token from `Authorization: Bearer <token>`, or undefined. */
export function bearerToken(header: string | null): string | undefined {
	return header?.match(/^Bearer\s+(\S+)$/i)?.[1];
}
