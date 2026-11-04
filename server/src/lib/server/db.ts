import Database from 'better-sqlite3';
import * as env from '$app/env/private';
import { migrate } from './migrate';

const db = new Database(env.DATABASE_PATH ?? 'local.db');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.pragma('synchronous = NORMAL'); // safe with WAL + Litestream
// Issue #64: a 32 MB page cache (negative means KiB) so the book and the
// recent job history stay in memory, and temp b-trees (the ORDER BY sorts)
// in memory rather than in a temp file.
db.pragma('cache_size = -32000');
db.pragma('temp_store = MEMORY');

migrate(db, env.MIGRATIONS_DIR ?? 'migrations');
// Refresh the planner's statistics where they are missing or stale, as
// SQLite advises for a long-lived connection at open (0x10002: analyse every
// table that needs it, with a bounded cost per table).
db.pragma('optimize = 0x10002');

export default db;
