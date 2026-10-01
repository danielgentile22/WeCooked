import type { Database } from 'better-sqlite3';

// Issue #42: the phones that registered for capture-ready pushes, keyed by the
// device id each install generates once and sends as X-Device-Id.

export const PUSH_ENVIRONMENTS = ['sandbox', 'production'] as const;
export type PushEnvironment = (typeof PUSH_ENVIRONMENTS)[number];

export type Device = {
	id: string;
	push_token: string;
	environment: PushEnvironment;
	updated_at: string;
};

/** Upsert: the app re-registers on every launch, so the same row is refreshed. */
export function registerDevice(
	db: Database,
	d: { device_id: string; push_token: string; environment: PushEnvironment }
): void {
	db.prepare(
		`INSERT INTO device (id, push_token, environment, updated_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT (id) DO UPDATE SET
		   push_token = excluded.push_token,
		   environment = excluded.environment,
		   updated_at = excluded.updated_at`
	).run(d.device_id, d.push_token, d.environment, new Date().toISOString());
}

export const getDevice = (db: Database, id: string) =>
	db.prepare('SELECT * FROM device WHERE id = ?').get(id) as Device | undefined;

/** Only while it still holds this token: a phone that re-registered a fresh
 *  token since the failed send keeps it. */
export function deleteDevice(db: Database, id: string, pushToken: string): void {
	db.prepare('DELETE FROM device WHERE id = ? AND push_token = ?').run(id, pushToken);
}
