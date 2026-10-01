import crypto from 'node:crypto';
import http2 from 'node:http2';
import type { Database } from 'better-sqlite3';
import { env } from '$env/dynamic/private';
import { deleteDevice, getDevice, type PushEnvironment } from './devices';
import { isCaptureKind, type AfterJob, type JobRow } from './jobs';

// Issue #42: "Ready to review" on the phone that queued a capture. Sent
// straight to Apple's push service (APNs), so no third party holds household
// data. A failed push is logged and never touches the job.

/** One HTTP/2 request to APNs; the seam the tests stub. */
export type PushTransport = (req: {
	host: string;
	path: string;
	headers: Record<string, string>;
	body: string;
}) => Promise<{ status: number; body: string }>;

/** The bearer token for a moment in time (ms since epoch). */
export type ApnsAuth = (nowMs: number) => string;

const TOPIC = 'kitchen.wecooked.ios';
const HOST: Record<PushEnvironment, string> = {
	production: 'api.push.apple.com',
	sandbox: 'api.sandbox.push.apple.com'
};
const TIMEOUT_MS = 10_000;
// Apple rejects tokens older than an hour and throttles re-signing more often than every 20 minutes.
const TOKEN_TTL_MS = 50 * 60_000;

const sessions = new Map<string, http2.ClientHttp2Session>();

function session(host: string): http2.ClientHttp2Session {
	const open = sessions.get(host);
	if (open && !open.closed && !open.destroyed) return open;
	const s = http2.connect(`https://${host}`);
	// Without an error listener a dropped connection would crash the process;
	// forgetting the session makes the next push reconnect.
	s.on('error', (e) => {
		console.error(`apns session to ${host} failed:`, e);
		sessions.delete(host);
	});
	s.on('close', () => sessions.delete(host));
	s.unref();
	sessions.set(host, s);
	return s;
}

/** APNs needs HTTP/2, which fetch does not speak. One session per host. */
export const http2Transport: PushTransport = (req) =>
	new Promise((resolve, reject) => {
		const stream = session(req.host).request({ ':method': 'POST', ':path': req.path, ...req.headers });
		let status = 0;
		let body = '';
		stream.setEncoding('utf8');
		stream.setTimeout(TIMEOUT_MS, () => {
			stream.close(http2.constants.NGHTTP2_CANCEL);
			reject(new Error(`apns timed out after ${TIMEOUT_MS} ms`));
		});
		stream.on('response', (h) => (status = Number(h[':status'])));
		stream.on('data', (chunk: string) => (body += chunk));
		stream.on('end', () => resolve({ status, body }));
		stream.on('error', reject);
		stream.end(req.body);
	});

/** The .p8 key as a Fly secret: PEM, PEM with its newlines escaped, or base64 of the PEM. */
function readKey(raw: string): crypto.KeyObject {
	const pem = raw.includes('BEGIN') ? raw.replace(/\\n/g, '\n') : Buffer.from(raw, 'base64').toString('utf8');
	return crypto.createPrivateKey(pem);
}

const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

/** An ES256 signer for the push key, or null (logged) when it is not configured. */
export function makeApnsAuth(vars: Record<string, string | undefined> = env): ApnsAuth | null {
	const { APNS_KEY, APNS_KEY_ID, APNS_TEAM_ID } = vars;
	if (!APNS_KEY || !APNS_KEY_ID || !APNS_TEAM_ID) {
		console.warn('push: APNS_KEY, APNS_KEY_ID or APNS_TEAM_ID unset; capture pushes are off');
		return null;
	}
	let key: crypto.KeyObject;
	try {
		key = readKey(APNS_KEY);
	} catch (e) {
		console.error('push: APNS_KEY is not a readable private key; capture pushes are off', e);
		return null;
	}
	let cached: { token: string; at: number } | null = null;
	return (nowMs) => {
		if (cached && nowMs - cached.at < TOKEN_TTL_MS) return cached.token;
		const data = `${b64url({ alg: 'ES256', kid: APNS_KEY_ID })}.${b64url({ iss: APNS_TEAM_ID, iat: Math.floor(nowMs / 1000) })}`;
		const sig = crypto.sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' });
		cached = { token: `${data}.${sig.toString('base64url')}`, at: nowMs };
		return cached.token;
	};
}

/** What the phone shows for a finished capture, or null when nothing should be sent. */
export function captureNotification(job: JobRow): { title: string; body: string } | null {
	if (!isCaptureKind(job.kind) || job.device_id === null) return null;
	if (job.status === 'failed') return { title: 'Capture failed', body: job.error_text ?? '' };
	if (job.status !== 'done') return null;
	const title = (JSON.parse(job.result_json ?? 'null') as { title?: unknown } | null)?.title;
	return { title: 'Ready to review', body: typeof title === 'string' && title ? title : 'A recipe' };
}

function reason(body: string): string | undefined {
	try {
		return (JSON.parse(body) as { reason?: string }).reason;
	} catch {
		return undefined;
	}
}

/** The runner's afterJob: one push per finished capture queued from a registered phone. */
export function pushAfterJob(
	db: Database,
	deps: { transport: PushTransport; auth: ApnsAuth | null; now?: () => number }
): AfterJob {
	const { transport, auth, now = Date.now } = deps;
	if (!auth) return async () => {};
	return async (job) => {
		try {
			const note = captureNotification(job);
			const device = note && job.device_id ? getDevice(db, job.device_id) : undefined;
			if (!note || !device) return;
			const res = await transport({
				host: HOST[device.environment],
				path: `/3/device/${device.push_token}`,
				headers: {
					authorization: `bearer ${auth(now())}`,
					'apns-topic': TOPIC,
					'apns-push-type': 'alert',
					'apns-priority': '10'
				},
				body: JSON.stringify({
					aps: { alert: note, sound: 'default' },
					link: `wecooked://drafts/${job.id}`
				})
			});
			if (res.status === 200) return;
			const why = reason(res.body);
			if (res.status === 410 || (res.status === 400 && why === 'BadDeviceToken')) {
				deleteDevice(db, device.id, device.push_token);
				return;
			}
			console.error(`push for job ${job.id} failed: ${res.status} ${why ?? res.body}`);
		} catch (e) {
			console.error(`push for job ${job.id} failed:`, e);
		}
	};
}
