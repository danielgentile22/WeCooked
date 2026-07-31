import type { Database } from 'better-sqlite3';
import { ulid } from './ids';
import { ERROR_COPY, type ErrorCode } from '$lib/jobs';

// The in-process job runner (SPEC 6): 500 ms poll, concurrency 2,
// transactional claim, startup recovery. No queue service, no second process.

export type JobKind =
	| 'extract_url'
	| 'extract_paste'
	| 'extract_photos'
	| 'scale'
	| 'reconvert'
	| 'shopping_merge';

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
};

/** A handler returns the value stored as result_json. */
export type JobHandler = (job: JobRow, db: Database) => Promise<unknown>;
export type Handlers = Partial<Record<JobKind, JobHandler>>;

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
	refs: { recipe_id?: string; variation_id?: string; list_id?: string } = {}
): string {
	const id = ulid();
	db.prepare(
		`INSERT INTO job (id, kind, status, recipe_id, variation_id, list_id, input_json, created_at)
		 VALUES (?, ?, 'queued', ?, ?, ?, ?, ?)`
	).run(
		id,
		kind,
		refs.recipe_id ?? null,
		refs.variation_id ?? null,
		refs.list_id ?? null,
		JSON.stringify(input),
		new Date().toISOString()
	);
	return id;
}

/** SPEC 6.2: on boot, anything left running failed with 'interrupted'. */
export function recoverInterrupted(db: Database): number {
	return db
		.prepare(
			`UPDATE job SET status = 'failed', error_code = 'interrupted', error_text = ?, finished_at = ?
			 WHERE status = 'running'`
		)
		.run(ERROR_COPY.interrupted, new Date().toISOString()).changes;
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
		.get(new Date().toISOString()) as JobRow | undefined;
}

async function run(db: Database, handlers: Handlers, job: JobRow): Promise<void> {
	try {
		const handler = handlers[job.kind];
		if (!handler) throw new JobError('api_error', `No handler for job kind ${job.kind}`);
		const result = await handler(job, db);
		db.prepare(`UPDATE job SET status = 'done', result_json = ?, finished_at = ? WHERE id = ?`).run(
			JSON.stringify(result ?? null),
			new Date().toISOString(),
			job.id
		);
	} catch (e) {
		const code: ErrorCode = e instanceof JobError ? e.code : 'api_error';
		db.prepare(
			`UPDATE job SET status = 'failed', error_code = ?, error_text = ?, finished_at = ? WHERE id = ?`
		).run(code, ERROR_COPY[code], new Date().toISOString(), job.id);
	}
}

const CONCURRENCY = 2;

export function startRunner(db: Database, handlers: Handlers, pollMs = 500) {
	let running = 0;
	// Claims up to the free slots; returns completion of the jobs it started.
	const tick = (): Promise<void> => {
		const started: Promise<void>[] = [];
		while (running < CONCURRENCY) {
			const job = claimNext(db);
			if (!job) break;
			running++;
			started.push(run(db, handlers, job).finally(() => running--));
		}
		return Promise.all(started).then(() => {});
	};
	const interval = setInterval(tick, pollMs);
	interval.unref?.();
	return { tick, stop: () => clearInterval(interval) };
}
