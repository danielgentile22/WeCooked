import { createHash, createHmac } from 'node:crypto';
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

/** Presigned GET with the timestamp rounded to the UTC day (SPEC 8.6). */
export function presignGet(key: string, cfg?: R2Config): string {
	const day = new Date();
	day.setUTCHours(0, 0, 0, 0);
	return presign('GET', key, day, cfg);
}

/** Server-side upload: presign a PUT and fetch it. */
export async function putObject(key: string, body: Uint8Array, cfg?: R2Config): Promise<void> {
	const res = await fetch(presign('PUT', key, new Date(), cfg), {
		method: 'PUT',
		body: new Blob([body as Uint8Array<ArrayBuffer>]),
		headers: { 'content-type': 'image/jpeg' }
	});
	if (!res.ok) throw new Error(`R2 PUT ${key} failed: ${res.status} ${await res.text()}`);
}
