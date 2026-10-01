import type { Database } from 'better-sqlite3';

// A tiny router for /api/v1: a table of routes, one dispatch, and one error
// shape. Handlers take the database and a parsed request and return the reply
// body; they never see SvelteKit, so tests call dispatch directly.

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type ApiRequest = {
	params: Record<string, string>;
	query: URLSearchParams;
	/** Client IP, for the login rate limit. */
	ip: string;
	/** The phone's install id from X-Device-Id (issue #42), already parsed. */
	deviceId: string | undefined;
	/** The JSON body, or undefined when it is empty or malformed. */
	json(): Promise<unknown>;
	bytes(): Promise<Buffer>;
};

/** X-Device-Id is a UUID from the app; anything blank or oversized is ignored, not refused. */
export function deviceIdHeader(raw: string | null): string | undefined {
	const id = raw?.trim();
	return id && id.length <= 64 ? id : undefined;
}

export type Route = {
	method: Method;
	/** Segments; `:name` captures one into params. */
	path: string;
	run: (db: Database, req: ApiRequest) => unknown;
};

/** Every error reply is `{error}` with this status. */
export class ApiError extends Error {
	constructor(
		public status: number,
		message: string
	) {
		super(message);
	}
}

export type Reply = { status: number; body: unknown };

/**
 * The $lib/server functions throw plain Errors whose message is written for
 * the user; the form actions turn those into 400s, and so does this.
 */
export function guard<T>(fn: () => T): T {
	try {
		return fn();
	} catch (e) {
		if (e instanceof Error && !(e instanceof ApiError)) throw new ApiError(400, e.message);
		throw e;
	}
}

function match(pattern: string, path: string): Record<string, string> | null {
	const want = pattern.split('/').filter(Boolean);
	const got = path.split('/').filter(Boolean);
	if (want.length !== got.length) return null;
	const params: Record<string, string> = {};
	for (let i = 0; i < want.length; i++) {
		if (want[i].startsWith(':')) params[want[i].slice(1)] = decodeURIComponent(got[i]);
		else if (want[i] !== got[i]) return null;
	}
	return params;
}

export async function dispatch(
	db: Database,
	routes: readonly Route[],
	method: string,
	path: string,
	req: Omit<ApiRequest, 'params'>
): Promise<Reply> {
	let pathMatched = false;
	for (const route of routes) {
		const params = match(route.path, path);
		if (!params) continue;
		pathMatched = true;
		if (route.method !== method) continue;
		try {
			return { status: 200, body: await route.run(db, { ...req, params }) };
		} catch (e) {
			if (e instanceof ApiError) return { status: e.status, body: { error: e.message } };
			console.error(`api ${method} ${path} failed:`, e);
			return { status: 500, body: { error: 'Something went wrong.' } };
		}
	}
	return pathMatched
		? { status: 405, body: { error: 'Method not allowed.' } }
		: { status: 404, body: { error: 'Not found.' } };
}
