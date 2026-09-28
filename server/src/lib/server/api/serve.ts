import { json, type RequestEvent } from '@sveltejs/kit';
import db from '../db';
import { dispatch } from './dispatch';
import { routes } from './v1';

/** Parse a SvelteKit request, dispatch it to the v1 table, reply with JSON. */
export async function serve(event: RequestEvent, path: string): Promise<Response> {
	const { request } = event;
	const reply = await dispatch(db, routes, request.method, path, {
		query: event.url.searchParams,
		// Fly-Client-IP, not the socket address, or every client is Fly's proxy.
		ip: request.headers.get('fly-client-ip') ?? event.getClientAddress(),
		json: () => request.json().catch(() => undefined),
		bytes: async () => Buffer.from(await request.arrayBuffer())
	});
	return json(reply.body, { status: reply.status });
}
