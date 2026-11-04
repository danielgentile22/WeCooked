import { error } from '@sveltejs/kit';
import { getObject, localStore } from '#lib/server/r2.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
	if (!localStore()) error(404);
	const body = await getObject(params.key).catch(() => error(404));
	const type = params.key.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
	return new Response(new Uint8Array(body), { headers: { 'content-type': type } });
};
