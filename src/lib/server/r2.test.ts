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
