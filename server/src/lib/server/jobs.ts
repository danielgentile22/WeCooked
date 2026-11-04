import type { Database } from 'better-sqlite3';
import { ulid } from './ids';
import { prepared } from './statements';
import { ERROR_COPY, type ErrorCode, type JobPoll } from '#lib/jobs.js';
import type { CoverTarget } from '#lib/extract.js';

// The in-process job runner (SPEC 6): concurrency 2, transactional claim,
// startup recovery. Creating a job wakes the runner at once; the 500 ms poll
// is the safety net (issue #63). No queue service, no second process.

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

/** Work nobody is standing over (issue #63): covers and a variation's
 *  reconvert. Everything else is claimed ahead of these, and their old
 *  finished rows are pruned. A draft's conversion (conversion_draft set) is
 *  not one: the cook is looking at the draft, and the job holds its
 *  counterpart body. */
const BACKGROUND_SQL = `(kind = 'cover' OR (kind = 'reconvert' AND conversion_draft IS NULL))`;

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
	created.emit(db);
	return id;
}

// In-process listeners per database: runners hear a job created, status
// long-polls hear a job change status (issue #65). createJob is called from
// inside transactions, so every emit is deferred to after the current task:
// a listener then reads a committed row.
function channel() {
	const listeners = new WeakMap<Database, Set<() => void>>();
	return {
		emit(db: Database): void {
			const set = listeners.get(db);
			if (set?.size) setImmediate(() => set.forEach((l) => l()));
		},
		on(db: Database, l: () => void): () => void {
			let set = listeners.get(db);
			if (!set) listeners.set(db, (set = new Set()));
			set.add(l);
			return () => set.delete(l);
		}
	};
}

const created = channel();
const changed = channel();

/** The cover jobs in these statuses for a draft, or for a recipe directly or
 *  through the draft that became it (issue #44). Newest first. cover_owner
 *  (issue #64) is the draft or recipe id from input_json, null on every
 *  other kind, so it needs no kind term (which would steer the planner off
 *  its index). */
export function coverJobs(
	db: Database,
	target: CoverTarget,
	statuses: JobRow['status'][]
): Pick<JobRow, 'id' | 'result_json'>[] {
	const [match, id] =
		'draft_id' in target
			? [`cover_owner = @id`, target.draft_id]
			: [
					`(cover_owner = @id OR cover_owner IN (SELECT id FROM job WHERE recipe_id = @id))`,
					target.recipe_id
				];
	return db
		.prepare(
			`SELECT id, result_json FROM job
			 WHERE ${match} AND status IN (${statuses.map(() => '?').join(',')})
			 ORDER BY created_at DESC, id DESC`
		)
		.all(...statuses, { id }) as Pick<JobRow, 'id' | 'result_json'>[];
}

/** The queued or running cover job for a draft or recipe, else null. */
export const pendingCoverJob = (db: Database, target: CoverTarget): string | null =>
	coverJobs(db, target, ['queued', 'running'])[0]?.id ?? null;

/** SPEC 6.3 polling contract, or null for an unknown job. */
export function getJobPoll(db: Database, id: string): JobPoll | null {
	const row = prepared(
		db,
		'SELECT status, error_code, error_text, recipe_id, variation_id, list_id FROM job WHERE id = ?'
	).get(id) as
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

/** Longest a status request may be held open (issue #65): well inside the
 *  phone's 60 s request timeout and Fly's proxy idle timeout. */
export const MAX_WAIT_MS = 25_000;

/** `?wait=` in seconds as milliseconds, capped at MAX_WAIT_MS; absent is 0
 *  (answer at once, as older clients expect); anything else unreadable is null. */
export function parseWait(raw: string | null): number | null {
	if (raw === null || raw === '') return 0;
	const s = Number(raw);
	if (!Number.isFinite(s) || s < 0) return null;
	return Math.min(Math.round(s * 1000), MAX_WAIT_MS);
}

// The runner and requeueJob announce every status they write; this re-read
// is the safety net for any other writer.
const RECHECK_MS = 1000;

/**
 * The status long-poll (issue #65): answers as soon as the job's status
 * differs from what it was on arrival, when `waitMs` elapses, or when the
 * client goes away. A finished or unknown job, or no wait, answers at once.
 */
export function waitForJobPoll(
	db: Database,
	id: string,
	waitMs: number,
	signal?: AbortSignal
): Promise<JobPoll | null> {
	const first = getJobPoll(db, id);
	if (!first || waitMs <= 0 || first.status === 'done' || first.status === 'failed' || signal?.aborted)
		return Promise.resolve(first);
	return new Promise((resolve) => {
		const check = () => {
			const poll = getJobPoll(db, id);
			if (poll?.status !== first.status) finish(poll);
		};
		const finish = (poll: JobPoll | null) => {
			clearTimeout(timer);
			clearInterval(recheck);
			unsubscribe();
			signal?.removeEventListener('abort', gone);
			resolve(poll);
		};
		const gone = () => finish(getJobPoll(db, id));
		const timer = setTimeout(gone, waitMs);
		const recheck = setInterval(check, RECHECK_MS);
		const unsubscribe = changed.on(db, check);
		signal?.addEventListener('abort', gone, { once: true });
	});
}

/** SPEC 6.4 retry: puts a failed job back in the queue, wakes the runner and
 *  answers held status polls. `input`, when given, replaces input_json.
 *  Returns false, changing nothing, unless the job had failed. */
export function requeueJob(db: Database, id: string, input?: unknown): boolean {
	const n = db
		.prepare(
			`UPDATE job SET status = 'queued', input_json = coalesce(?, input_json), error_code = NULL,
			   error_text = NULL, result_json = NULL, started_at = NULL, finished_at = NULL
			 WHERE id = ? AND status = 'failed'`
		)
		.run(input === undefined ? null : JSON.stringify(input), id).changes;
	if (!n) return false;
	created.emit(db);
	changed.emit(db);
	return true;
}

/** SPEC 6.2: on boot, anything left running failed with 'interrupted'. */
export function recoverInterrupted(db: Database): number {
	const n = db
		.prepare(
			`UPDATE job SET status = 'failed', error_code = 'interrupted', error_text = ?, finished_at = ?
			 WHERE status = 'running'`
		)
		.run(ERROR_COPY.interrupted, now());
	if (n.changes) changed.emit(db);
	return n.changes;
}

// Single-statement claim: atomic, so a future second process cannot
// double-run a job (SPEC 6.1). Background kinds go last (issue #63), so a
// cover backfill never makes the cook wait; otherwise oldest first.
function claimNext(db: Database): JobRow | undefined {
	const job = prepared(
		db,
		`UPDATE job SET status = 'running', started_at = ?, attempts = attempts + 1
		 WHERE id = (SELECT id FROM job WHERE status = 'queued'
		             ORDER BY ${BACKGROUND_SQL}, created_at, id LIMIT 1)
		   AND status = 'queued'
		 RETURNING *`
	).get(now()) as JobRow | undefined;
	if (job) changed.emit(db);
	return job;
}

/** How long finished background jobs are kept (issue #63). */
export const PRUNE_AFTER_DAYS = 30;

/** Deletes finished background jobs older than the retention period and
 *  returns how many. Captures, generations and draft conversions back drafts
 *  and are kept, and so is a cover job that found an image: it is the record
 *  that keeps the backfill from putting back a cover the cook removed. */
export function pruneJobs(db: Database, at = Date.now(), days = PRUNE_AFTER_DAYS): number {
	const cutoff = new Date(at - days * 24 * 60 * 60 * 1000).toISOString();
	return db
		.prepare(
			`DELETE FROM job
			 WHERE ${BACKGROUND_SQL} AND status IN ('done', 'failed') AND finished_at < ?
			   AND NOT (kind = 'cover' AND json_extract(result_json, '$.image_id') IS NOT NULL)`
		)
		.run(cutoff).changes;
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
	changed.emit(db);
	if (!afterJob) return;
	// The job's outcome is already stored; nothing here may change it. Fire
	// and forget (issue #63): a slow push send must not hold the job's slot.
	const finished = db.prepare('SELECT * FROM job WHERE id = ?').get(job.id) as JobRow;
	Promise.resolve()
		.then(() => afterJob(finished))
		.catch((e) => console.error(`after job ${job.id} (${job.kind}) failed:`, e));
}

const CONCURRENCY = 2;

export function startRunner(db: Database, handlers: Handlers, pollMs = 500, afterJob?: AfterJob) {
	let running = 0;
	// Claims up to the free slots; a freed slot claims the next job straight
	// away. Returns completion of the jobs it started and those they chained to.
	const tick = (): Promise<void> => {
		const started: Promise<void>[] = [];
		while (running < CONCURRENCY) {
			const job = claimNext(db);
			if (!job) break;
			running++;
			started.push(
				run(db, handlers, job, afterJob)
					.finally(() => running--)
					.then(tick)
			);
		}
		return Promise.all(started).then(() => {});
	};
	const interval = setInterval(tick, pollMs);
	interval.unref?.();
	const unsubscribe = created.on(db, () => void tick());
	return {
		tick,
		stop: () => {
			clearInterval(interval);
			unsubscribe();
		}
	};
}
