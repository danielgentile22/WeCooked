import type { Database } from 'better-sqlite3';
import { createRecipe } from './recipes';
import { DRAFT_KINDS, isDraftKind, pendingCoverJob, type JobRow } from './jobs';
import { CANDIDATE_COUNT } from './generate';
import { enqueueCover } from './cover';
import { presignGet } from './r2';
import {
	draftToInput,
	type CaptureInput,
	type GenerateInput,
	type GenerateResult,
	type RecipeDraft
} from '$lib/extract';
import type { Cuisine, Damage, Effort, Protein, RecipeInput } from '$lib/tags';

// Drafts (SPEC 6.5): every capture job without a recipe is a draft. The job
// row is the draft; there are no phantom recipe rows. A generate job (issue
// #41) is a draft too once a candidate is picked; before that it is choosing.
// Shared by the web pages and /api/v1.

export type DraftCard = {
	id: string;
	status: 'extracting' | 'generating' | 'choosing' | 'failed' | 'ready';
	title: string;
};

type DraftSource = Pick<JobRow, 'kind' | 'status' | 'input_json' | 'result_json'>;

const generateInput = (job: Pick<JobRow, 'input_json'>) =>
	JSON.parse(job.input_json) as GenerateInput;

/** A done generate job whose candidates still wait for a pick. */
export const isChoosing = (job: DraftSource) =>
	job.kind === 'generate' &&
	job.status === 'done' &&
	generateInput(job).picked === null;

/** The recipe a draft job holds: a capture's extraction, or a generation's
 *  picked candidate. Null while running, failed, or choosing. */
export function draftOf(job: DraftSource): RecipeDraft | null {
	if (!job.result_json) return null;
	if (job.kind !== 'generate') return JSON.parse(job.result_json) as RecipeDraft;
	const { picked } = generateInput(job);
	return picked === null
		? null
		: (JSON.parse(job.result_json) as GenerateResult).candidates[picked];
}

function cardStatus(job: DraftSource): DraftCard['status'] {
	if (job.status === 'failed') return 'failed';
	if (job.status !== 'done') return job.kind === 'generate' ? 'generating' : 'extracting';
	return isChoosing(job) ? 'choosing' : 'ready';
}

function cardTitle(job: DraftSource): string {
	const title = draftOf(job)?.title;
	if (title) return title;
	if (job.kind === 'generate') return generateInput(job).description;
	const input = JSON.parse(job.input_json) as CaptureInput;
	return input.text?.trim().split('\n')[0]?.slice(0, 80) || input.url || 'Draft';
}

/** The draft cards above the saved recipes on browse, newest first. */
export function listDrafts(db: Database): DraftCard[] {
	const rows = db
		.prepare(
			`SELECT id, kind, status, input_json, result_json FROM job
			 WHERE kind IN (${DRAFT_KINDS.map(() => '?').join(',')}) AND recipe_id IS NULL
			 ORDER BY created_at DESC`
		)
		.all(...DRAFT_KINDS) as (DraftSource & { id: string })[];
	return rows.map((j) => ({ id: j.id, status: cardStatus(j), title: cardTitle(j) }));
}

/** The job behind a draft, or null if there is no such draft-kind job. */
export function getDraftJob(db: Database, id: string): JobRow | null {
	const job = db.prepare(`SELECT * FROM job WHERE id = ?`).get(id) as JobRow | undefined;
	return job && isDraftKind(job.kind) ? job : null;
}

/** The generate job behind a generation, or null for any other id. */
export function getGenerationJob(db: Database, id: string): JobRow | null {
	const job = getDraftJob(db, id);
	return job?.kind === 'generate' ? job : null;
}

/** source_url is set on a found cover (issue #44): fetched, not taken. */
export type DraftImage = { id: string; url: string; source_url: string | null };

/** What every seeded form carries besides the recipe: the link, the photo
 *  strip, and the found cover's id when the cover job found one. */
type DraftSeed = { source_url: string | null; images: DraftImage[]; cover_image_id: string | null };

export type DraftView = {
	id: string;
	kind: 'capture' | 'generate';
	status: JobRow['status'];
	error_text: string | null;
	source_text: string | null;
	initial: (Partial<RecipeInput> & DraftSeed) | DraftSeed | null;
	/** The cover job still looking for this draft's cover, if any (issue #44):
	 *  the phone watches it and re-reads the draft when it ends. */
	cover_job_id: string | null;
	warnings: string[];
	damage_reasoning: string | null;
};

type DraftImageRefs = Pick<CaptureInput, 'image_ids' | 'cover_image_id'>;

/** Capture photos ride input_json (ADR-024); the found cover comes last (issue #44). */
const draftImageIds = (input: DraftImageRefs) => [
	...(input.image_ids ?? []),
	...(input.cover_image_id ? [input.cover_image_id] : [])
];

/** A draft's live images, in draftImageIds order. */
function draftImages(
	db: Database,
	input: DraftImageRefs
): { images: DraftImage[]; cover_image_id: string | null } {
	const ids = draftImageIds(input);
	const rows = ids.length
		? (db
				.prepare(
					`SELECT id, r2_key_display, source_url FROM image
					 WHERE id IN (${ids.map(() => '?').join(',')}) AND deleted_at IS NULL`
				)
				.all(...ids) as { id: string; r2_key_display: string; source_url: string | null }[])
		: [];
	const byId = new Map(rows.map((r) => [r.id, r]));
	const images = ids.flatMap((id) => {
		const r = byId.get(id);
		return r ? [{ id, url: presignGet(r.r2_key_display), source_url: r.source_url }] : [];
	});
	const cover = input.cover_image_id && byId.has(input.cover_image_id) ? input.cover_image_id : null;
	return { images, cover_image_id: cover };
}

/** One candidate as the deck compares it: the as-written ingredients, flattened. */
export type Candidate = {
	title: string;
	prep_minutes: number | null;
	cook_minutes: number | null;
	effort: Effort;
	damage: Damage;
	cuisine: Cuisine | null;
	protein: Protein | null;
	ingredients: string[];
};

export type GenerationView = {
	id: string;
	status: JobRow['status'];
	description: string;
	yield_count: number;
	candidates: Candidate[];
};

const candidate = (d: RecipeDraft): Candidate => ({
	title: d.title,
	prep_minutes: d.prep_minutes,
	cook_minutes: d.cook_minutes,
	effort: d.tags.effort,
	damage: d.tags.damage,
	cuisine: d.tags.cuisine,
	protein: d.tags.protein,
	ingredients: d.body[d.body.source_units].ingredients.flatMap((g) => g.items)
});

/** A generation before its pick is a GenerationView; after, the review form's
 *  data like any draft, seeded from the picked candidate with the description
 *  as its source text. */
function generationView(db: Database, job: JobRow): DraftView | GenerationView {
	const input = generateInput(job);
	const { description, yield_count } = input;
	if (isChoosing(job))
		return {
			id: job.id,
			status: job.status,
			description,
			yield_count,
			candidates: (JSON.parse(job.result_json!) as GenerateResult).candidates.map(candidate)
		};
	const draft = draftOf(job);
	return {
		id: job.id,
		kind: 'generate',
		status: job.status,
		error_text: job.error_text,
		source_text: description,
		initial: draft
			? { ...draftToInput(draft), source_text: description, source_url: null, ...draftImages(db, input) }
			: null,
		cover_job_id: pendingCoverJob(db, { draft_id: job.id }),
		warnings: [],
		damage_reasoning: draft?.damage_reasoning ?? null
	};
}

/** The review form's data for an unsaved draft job. */
export function draftView(db: Database, job: JobRow): DraftView | GenerationView {
	if (job.kind === 'generate') return generationView(db, job);
	const input = JSON.parse(job.input_json) as CaptureInput;
	const draft = draftOf(job);
	// The strip shows the photos on success and on failure alike, and Save
	// claims them onto the recipe.
	const seed = draftImages(db, input);
	return {
		id: job.id,
		kind: 'capture',
		status: job.status,
		error_text: job.error_text,
		source_text: input.text ?? null,
		// The URL rides input_json, not the extraction, so it seeds the form
		// here: on failure too, so a fetch_blocked draft still carries its link.
		initial: draft
			? { ...draftToInput(draft), source_url: input.url ?? null, ...seed }
			: input.url || seed.images.length
				? { source_url: input.url ?? null, ...seed }
				: null,
		cover_job_id: pendingCoverJob(db, { draft_id: job.id }),
		warnings: draft?.extraction_warnings ?? [],
		damage_reasoning: draft?.damage_reasoning ?? null
	};
}

/**
 * Save claims the job: the recipe id written back is what removes the card
 * from browse (SPEC 6.5). Throws createRecipe's validation messages.
 */
export function saveDraft(db: Database, job: JobRow, payload: RecipeInput): string {
	if (isChoosing(job)) throw new Error('Pick a recipe first.');
	return db.transaction(() => {
		const id = createRecipe(db, payload);
		db.prepare(`UPDATE job SET recipe_id = ? WHERE id = ?`).run(id, job.id);
		// A found cover the form left out (removed, or never seen because the
		// form was loaded before the cover job finished) would otherwise sit
		// unclaimed forever (issue #44).
		const { cover_image_id } = JSON.parse(job.input_json) as CaptureInput;
		if (cover_image_id && !(payload.image_ids ?? []).includes(cover_image_id))
			db.prepare(`UPDATE image SET deleted_at = ? WHERE id = ? AND recipe_id IS NULL`).run(
				new Date().toISOString(),
				cover_image_id
			);
		return id;
	})();
}

/**
 * Discard hard-deletes the job row (machine output, ADR-035) and
 * soft-deletes its capture images and found cover. Running jobs cannot be
 * discarded.
 */
export function discardDraft(db: Database, job: JobRow): void {
	if (job.status === 'queued' || job.status === 'running')
		throw new Error(
			job.kind === 'generate'
				? 'Still generating; wait for it to finish.'
				: 'Still extracting; wait for it to finish.'
		);
	const imageIds = draftImageIds(JSON.parse(job.input_json) as CaptureInput);
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

/**
 * Picking narrows a done generation to one candidate: the row becomes a draft
 * seeded from it, under the same id. Picking the same index again is a no-op.
 */
export function pickCandidate(db: Database, job: JobRow, index: unknown): void {
	if (job.status !== 'done') throw new Error('Still generating; wait for it to finish.');
	if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= CANDIDATE_COUNT)
		throw new Error('Pick one of the three.');
	const input = generateInput(job);
	if (input.picked === index) return;
	if (input.picked !== null) throw new Error('Already picked.');
	db.prepare(`UPDATE job SET input_json = ? WHERE id = ?`).run(
		JSON.stringify({ ...input, picked: index }),
		job.id
	);
	enqueueCover(db, job.id);
}
