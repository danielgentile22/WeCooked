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
		const id = url
			? createJob(db, 'extract_url', { url })
			: createJob(db, 'extract_paste', { text });
		// The draft page shows the extraction as it runs (AddTab.extractButton).
		redirect(303, `/drafts/${id}`);
	},

	// SPEC 7.1 photo path: images are already uploaded (recipe_id NULL,
	// ADR-024); the job records their ids in page order.
	photos: async ({ request }) => {
		let image_ids: unknown;
		try {
			image_ids = JSON.parse(String((await request.formData()).get('image_ids') ?? ''));
		} catch {
			return fail(400, { photoError: 'Malformed submission.' });
		}
		if (
			!Array.isArray(image_ids) ||
			image_ids.length === 0 ||
			image_ids.some((i) => typeof i !== 'string')
		)
			return fail(400, { photoError: 'Add at least one photo first.' });
		// SPEC 5.8 headroom: one recipe never spans this many pages, and a cap
		// bounds the sharp fan-out and the request Claude sees.
		if (image_ids.length > 10) return fail(400, { photoError: 'At most 10 pages per recipe.' });
		redirect(303, `/drafts/${createJob(db, 'extract_photos', { image_ids })}`);
	}
};
