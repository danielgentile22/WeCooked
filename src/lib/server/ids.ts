import { randomBytes } from 'node:crypto';

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford

/** ULID (SPEC 4): 48-bit timestamp + 80-bit randomness, lexically sortable. */
export function ulid(now = Date.now()): string {
	let t = now;
	let time = '';
	for (let i = 0; i < 10; i++) {
		time = B32[t % 32] + time;
		t = Math.floor(t / 32);
	}
	const bytes = randomBytes(16);
	let rand = '';
	for (let i = 0; i < 16; i++) rand += B32[bytes[i] % 32];
	return time + rand;
}
