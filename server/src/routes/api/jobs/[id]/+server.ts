import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import db from '$lib/server/db';
import type { JobPoll } from '$lib/jobs';

// SPEC 6.3 polling contract. Auth via hooks.server.ts.
export const GET: RequestHandler = ({ params }) => {
	const row = db
		.prepare(
			'SELECT status, error_code, error_text, recipe_id, variation_id, list_id FROM job WHERE id = ?'
		)
		.get(params.id) as
		| (Pick<JobPoll, 'status' | 'error_code' | 'error_text'> & {
				recipe_id: string | null;
				variation_id: string | null;
				list_id: string | null;
		  })
		| undefined;
	if (!row) error(404, 'No such job.');
	const body: JobPoll = {
		status: row.status,
		error_code: row.error_code,
		error_text: row.error_text,
		// variation first: a done scale job's ref is the variation it produced
		// (its recipe_id is set from creation, so recipe-first would mask it).
		result_ref: row.variation_id ?? row.recipe_id ?? row.list_id ?? null
	};
	return json(body);
};
