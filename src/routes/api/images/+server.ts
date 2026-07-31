import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import db from '$lib/server/db';
import { saveImage } from '$lib/server/images';

// Photos upload here before any recipe exists (ADR-024); a later save claims
// them. The body is the client-normalised JPEG, raw. Auth via hooks.server.ts.
export const POST: RequestHandler = async ({ request, url }) => {
	// ?role=capture marks cookbook-page uploads (SPEC 7.1 photo path).
	const role = url.searchParams.get('role') ?? 'photo';
	if (role !== 'photo' && role !== 'capture') error(400, 'Unknown image role.');
	const buf = Buffer.from(await request.arrayBuffer());
	if (buf.length === 0) error(400, 'Empty upload.');
	// A normalised 3000px q90 JPEG is 1-2 MB; anything bigger skipped the client
	// pipeline. 8 MB leaves headroom for very busy pages.
	if (buf.length > 8 * 1024 * 1024) error(413, 'Image too large.');
	try {
		return json(await saveImage(db, buf, role));
	} catch (e) {
		error(400, e instanceof Error ? e.message : 'Could not process image.');
	}
};
