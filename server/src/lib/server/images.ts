import sharp from 'sharp';
import type { Database } from 'better-sqlite3';
import { ulid } from './ids';
import { presignGet, putObject } from './r2';

// SPEC 8.1 step 2: the client uploads a normalised 3000px JPEG; the server
// stores it (r2_key_full) and derives a 1200px display size, plus a 2576px
// q85 copy on demand for Claude (SPEC 5.8).
// SPEC 8.2: .rotate() honours EXIF orientation before resizing, so even an
// upload that skipped client normalisation cannot come out sideways.

// Decompression-bomb guard: a small file can declare billions of pixels.
// 50 MP is well above a 3000px normalised upload or any phone camera.
const opts = { limitInputPixels: 50_000_000 };

export const DISPLAY_EDGE = 1200;
export const CLAUDE_EDGE = 2576;

/**
 * ADR-009 rule 3: rotate pixels on upload, then strip EXIF. A client-canvas
 * JPEG carries no EXIF and passes through untouched; anything else (an upload
 * that skipped normalisation) is re-encoded, which bakes orientation into the
 * pixels and drops the metadata, GPS included (ADR-026: private photos).
 */
export async function normaliseFull(file: Buffer): Promise<Buffer> {
	const m = await sharp(file, opts).metadata();
	if (!m.exif && (m.orientation ?? 1) === 1) return file;
	return sharp(file, opts).rotate().jpeg({ quality: 90 }).toBuffer();
}

export function deriveDisplay(full: Buffer) {
	return sharp(full, opts)
		.rotate()
		.resize(DISPLAY_EDGE, DISPLAY_EDGE, { fit: 'inside', withoutEnlargement: true })
		.jpeg({ quality: 85 })
		.toBuffer({ resolveWithObject: true });
}

/** SPEC 5.8: the copy Claude reads. Long edge 2576, q85; never below q80,
 *  this is a page of printed text. Derived from the stored full at extraction
 *  time, not stored: an extraction happens once per capture. */
export function deriveClaude(full: Buffer): Promise<Buffer> {
	return sharp(full, opts)
		.rotate()
		.resize(CLAUDE_EDGE, CLAUDE_EDGE, { fit: 'inside', withoutEnlargement: true })
		.jpeg({ quality: 85 })
		.toBuffer();
}

/** ADR-043: a found image as a normalised full, the shape a client upload
 *  has: rotated, long edge at most 3000, q90. Decoding it here proves the
 *  bytes are an image before anything is stored. */
export function normaliseFound(buf: Buffer) {
	return sharp(buf, opts)
		.rotate()
		.resize(3000, 3000, { fit: 'inside', withoutEnlargement: true })
		.jpeg({ quality: 90 })
		.toBuffer({ resolveWithObject: true });
}

/** ADR-043: the small copy a cover pick sends Claude. Choosing a dish
 *  photo needs no detail, and four candidates ride one call. */
export function deriveThumb(buf: Buffer): Promise<Buffer> {
	return sharp(buf, opts)
		.rotate()
		.resize(512, 512, { fit: 'inside', withoutEnlargement: true })
		.jpeg({ quality: 80 })
		.toBuffer();
}

/** Pixel dimensions as displayed, i.e. with EXIF orientation applied. */
export async function orientedDims(buf: Buffer): Promise<{ width: number; height: number }> {
	const m = await sharp(buf, opts).metadata();
	const flipped = (m.orientation ?? 1) >= 5;
	return flipped ? { width: m.height, height: m.width } : { width: m.width, height: m.height };
}

export type UploadedImage = { id: string; url: string; width: number; height: number };

/**
 * Store one photo: full + display to R2, row with recipe_id NULL until a save
 * claims it (ADR-024). Returns what the review form needs to show the thumb.
 * source_url marks a found cover (ADR-043): an image fetched from the web.
 */
export async function saveImage(
	db: Database,
	upload: Buffer,
	role: 'photo' | 'capture' = 'photo',
	found: { source_url?: string } = {}
): Promise<UploadedImage> {
	const id = ulid();
	const file = await normaliseFull(upload);
	const { width, height } = await orientedDims(file);
	const display = await deriveDisplay(file);
	const keyFull = `images/${id}/full.jpg`;
	const keyDisplay = `images/${id}/display.jpg`;
	await putObject(keyFull, file);
	await putObject(keyDisplay, display.data);
	db.prepare(
		`INSERT INTO image (id, recipe_id, r2_key_full, r2_key_display, width, height, role, source_url, created_at)
		 VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)`
	).run(id, keyFull, keyDisplay, width, height, role, found.source_url ?? null, new Date().toISOString());
	return { id, url: presignGet(keyDisplay), width, height };
}
