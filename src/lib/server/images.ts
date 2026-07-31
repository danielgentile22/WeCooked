import sharp from 'sharp';
import type { Database } from 'better-sqlite3';
import { ulid } from './ids';
import { presignGet, putObject } from './r2';

// SPEC 8.1 step 2: the client uploads a normalised 3000px JPEG; the server
// stores it as-is (r2_key_full) and derives a 1200px display size.
// SPEC 8.2: .rotate() honours EXIF orientation before resizing, so even an
// upload that skipped client normalisation cannot come out sideways.

export const DISPLAY_EDGE = 1200;

export function deriveDisplay(full: Buffer) {
	return sharp(full)
		.rotate()
		.resize(DISPLAY_EDGE, DISPLAY_EDGE, { fit: 'inside', withoutEnlargement: true })
		.jpeg({ quality: 85 })
		.toBuffer({ resolveWithObject: true });
}

/** Pixel dimensions as displayed, i.e. with EXIF orientation applied. */
export async function orientedDims(buf: Buffer): Promise<{ width: number; height: number }> {
	const m = await sharp(buf).metadata();
	const flipped = (m.orientation ?? 1) >= 5;
	return flipped ? { width: m.height, height: m.width } : { width: m.width, height: m.height };
}

export type UploadedImage = { id: string; url: string; width: number; height: number };

/**
 * Store one photo: full + display to R2, row with recipe_id NULL until a save
 * claims it (ADR-024). Returns what the review form needs to show the thumb.
 */
export async function saveImage(db: Database, file: Buffer): Promise<UploadedImage> {
	const id = ulid();
	const { width, height } = await orientedDims(file);
	const display = await deriveDisplay(file);
	const keyFull = `images/${id}/full.jpg`;
	const keyDisplay = `images/${id}/display.jpg`;
	await putObject(keyFull, file);
	await putObject(keyDisplay, display.data);
	db.prepare(
		`INSERT INTO image (id, recipe_id, r2_key_full, r2_key_display, width, height, role, created_at)
		 VALUES (?, NULL, ?, ?, ?, ?, 'photo', ?)`
	).run(id, keyFull, keyDisplay, width, height, new Date().toISOString());
	return { id, url: presignGet(keyDisplay), width, height };
}
