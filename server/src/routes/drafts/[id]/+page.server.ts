import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import db from '$lib/server/db';
import type { JobRow } from '$lib/server/jobs';
import { discardDraft, draftView, getCaptureJob, retryDraft, saveDraft } from '$lib/server/drafts';

// The draft review page (SPEC 6.5): the job row is the draft. Done jobs seed
// the form from result_json; failed jobs open it empty with the source text
// attached; save claims the job; discard hard-deletes it.

function captureJob(id: string): JobRow {
	const job = getCaptureJob(db, id);
	if (!job) error(404, 'No such draft.');
	return job;
}

export const load: PageServerLoad = ({ params }) => {
	const job = captureJob(params.id);
	if (job.recipe_id) redirect(303, `/recipes/${job.recipe_id}`);
	return draftView(db, job);
};

export const actions: Actions = {
	save: async ({ params, request }) => {
		const job = captureJob(params.id);
		if (job.recipe_id) redirect(303, `/recipes/${job.recipe_id}`);
		const payload = (await request.formData()).get('payload');
		if (typeof payload !== 'string') return fail(400, { error: 'Malformed submission.' });
		let id: string;
		try {
			id = saveDraft(db, job, JSON.parse(payload));
		} catch (e) {
			return fail(400, { error: e instanceof Error ? e.message : 'Could not save.' });
		}
		redirect(303, `/recipes/${id}`);
	},

	discard: async ({ params }) => {
		const job = captureJob(params.id);
		try {
			discardDraft(db, job);
		} catch (e) {
			return fail(400, { error: e instanceof Error ? e.message : 'Could not discard.' });
		}
		redirect(303, '/');
	},

	retry: async ({ params }) => {
		retryDraft(db, captureJob(params.id)); // 404s non-capture jobs; only drafts retry here
		redirect(303, `/drafts/${params.id}`);
	}
};
