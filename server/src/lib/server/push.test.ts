import { describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { migrate } from './migrate';
import { createJob, type JobKind, type JobRow } from './jobs';
import { getDevice, registerDevice } from './devices';
import { captureNotification, makeApnsAuth, pushAfterJob, type PushTransport } from './push';

vi.mock('$env/dynamic/private', () => ({ env: {} }));

const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const ENV = { APNS_KEY: PEM, APNS_KEY_ID: 'KEY123', APNS_TEAM_ID: 'TEAM456' };
const TOKEN = 'ab'.repeat(32);
const T0 = Date.parse('2026-10-01T12:00:00Z');

function testDb() {
	const db = new Database(':memory:');
	migrate(db, 'migrations');
	return db;
}

function finished(
	db: Database.Database,
	kind: JobKind,
	over: { device_id?: string; status?: 'done' | 'failed'; result?: unknown; error_text?: string } = {}
): JobRow {
	const id = createJob(db, kind, {}, { device_id: over.device_id });
	db.prepare(`UPDATE job SET status = ?, result_json = ?, error_text = ? WHERE id = ?`).run(
		over.status ?? 'done',
		over.result === undefined ? null : JSON.stringify(over.result),
		over.error_text ?? null,
		id
	);
	return db.prepare('SELECT * FROM job WHERE id = ?').get(id) as JobRow;
}

type Sent = Parameters<PushTransport>[0];

function setup(reply: Awaited<ReturnType<PushTransport>> = { status: 200, body: '' }) {
	const db = testDb();
	const sent: Sent[] = [];
	let clock = T0;
	const transport = vi.fn<PushTransport>(async (req) => {
		sent.push(req);
		return reply;
	});
	const push = pushAfterJob(db, { transport, auth: makeApnsAuth(ENV), now: () => clock });
	return { db, sent, transport, push, advance: (ms: number) => (clock += ms) };
}

const b64json = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

describe('captureNotification (issue #42)', () => {
	it('names the draft when done and the failure when failed', () => {
		const db = testDb();
		expect(captureNotification(finished(db, 'extract_url', { device_id: 'p', result: { title: 'Toast' } }))).toEqual({
			title: 'Ready to review',
			body: 'Toast'
		});
		expect(captureNotification(finished(db, 'extract_paste', { device_id: 'p', result: { title: '' } }))).toEqual({
			title: 'Ready to review',
			body: 'A recipe'
		});
		expect(
			captureNotification(finished(db, 'extract_photos', { device_id: 'p', status: 'failed', error_text: 'No recipe.' }))
		).toEqual({ title: 'Capture failed', body: 'No recipe.' });
	});

	it('is null without a device or for a kind that is not a capture', () => {
		const db = testDb();
		expect(captureNotification(finished(db, 'extract_url', { result: { title: 'Toast' } }))).toBeNull();
		for (const kind of ['generate', 'scale', 'reconvert', 'cover', 'shopping_merge'] as const)
			expect(captureNotification(finished(db, kind, { device_id: 'p' }))).toBeNull();
	});
});

describe('pushAfterJob (issue #42)', () => {
	it('sends a done capture to the phone that queued it', async () => {
		const { db, sent, push } = setup();
		registerDevice(db, { device_id: 'phone', push_token: TOKEN, environment: 'production' });
		const job = finished(db, 'extract_url', { device_id: 'phone', result: { title: 'Shakshuka' } });
		await push(job);

		expect(sent).toHaveLength(1);
		const [req] = sent;
		expect(req.host).toBe('api.push.apple.com');
		expect(req.path).toBe(`/3/device/${TOKEN}`);
		expect(req.headers).toMatchObject({
			'apns-topic': 'kitchen.wecooked.ios',
			'apns-push-type': 'alert',
			'apns-priority': '10'
		});
		expect(JSON.parse(req.body)).toEqual({
			aps: { alert: { title: 'Ready to review', body: 'Shakshuka' }, sound: 'default' },
			link: `wecooked://drafts/${job.id}`
		});

		const [scheme, jwt] = req.headers.authorization.split(' ');
		expect(scheme).toBe('bearer');
		const [head, claims, sig] = jwt.split('.');
		expect(b64json(head)).toEqual({ alg: 'ES256', kid: 'KEY123' });
		expect(b64json(claims)).toEqual({ iss: 'TEAM456', iat: T0 / 1000 });
		const ok = crypto.verify(
			'sha256',
			Buffer.from(`${head}.${claims}`),
			{ key: publicKey, dsaEncoding: 'ieee-p1363' },
			Buffer.from(sig, 'base64url')
		);
		expect(ok).toBe(true);
	});

	it('sends a failed capture to the sandbox host for a sandbox phone', async () => {
		const { db, sent, push } = setup();
		registerDevice(db, { device_id: 'phone', push_token: TOKEN, environment: 'sandbox' });
		const job = finished(db, 'extract_photos', { device_id: 'phone', status: 'failed', error_text: 'Could not read it.' });
		await push(job);
		expect(sent[0].host).toBe('api.sandbox.push.apple.com');
		expect(JSON.parse(sent[0].body)).toEqual({
			aps: { alert: { title: 'Capture failed', body: 'Could not read it.' }, sound: 'default' },
			link: `wecooked://drafts/${job.id}`
		});
	});

	it('sends nothing without a registered device or for other kinds', async () => {
		const { db, transport, push } = setup();
		registerDevice(db, { device_id: 'phone', push_token: TOKEN, environment: 'production' });
		await push(finished(db, 'extract_url', { result: { title: 'Toast' } }));
		await push(finished(db, 'extract_url', { device_id: 'unknown', result: { title: 'Toast' } }));
		for (const kind of ['generate', 'scale', 'cover', 'shopping_merge'] as const)
			await push(finished(db, kind, { device_id: 'phone', result: { title: 'Toast' } }));
		expect(transport).not.toHaveBeenCalled();
	});

	it('forgets a device Apple reports as gone or bad', async () => {
		for (const reply of [
			{ status: 410, body: '{"reason":"Unregistered"}' },
			{ status: 400, body: '{"reason":"BadDeviceToken"}' }
		]) {
			const { db, push } = setup(reply);
			registerDevice(db, { device_id: 'phone', push_token: TOKEN, environment: 'production' });
			await push(finished(db, 'extract_url', { device_id: 'phone', result: { title: 'Toast' } }));
			expect(getDevice(db, 'phone'), reply.body).toBeUndefined();
		}
	});

	it('keeps the device on any other failure', async () => {
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { db, push } = setup({ status: 400, body: '{"reason":"BadTopic"}' });
		registerDevice(db, { device_id: 'phone', push_token: TOKEN, environment: 'production' });
		await push(finished(db, 'extract_url', { device_id: 'phone', result: { title: 'Toast' } }));
		expect(getDevice(db, 'phone')).toBeDefined();
		expect(log).toHaveBeenCalledWith(expect.stringContaining('BadTopic'));
		log.mockRestore();
	});

	it('logs and swallows a transport that throws', async () => {
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		const db = testDb();
		registerDevice(db, { device_id: 'phone', push_token: TOKEN, environment: 'production' });
		const push = pushAfterJob(db, {
			transport: async () => {
				throw new Error('socket hang up');
			},
			auth: makeApnsAuth(ENV)
		});
		await expect(push(finished(db, 'extract_url', { device_id: 'phone', result: {} }))).resolves.toBeUndefined();
		expect(log).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: 'socket hang up' }));
		log.mockRestore();
	});

	it('reuses the token for 50 minutes, then signs a new one', async () => {
		const { db, sent, push, advance } = setup();
		registerDevice(db, { device_id: 'phone', push_token: TOKEN, environment: 'production' });
		const send = () => push(finished(db, 'extract_url', { device_id: 'phone', result: { title: 'Toast' } }));
		await send();
		advance(49 * 60_000);
		await send();
		advance(2 * 60_000);
		await send();
		const [a, b, c] = sent.map((r) => r.headers.authorization);
		expect(b).toBe(a);
		expect(c).not.toBe(a);
	});
});

describe('makeApnsAuth (issue #42)', () => {
	const iss = (auth: ReturnType<typeof makeApnsAuth>) => b64json(auth!(T0).split('.')[1]).iss;

	it('reads the key as PEM, PEM with literal \\n, or base64 of the PEM', () => {
		expect(iss(makeApnsAuth(ENV))).toBe('TEAM456');
		expect(iss(makeApnsAuth({ ...ENV, APNS_KEY: PEM.replace(/\n/g, '\\n') }))).toBe('TEAM456');
		expect(iss(makeApnsAuth({ ...ENV, APNS_KEY: Buffer.from(PEM).toString('base64') }))).toBe('TEAM456');
	});

	it('is null when a secret is missing, and the sender then does nothing', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(makeApnsAuth({ ...ENV, APNS_TEAM_ID: '' })).toBeNull();
		const db = testDb();
		registerDevice(db, { device_id: 'phone', push_token: TOKEN, environment: 'production' });
		const transport = vi.fn<PushTransport>();
		await pushAfterJob(db, { transport, auth: null })(
			finished(db, 'extract_url', { device_id: 'phone', result: { title: 'Toast' } })
		);
		expect(transport).not.toHaveBeenCalled();
		warn.mockRestore();
	});
});
