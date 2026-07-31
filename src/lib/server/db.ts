import Database from 'better-sqlite3';
import { env } from '$env/dynamic/private';
import { migrate } from './migrate';

const db = new Database(env.DATABASE_PATH ?? 'local.db');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.pragma('synchronous = NORMAL'); // safe with WAL + Litestream

migrate(db, env.MIGRATIONS_DIR ?? 'migrations');

export default db;
