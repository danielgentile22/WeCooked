import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { deriveClaude, deriveDisplay, normaliseFull, orientedDims, CLAUDE_EDGE, DISPLAY_EDGE } from './images';

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

	// SPEC 5.8 + 8.2: the Claude copy is 2576 max and rotated, so a sideways
	// EXIF upload cannot reach the model sideways even via this path.
	it('Claude copy caps the long edge at 2576 and bakes rotation in', async () => {
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
});
