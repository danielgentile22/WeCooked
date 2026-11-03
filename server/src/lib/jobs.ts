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

// Rejects with the signal's reason when the page that started the wait goes away.
function sleep(ms: number, signal?: AbortSignal) {
	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason);
		const t = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(t);
			reject(signal!.reason);
		};
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

export type PollOptions = {
	/** Abort when the page that started the poll goes away (issue #66). */
	signal?: AbortSignal;
	fetchFn?: typeof fetch;
};

/**
 * Poll GET /api/jobs/:id every 1.5 s, backing off to 5 s after 30 s, giving
 * up at 5 minutes with status 'timeout' (SPEC 6.3). Resolves on done/failed;
 * rejects with an AbortError once `signal` aborts, so a cancelled poll never
 * reaches the caller's reload.
 */
export async function pollJob(
	id: string,
	{ signal, fetchFn = fetch }: PollOptions = {}
): Promise<JobPoll> {
	const start = Date.now();
	for (;;) {
		signal?.throwIfAborted();
		const res = await fetchFn(`/api/jobs/${id}`, { signal });
		if (!res.ok) throw new Error(`Job poll failed: ${res.status}`);
		const job: JobPoll = await res.json();
		if (job.status === 'done' || job.status === 'failed') return job;
		const elapsed = Date.now() - start;
		if (elapsed >= 5 * 60_000)
			return { status: 'timeout', error_code: null, error_text: TIMEOUT_COPY, result_ref: null };
		await sleep(elapsed < 30_000 ? 1500 : 5000, signal);
	}
}

export const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';
/** `.catch` for a poll: a cancelled poll is silent, anything else still surfaces. */
export const ignoreAbort = (e: unknown) => {
	if (!isAbort(e)) throw e;
};

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
