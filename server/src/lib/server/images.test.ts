import { beforeEach, describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { getObject, putObject } from './r2';
import { migrate } from './migrate';
import {
	backfillThumbnails,
	deriveClaude,
	deriveDisplay,
	deriveThumbnail,
	normaliseFull,
	orientedDims,
	saveImage,
	CLAUDE_EDGE,
	DISPLAY_EDGE,
	THUMB_EDGE
} from './images';

vi.mock('./r2', () => ({
	presignGet: (key: string) => `https://r2/${key}`,
	putObject: vi.fn(async () => {}),
	getObject: vi.fn()
}));

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
			expect([...stored().keys()]).toEqual([
				`images/${id}/full.jpg`,
				`images/${id}/display.jpg`,
				`images/${id}/thumb.webp`
			]);
			expect(d.prepare('SELECT r2_key_claude FROM image WHERE id = ?').get(id)).toEqual({ r2_key_claude: null });
		});
	});
});

const grey = (width: number, height: number) =>
	sharp({ create: { width, height, channels: 3, background: '#888' } }).jpeg().toBuffer();

describe('thumbnail (issue #73)', () => {
	it('is a WebP with the long edge at 400, rotation baked in', async () => {
		const big = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#888' } })
			.jpeg()
			.withMetadata({ orientation: 6 })
			.toBuffer();
		const m = await sharp(await deriveThumbnail(big)).metadata();
		expect(m.format).toBe('webp');
		expect([m.width, m.height]).toEqual([Math.round((2000 / 3000) * THUMB_EDGE), THUMB_EDGE]);
		expect(m.orientation ?? 1).toBe(1);
	});

	it('does not enlarge a small image', async () => {
		const m = await sharp(await deriveThumbnail(await grey(120, 90))).metadata();
		expect([m.width, m.height]).toEqual([120, 90]);
	});
});

describe('saveImage', () => {
	let db: Database.Database;
	beforeEach(() => {
		db = new Database(':memory:');
		migrate(db, 'migrations');
		vi.mocked(putObject).mockReset();
		vi.mocked(getObject).mockReset();
	});

	it('stores full, display and thumbnail, and records the thumbnail key', async () => {
		const img = await saveImage(db, await grey(1600, 1200));
		const keys = vi.mocked(putObject).mock.calls.map((c) => c[0]);
		expect(keys.sort()).toEqual([`images/${img.id}/display.jpg`, `images/${img.id}/full.jpg`, `images/${img.id}/thumb.webp`]);
		const thumbCall = vi.mocked(putObject).mock.calls.find((c) => c[0].endsWith('thumb.webp'))!;
		expect(thumbCall[2]).toBe('image/webp');
		expect((await sharp(Buffer.from(thumbCall[1])).metadata()).width).toBe(THUMB_EDGE);
		expect(db.prepare('SELECT r2_key_thumb FROM image WHERE id = ?').get(img.id)).toEqual({
			r2_key_thumb: `images/${img.id}/thumb.webp`
		});
		expect(img).toMatchObject({ width: 1600, height: 1200, url: `https://r2/images/${img.id}/display.jpg` });
	});

	it('uploads the stored copies in parallel', async () => {
		let inFlight = 0;
		let most = 0;
		vi.mocked(putObject).mockImplementation(async () => {
			most = Math.max(most, ++inFlight);
			await new Promise((r) => setTimeout(r, 5));
			inFlight--;
		});
		await saveImage(db, await grey(800, 600));
		expect(most).toBe(3);
	});
});

describe('backfillThumbnails', () => {
	let db: Database.Database;
	beforeEach(() => {
		db = new Database(':memory:');
		migrate(db, 'migrations');
		vi.mocked(putObject).mockReset();
		vi.mocked(getObject).mockReset();
	});

	const legacy = (id: string, deleted = false) =>
		db
			.prepare(
				`INSERT INTO image (id, recipe_id, r2_key_full, r2_key_display, width, height, role, created_at, deleted_at)
				 VALUES (?, NULL, ?, ?, 800, 600, 'photo', '2026', ?)`
			)
			.run(id, `images/${id}/full.jpg`, `images/${id}/display.jpg`, deleted ? '2026' : null);
	const thumbOf = (id: string) =>
		(db.prepare('SELECT r2_key_thumb FROM image WHERE id = ?').get(id) as { r2_key_thumb: string | null })
			.r2_key_thumb;

	it('makes a thumbnail from the display copy for each image without one, and is safe to rerun', async () => {
		legacy('a');
		legacy('b');
		legacy('gone', true);
		const display = await grey(1200, 900);
		vi.mocked(getObject).mockResolvedValue(display);

		expect(await backfillThumbnails(db, 1)).toEqual({ made: 1, failed: 0, next: 'a' });
		expect(await backfillThumbnails(db, 10, 'a')).toEqual({ made: 1, failed: 0, next: null });
		expect(thumbOf('a')).toBe('images/a/thumb.webp');
		expect(thumbOf('b')).toBe('images/b/thumb.webp');
		expect(thumbOf('gone')).toBeNull();
		expect(vi.mocked(getObject).mock.calls.map((c) => c[0]).sort()).toEqual([
			'images/a/display.jpg',
			'images/b/display.jpg'
		]);

		expect(await backfillThumbnails(db, 10)).toEqual({ made: 0, failed: 0, next: null });
		expect(vi.mocked(putObject)).toHaveBeenCalledTimes(2);
	});

	it('skips an image whose display copy cannot be read and moves past it', async () => {
		legacy('a');
		legacy('b');
		legacy('c');
		vi.mocked(getObject).mockImplementation(async (key: string) => {
			if (key.startsWith('images/a/')) throw new Error('R2 GET failed: 404');
			return grey(400, 300);
		});
		// The cursor walks past the failure, so a page of broken images cannot
		// stall the loop; a later run from the start retries it.
		expect(await backfillThumbnails(db, 1)).toEqual({ made: 0, failed: 1, next: 'a' });
		expect(await backfillThumbnails(db, 10, 'a')).toEqual({ made: 2, failed: 0, next: null });
		expect(thumbOf('a')).toBeNull();
		expect(thumbOf('b')).toBe('images/b/thumb.webp');
	});
});
