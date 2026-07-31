import { error, json } from '@sveltejs/kit';
import { dev } from '$app/environment';
import type { RequestHandler } from './$types';
import db from '$lib/server/db';
import { createJob } from '$lib/server/jobs';

// Dev-only: enqueue a stub job to exercise the runner and polling end to end
// before any real extraction exists (issue #12). The stub handler for
// 'reconvert' is registered in hooks.server.ts, dev only.
// Body: { delay_ms?: number, fail?: ErrorCode }
export const POST: RequestHandler = async ({ request }) => {
	if (!dev) error(404, 'Not found');
	const input = await request.json().catch(() => ({}));
	return json({ id: createJob(db, 'reconvert', input) });
};
