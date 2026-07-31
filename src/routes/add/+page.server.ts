import { fail, redirect } from '@sveltejs/kit';
import type { Actions } from './$types';
import db from '$lib/server/db';
import { createJob } from '$lib/server/jobs';
import { asUrl } from '$lib/extract';

export const actions: Actions = {
	paste: async ({ request }) => {
		const text = String((await request.formData()).get('text') ?? '').trim();
		if (!text) return fail(400, { error: 'Paste some recipe text first.' });
		// SPEC 7.1: one box, text or URL. A lone link takes the URL path;
		// anything else is recipe text.
		const url = asUrl(text);
		if (url) createJob(db, 'extract_url', { url });
		else createJob(db, 'extract_paste', { text });
		// The job card on browse is the draft (SPEC 6.5); nothing to wait for here.
		redirect(303, '/');
	},

	// SPEC 7.1 photo path: images are already uploaded (recipe_id NULL,
	// ADR-024); the job records their ids in page order.
	photos: async ({ request }) => {
		let image_ids: unknown;
		try {
			image_ids = JSON.parse(String((await request.formData()).get('image_ids') ?? ''));
		} catch {
			return fail(400, { error: 'Malformed submission.' });
		}
		if (
			!Array.isArray(image_ids) ||
			image_ids.length === 0 ||
			image_ids.some((i) => typeof i !== 'string')
		)
			return fail(400, { error: 'Add at least one photo first.' });
		createJob(db, 'extract_photos', { image_ids });
		redirect(303, '/');
	}
};
