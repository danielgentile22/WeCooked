// Forges the Trash states the unit 7 UI tests need, straight in the local
// database. Each subcommand converges on the same state however often it runs.
//
//   node server/scripts/unit7-prep.mjs reset
//   node server/scripts/unit7-prep.mjs forge-clash
//   node server/scripts/unit7-prep.mjs clear
//
// DB overrides the database path (default server/local.db).

import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const DB = process.env.DB ?? fileURLToPath(new URL('../local.db', import.meta.url));
// 26 characters like a real ULID, so trash-restore-<id> is a stable identifier.
const CLASH_ID = '01UNIT7CLASH00000000000000';
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

function recipeId(title, { live = true } = {}) {
	const r = db
		.prepare(`SELECT id FROM recipe WHERE title = ? ${live ? 'AND deleted_at IS NULL' : ''}`)
		.get(title);
	if (!r) fail(`No ${live ? 'live ' : ''}recipe titled "${title}" in ${DB}`);
	return r.id;
}

function trashVariations(recipe, yieldCount, exceptId = null) {
	db.prepare(
		`UPDATE variation SET deleted_at = coalesce(deleted_at, ?)
		 WHERE recipe_id = ? AND is_original = 0 AND yield_count = ? AND id IS NOT ?`
	).run(now, recipe, yieldCount, exceptId);
}

function newestSix(shakshuka) {
	const row = db
		.prepare(
			`SELECT * FROM variation WHERE recipe_id = ? AND is_original = 0 AND yield_count = 6
			 ORDER BY created_at DESC LIMIT 1`
		)
		.get(shakshuka);
	if (!row) fail(`Shakshuka has no yield 6 variation in ${DB}`);
	return row;
}

function clear() {
	db.prepare('DELETE FROM body WHERE variation_id = ?').run(CLASH_ID);
	db.prepare('DELETE FROM variation WHERE id = ?').run(CLASH_ID);
}

function reset() {
	clear();
	db.prepare('UPDATE recipe SET deleted_at = coalesce(deleted_at, ?) WHERE id = ?').run(
		now,
		recipeId('Lemony White Beans on Toast', { live: false })
	);
	const shakshuka = recipeId('Shakshuka');
	const keep = newestSix(shakshuka).id;
	// variation_unique_yield allows one live row per yield: trash the rest first.
	trashVariations(shakshuka, 6, keep);
	db.prepare('UPDATE variation SET deleted_at = NULL WHERE id = ?').run(keep);
	trashVariations(recipeId('Buttermilk pancakes'), 13);
}

// ADR-025: restoring a variation at the original's yield is refused, so this
// row makes the restore error reachable.
function forgeClash() {
	reset();
	const shakshuka = recipeId('Shakshuka');
	const original = db
		.prepare('SELECT yield_count FROM variation WHERE recipe_id = ? AND is_original = 1 AND deleted_at IS NULL')
		.get(shakshuka);
	if (!original) fail(`Shakshuka has no live original in ${DB}`);
	const source = newestSix(shakshuka);
	db.prepare(
		`INSERT INTO variation (id, recipe_id, yield_count, is_original, hand_edited,
		   based_on_content_version, scaling_note, created_at, updated_at, deleted_at)
		 VALUES (?, ?, ?, 0, 1, ?, NULL, ?, ?, ?)`
	).run(CLASH_ID, shakshuka, original.yield_count, source.based_on_content_version, now, now, now);
	const bodies = db.prepare('SELECT * FROM body WHERE variation_id = ?').all(source.id);
	const ins = db.prepare(
		`INSERT INTO body (id, variation_id, unit_system, is_source, ingredients_json, steps_json, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	);
	for (const b of bodies) ins.run(ulid(), CLASH_ID, b.unit_system, b.is_source, b.ingredients_json, b.steps_json, now, now);
}

const commands = { reset, 'forge-clash': forgeClash, clear };

const [name] = process.argv.slice(2);
const command = commands[name];
if (!command) fail(`Usage: unit7-prep.mjs <${Object.keys(commands).join('|')}>`);
db.transaction(command)();

// listTrash in src/lib/server/recipes.ts.
console.log('Recipes');
for (const r of db
	.prepare('SELECT id, title, deleted_at FROM recipe WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC')
	.all())
	console.log(`  ${r.id} ${r.title} (${r.deleted_at})`);
console.log('Variations');
for (const v of db
	.prepare(
		`SELECT v.id, r.title, v.yield_count, r.yield_unit, v.deleted_at
		 FROM variation v JOIN recipe r ON r.id = v.recipe_id
		 WHERE v.deleted_at IS NOT NULL AND r.deleted_at IS NULL
		 ORDER BY v.deleted_at DESC`
	)
	.all())
	console.log(`  ${v.id} ${v.title} · ${v.yield_count} ${v.yield_unit} (${v.deleted_at})`);
console.log(`${name}: done`);
