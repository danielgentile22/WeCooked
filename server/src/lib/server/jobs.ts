import type { Database } from 'better-sqlite3';
import { ulid } from './ids';
import { ERROR_COPY, type ErrorCode, type JobPoll } from '$lib/jobs';
import type { CoverTarget } from '$lib/extract';

// The in-process job runner (SPEC 6): 500 ms poll, concurrency 2,
// transactional claim, startup recovery. No queue service, no second process.

export type JobKind =
	| 'extract_url'
	| 'extract_paste'
	| 'extract_photos'
	| 'scale'
	| 'reconvert'
	| 'shopping_merge'
	| 'generate'
	| 'cover';

/** The kinds that turn something the cook shared into a draft. */
export const CAPTURE_KINDS = ['extract_url', 'extract_paste', 'extract_photos'] as const;
export const isCaptureKind = (k: string) => (CAPTURE_KINDS as readonly string[]).includes(k);

/** The kinds whose job row is a draft (SPEC 6.5): the captures and generation (issue #41). */
export const DRAFT_KINDS = [...CAPTURE_KINDS, 'generate'] as const;
export const isDraftKind = (k: string) => (DRAFT_KINDS as readonly string[]).includes(k);

export type JobRow = {
	id: string;
	kind: JobKind;
	status: 'queued' | 'running' | 'done' | 'failed';
	recipe_id: string | null;
	variation_id: string | null;
	list_id: string | null;
	input_json: string;
	result_json: string | null;
	error_code: ErrorCode | null;
	error_text: string | null;
	attempts: number;
	/** The phone that queued it (issue #42), from X-Device-Id. */
	device_id: string | null;
};

/** A handler returns the value stored as result_json. */
export type JobHandler = (job: JobRow, db: Database) => Promise<unknown>;
export type Handlers = Partial<Record<JobKind, JobHandler>>;

const now = () => new Date().toISOString();

/** Throw one of these from a handler to fail the job with a SPEC 6.4 code. */
export class JobError extends Error {
	constructor(
		public code: ErrorCode,
		text?: string
	) {
		super(text ?? ERROR_COPY[code]);
	}
}

export function createJob(
	db: Database,
	kind: JobKind,
	input: unknown,
	refs: { recipe_id?: string; variation_id?: string; list_id?: string; device_id?: string } = {}
): string {
	const id = ulid();
	db.prepare(
		`INSERT INTO job (id, kind, status, recipe_id, variation_id, list_id, device_id, input_json, created_at)
		 VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?)`
	).run(
		id,
		kind,
		refs.recipe_id ?? null,
		refs.variation_id ?? null,
		refs.list_id ?? null,
		refs.device_id ?? null,
		JSON.stringify(input),
		now()
	);
	return id;
}

/** The cover jobs in these statuses for a draft, or for a recipe directly or
 *  through the draft that became it (issue #44). Newest first. */
export function coverJobs(
	db: Database,
	target: CoverTarget,
	statuses: JobRow['status'][]
): Pick<JobRow, 'id' | 'result_json'>[] {
	const [match, id] =
		'draft_id' in target
			? [`json_extract(input_json, '$.draft_id') = @id`, target.draft_id]
			: [
					`(json_extract(input_json, '$.recipe_id') = @id
					  OR json_extract(input_json, '$.draft_id') IN (SELECT id FROM job WHERE recipe_id = @id))`,
					target.recipe_id
				];
	return db
		.prepare(
			`SELECT id, result_json FROM job
			 WHERE kind = 'cover' AND status IN (${statuses.map(() => '?').join(',')}) AND ${match}
			 ORDER BY created_at DESC, id DESC`
		)
		.all(...statuses, { id }) as Pick<JobRow, 'id' | 'result_json'>[];
}

/** The queued or running cover job for a draft or recipe, else null. */
export const pendingCoverJob = (db: Database, target: CoverTarget): string | null =>
	coverJobs(db, target, ['queued', 'running'])[0]?.id ?? null;

/** SPEC 6.3 polling contract, or null for an unknown job. */
export function getJobPoll(db: Database, id: string): JobPoll | null {
	const row = db
		.prepare(
			'SELECT status, error_code, error_text, recipe_id, variation_id, list_id FROM job WHERE id = ?'
		)
		.get(id) as
		| (Pick<JobPoll, 'status' | 'error_code' | 'error_text'> & {
				recipe_id: string | null;
				variation_id: string | null;
				list_id: string | null;
		  })
		| undefined;
	if (!row) return null;
	return {
		status: row.status,
		error_code: row.error_code,
		error_text: row.error_text,
		// variation first: a done scale job's ref is the variation it produced
		// (its recipe_id is set from creation, so recipe-first would mask it).
		result_ref: row.variation_id ?? row.recipe_id ?? row.list_id ?? null
	};
}

/** SPEC 6.2: on boot, anything left running failed with 'interrupted'. */
export function recoverInterrupted(db: Database): number {
	return db
		.prepare(
			`UPDATE job SET status = 'failed', error_code = 'interrupted', error_text = ?, finished_at = ?
			 WHERE status = 'running'`
		)
		.run(ERROR_COPY.interrupted, now()).changes;
}

// Single-statement claim: atomic, so a future second process cannot
// double-run a job (SPEC 6.1).
function claimNext(db: Database): JobRow | undefined {
	return db
		.prepare(
			`UPDATE job SET status = 'running', started_at = ?, attempts = attempts + 1
			 WHERE id = (SELECT id FROM job WHERE status = 'queued' ORDER BY created_at, id LIMIT 1)
			   AND status = 'queued'
			 RETURNING *`
		)
		.get(now()) as JobRow | undefined;
}

/** Runs once a job has finished, done or failed (issue #42: the capture push). */
export type AfterJob = (job: JobRow) => Promise<void>;

async function run(db: Database, handlers: Handlers, job: JobRow, afterJob?: AfterJob): Promise<void> {
	try {
		const handler = handlers[job.kind];
		if (!handler) throw new JobError('api_error', `No handler for job kind ${job.kind}`);
		const result = await handler(job, db);
		db.prepare(`UPDATE job SET status = 'done', result_json = ?, finished_at = ? WHERE id = ?`).run(
			JSON.stringify(result ?? null),
			now(),
			job.id
		);
	} catch (e) {
		const code: ErrorCode = e instanceof JobError ? e.code : 'api_error';
		// The UI always gets the fixed SPEC 6.4 copy; the real cause goes to the
		// server log, or a failure would be unobservable.
		console.error(`job ${job.id} (${job.kind}) failed:`, e);
		db.prepare(
			`UPDATE job SET status = 'failed', error_code = ?, error_text = ?, finished_at = ? WHERE id = ?`
		).run(code, ERROR_COPY[code], now(), job.id);
	}
	if (!afterJob) return;
	// The job's outcome is already stored; nothing here may change it.
	try {
		await afterJob(db.prepare('SELECT * FROM job WHERE id = ?').get(job.id) as JobRow);
	} catch (e) {
		console.error(`after job ${job.id} (${job.kind}) failed:`, e);
	}
}

const CONCURRENCY = 2;

export function startRunner(db: Database, handlers: Handlers, pollMs = 500, afterJob?: AfterJob) {
	let running = 0;
	// Claims up to the free slots; returns completion of the jobs it started.
	const tick = (): Promise<void> => {
		const started: Promise<void>[] = [];
		while (running < CONCURRENCY) {
			const job = claimNext(db);
			if (!job) break;
			running++;
			started.push(run(db, handlers, job, afterJob).finally(() => running--));
		}
		return Promise.all(started).then(() => {});
	};
	const interval = setInterval(tick, pollMs);
	interval.unref?.();
	return { tick, stop: () => clearInterval(interval) };
}
