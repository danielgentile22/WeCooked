import type { Database, Statement } from 'better-sqlite3';

// Issue #64: the statements behind the job claim, the job poll and the
// shopping state run many times a second between them. Each is compiled once
// per connection and reused, keyed by its SQL text.
const cache = new WeakMap<Database, Map<string, Statement>>();

export function prepared(db: Database, sql: string): Statement {
	let statements = cache.get(db);
	if (!statements) cache.set(db, (statements = new Map()));
	let statement = statements.get(sql);
	if (!statement) statements.set(sql, (statement = db.prepare(sql)));
	return statement;
}
