import { createHash, createHmac } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';

// SPEC 8.6 / ADR-026: private bucket, SigV4 presigned URLs, no aws-sdk.
// The signing timestamp is rounded to the UTC day so a URL is byte-identical
// across renders within a day and the browser cache works; expiry is 7 days,
// the SigV4 maximum, so a URL signed at 23:59 still outlives its day.

export type R2Config = {
	accountId: string;
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
};

// SPEC 9.3 names, no fallbacks: Litestream may reuse this pair, not the
// other way round.
const fromEnv = (): R2Config => {
	const cfg = {
		accountId: env.R2_ACCOUNT_ID ?? '',
		bucket: env.R2_BUCKET ?? '',
		accessKeyId: env.R2_ACCESS_KEY_ID ?? '',
		secretAccessKey: env.R2_SECRET_ACCESS_KEY ?? ''
	};
	if (Object.values(cfg).some((v) => !v)) throw new Error('R2 credentials are not configured.');
	return cfg;
};

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const hmac = (key: Buffer | string, s: string) => createHmac('sha256', key).update(s).digest();

/** SigV4 query-string presign for one object. Keys are ULID-based, so the
 *  canonical path needs no escaping beyond what they already satisfy. */
export function presign(
	method: 'GET' | 'PUT',
	key: string,
	signedAt: Date,
	cfg: R2Config = fromEnv()
): string {
	const host = `${cfg.accountId}.r2.cloudflarestorage.com`;
	const stamp = signedAt.toISOString().replace(/[-:]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
	const day = stamp.slice(0, 8);
	const scope = `${day}/auto/s3/aws4_request`;
	const path = `/${cfg.bucket}/${key}`;
	const params = new URLSearchParams({
		'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
		'X-Amz-Credential': `${cfg.accessKeyId}/${scope}`,
		'X-Amz-Date': stamp,
		'X-Amz-Expires': '604800',
		'X-Amz-SignedHeaders': 'host'
	});
	params.sort();
	const canonical = [method, path, params.toString(), `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
	const toSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256(canonical)].join('\n');
	let k = hmac(`AWS4${cfg.secretAccessKey}`, day);
	for (const part of ['auto', 's3', 'aws4_request']) k = hmac(k, part);
	const signature = hmac(k, toSign).toString('hex');
	return `https://${host}${path}?${params}&X-Amz-Signature=${signature}`;
}

// IMAGE_STORE=local keeps a dev server's photos on disk: the dev .env holds
// the production bucket's credentials. Refused outside dev so a stray variable
// on Fly cannot switch production storage.
type LocalStore = { dir: string; origin: string };

export function localStore(): LocalStore | null {
	const mode = env.IMAGE_STORE ?? '';
	if (mode === '' || mode === 'r2') return null;
	if (mode !== 'local') throw new Error(`IMAGE_STORE=${mode} is not "local" or "r2".`);
	if (!dev) throw new Error('IMAGE_STORE=local is only allowed in dev.');
	return {
		dir: resolve(env.IMAGE_STORE_DIR || '.dev-images'),
		origin: env.IMAGE_STORE_ORIGIN || 'http://localhost:5173'
	};
}

// No dot segments are possible: only the final ".jpg" may contain a dot.
const SAFE_KEY = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*\.jpg$/;

export function localPath(store: LocalStore, key: string): string {
	if (!SAFE_KEY.test(key)) throw new Error(`Unsafe image key: ${key}`);
	return resolve(store.dir, key);
}

/** Presigned GET with the timestamp rounded to the UTC day (SPEC 8.6). */
export function presignGet(key: string, cfg?: R2Config): string {
	const local = localStore();
	if (local) {
		localPath(local, key);
		return `${local.origin}/dev-images/${key}`;
	}
	const day = new Date();
	day.setUTCHours(0, 0, 0, 0);
	return presign('GET', key, day, cfg);
}

/** Server-side download: presign a GET and fetch it. */
export async function getObject(key: string, cfg?: R2Config): Promise<Buffer> {
	const local = localStore();
	if (local) return readFile(localPath(local, key));
	const res = await fetch(presign('GET', key, new Date(), cfg));
	if (!res.ok) throw new Error(`R2 GET ${key} failed: ${res.status} ${await res.text()}`);
	return Buffer.from(await res.arrayBuffer());
}

/** Server-side upload: presign a PUT and fetch it. */
export async function putObject(key: string, body: Uint8Array, cfg?: R2Config): Promise<void> {
	const local = localStore();
	if (local) {
		const path = localPath(local, key);
		await mkdir(dirname(path), { recursive: true });
		return writeFile(path, body);
	}
	const res = await fetch(presign('PUT', key, new Date(), cfg), {
		method: 'PUT',
		body: new Blob([body as Uint8Array<ArrayBuffer>]),
		headers: { 'content-type': 'image/jpeg' }
	});
	if (!res.ok) throw new Error(`R2 PUT ${key} failed: ${res.status} ${await res.text()}`);
}
