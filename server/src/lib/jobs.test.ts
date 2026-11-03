import { afterEach, describe, expect, it, vi } from 'vitest';
import { pollJob, TIMEOUT_COPY, type JobPoll } from './jobs';

const poll = (status: JobPoll['status']): JobPoll => ({
	status,
	error_code: null,
	error_text: null,
	result_ref: status === 'done' ? 'v1' : null
});

/** A fetch that replays `statuses` and records each URL; each call "takes" `ms`. */
function fakeFetch(statuses: JobPoll['status'][], ms = 0) {
	const urls: string[] = [];
	const fn = (async (url: string) => {
		urls.push(url);
		vi.setSystemTime(Date.now() + ms);
		const s = statuses[Math.min(urls.length - 1, statuses.length - 1)];
		return new Response(JSON.stringify(poll(s)));
	}) as unknown as typeof fetch;
	return { fn, urls };
}

describe('pollJob long-poll (issue #65)', () => {
	afterEach(() => vi.useRealTimers());

	it('asks the server to hold the reply and re-asks straight away on a change', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		const { fn, urls } = fakeFetch(['queued', 'running', 'done']);
		expect(await pollJob('j1', fn)).toEqual(poll('done'));
		expect(urls).toEqual(Array(3).fill('/api/jobs/j1?wait=25'));
	});

	it('gives up at 5 minutes, never asking to wait past it', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		const { fn, urls } = fakeFetch(['running'], 25_000);
		const r = await pollJob('j1', fn);
		expect(r).toEqual({ status: 'timeout', error_code: null, error_text: TIMEOUT_COPY, result_ref: null });
		expect(urls.length).toBe(12);
		expect(urls.every((u) => u === '/api/jobs/j1?wait=25')).toBe(true);
	});
});
