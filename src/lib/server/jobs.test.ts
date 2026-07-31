import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './migrate';
import { createJob, recoverInterrupted, startRunner, JobError, type JobRow } from './jobs';
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
