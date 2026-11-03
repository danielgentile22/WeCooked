import { describe, it, expect, vi } from 'vitest';
import sharp from 'sharp';
import Database from 'better-sqlite3';
import { deriveClaude, deriveDisplay, normaliseFull, orientedDims, saveImage, CLAUDE_EDGE, DISPLAY_EDGE } from './images';
import { migrate } from './migrate';
import { putObject } from './r2';

vi.mock('./r2', () => ({ presignGet: (key: string) => `https://r2/${key}`, putObject: vi.fn() }));

// SPEC 8.2: the mandated EXIF trap test. Orientation 6 means "rotate 90° CW
// to display": a 400x300 sensor image must come out of the pipeline 300x400.
const rotatedFixture = () =>
	sharp({ create: { width: 400, height: 300, channels: 3, background: '#888' } })
		.jpeg()
		.withMetadata({ orientation: 6 })
		.toBuffer();

describe('image pipeline (SPEC 8.1, 8.2)', () => {
	it('bakes EXIF orientation into pixels: output dimensions flip', async () => {
		const { info } = await deriveDisplay(await rotatedFixture());
		expect(info.width).toBe(300);
		expect(info.height).toBe(400);
	});

	it('reports stored dimensions as displayed, not as encoded', async () => {
		expect(await orientedDims(await rotatedFixture())).toEqual({ width: 300, height: 400 });
	});

	it('stored full copy has pixels rotated and EXIF stripped (ADR-009 rule 3)', async () => {
		const full = await normaliseFull(await rotatedFixture());
		const m = await sharp(full).metadata();
		expect([m.width, m.height]).toEqual([300, 400]);
		expect(m.orientation ?? 1).toBe(1);
		expect(m.exif).toBeUndefined();
	});

	it('passes an EXIF-free upload through untouched', async () => {
		const clean = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#888' } })
			.jpeg()
			.toBuffer();
		expect(await normaliseFull(clean)).toBe(clean);
	});

	it('caps the long edge at 1200 without enlarging small images', async () => {
		const big = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#888' } })
			.jpeg()
			.toBuffer();
		const { info } = await deriveDisplay(big);
		expect(Math.max(info.width, info.height)).toBe(DISPLAY_EDGE);

		const small = await sharp({ create: { width: 600, height: 400, channels: 3, background: '#888' } })
			.jpeg()
			.toBuffer();
		expect((await deriveDisplay(small)).info.width).toBe(600);
	});

	// SPEC 5.8 + 8.2: the Claude copy is CLAUDE_EDGE max and rotated, so a
	// sideways EXIF upload cannot reach the model sideways even via this path.
	it('Claude copy caps the long edge at CLAUDE_EDGE and bakes rotation in', async () => {
		const big = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: '#888' } })
			.jpeg()
			.withMetadata({ orientation: 6 })
			.toBuffer();
		const m = await sharp(await deriveClaude(big)).metadata();
		// orientation 6 flips: sensor 4000x3000 displays 3000x4000, scaled to fit.
		expect(m.height).toBe(CLAUDE_EDGE);
		expect(m.width).toBe(Math.round((3000 / 4000) * CLAUDE_EDGE));
		expect(m.orientation ?? 1).toBe(1);
	});

	it('refuses decompression bombs: more than 50 MP of declared pixels', async () => {
		const bomb = await sharp({
			create: { width: 8000, height: 7000, channels: 3, background: '#000' }
		})
			.png()
			.toBuffer();
		await expect(deriveDisplay(bomb)).rejects.toThrow(/pixel limit/i);
	});

	// Issue #71: a capture's Claude copy is built at upload, so the photo job
	// only downloads it. A plain photo never goes to Claude and gets none.
	describe('saveImage', () => {
		const db = () => {
			const d = new Database(':memory:');
			migrate(d, 'migrations');
			return d;
		};
		const page = () =>
			sharp({ create: { width: 3000, height: 2250, channels: 3, background: '#eee' } })
				.jpeg()
				.toBuffer();
		const stored = () => new Map(vi.mocked(putObject).mock.calls.map(([k, b]) => [k, b]));

		it('stores a Claude copy for a capture and records its key', async () => {
			vi.mocked(putObject).mockClear();
			const d = db();
			const { id } = await saveImage(d, await page(), 'capture');
			const key = `images/${id}/claude.jpg`;
			const m = await sharp(stored().get(key) as Buffer).metadata();
			expect(Math.max(m.width, m.height)).toBe(CLAUDE_EDGE);
			expect(m.format).toBe('jpeg');
			expect(d.prepare('SELECT r2_key_claude FROM image WHERE id = ?').get(id)).toEqual({ r2_key_claude: key });
		});

		it('stores no Claude copy for a recipe photo', async () => {
			vi.mocked(putObject).mockClear();
			const d = db();
			const { id } = await saveImage(d, await page(), 'photo');
			expect([...stored().keys()]).toEqual([`images/${id}/full.jpg`, `images/${id}/display.jpg`]);
			expect(d.prepare('SELECT r2_key_claude FROM image WHERE id = ?').get(id)).toEqual({ r2_key_claude: null });
		});
	});
});
