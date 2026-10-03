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

/** Normalise then upload one photo; resolves to what the form strip needs. */
export async function uploadPhoto(file: File, role: 'photo' | 'capture' = 'photo'): Promise<FormImage> {
	const blob = await normalise(file);
	const res = await fetch(`/api/images?role=${role}`, { method: 'POST', body: blob });
	if (!res.ok) throw new Error('Upload failed.');
	const { id, url } = await res.json();
	return { id, url, source_url: null };
}
