import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './migrate';
import {
	createJob,
	parseWait,
	pruneJobs,
	recoverInterrupted,
	requeueJob,
	startRunner,
	waitForJobPoll,
	JobError,
	MAX_WAIT_MS,
	type JobRow
} from './jobs';
import { ERROR_COPY } from '$lib/jobs';

function testDb() {
	const db = new Database(':memory:');
	migrate(db, 'migrations');
	return db;
}

const row = (db: Database.Database, id: string) =>
	db.prepare('SELECT * FROM job WHERE id = ?').get(id) as JobRow & { finished_at: string | null };

describe('job runner (SPEC 6)', () => {
	it('runs a queued job to done and stores the result', async () => {
		const db = testDb();
		const id = createJob(db, 'reconvert', { n: 1 });
		const runner = startRunner(db, {
			reconvert: async (job) => ({ echo: JSON.parse(job.input_json) })
		});
		runner.stop();
		await runner.tick();
		const j = row(db, id);
		expect(j.status).toBe('done');
		expect(JSON.parse(j.result_json!)).toEqual({ echo: { n: 1 } });
		expect(j.attempts).toBe(1);
		expect(j.finished_at).toBeTruthy();
	});

	it('a thrown JobError fails the job with its code and SPEC 6.4 copy', async () => {
		const db = testDb();
		const id = createJob(db, 'reconvert', {});
		const runner = startRunner(db, {
			reconvert: async () => {
				throw new JobError('no_recipe_found');
			}
		});
		runner.stop();
		await runner.tick();
		const j = row(db, id);
		expect(j.status).toBe('failed');
		expect(j.error_code).toBe('no_recipe_found');
		expect(j.error_text).toBe(ERROR_COPY.no_recipe_found);
	});

	it('an unexpected throw fails the job as api_error', async () => {
		const db = testDb();
		const id = createJob(db, 'reconvert', {});
		const runner = startRunner(db, {
			reconvert: async () => {
				throw new Error('boom');
			}
		});
		runner.stop();
		await runner.tick();
		expect(row(db, id).error_code).toBe('api_error');
	});

	it('claims at most 2 jobs at a time', async () => {
		const db = testDb();
		[1, 2, 3].map((n) => createJob(db, 'reconvert', { n }));
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const runner = startRunner(db, { reconvert: () => gate.then(() => 'ok') });
		runner.stop();
		const counts = () =>
			db.prepare('SELECT status, count(*) AS n FROM job GROUP BY status').all() as {
				status: string;
				n: number;
			}[];
		const first = runner.tick();
		expect(counts()).toEqual([
			{ status: 'queued', n: 1 },
			{ status: 'running', n: 2 }
		]);
		release();
		await first;
		await runner.tick();
		expect(counts()).toEqual([{ status: 'done', n: 3 }]);
	});

	it('calls afterJob with the finished row, done or failed (issue #42)', async () => {
		const db = testDb();
		const done = createJob(db, 'reconvert', { ok: true }, { device_id: 'phone' });
		const failed = createJob(db, 'reconvert', { ok: false });
		const seen: JobRow[] = [];
		const runner = startRunner(
			db,
			{
				reconvert: async (job) => {
					if (!JSON.parse(job.input_json).ok) throw new JobError('no_recipe_found');
					return 'ok';
				}
			},
			500,
			async (job) => {
				seen.push(job);
			}
		);
		runner.stop();
		await runner.tick();
		const by = Object.fromEntries(seen.map((j) => [j.id, j]));
		expect(seen).toHaveLength(2);
		expect(by[done]).toMatchObject({ status: 'done', result_json: '"ok"', device_id: 'phone' });
		expect(by[failed]).toMatchObject({ status: 'failed', error_code: 'no_recipe_found', device_id: null });
	});

	it('a throwing afterJob is logged and leaves the status alone (issue #42)', async () => {
		const db = testDb();
		const id = createJob(db, 'reconvert', {});
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		const runner = startRunner(db, { reconvert: async () => 'ok' }, 500, async () => {
			throw new Error('push down');
		});
		runner.stop();
		await runner.tick();
		expect(row(db, id).status).toBe('done');
		expect(log).toHaveBeenCalledWith(expect.stringContaining(id), expect.any(Error));
		log.mockRestore();
	});

	it('a created job wakes the runner without waiting for the timer (issue #63)', async () => {
		const db = testDb();
		const ran: string[] = [];
		// A timer that never fires inside the test: only the wakeup can start the job.
		const runner = startRunner(db, { extract_paste: async (job) => void ran.push(job.id) }, 60_000);
		try {
			const id = createJob(db, 'extract_paste', { text: 'x' });
			await vi.waitFor(() => expect(row(db, id).status).toBe('done'), { timeout: 1000, interval: 5 });
			expect(ran).toEqual([id]);
		} finally {
			runner.stop();
		}
	});

	it('a stopped runner is not woken by a created job (issue #63)', async () => {
		const db = testDb();
		const runner = startRunner(db, { extract_paste: async () => 'ok' }, 60_000);
		runner.stop();
		const id = createJob(db, 'extract_paste', {});
		await new Promise((r) => setTimeout(r, 20));
		expect(row(db, id).status).toBe('queued');
	});

	it('claims captures and generations ahead of queued background jobs (issue #63)', async () => {
		const db = testDb();
		const background = [
			createJob(db, 'cover', { recipe_id: 'r1' }),
			createJob(db, 'cover', { recipe_id: 'r2' }),
			createJob(db, 'reconvert', { variation_id: 'v1' })
		];
		// A draft's conversion is foreground: the cook is looking at the draft.
		const conversion = createJob(db, 'reconvert', { draft_id: 'd1', source: {} });
		const paste = createJob(db, 'extract_paste', { text: 'x' });
		const gen = createJob(db, 'generate', { description: 'y' });
		// Distinct creation times: ids made in one millisecond do not sort in order.
		[...background, conversion, paste, gen].forEach((id, i) =>
			db.prepare('UPDATE job SET created_at = ? WHERE id = ?').run(`2026-11-01T00:00:0${i}Z`, id)
		);
		const order: string[] = [];
		const record = async (job: JobRow) => void order.push(job.id);
		const runner = startRunner(db, { cover: record, reconvert: record, extract_paste: record, generate: record });
		runner.stop();
		await runner.tick();
		expect(order.slice(0, 2).sort()).toEqual([conversion, paste].sort());
		expect(order[2]).toBe(gen);
		expect(order.slice(3)).toEqual(background);
	});

	it('a hanging afterJob does not hold a job slot (issue #63)', async () => {
		const db = testDb();
		const ids = [1, 2, 3].map((n) => createJob(db, 'reconvert', { n }));
		const pushes: string[] = [];
		const runner = startRunner(db, { reconvert: async () => 'ok' }, 500, (job) => {
			pushes.push(job.id);
			return new Promise<void>(() => {}); // a push send that never answers
		});
		runner.stop();
		await runner.tick();
		expect(ids.map((id) => row(db, id).status)).toEqual(['done', 'done', 'done']);
		expect(pushes.sort()).toEqual([...ids].sort());
	});

	it('prunes old finished background jobs and keeps everything else (issue #63)', () => {
		const db = testDb();
		const DAY = 24 * 60 * 60 * 1000;
		const at = Date.parse('2026-11-01T00:00:00Z');
		const finish = (id: string, status: string, daysAgo: number, result: unknown = null) =>
			db
				.prepare('UPDATE job SET status = ?, finished_at = ?, result_json = ? WHERE id = ?')
				.run(status, new Date(at - daysAgo * DAY).toISOString(), JSON.stringify(result), id);
		const job = (
			kind: Parameters<typeof createJob>[1],
			status: string,
			daysAgo: number,
			result?: unknown,
			input: unknown = {}
		) => {
			const id = createJob(db, kind, input);
			if (status !== 'queued') finish(id, status, daysAgo, result);
			return id;
		};
		const pruned = [
			job('reconvert', 'done', 40),
			job('reconvert', 'failed', 40),
			job('cover', 'done', 40, { image_id: null }),
			job('cover', 'failed', 40)
		];
		const kept = [
			job('reconvert', 'done', 5), // inside the retention period
			job('reconvert', 'queued', 0),
			// A draft's counterpart body lives only in its conversion job.
			job('reconvert', 'done', 40, { ingredients: [], steps: [] }, { draft_id: 'd1', source: {} }),
			job('reconvert', 'failed', 40, null, { draft_id: 'd2', source: {} }),
			// A found cover is the record that keeps the backfill from
			// putting back a cover the cook removed.
			job('cover', 'done', 40, { image_id: 'img1' }),
			// Captures and generations back drafts: never pruned.
			job('extract_paste', 'done', 400),
			job('extract_url', 'failed', 400),
			job('extract_photos', 'done', 400),
			job('generate', 'done', 400),
			job('scale', 'done', 400),
			job('shopping_merge', 'done', 400)
		];
		expect(pruneJobs(db, at)).toBe(pruned.length);
		const left = (db.prepare('SELECT id FROM job').all() as { id: string }[]).map((r) => r.id);
		expect(left.sort()).toEqual(kept.sort());
	});

	it('requeueJob queues a failed job, wakes the runner and answers held polls', async () => {
		const db = testDb();
		const id = createJob(db, 'reconvert', {});
		db.prepare(
			"UPDATE job SET status = 'failed', error_code = 'api_error', error_text = 'x', result_json = 'null', finished_at = '2026' WHERE id = ?"
		).run(id);
		let ran!: () => void;
		const done = new Promise<void>((r) => (ran = r));
		// A poll interval far past the test: only the wakeup can start the job.
		const runner = startRunner(db, { reconvert: async () => (ran(), 'again') }, 60_000);
		const waiting = waitForJobPoll(db, id, 5000);
		expect(requeueJob(db, id, { n: 2 })).toBe(true);
		// Answered by the emit, not the 1 s re-read.
		expect(await Promise.race([waiting, new Promise((r) => setTimeout(() => r('held'), 300))])).not.toBe('held');
		await Promise.race([done, new Promise((_, no) => setTimeout(() => no(new Error('runner not woken')), 300))]);
		runner.stop();
		await new Promise((r) => setTimeout(r, 10));
		const j = row(db, id);
		expect(j).toMatchObject({ status: 'done', error_code: null, error_text: null, input_json: '{"n":2}' });
		// Only a failed job is requeued.
		expect(requeueJob(db, id)).toBe(false);
	});

	it('startup recovery fails running jobs with interrupted and retry copy', () => {
		const db = testDb();
		const id = createJob(db, 'extract_url', { url: 'https://x' });
		db.prepare("UPDATE job SET status = 'running' WHERE id = ?").run(id);
		expect(recoverInterrupted(db)).toBe(1);
		const j = row(db, id);
		expect(j.status).toBe('failed');
		expect(j.error_code).toBe('interrupted');
		expect(j.error_text).toContain('try again');
	});

	it('has SPEC 6.4 copy for all seven error codes', () => {
		expect(Object.keys(ERROR_COPY).sort()).toEqual([
			'api_error',
			'fetch_blocked',
			'fetch_failed',
			'image_unreadable',
			'interrupted',
			'no_recipe_found',
			'quota_exceeded'
		]);
	});
});

describe('job status long-poll (issue #65)', () => {
	/** Settles after `ms` with 'pending', so a test can tell "still waiting" from an answer. */
	const within = <T>(p: Promise<T>, ms: number) =>
		Promise.race([p, new Promise<'pending'>((r) => setTimeout(() => r('pending'), ms))]);

	it('without a wait answers at once, as today', async () => {
		const db = testDb();
		const id = createJob(db, 'reconvert', {});
		expect(await within(waitForJobPoll(db, id, 0), 20)).toMatchObject({ status: 'queued' });
	});

	it('answers an unknown job with null at once', async () => {
		expect(await within(waitForJobPoll(testDb(), 'missing', 5000), 20)).toBeNull();
	});

	it('answers a finished job at once even with a wait', async () => {
		const db = testDb();
		const id = createJob(db, 'reconvert', {});
		const runner = startRunner(db, { reconvert: async () => null });
		runner.stop();
		await runner.tick();
		expect(await within(waitForJobPoll(db, id, 5000), 20)).toMatchObject({ status: 'done' });
	});

	it('answers as soon as the status changes', async () => {
		const db = testDb();
		const id = createJob(db, 'reconvert', {});
		let finish!: () => void;
		const runner = startRunner(db, {
			reconvert: () => new Promise<null>((r) => (finish = () => r(null)))
		});
		runner.stop();

		const started = waitForJobPoll(db, id, 5000);
		expect(await within(started, 20)).toBe('pending');
		const done = runner.tick();
		expect(await within(started, 50)).toMatchObject({ status: 'running' });

		const finished = waitForJobPoll(db, id, 5000);
		expect(await within(finished, 20)).toBe('pending');
		finish();
		await done;
		expect(await within(finished, 50)).toMatchObject({ status: 'done', error_code: null });
	});

	it('answers a failure as soon as it is stored', async () => {
		const db = testDb();
		const id = createJob(db, 'reconvert', {});
		db.prepare("UPDATE job SET status = 'running' WHERE id = ?").run(id);
		const waiting = waitForJobPoll(db, id, 5000);
		recoverInterrupted(db);
		expect(await within(waiting, 50)).toMatchObject({ status: 'failed', error_code: 'interrupted' });
	});

	it('answers with the unchanged status when the wait elapses', async () => {
		const db = testDb();
		const id = createJob(db, 'reconvert', {});
		const waiting = waitForJobPoll(db, id, 60);
		expect(await within(waiting, 30)).toBe('pending');
		expect(await within(waiting, 200)).toMatchObject({ status: 'queued' });
	});

	it('answers when the client goes away', async () => {
		const db = testDb();
		const id = createJob(db, 'reconvert', {});
		const gone = new AbortController();
		const waiting = waitForJobPoll(db, id, 5000, gone.signal);
		gone.abort();
		expect(await within(waiting, 20)).toMatchObject({ status: 'queued' });
	});

	it('reads ?wait= in seconds, capped, and refuses nonsense', () => {
		expect(parseWait(null)).toBe(0);
		expect(parseWait('')).toBe(0);
		expect(parseWait('2.5')).toBe(2500);
		expect(parseWait('600')).toBe(MAX_WAIT_MS);
		expect(parseWait('-1')).toBeNull();
		expect(parseWait('soon')).toBeNull();
	});
});
