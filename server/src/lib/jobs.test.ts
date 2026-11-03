import { afterEach, describe, expect, it, vi } from 'vitest';
import { pollJob, type JobPoll } from './jobs';

const running: JobPoll = { status: 'running', error_code: null, error_text: null, result_ref: null };

describe('pollJob cancellation (issue #66)', () => {
	afterEach(() => vi.useRealTimers());

	it('stops polling and rejects once its page aborts the signal', async () => {
		vi.useFakeTimers();
		const fetchFn = vi.fn(async () => Response.json(running));
		const page = new AbortController();
		const poll = pollJob('j1', { signal: page.signal, fetchFn: fetchFn as typeof fetch });
		const settled = poll.then(
			() => 'resolved',
			(e: unknown) => (e as Error).name
		);
		await vi.advanceTimersByTimeAsync(1500);
		expect(fetchFn).toHaveBeenCalledTimes(2);
		page.abort();
		expect(await settled).toBe('AbortError');
		await vi.advanceTimersByTimeAsync(60_000);
		expect(fetchFn).toHaveBeenCalledTimes(2);
	});

	it('passes the signal to fetch so an in-flight request is cancelled too', async () => {
		let seen: AbortSignal | undefined;
		const fetchFn = vi.fn(
			(_url: string, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					seen = init?.signal ?? undefined;
					seen?.addEventListener('abort', () => reject(seen!.reason));
				})
		);
		const page = new AbortController();
		const poll = pollJob('j1', { signal: page.signal, fetchFn: fetchFn as typeof fetch });
		expect(seen).toBe(page.signal);
		page.abort();
		await expect(poll).rejects.toMatchObject({ name: 'AbortError' });
		expect(fetchFn).toHaveBeenCalledTimes(1);
	});

	it('does not fetch when the page is already gone', async () => {
		const fetchFn = vi.fn(async () => Response.json(running));
		const page = new AbortController();
		page.abort();
		await expect(
			pollJob('j1', { signal: page.signal, fetchFn: fetchFn as typeof fetch })
		).rejects.toMatchObject({ name: 'AbortError' });
		expect(fetchFn).not.toHaveBeenCalled();
	});
});
