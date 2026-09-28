import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import db from '$lib/server/db';
import { getJobPoll } from '$lib/server/jobs';

// SPEC 6.3 polling contract. Auth via hooks.server.ts.
export const GET: RequestHandler = ({ params }) => {
	const poll = getJobPoll(db, params.id);
	if (!poll) error(404, 'No such job.');
	return json(poll);
};
