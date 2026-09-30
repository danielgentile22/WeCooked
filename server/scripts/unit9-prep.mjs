// Forges the generation state the unit 9 UI tests need, straight in the local
// database. Each subcommand converges on the same state however often it runs.
//
//   node server/scripts/unit9-prep.mjs choosing
//   node server/scripts/unit9-prep.mjs reset
//
// DB overrides the database path (default server/local.db). The database
// must already carry migration 002: restart the dev server after pulling it.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const DB = process.env.DB ?? fileURLToPath(new URL('../local.db', import.meta.url));
const CHOOSING_ID = '01UNIT9CHOOSING000000000000';
const DESCRIPTION = 'the chicken thighs and half a cabbage, under 40 minutes';
const CANDIDATES = readFileSync(new URL('../fixtures/candidates.json', import.meta.url), 'utf8');

const db = new Database(DB);
const now = new Date().toISOString();

function reset() {
	db.prepare(`DELETE FROM job WHERE kind = 'generate'`).run();
}

// A done, unpicked generation: the browse card says choose, the draft opens the deck.
function choosing() {
	reset();
	db.prepare(
		`INSERT INTO job (id, kind, status, input_json, result_json, attempts, created_at, started_at, finished_at)
		 VALUES (?, 'generate', 'done', ?, ?, 1, ?, ?, ?)`
	).run(
		CHOOSING_ID,
		JSON.stringify({ description: DESCRIPTION, yield_count: 2, picked: null }),
		JSON.stringify(JSON.parse(CANDIDATES)),
		now,
		now,
		now
	);
}

const commands = { choosing, reset };

const [name] = process.argv.slice(2);
const command = commands[name];
if (!command) {
	console.error(`Usage: unit9-prep.mjs <${Object.keys(commands).join('|')}>`);
	process.exit(1);
}
db.transaction(command)();

for (const j of db.prepare(`SELECT id, status, input_json FROM job WHERE kind = 'generate'`).all())
	console.log(`  ${j.id} ${j.status} ${j.input_json}`);
console.log(`${name}: done`);
