import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages/messages';
import type { Database } from 'better-sqlite3';
import { env } from '$env/dynamic/private';
import { JobError } from './jobs';

// The one Claude API wrapper (SPEC 5.1, 5.9). Every call goes through
// claudeCall so the daily cap can never be bypassed (ADR-027).

// maxRetries: 1 is deliberate and load-bearing (ADR-016): the SDK default of 2
// means one transient failure silently bills three full extractions.
// Issue #70: two attempts must fit inside the client's five minute give-up
// (GIVE_UP_MS), with the page fetch before them and the SDK's backoff
// between. The SDK would honour a server-sent retry-after uncapped, so
// withoutRetryAfter drops it and the wait is always the SDK's own backoff
// (8 s at most).
export const CALL_TIMEOUT_MS = 110_000;

/** fetch for the SDK with the retry-after headers removed from every reply,
 *  so no retry waits longer than the SDK's default backoff. */
export const withoutRetryAfter =
	(fetchFn: typeof fetch = fetch): typeof fetch =>
	async (...args) => {
		const res = await fetchFn(...args);
		if (!res.headers.has('retry-after') && !res.headers.has('retry-after-ms')) return res;
		const headers = new Headers(res.headers);
		headers.delete('retry-after');
		headers.delete('retry-after-ms');
		return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
	};

// Lazy so the module can load (and takeQuota be tested) without a key.
let _client: Anthropic | undefined;
const client = () =>
	(_client ??= new Anthropic({
		apiKey: env.ANTHROPIC_API_KEY,
		maxRetries: 1,
		timeout: CALL_TIMEOUT_MS,
		fetch: withoutRetryAfter()
	}));

// 'YYYY-MM-DD' in America/New_York (SPEC 5.9); en-CA formats as ISO.
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
export const nyDay = (d = new Date()) => dayFmt.format(d);

/**
 * Count one Claude call against today's quota, atomically. Throws
 * JobError('quota_exceeded') once the cap is reached.
 */
export function takeQuota(db: Database, cap = Number(env.DAILY_CALL_CAP || 50), now = new Date()) {
	// `||` not `??`: a set-but-empty DAILY_CALL_CAP= must mean 50, not Number('')=0.
	const row = db
		.prepare(
			`INSERT INTO job_quota (day, count) VALUES (?, 1)
			 ON CONFLICT(day) DO UPDATE SET count = count + 1 WHERE count < ?
			 RETURNING count`
		)
		.get(nyDay(now), cap);
	if (!row) throw new JobError('quota_exceeded');
}

/** One structured-output Claude call. Returns the parsed JSON result. */
export async function claudeCall<T>(
	db: Database,
	opts: {
		system: string;
		messages: MessageParam[];
		schema: Record<string, unknown>;
		max_tokens?: number;
		model?: string;
	}
): Promise<T> {
	takeQuota(db);
	let msg: Anthropic.Message;
	try {
		msg = await client().messages.create({
			model: opts.model || env.CLAUDE_MODEL || 'claude-sonnet-5-5',
			max_tokens: opts.max_tokens ?? 16_000,
			system: opts.system,
			messages: opts.messages,
			output_config: {
				// API default effort on this generation is 'high'; low must be
				// explicit (SPEC 5.1).
				effort: (env.CLAUDE_EFFORT || 'low') as 'low' | 'medium' | 'high',
				format: { type: 'json_schema', schema: opts.schema }
			}
		});
	} catch (e) {
		throw new JobError('api_error', e instanceof Error ? e.message : String(e));
	}
	const text = msg.content.find((b) => b.type === 'text')?.text;
	if (!text) throw new JobError('api_error', 'Empty response from Claude.');
	return JSON.parse(text) as T;
}
