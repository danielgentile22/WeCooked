import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import db from '#lib/server/db.js';
import { parseWait, waitForJobPoll } from '#lib/server/jobs.js';

// SPEC 6.3 polling contract; ?wait= seconds long-polls (issue #65). Auth via hooks.server.ts.
export const GET: RequestHandler = async ({ params, url, request }) => {
	const wait = parseWait(url.searchParams.get('wait'));
	if (wait === null) error(400, 'Wait must be a number of seconds.');
	const poll = await waitForJobPoll(db, params.id, wait, request.signal);
	if (!poll) error(404, 'No such job.');
	return json(poll);
};
