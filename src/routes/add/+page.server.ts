import { fail, redirect } from '@sveltejs/kit';
import type { Actions } from './$types';
import db from '$lib/server/db';
import { createJob } from '$lib/server/jobs';

export const actions: Actions = {
	default: async ({ request }) => {
		const text = String((await request.formData()).get('text') ?? '').trim();
		if (!text) return fail(400, { error: 'Paste some recipe text first.' });
		// The D3 box takes URLs too, but the URL path is a later issue. Until
		// then, be honest instead of feeding a bare link to the model.
		if (/^https?:\/\/\S+$/.test(text))
			return fail(400, {
				error: 'Reading a link is not built yet. Open the page and paste the recipe text itself.'
			});
		createJob(db, 'extract_paste', { text });
		// The job card on browse is the draft (SPEC 6.5); nothing to wait for here.
		redirect(303, '/');
	}
};
