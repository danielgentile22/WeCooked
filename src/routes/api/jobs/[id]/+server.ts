import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import db from '$lib/server/db';

// SPEC 6.3 polling contract. Auth via hooks.server.ts.
export const GET: RequestHandler = ({ params }) => {
	const row = db
		.prepare(
			'SELECT status, error_code, error_text, recipe_id, variation_id, list_id FROM job WHERE id = ?'
		)
		.get(params.id) as
		| {
				status: string;
				error_code: string | null;
				error_text: string | null;
				recipe_id: string | null;
				variation_id: string | null;
				list_id: string | null;
		  }
		| undefined;
	if (!row) error(404, 'No such job.');
	return json({
		status: row.status,
		error_code: row.error_code,
		error_text: row.error_text,
		result_ref: row.recipe_id ?? row.variation_id ?? row.list_id ?? null
	});
};
