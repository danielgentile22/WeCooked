import { describe, expect, it } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import Database from 'better-sqlite3';
import { migrate } from './migrate';
import { CALL_TIMEOUT_MS, nyDay, takeQuota, withoutRetryAfter } from './claude';
import { GIVE_UP_MS } from '#lib/jobs.js';
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

describe('per-call timeout (issue #70)', () => {
	it('fits two attempts inside the client five minute give-up', () => {
		// Two attempts (maxRetries: 1), the 10 s page fetch before them, and
		// a minute between them: well past the SDK's 8 s default backoff.
		expect(2 * CALL_TIMEOUT_MS + 10_000 + 60_000).toBeLessThanOrEqual(GIVE_UP_MS);
	});

	it('retries an overload on the default backoff, not a long server Retry-After', async () => {
		const reply = { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [], stop_reason: 'end_turn', usage: {} };
		let calls = 0;
		const fake = (async () =>
			++calls === 1
				? new Response('{"type":"error","error":{"type":"overloaded_error","message":"busy"}}', {
						status: 529,
						headers: { 'content-type': 'application/json', 'retry-after': '20', 'retry-after-ms': '20000' }
					})
				: new Response(JSON.stringify(reply), { headers: { 'content-type': 'application/json' } })) as typeof fetch;
		const client = new Anthropic({ apiKey: 'k', maxRetries: 1, fetch: withoutRetryAfter(fake) });
		const start = Date.now();
		await client.messages.create({ model: 'x', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });
		expect(calls).toBe(2);
		// The SDK's own backoff tops out at 8 s; one retry waits under 1 s.
		expect(Date.now() - start).toBeLessThan(8_000);
	}, 10_000);
});
