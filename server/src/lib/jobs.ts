// Job error codes and their exact UI copy (SPEC 6.4), plus the client-side
// polling loop (SPEC 6.3). Shared: the server stores the copy in error_text,
// the client renders it through Banner (D6).

export type ErrorCode =
	| 'fetch_blocked'
	| 'fetch_failed'
	| 'no_recipe_found'
	| 'image_unreadable'
	| 'quota_exceeded'
	| 'api_error'
	| 'interrupted';

export const ERROR_COPY: Record<ErrorCode, string> = {
	fetch_blocked:
		'This site blocks automated readers. Copy the recipe text and paste it instead, or screenshot the page.',
	fetch_failed: 'Could not load that page. Paste the text instead?',
	no_recipe_found: 'Could not find a recipe there. Try pasting the text or a photo.',
	image_unreadable:
		'Could not read that photo. Try again with more light, or crop tighter on the recipe.',
	quota_exceeded: 'Daily limit on Claude calls reached. This usually means something is stuck.',
	api_error: 'Claude is unavailable right now. Try again in a minute.',
	interrupted: 'That was interrupted by a restart. Tap to try again.'
};

export type JobPoll = {
	status: 'queued' | 'running' | 'done' | 'failed' | 'timeout';
	error_code: ErrorCode | null;
	error_text: string | null;
	result_ref: string | null;
};

// SPEC 6.3: the poll gives up at 5 minutes "with a timeout message".
export const TIMEOUT_COPY = 'Still working after 5 minutes. Try again in a bit.';

// Issue #65: each request asks the server to hold the reply this many seconds,
// answering early the moment the status changes, so no client-side sleep.
const LONG_POLL_S = 25;
export const GIVE_UP_MS = 5 * 60_000;

export type PollOptions = {
	/** Abort when the page that started the poll goes away (issue #66). */
	signal?: AbortSignal;
	fetchFn?: typeof fetch;
};

/**
 * Long-poll GET /api/jobs/:id (issue #65) until the job is done or failed,
 * giving up at 5 minutes with status 'timeout' (SPEC 6.3). Rejects with an
 * AbortError once `signal` aborts, so a cancelled poll never reaches the
 * caller's reload (issue #66).
 */
export async function pollJob(
	id: string,
	{ signal, fetchFn = fetch }: PollOptions = {}
): Promise<JobPoll> {
	const start = Date.now();
	for (;;) {
		signal?.throwIfAborted();
		const left = GIVE_UP_MS - (Date.now() - start);
		if (left <= 0)
			return { status: 'timeout', error_code: null, error_text: TIMEOUT_COPY, result_ref: null };
		const wait = Math.min(LONG_POLL_S, Math.ceil(left / 1000));
		const res = await fetchFn(`/api/jobs/${id}?wait=${wait}`, { signal });
		if (!res.ok) throw new Error(`Job poll failed: ${res.status}`);
		const job: JobPoll = await res.json();
		if (job.status === 'done' || job.status === 'failed') return job;
	}
}

export const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';
/** `.catch` for a poll: a cancelled poll is silent, anything else still surfaces. */
export const ignoreAbort = (e: unknown) => {
	if (!isAbort(e)) throw e;
};

/**
 * A page effect's job watch: polls `jobId` and hands the finished poll to
 * `onEnd`. Returns the effect's cleanup, which aborts the poll (issue #66),
 * so a page that moves on never runs `onEnd`. A failure other than that
 * abort goes to `onError`, else surfaces as before.
 */
export function watchJob(
	jobId: string,
	onEnd: (job: JobPoll) => unknown,
	{ onError, fetchFn }: { onError?: (e: unknown) => void; fetchFn?: typeof fetch } = {}
): () => void {
	const poll = new AbortController();
	pollJob(jobId, { signal: poll.signal, fetchFn })
		.then(onEnd)
		.catch((e) => {
			if (isAbort(e)) return;
			if (!onError) throw e;
			onError(e);
		});
	return () => poll.abort();
}

/**
 * Named load dependencies (SvelteKit `depends`) a finished job invalidates,
 * so it reruns only the loads that show what the job changed (issue #66).
 * A key carries its id, so a poll left over from another page matches nothing.
 */
export const jobDeps = {
	drafts: 'app:drafts',
	draft: (id: string) => `app:draft:${id}`,
	recipe: (id: string) => `app:recipe:${id}`,
	shopping: 'app:shopping'
} as const;
