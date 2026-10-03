import { fail, redirect } from '@sveltejs/kit';
import type { Actions } from './$types';
import db from '$lib/server/db';
import { createJob } from '$lib/server/jobs';
import type { GenerateInput } from '$lib/extract';

// Issue #41: a description and a yield become one generate job, the same
// checks as POST /api/v1/generations. The draft page shows the deck.
export const actions: Actions = {
	default: async ({ request }) => {
		const data = await request.formData();
		const description = String(data.get('description') ?? '').trim();
		if (!description || description.length > 1000)
			return fail(400, {
				description,
				error: 'Describe what you want to cook.'
			});
		const count = Number(data.get('yield_count'));
		if (!Number.isInteger(count) || count < 1 || count > 100)
			return fail(400, {
				description,
				error: 'Yield must be a whole number from 1 to 100.'
			});
		const input: GenerateInput = {
			description,
			yield_count: count,
			picked: null
		};
		redirect(303, `/drafts/${createJob(db, 'generate', input)}`);
	}
};
