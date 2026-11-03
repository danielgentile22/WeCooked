// SPEC 8.1 step 1: client-side normalisation. createImageBitmap with
// from-image bakes EXIF orientation into the pixels, the canvas resize caps
// the long edge at 3000, and the JPEG q90 export sidesteps HEIC on the server
// while cutting a 10+ MB camera file to 1-2 MB for cellular.
export const FULL_EDGE = 3000;

export async function normalise(file: File): Promise<Blob> {
	const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
	const scale = Math.min(1, FULL_EDGE / Math.max(bmp.width, bmp.height));
	const canvas = document.createElement('canvas');
	canvas.width = Math.round(bmp.width * scale);
	canvas.height = Math.round(bmp.height * scale);
	canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
	bmp.close();
	return new Promise((resolve, reject) =>
		canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode image.'))), 'image/jpeg', 0.9)
	);
}

/** source_url is set on a found cover (issue #44): fetched, not taken. */
export type FormImage = { id: string; url: string; source_url: string | null };

type Role = 'photo' | 'capture';
type UploadOptions = { shrink?: (file: File) => Promise<Blob>; fetchFn?: typeof fetch };

async function send(blob: Blob, role: Role, fetchFn: typeof fetch): Promise<FormImage> {
	const res = await fetchFn(`/api/images?role=${role}`, { method: 'POST', body: blob });
	if (!res.ok) throw new Error('Upload failed.');
	const { id, url } = await res.json();
	return { id, url, source_url: null };
}

/** Normalise then upload one photo; resolves to what the form strip needs. */
export async function uploadPhoto(file: File, role: Role = 'photo'): Promise<FormImage> {
	return send(await normalise(file), role, fetch);
}

/**
 * Issue #77: several picked pages. Each is shrunk in turn (one full-size
 * decode at a time) and uploads as soon as it is shrunk, so the uploads
 * overlap. One promise per file, in pick order; each fails on its own.
 */
export function uploadPhotos(
	files: File[],
	role: Role,
	{ shrink = normalise, fetchFn = fetch }: UploadOptions = {}
): Promise<FormImage>[] {
	let previous: Promise<unknown> = Promise.resolve();
	return files.map((file) => {
		const blob = previous.then(() => shrink(file));
		previous = blob.catch(() => {});
		return blob.then((b) => send(b, role, fetchFn));
	});
}
