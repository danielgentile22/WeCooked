import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import db from '$lib/server/db';
import type { JobRow } from '$lib/server/jobs';
import {
	discardDraft,
	draftView,
	getDraftJob,
	getGenerationJob,
	pickCandidate,
	retryDraft,
	saveDraft
} from '$lib/server/drafts';
import { createJob } from '$lib/server/jobs';
import type { GenerateInput } from '$lib/extract';
import { findDraftCover } from '$lib/server/cover';

// The draft review page (SPEC 6.5): the job row is the draft. Done jobs seed
// the form from result_json; failed jobs open it empty with the source text
// attached; save claims the job; discard hard-deletes it.

function draftJob(id: string): JobRow {
	const job = getDraftJob(db, id);
	if (!job) error(404, 'No such draft.');
	return job;
}

function generationJob(id: string): JobRow {
	const job = getGenerationJob(db, id);
	if (!job) error(404, 'No such generation.');
	return job;
}

export const load: PageServerLoad = ({ params }) => {
	const job = draftJob(params.id);
	if (job.recipe_id) redirect(303, `/recipes/${job.recipe_id}`);
	return draftView(db, job);
};

export const actions: Actions = {
	save: async ({ params, request }) => {
		const job = draftJob(params.id);
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
		const job = draftJob(params.id);
		try {
			discardDraft(db, job);
		} catch (e) {
			return fail(400, { error: e instanceof Error ? e.message : 'Could not discard.' });
		}
		redirect(303, '/');
	},

	retry: async ({ params }) => {
		retryDraft(db, draftJob(params.id)); // 404s non-draft jobs; only drafts retry here
		redirect(303, `/drafts/${params.id}`);
	},

	// Issue #41: the deck's "Pick this one". The row becomes an ordinary draft
	// seeded from the candidate, so the reload lands on the review form.
	pick: async ({ params, request }) => {
		const index = Number((await request.formData()).get('index'));
		try {
			pickCandidate(db, generationJob(params.id), index);
		} catch (e) {
			return fail(400, { error: e instanceof Error ? e.message : 'Could not pick.' });
		}
		redirect(303, `/drafts/${params.id}`);
	},

	// The deck's "Try again" (EditorModel.tryAgain): a fresh generation from
	// the same description and yield replaces this one. The new set is already
	// on its way, so a refused discard only leaves the old card on Recipes.
	tryAgain: async ({ params }) => {
		const old = generationJob(params.id);
		const { description, yield_count } = JSON.parse(old.input_json) as GenerateInput;
		const input: GenerateInput = { description, yield_count, picked: null };
		const id = createJob(db, 'generate', input);
		try {
			discardDraft(db, old);
		} catch {
			// still running: the card stays for the cook to discard later
		}
		redirect(303, `/drafts/${id}`);
	},

	// Issue #44 "Find another photo": a cover job past the found cover.
	findCover: async ({ params }) => {
		try {
			findDraftCover(db, draftJob(params.id));
		} catch (e) {
			return fail(400, { error: e instanceof Error ? e.message : 'Could not look for a photo.' });
		}
		return { ok: true };
	}
};
