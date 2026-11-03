import { afterEach, describe, expect, it, vi } from 'vitest';
import { pollJob, TIMEOUT_COPY, watchJob, type JobPoll } from './jobs';

const poll = (status: JobPoll['status']): JobPoll => ({
	status,
	error_code: null,
	error_text: null,
	result_ref: status === 'done' ? 'v1' : null
});
const running = poll('running');

/** A fetch that replays `statuses` and records each URL; each call "takes" `ms`. */
function fakeFetch(statuses: JobPoll['status'][], ms = 0) {
	const urls: string[] = [];
	const fn = (async (url: string) => {
		urls.push(url);
		vi.setSystemTime(Date.now() + ms);
		const s = statuses[Math.min(urls.length - 1, statuses.length - 1)];
		return Response.json(poll(s));
	}) as unknown as typeof fetch;
	return { fn, urls };
}

describe('pollJob long-poll (issue #65)', () => {
	afterEach(() => vi.useRealTimers());

	it('asks the server to hold the reply and re-asks straight away on a change', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		const { fn, urls } = fakeFetch(['queued', 'running', 'done']);
		expect(await pollJob('j1', { fetchFn: fn })).toEqual(poll('done'));
		expect(urls).toEqual(Array(3).fill('/api/jobs/j1?wait=25'));
	});

	it('gives up at 5 minutes, never asking to wait past it', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		const { fn, urls } = fakeFetch(['running'], 25_000);
		const r = await pollJob('j1', { fetchFn: fn });
		expect(r).toEqual({ status: 'timeout', error_code: null, error_text: TIMEOUT_COPY, result_ref: null });
		expect(urls.length).toBe(12);
		expect(urls.every((u) => u === '/api/jobs/j1?wait=25')).toBe(true);
	});
});

describe('pollJob cancellation (issue #66)', () => {
	afterEach(() => vi.useRealTimers());

	it('stops polling and rejects once its page aborts the signal', async () => {
		vi.useFakeTimers();
		// The server holds each request for its whole wait (issue #65).
		const fetchFn = vi.fn(
			(_url: string, init?: RequestInit) =>
				new Promise<Response>((resolve, reject) => {
					const t = setTimeout(() => resolve(Response.json(running)), 25_000);
					init?.signal?.addEventListener('abort', () => {
						clearTimeout(t);
						reject(init.signal!.reason);
					});
				})
		);
		const page = new AbortController();
		const poll = pollJob('j1', { signal: page.signal, fetchFn: fetchFn as typeof fetch });
		const settled = poll.then(
			() => 'resolved',
			(e: unknown) => (e as Error).name
		);
		await vi.advanceTimersByTimeAsync(25_000);
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

describe('watchJob', () => {
	const held = () => {
		let answer!: (r: Response) => void;
		const fetchFn = ((_url: string, init?: RequestInit) =>
			new Promise<Response>((resolve, reject) => {
				answer = resolve;
				init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
			})) as typeof fetch;
		return { fetchFn, answer: (s: JobPoll['status']) => answer(Response.json(poll(s))) };
	};

	it('hands the finished poll to onEnd', async () => {
		const { fetchFn, answer } = held();
		const onEnd = vi.fn();
		watchJob('j1', onEnd, { fetchFn });
		answer('done');
		await vi.waitFor(() => expect(onEnd).toHaveBeenCalledWith(poll('done')));
	});

	it('its cleanup cancels the poll silently: no onEnd, no onError', async () => {
		const { fetchFn } = held();
		const onEnd = vi.fn();
		const onError = vi.fn();
		const stop = watchJob('j1', onEnd, { fetchFn, onError });
		stop();
		await new Promise((r) => setTimeout(r, 0));
		expect(onEnd).not.toHaveBeenCalled();
		expect(onError).not.toHaveBeenCalled();
	});

	it('passes any other failure to onError', async () => {
		const fetchFn = (async () => new Response('', { status: 500 })) as unknown as typeof fetch;
		const onError = vi.fn();
		watchJob('j1', () => {}, { fetchFn, onError });
		await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
	});
});
