import { fail, redirect } from '@sveltejs/kit';
import type { Actions } from './$types';
import db from '$lib/server/db';
import { createJob } from '$lib/server/jobs';

export const actions: Actions = {
	default: async ({ request }) => {
		const text = String((await request.formData()).get('text') ?? '').trim();
		if (!text) return fail(400, { error: 'Paste some recipe text first.' });
		// SPEC 7.1: one box, text or URL. A lone link takes the URL path;
		// anything else is recipe text.
		if (/^https?:\/\/\S+$/.test(text)) createJob(db, 'extract_url', { url: text });
		else createJob(db, 'extract_paste', { text });
		// The job card on browse is the draft (SPEC 6.5); nothing to wait for here.
		redirect(303, '/');
	}
};
