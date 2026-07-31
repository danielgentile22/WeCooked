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
	quota_exceeded: 'Daily limit reached (50 Claude calls). This usually means something is stuck.',
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll GET /api/jobs/:id every 1.5 s, backing off to 5 s after 30 s, giving
 * up at 5 minutes with status 'timeout' (SPEC 6.3). Resolves on done/failed.
 */
export async function pollJob(id: string, fetchFn: typeof fetch = fetch): Promise<JobPoll> {
	const start = Date.now();
	for (;;) {
		const res = await fetchFn(`/api/jobs/${id}`);
		if (!res.ok) throw new Error(`Job poll failed: ${res.status}`);
		const job: JobPoll = await res.json();
		if (job.status === 'done' || job.status === 'failed') return job;
		const elapsed = Date.now() - start;
		if (elapsed >= 5 * 60_000)
			return { status: 'timeout', error_code: null, error_text: TIMEOUT_COPY, result_ref: null };
		await sleep(elapsed < 30_000 ? 1500 : 5000);
	}
}
