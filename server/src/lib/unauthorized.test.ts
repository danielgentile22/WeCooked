import { describe, expect, it, vi } from 'vitest';
import { onUnauthorized } from './unauthorized';

const origin = 'https://cook.example';
const reply = (status: number, url: string) => {
	const res = new Response(null, { status });
	Object.defineProperty(res, 'url', { value: url });
	return res;
};

describe('onUnauthorized', () => {
	it('calls back on a 401 from our own /api and still returns the response', async () => {
		const out = vi.fn();
		const res = reply(401, `${origin}/api/jobs/1`);
		const wrapped = onUnauthorized(async () => res, origin, out);
		expect(await wrapped('/api/jobs/1')).toBe(res);
		expect(out).toHaveBeenCalledOnce();
	});

	it('leaves other statuses, pages and other origins alone', async () => {
		const out = vi.fn();
		for (const res of [
			reply(200, `${origin}/api/v1/shopping`),
			reply(500, `${origin}/api/v1/shopping`),
			reply(401, `${origin}/recipes/1`),
			reply(401, `https://elsewhere.example/api/x`)
		])
			await onUnauthorized(async () => res, origin, out)('/x');
		expect(out).not.toHaveBeenCalled();
	});
});
