import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import db from '$lib/server/db';
import { setTicked } from '$lib/server/shopping';

// A tick is a per-item POST, last write wins, idempotent (ADR-033).
export const POST: RequestHandler = async ({ params, request }) => {
	const { ticked } = (await request.json()) as { ticked: boolean };
	setTicked(db, params.id, !!ticked);
	return json({ ok: true });
};
