import db from '$lib/server/db';
import type { RequestHandler } from './$types';

// Health check: the database file must be writable (SPEC 9.1).
export const GET: RequestHandler = () => {
	try {
		// BEGIN IMMEDIATE takes a write lock, so it fails on a read-only or
		// broken database without writing any data for Litestream to replicate.
		db.exec('BEGIN IMMEDIATE; ROLLBACK;');
		return new Response('ok');
	} catch {
		return new Response('db not writable', { status: 500 });
	}
};
