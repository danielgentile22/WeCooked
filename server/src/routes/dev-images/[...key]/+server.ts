import { error } from '@sveltejs/kit';
import { getObject, localStore } from '$lib/server/r2';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
	if (!localStore()) error(404);
	const body = await getObject(params.key).catch(() => error(404));
	return new Response(new Uint8Array(body), { headers: { 'content-type': 'image/jpeg' } });
};
