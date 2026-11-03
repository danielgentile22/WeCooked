import { describe, it, expect, afterEach, vi } from 'vitest';
import { presign, presignGet, type R2Config } from './r2';

const cfg: R2Config = {
	accountId: 'acct',
	bucket: 'photos',
	accessKeyId: 'AKIDEXAMPLE',
	secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'
};

afterEach(() => vi.useRealTimers());

describe('presigned R2 URLs (SPEC 8.6)', () => {
	it('points at the bucket path with 7-day expiry and signed host', () => {
		const url = new URL(presign('GET', 'images/x/display.jpg', new Date('2026-07-30T10:00:00Z'), cfg));
		expect(url.host).toBe('acct.r2.cloudflarestorage.com');
		expect(url.pathname).toBe('/photos/images/x/display.jpg');
		expect(url.searchParams.get('X-Amz-Expires')).toBe('604800');
		expect(url.searchParams.get('X-Amz-Date')).toBe('20260730T100000Z');
		expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
	});

	it('is byte-identical across renders within the same day (cache works)', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-07-30T08:12:00Z'));
		const a = presignGet('images/x/display.jpg', cfg);
		vi.setSystemTime(new Date('2026-07-30T23:59:59Z'));
		const b = presignGet('images/x/display.jpg', cfg);
		expect(a).toBe(b);
	});

	it('changes on the next day and per key', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-07-30T08:12:00Z'));
		const a = presignGet('images/x/display.jpg', cfg);
		const other = presignGet('images/y/display.jpg', cfg);
		vi.setSystemTime(new Date('2026-07-31T08:12:00Z'));
		const b = presignGet('images/x/display.jpg', cfg);
		expect(a).not.toBe(b);
		expect(a).not.toBe(other);
	});
});

// Independent SigV4 reference (no caching, RFC 3986 query encoding) so a
// stale cached signing key or a mis-encoded signed parameter shows up as a
// signature mismatch.
import { createHash, createHmac } from 'node:crypto';
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
function reference(url: string, method: string, c: R2Config): string {
	const u = new URL(url);
	const pairs = [...u.searchParams].filter(([k]) => k !== 'X-Amz-Signature');
	const query = pairs.map(([k, v]) => [enc(k), enc(v)]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('&');
	const stamp = u.searchParams.get('X-Amz-Date')!;
	const day = stamp.slice(0, 8);
	const scope = `${day}/auto/s3/aws4_request`;
	const canonical = [method, u.pathname, query, `host:${u.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
	const toSign = ['AWS4-HMAC-SHA256', stamp, scope, createHash('sha256').update(canonical).digest('hex')].join('\n');
	const h = (k: Buffer | string, s: string) => createHmac('sha256', k).update(s).digest();
	let k = h(`AWS4${c.secretAccessKey}`, day);
	for (const p of ['auto', 's3', 'aws4_request']) k = h(k, p);
	return h(k, toSign).toString('hex');
}

describe('photo caching (issue #74)', () => {
	it('signs a long private immutable cache lifetime into every GET', () => {
		const url = new URL(presign('GET', 'images/x/display.jpg', new Date('2026-07-30T00:00:00Z'), cfg));
		const cc = url.searchParams.get('response-cache-control') ?? '';
		expect(cc.split(', ')).toEqual(expect.arrayContaining(['private', 'immutable']));
		expect(Number(/max-age=(\d+)/.exec(cc)?.[1])).toBeGreaterThanOrEqual(30 * 86400);
		expect(cc).not.toMatch(/public/);
		// Spaces and commas are percent-encoded, never "+", as SigV4 requires.
		expect(url.search).not.toContain('+');
		expect(url.searchParams.get('X-Amz-Signature')).toBe(reference(url.href, 'GET', cfg));
	});

	it('leaves PUT URLs without a response override', () => {
		const url = new URL(presign('PUT', 'images/x/display.jpg', new Date('2026-07-30T10:00:00Z'), cfg));
		expect(url.searchParams.has('response-cache-control')).toBe(false);
		expect(url.searchParams.get('X-Amz-Signature')).toBe(reference(url.href, 'PUT', cfg));
	});

	it('signs correctly across day changes and secret changes (cached key never goes stale)', () => {
		const other = { ...cfg, secretAccessKey: 'another-secret' };
		for (const [at, c] of [
			['2026-07-30T00:00:00Z', cfg],
			['2026-07-30T12:00:00Z', cfg],
			['2026-07-31T00:00:00Z', cfg],
			['2026-07-31T00:00:00Z', other],
			['2026-07-30T00:00:00Z', cfg]
		] as const) {
			const url = presign('GET', 'images/x/display.jpg', new Date(at), c);
			expect(new URL(url).searchParams.get('X-Amz-Signature')).toBe(reference(url, 'GET', c));
		}
	});
});
