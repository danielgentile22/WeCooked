import { describe, expect, it } from 'vitest';
import { uploadPhotos } from './images';

const file = (name: string) => new File([name], name, { type: 'image/jpeg' });

describe('uploadPhotos (issue #77)', () => {
	it('shrinks one page at a time, uploads them together and keeps pick order', async () => {
		const log: string[] = [];
		const shrink = async (f: File) => {
			log.push(`shrink ${f.name}`);
			await new Promise((r) => setTimeout(r, 5));
			log.push(`shrunk ${f.name}`);
			return new Blob([f.name]);
		};
		// Answers none of the uploads until all three have arrived, so
		// one-at-a-time uploads would never finish.
		const held: (() => void)[] = [];
		const fetchFn = (async (_url: string, init: RequestInit) => {
			const name = await (init.body as Blob).text();
			log.push(`upload ${name}`);
			await new Promise<void>((r) => {
				held.push(r);
				if (held.length === 3) held.forEach((go) => go());
			});
			return Response.json({ id: `id-${name}`, url: `u/${name}` });
		}) as unknown as typeof fetch;

		const uploads = uploadPhotos([file('a'), file('b'), file('c')], 'capture', { shrink, fetchFn });
		const images = await Promise.all(uploads);
		expect(images.map((i) => i.id)).toEqual(['id-a', 'id-b', 'id-c']);
		expect(log.filter((l) => !l.startsWith('upload'))).toEqual([
			'shrink a',
			'shrunk a',
			'shrink b',
			'shrunk b',
			'shrink c',
			'shrunk c'
		]);
		expect(log.indexOf('upload a')).toBeLessThan(log.indexOf('shrunk b'));
	});

	it('fails a page that cannot be read on its own', async () => {
		const shrink = async (f: File) => {
			if (f.name === 'b') throw new Error('unreadable');
			return new Blob([f.name]);
		};
		const fetchFn = (async (_url: string, init: RequestInit) =>
			Response.json({ id: await (init.body as Blob).text(), url: 'u' })) as unknown as typeof fetch;
		const uploads = uploadPhotos([file('a'), file('b'), file('c')], 'capture', { shrink, fetchFn });
		const results = await Promise.allSettled(uploads);
		expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
	});
});
