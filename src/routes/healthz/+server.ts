import db from '$lib/server/db';
import type { RequestHandler } from './$types';

// Health check: the database file must be writable (SPEC 9.1).
export const GET: RequestHandler = () => {
	try {
		db.exec('CREATE TABLE IF NOT EXISTS _healthz (ts TEXT)');
		db.prepare('INSERT INTO _healthz (ts) VALUES (?)').run(new Date().toISOString());
		db.exec('DELETE FROM _healthz');
		return new Response('ok');
	} catch (e) {
		return new Response(`db not writable: ${e}`, { status: 500 });
	}
};
