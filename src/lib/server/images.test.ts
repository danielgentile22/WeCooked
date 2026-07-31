import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { deriveDisplay, orientedDims, DISPLAY_EDGE } from './images';

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
});
