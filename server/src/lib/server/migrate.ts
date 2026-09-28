import type { Database } from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Apply numbered .sql files from `dir` whose leading number is greater than
 * PRAGMA user_version, each in its own transaction, bumping the pragma as it
 * goes (SPEC 4.1, ADR-032).
 */
export function migrate(db: Database, dir: string): void {
	const applied = db.pragma('user_version', { simple: true }) as number;
	const files = readdirSync(dir)
		.filter((f) => f.endsWith('.sql') && parseInt(f, 10) > applied)
		.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
	for (const file of files) {
		db.transaction(() => {
			db.exec(readFileSync(join(dir, file), 'utf8'));
			db.pragma(`user_version = ${parseInt(file, 10)}`);
		})();
	}
}
