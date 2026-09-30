import type { Database } from 'better-sqlite3';
import { createRecipe } from './recipes';
import { DRAFT_KINDS, isDraftKind, type JobRow } from './jobs';
import { presignGet } from './r2';
import { draftToInput, type CaptureInput, type RecipeDraft } from '$lib/extract';
import type { RecipeInput } from '$lib/tags';

// Drafts (SPEC 6.5): every capture job without a recipe is a draft. The job
// row is the draft; there are no phantom recipe rows. Shared by the web pages
// and /api/v1.

export type DraftCard = {
	id: string;
	status: 'extracting' | 'failed' | 'ready';
	title: string;
};

/** The draft cards above the saved recipes on browse, newest first. */
export function listDrafts(db: Database): DraftCard[] {
	const rows = db
		.prepare(
			`SELECT id, status, input_json, result_json FROM job
			 WHERE kind IN (${DRAFT_KINDS.map(() => '?').join(',')}) AND recipe_id IS NULL
			 ORDER BY created_at DESC`
		)
		.all(...DRAFT_KINDS) as {
		id: string;
		status: string;
		input_json: string;
		result_json: string | null;
	}[];
	return rows.map((j) => {
		const input = JSON.parse(j.input_json) as CaptureInput;
		const title =
			(j.result_json && (JSON.parse(j.result_json) as { title?: string })?.title) ||
			input.text?.trim().split('\n')[0]?.slice(0, 80) ||
			input.url ||
			'Draft';
		return {
			id: j.id,
			status: j.status === 'done' ? 'ready' : j.status === 'failed' ? 'failed' : 'extracting',
			title
		};
	});
}

/** The job behind a draft, or null if there is no such draft-kind job. */
export function getDraftJob(db: Database, id: string): JobRow | null {
	const job = db.prepare(`SELECT * FROM job WHERE id = ?`).get(id) as JobRow | undefined;
	return job && isDraftKind(job.kind) ? job : null;
}

export type DraftImage = { id: string; url: string };

export type DraftView = {
	id: string;
	status: JobRow['status'];
	error_text: string | null;
	source_text: string | null;
	initial:
		| (Partial<RecipeInput> & { source_url: string | null; images: DraftImage[] })
		| { source_url: string | null; images: DraftImage[] }
		| null;
	warnings: string[];
	damage_reasoning: string | null;
};

/** The review form's data for an unsaved capture job. */
export function draftView(db: Database, job: JobRow): DraftView {
	const input = JSON.parse(job.input_json) as CaptureInput;
	const draft =
		job.status === 'done' && job.result_json
			? (JSON.parse(job.result_json) as RecipeDraft)
			: null;
	// Capture photos ride input_json too (ADR-024): the strip shows them on
	// success and on failure alike, and Save claims them onto the recipe.
	const imageIds = input.image_ids ?? [];
	const rows = imageIds.length
		? (db
				.prepare(
					`SELECT id, r2_key_display FROM image
					 WHERE id IN (${imageIds.map(() => '?').join(',')}) AND deleted_at IS NULL`
				)
				.all(...imageIds) as { id: string; r2_key_display: string }[])
		: [];
	const byId = new Map(rows.map((r) => [r.id, r.r2_key_display]));
	const images = imageIds
		.filter((id) => byId.has(id))
		.map((id) => ({ id, url: presignGet(byId.get(id)!) }));
	return {
		id: job.id,
		status: job.status,
		error_text: job.error_text,
		source_text: input.text ?? null,
		// The URL rides input_json, not the extraction, so it seeds the form
		// here: on failure too, so a fetch_blocked draft still carries its link.
		initial: draft
			? { ...draftToInput(draft), source_url: input.url ?? null, images }
			: input.url || images.length
				? { source_url: input.url ?? null, images }
				: null,
		warnings: draft?.extraction_warnings ?? [],
		damage_reasoning: draft?.damage_reasoning ?? null
	};
}

/**
 * Save claims the job: the recipe id written back is what removes the card
 * from browse (SPEC 6.5). Throws createRecipe's validation messages.
 */
export function saveDraft(db: Database, job: JobRow, payload: RecipeInput): string {
	const id = createRecipe(db, payload);
	db.prepare(`UPDATE job SET recipe_id = ? WHERE id = ?`).run(id, job.id);
	return id;
}

/**
 * Discard hard-deletes the job row (machine output, ADR-035) and
 * soft-deletes its capture images. Running jobs cannot be discarded.
 */
export function discardDraft(db: Database, job: JobRow): void {
	if (job.status === 'queued' || job.status === 'running')
		throw new Error('Still extracting; wait for it to finish.');
	const imageIds = (JSON.parse(job.input_json) as CaptureInput).image_ids ?? [];
	db.transaction(() => {
		const soft = db.prepare(`UPDATE image SET deleted_at = ? WHERE id = ? AND recipe_id IS NULL`);
		for (const id of imageIds) soft.run(new Date().toISOString(), id);
		db.prepare(`DELETE FROM job WHERE id = ? AND recipe_id IS NULL`).run(job.id);
	})();
}

/** Retry re-queues a failed job; the runner picks it up (SPEC 6.4: a failure
 *  is never a dead end). A no-op for any other status. */
export function retryDraft(db: Database, job: JobRow): void {
	db.prepare(
		`UPDATE job SET status = 'queued', error_code = NULL, error_text = NULL,
		   result_json = NULL, started_at = NULL, finished_at = NULL
		 WHERE id = ? AND status = 'failed'`
	).run(job.id);
}
