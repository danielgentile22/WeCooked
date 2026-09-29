import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const h = vi.hoisted(() => ({ env: {} as Record<string, string>, app: { dev: true } }));
vi.mock('$env/dynamic/private', () => ({ env: h.env }));
vi.mock('$app/environment', () => ({
	get dev() {
		return h.app.dev;
	}
}));

const { getObject, presignGet, putObject } = await import('./r2');

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'dev-images-'));
	Object.assign(h.env, { IMAGE_STORE: 'local', IMAGE_STORE_DIR: dir, IMAGE_STORE_ORIGIN: 'http://localhost:5173' });
	h.app.dev = true;
});
afterEach(() => {
	for (const k of Object.keys(h.env)) delete h.env[k];
	rmSync(dir, { recursive: true, force: true });
});

describe('local image store (IMAGE_STORE=local)', () => {
	const key = 'images/01J9Z8Y7X6W5V4T3S2R1Q0P9N8/display.jpg';

	it('round-trips put and get on disk and serves from the dev route', async () => {
		const body = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
		await putObject(key, body);
		expect(new Uint8Array(await getObject(key))).toEqual(body);
		expect(presignGet(key)).toBe(`http://localhost:5173/dev-images/${key}`);
	});

	it('rejects keys that could escape the directory', async () => {
		for (const bad of ['../x.jpg', 'images/../../etc/passwd.jpg', '/etc/x.jpg', 'images/a/..jpg', 'images/a/b.png']) {
			await expect(putObject(bad, new Uint8Array([1]))).rejects.toThrow(/Unsafe image key/);
			await expect(getObject(bad)).rejects.toThrow(/Unsafe image key/);
			expect(() => presignGet(bad)).toThrow(/Unsafe image key/);
		}
	});

	it('is refused outside dev', async () => {
		h.app.dev = false;
		expect(() => presignGet(key)).toThrow(/only allowed in dev/);
		await expect(putObject(key, new Uint8Array([1]))).rejects.toThrow(/only allowed in dev/);
	});

	it('rejects an unknown mode rather than falling back to R2', () => {
		h.env.IMAGE_STORE = 'Local';
		expect(() => presignGet(key)).toThrow(/not "local" or "r2"/);
	});
});
