import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import db from '$lib/server/db';
import { createRecipe } from '$lib/server/recipes';
import { draftToInput, type CaptureInput, type RecipeDraft } from '$lib/extract';
import { isCaptureKind, type JobRow } from '$lib/server/jobs';

// The draft review page (SPEC 6.5): the job row is the draft. Done jobs seed
// the form from result_json; failed jobs open it empty with the source text
// attached; save claims the job; discard hard-deletes it.

function getCaptureJob(id: string): JobRow {
	const job = db.prepare(`SELECT * FROM job WHERE id = ?`).get(id) as JobRow | undefined;
	if (!job || !isCaptureKind(job.kind)) error(404, 'No such draft.');
	return job;
}

export const load: PageServerLoad = ({ params }) => {
	const job = getCaptureJob(params.id);
	if (job.recipe_id) redirect(303, `/recipes/${job.recipe_id}`); // already saved
	const input = JSON.parse(job.input_json) as CaptureInput;
	const draft =
		job.status === 'done' && job.result_json
			? (JSON.parse(job.result_json) as RecipeDraft)
			: null;
	return {
		id: job.id,
		status: job.status,
		error_text: job.error_text,
		source_text: input.text ?? null,
		// The URL rides input_json, not the extraction, so it seeds the form
		// here: on failure too, so a fetch_blocked draft still carries its link.
		initial: draft
			? { ...draftToInput(draft), source_url: input.url ?? null }
			: input.url
				? { source_url: input.url }
				: null,
		warnings: draft?.extraction_warnings ?? [],
		damage_reasoning: draft?.damage_reasoning ?? null
	};
};

export const actions: Actions = {
	// Save claims the job: the recipe id written back is what removes the card
	// from browse (SPEC 6.5). A recipe row exists only after this human step.
	save: async ({ params, request }) => {
		const job = getCaptureJob(params.id);
		if (job.recipe_id) redirect(303, `/recipes/${job.recipe_id}`);
		const payload = (await request.formData()).get('payload');
		if (typeof payload !== 'string') return fail(400, { error: 'Malformed submission.' });
		let id: string;
		try {
			id = createRecipe(db, JSON.parse(payload));
		} catch (e) {
			return fail(400, { error: e instanceof Error ? e.message : 'Could not save.' });
		}
		db.prepare(`UPDATE job SET recipe_id = ? WHERE id = ?`).run(id, job.id);
		redirect(303, `/recipes/${id}`);
	},

	// Discard hard-deletes the job row (machine output, ADR-035) and
	// soft-deletes its capture images. Running jobs cannot be discarded.
	discard: async ({ params }) => {
		const job = getCaptureJob(params.id);
		if (job.status === 'queued' || job.status === 'running')
			return fail(400, { error: 'Still extracting; wait for it to finish.' });
		const imageIds = (JSON.parse(job.input_json) as CaptureInput).image_ids ?? [];
		db.transaction(() => {
			const soft = db.prepare(`UPDATE image SET deleted_at = ? WHERE id = ? AND recipe_id IS NULL`);
			for (const id of imageIds) soft.run(new Date().toISOString(), id);
			db.prepare(`DELETE FROM job WHERE id = ? AND recipe_id IS NULL`).run(job.id);
		})();
		redirect(303, '/');
	},

	// Retry re-queues a failed job; the runner picks it up (SPEC 6.4: a
	// failure is never a dead end).
	retry: async ({ params }) => {
		getCaptureJob(params.id); // 404s non-capture jobs; only drafts retry here
		db.prepare(
			`UPDATE job SET status = 'queued', error_code = NULL, error_text = NULL,
			   result_json = NULL, started_at = NULL, finished_at = NULL
			 WHERE id = ? AND status = 'failed'`
		).run(params.id);
		redirect(303, `/drafts/${params.id}`);
	}
};
