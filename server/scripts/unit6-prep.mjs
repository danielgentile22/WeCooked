// Forges the shopping list states the unit 6 UI tests need, straight in the
// local database, so only the steps under test spend Claude calls. Each
// subcommand converges on the same state however often it runs.
//
//   node server/scripts/unit6-prep.mjs clear
//   node server/scripts/unit6-prep.mjs forge-list
//   node server/scripts/unit6-prep.mjs stuck-build
//   node server/scripts/unit6-prep.mjs fail-build
//   node server/scripts/unit6-prep.mjs rebuild-result
//
// DB overrides the database path (default server/local.db).

import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const DB = process.env.DB ?? fileURLToPath(new URL('../local.db', import.meta.url));
// ERROR_COPY.api_error in src/lib/jobs.ts.
const API_ERROR = 'Claude is unavailable right now. Try again in a minute.';
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// Same shape as src/lib/server/ids.ts, which plain node cannot import.
function ulid(now = Date.now()) {
	let t = now;
	let time = '';
	for (let i = 0; i < 10; i++) {
		time = B32[t % 32] + time;
		t = Math.floor(t / 32);
	}
	const bytes = randomBytes(16);
	let rand = '';
	for (let i = 0; i < 16; i++) rand += B32[bytes[i] % 32];
	return time + rand;
}

function fail(message) {
	console.error(message);
	process.exit(1);
}

const db = new Database(DB);
const now = new Date().toISOString();

function recipeId(title) {
	const r = db.prepare(`SELECT id FROM recipe WHERE title = ? AND deleted_at IS NULL`).get(title);
	if (!r) fail(`No live recipe titled "${title}" in ${DB}`);
	return r.id;
}

// ADR-034: exactly one list row, created lazily by the server.
function listId() {
	const row = db.prepare('SELECT id FROM shopping_list').get();
	if (row) return row.id;
	const id = ulid();
	db.prepare('INSERT INTO shopping_list (id, created_at, updated_at) VALUES (?, ?, ?)').run(id, now, now);
	return id;
}

const PICKS = [
	{ title: 'Shakshuka', yield_count: 4 },
	{ title: 'Chickpea and spinach curry', yield_count: 6 }
];

function clear(list) {
	db.prepare('DELETE FROM shopping_list_item WHERE list_id = ?').run(list);
	db.prepare('DELETE FROM shopping_list_recipe WHERE list_id = ?').run(list);
	db.prepare(`DELETE FROM job WHERE kind = 'shopping_merge' AND list_id = ?`).run(list);
}

function insertPicks(list) {
	const ins = db.prepare('INSERT INTO shopping_list_recipe (list_id, recipe_id, yield_count) VALUES (?, ?, ?)');
	for (const p of PICKS) ins.run(list, recipeId(p.title), p.yield_count);
}

function insertJob(list, status, extra = {}) {
	const id = ulid();
	db.prepare(
		`INSERT INTO job (id, kind, status, list_id, input_json, result_json, error_code, error_text,
		   attempts, created_at, started_at, finished_at)
		 VALUES (?, 'shopping_merge', ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
	).run(
		id,
		status,
		list,
		JSON.stringify({ list_id: list }),
		extra.result ? JSON.stringify(extra.result) : null,
		extra.error_code ?? null,
		extra.error_text ?? null,
		now,
		now,
		status === 'running' ? null : now
	);
	return id;
}

function forgeList(list, result) {
	clear(list);
	insertPicks(list);
	const shakshuka = recipeId('Shakshuka');
	const curry = recipeId('Chickpea and spinach curry');
	const items = [
		['produce', '2 onions', '2 onions', [shakshuka, curry], 1],
		['produce', '14 oz spinach', '400 g spinach', [curry], 0],
		['meat-fish', '7 oz chorizo', '200 g chorizo', [shakshuka], 0],
		['dairy', '3.5 oz feta', '100 g feta', [shakshuka], 1],
		['dry-goods', '21 oz canned chickpeas', '600 g tinned chickpeas', [curry], 0],
		['spices', '2 tsp ground cumin', '2 tsp ground cumin', [shakshuka, curry], 0],
		['other', '1 jar harissa', '1 jar harissa', [shakshuka], 0],
		['staples', 'olive oil', 'olive oil', [shakshuka, curry], 0],
		['staples', 'salt', 'salt', [shakshuka, curry], 0]
	];
	const ins = db.prepare(
		`INSERT INTO shopping_list_item (id, list_id, section, text_us, text_metric,
		   from_recipes, is_manual, ticked, position)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
	);
	items.forEach(([section, us, metric, from, ticked], i) =>
		ins.run(ulid(), list, section, us, metric, JSON.stringify(from), 0, ticked, i)
	);
	// Position 0 so only the generated-before-manual rule puts it last in Other.
	ins.run(ulid(), list, 'other', 'kitchen roll', 'kitchen roll', '[]', 1, 0, 0);
	insertJob(list, 'done', { result });
}

const commands = {
	clear: (list) => clear(list),
	'forge-list': (list) => forgeList(list, { kept: 0, reset: [] }),
	'rebuild-result': (list) => forgeList(list, { kept: 2, reset: ['2 onions', 'olive oil'] }),
	// A running job nobody runs: the runner claims only queued rows, so the
	// app shows the building state until the next prep removes it.
	'stuck-build'(list) {
		clear(list);
		insertPicks(list);
		insertJob(list, 'running');
	},
	'fail-build'(list) {
		clear(list);
		insertPicks(list);
		insertJob(list, 'failed', { error_code: 'api_error', error_text: API_ERROR });
	}
};

const [name] = process.argv.slice(2);
const command = commands[name];
if (!command) fail(`Usage: unit6-prep.mjs <${Object.keys(commands).join('|')}>`);
const list = listId();
db.transaction(() => command(list))();
for (const row of db
	.prepare(`SELECT id, section, text_metric, ticked FROM shopping_list_item WHERE list_id = ? ORDER BY position`)
	.all(list))
	console.log(`${row.id} ${row.section} ${row.text_metric}${row.ticked ? ' (ticked)' : ''}`);
console.log(`${name}: done`);
