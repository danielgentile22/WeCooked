import { json, type RequestEvent } from '@sveltejs/kit';
import db from '../db';
import { deviceIdHeader, dispatch } from './dispatch';
import { routes } from './v1';

/** Parse a SvelteKit request, dispatch it to the v1 table, reply with JSON. */
export async function serve(event: RequestEvent, path: string): Promise<Response> {
	const { request } = event;
	const reply = await dispatch(db, routes, request.method, path, {
		query: event.url.searchParams,
		// Fly-Client-IP, not the socket address, or every client is Fly's proxy.
		ip: request.headers.get('fly-client-ip') ?? event.getClientAddress(),
		deviceId: deviceIdHeader(request.headers.get('x-device-id')),
		ifNoneMatch: request.headers.get('if-none-match') ?? undefined,
		json: () => request.json().catch(() => undefined),
		bytes: async () => Buffer.from(await request.arrayBuffer())
	});
	// no-cache: a client cache may keep a tagged reply but must ask before reusing it.
	const headers = reply.headers ? { ...reply.headers, 'cache-control': 'private, no-cache' } : undefined;
	if (reply.status === 304) return new Response(null, { status: 304, headers });
	return json(reply.body, { status: reply.status, headers });
}
