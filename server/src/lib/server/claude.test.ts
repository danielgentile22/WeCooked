import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './migrate';
import { nyDay, takeQuota } from './claude';
import { JobError } from './jobs';

function testDb() {
	const db = new Database(':memory:');
	migrate(db, 'migrations');
	return db;
}

describe('daily call cap (SPEC 5.9)', () => {
	it('allows exactly cap calls, then throws quota_exceeded', () => {
		const db = testDb();
		for (let i = 0; i < 50; i++) takeQuota(db, 50);
		expect(() => takeQuota(db, 50)).toThrowError(JobError);
		try {
			takeQuota(db, 50);
		} catch (e) {
			expect((e as JobError).code).toBe('quota_exceeded');
		}
		expect(db.prepare('SELECT count FROM job_quota').get()).toEqual({ count: 50 });
	});

	it('counts per America/New_York day, not UTC', () => {
		// 03:00 UTC on the 30th is still 23:00 on the 29th in New York (EDT).
		expect(nyDay(new Date('2026-07-30T03:00:00Z'))).toBe('2026-07-29');
		expect(nyDay(new Date('2026-07-30T05:00:00Z'))).toBe('2026-07-30');
		const db = testDb();
		takeQuota(db, 1, new Date('2026-07-30T03:00:00Z'));
		// A new NY day starts a fresh count even at cap 1.
		takeQuota(db, 1, new Date('2026-07-30T05:00:00Z'));
		expect(db.prepare('SELECT count(*) AS n FROM job_quota').get()).toEqual({ n: 2 });
	});
});
