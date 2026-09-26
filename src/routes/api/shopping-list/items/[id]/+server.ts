import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import db from '$lib/server/db';
import { setTicked } from '$lib/server/shopping';

// A tick is a per-item POST, last write wins, idempotent (ADR-033).
export const POST: RequestHandler = async ({ params, request }) => {
	const body = (await request.json().catch(() => null)) as { ticked?: unknown } | null;
	if (!body) error(400, 'Malformed JSON.');
	const { ticked } = body;
	setTicked(db, params.id, !!ticked);
	return json({ ok: true });
};
