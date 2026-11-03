import sharp, { type Metadata } from 'sharp';
import type { Database } from 'better-sqlite3';
import { ulid } from './ids';
import { getObject, presignGet, putObject } from './r2';

// SPEC 8.1 step 2: the client uploads a normalised 3000px JPEG; the server
// stores it (r2_key_full) and derives a 1200px display size and a 400px WebP
// thumbnail (issue #73). A capture also gets the copy Claude reads (SPEC 5.8),
// built here at upload (issue #71).
// SPEC 8.2: .rotate() honours EXIF orientation before resizing, so even an
// upload that skipped client normalisation cannot come out sideways.

// Decompression-bomb guard: a small file can declare billions of pixels.
// 50 MP is well above a 3000px normalised upload or any phone camera.
const opts = { limitInputPixels: 50_000_000 };

export const DISPLAY_EDGE = 1200;
export const CLAUDE_EDGE = 1568; // issue #71 benchmark, was 2576
export const THUMB_EDGE = 400;

/**
 * ADR-009 rule 3: rotate pixels on upload, then strip EXIF. A client-canvas
 * JPEG carries no EXIF and passes through untouched; anything else (an upload
 * that skipped normalisation) is re-encoded, which bakes orientation into the
 * pixels and drops the metadata, GPS included (ADR-026: private photos).
 */
export async function normaliseFull(file: Buffer): Promise<Buffer> {
	return (await normalised(file)).file;
}

/** normaliseFull plus the displayed dimensions, from one header read. A
 *  re-encoded file is rotated, so its dimensions are the oriented ones. */
async function normalised(upload: Buffer) {
	const m = await sharp(upload, opts).metadata();
	const dims = oriented(m);
	if (!m.exif && (m.orientation ?? 1) === 1) return { file: upload, ...dims };
	return { file: await sharp(upload, opts).rotate().jpeg({ quality: 90 }).toBuffer(), ...dims };
}

export function deriveDisplay(full: Buffer) {
	return sharp(full, opts)
		.rotate()
		.resize(DISPLAY_EDGE, DISPLAY_EDGE, { fit: 'inside', withoutEnlargement: true })
		.jpeg({ quality: 85 })
		.toBuffer({ resolveWithObject: true });
}

/** SPEC 5.8: the copy Claude reads. Long edge CLAUDE_EDGE, q85; never below
 *  q80, this is a page of printed text. Built when a capture is uploaded
 *  (issue #71); `edge` exists for the benchmark that chose CLAUDE_EDGE. */
export function deriveClaude(full: Buffer, edge = CLAUDE_EDGE): Promise<Buffer> {
	return sharp(full, opts)
		.rotate()
		.resize(edge, edge, { fit: 'inside', withoutEnlargement: true })
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

/** Issue #73: the list-size copy Browse rows and the photo strip show. 400px
 *  covers a 56pt row tile and a 140pt strip photo at 3x. WebP, a third the
 *  bytes of a JPEG at this size. Stored, unlike the cover-pick copy below. */
export function deriveThumbnail(buf: Buffer): Promise<Buffer> {
	return sharp(buf, opts)
		.rotate()
		.resize(THUMB_EDGE, THUMB_EDGE, { fit: 'inside', withoutEnlargement: true })
		.webp({ quality: 75 })
		.toBuffer();
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
	return oriented(await sharp(buf, opts).metadata());
}

function oriented(m: Metadata): { width: number; height: number } {
	const flipped = (m.orientation ?? 1) >= 5;
	return flipped ? { width: m.height, height: m.width } : { width: m.width, height: m.height };
}

export type UploadedImage = { id: string; url: string; width: number; height: number };

/**
 * Store one photo: full, display and thumbnail to R2 in parallel, row with recipe_id NULL until a save
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
	const { file, width, height } = await normalised(upload);
	const [display, thumb] = await Promise.all([deriveDisplay(file), deriveThumbnail(file)]);
	const keyFull = `images/${id}/full.jpg`;
	const keyDisplay = `images/${id}/display.jpg`;
	const keyThumb = thumbKey(id);
	const keyClaude = role === 'capture' ? `images/${id}/claude.jpg` : null;
	await Promise.all([
		putObject(keyFull, file),
		putObject(keyDisplay, display.data),
		putObject(keyThumb, thumb, 'image/webp'),
		keyClaude ? deriveClaude(file).then((c) => putObject(keyClaude, c)) : null
	]);
	db.prepare(
		`INSERT INTO image (id, recipe_id, r2_key_full, r2_key_display, r2_key_thumb, r2_key_claude, width, height, role, source_url, created_at)
		 VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		id,
		keyFull,
		keyDisplay,
		keyThumb,
		keyClaude,
		width,
		height,
		role,
		found.source_url ?? null,
		new Date().toISOString()
	);
	return { id, url: presignGet(keyDisplay), width, height };
}

const thumbKey = (id: string) => `images/${id}/thumb.webp`;

export const THUMB_BACKFILL_LIMIT = 25;

/**
 * Issue #73: thumbnails for images stored before they existed, one page at a
 * time in id order. Made from the display copy (1200px is plenty for 400px,
 * and a third the download of the full). Idempotent: only rows still without
 * r2_key_thumb are read, and the key is set after the upload lands, so a rerun
 * or a crash midway just redoes the unfinished rows. A row that fails is
 * logged and passed over; `next` is the cursor for the following page, null
 * once the last page is done. Trashed images are skipped: Trash shows no
 * photos, and a restore falls back to the display copy.
 */
export async function backfillThumbnails(
	db: Database,
	limit = THUMB_BACKFILL_LIMIT,
	after = ''
): Promise<{ made: number; failed: number; next: string | null }> {
	const rows = db
		.prepare(
			`SELECT id, r2_key_display FROM image
			 WHERE r2_key_thumb IS NULL AND deleted_at IS NULL AND id > ?
			 ORDER BY id LIMIT ?`
		)
		.all(after, limit) as { id: string; r2_key_display: string }[];
	const set = db.prepare('UPDATE image SET r2_key_thumb = ? WHERE id = ?');
	let made = 0;
	let failed = 0;
	for (const r of rows) {
		try {
			const thumb = await deriveThumbnail(await getObject(r.r2_key_display));
			await putObject(thumbKey(r.id), thumb, 'image/webp');
			set.run(thumbKey(r.id), r.id);
			made++;
		} catch (e) {
			console.error('thumbnail backfill failed', r.id, e);
			failed++;
		}
	}
	return { made, failed, next: rows.length === limit ? rows[rows.length - 1].id : null };
}
