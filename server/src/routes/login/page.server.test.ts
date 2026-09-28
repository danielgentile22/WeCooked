import { describe, it, expect, vi } from 'vitest';
import { verify } from '@node-rs/argon2';
import { actions } from './+page.server';

vi.mock('$env/dynamic/private', () => ({ env: { APP_PASSWORD_HASH: 'hash' } }));
vi.mock('$lib/server/session', () => ({ setSessionCookie: vi.fn() }));
// A slow, always-wrong verify, like Argon2 against a bad guess.
vi.mock('@node-rs/argon2', () => ({
	verify: vi.fn(() => new Promise<boolean>((r) => setTimeout(() => r(false), 20)))
}));

const attempt = (ip: string, password = 'guess') =>
	actions.default!({
		request: new Request('http://x/login', {
			method: 'POST',
			headers: { 'fly-client-ip': ip },
			body: new URLSearchParams({ password })
		}),
		cookies: {},
		getClientAddress: () => '0.0.0.0'
	} as never) as Promise<{ status: number }>;

describe('login rate limit (SPEC 8.5)', () => {
	it('counts parallel attempts: 10 at once get at most 5 verifies', async () => {
		const results = await Promise.all(Array.from({ length: 10 }, () => attempt('1.1.1.1')));
		expect(results.filter((r) => r.status === 429)).toHaveLength(5);
		expect(verify).toHaveBeenCalledTimes(5);
	});

	it('clears the count on success', async () => {
		for (let i = 0; i < 4; i++) await attempt('2.2.2.2');
		// The 5th attempt succeeds and redirects (thrown by SvelteKit).
		vi.mocked(verify).mockResolvedValueOnce(true);
		await expect(attempt('2.2.2.2', 'right')).rejects.toMatchObject({ status: 303 });
		const after = await Promise.all(Array.from({ length: 5 }, () => attempt('2.2.2.2')));
		expect(after.every((r) => r.status === 400)).toBe(true);
	});
});
