// Forges the variation states the unit 5 UI tests need, straight in the local
// database, so only the steps under test spend Claude calls. Each subcommand
// is idempotent and finds the recipe by exact live title.
//
//   node server/scripts/unit5-prep.mjs reset "Shakshuka"
//   node server/scripts/unit5-prep.mjs fail-scale "Shakshuka" 6
//   node server/scripts/unit5-prep.mjs stuck-scale "Shakshuka" 6
//   node server/scripts/unit5-prep.mjs stale "Shakshuka"
//   node server/scripts/unit5-prep.mjs hand-edit "Shakshuka" 6
//   node server/scripts/unit5-prep.mjs fail-reconvert "Sunday ragù"
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

function count(raw) {
	const n = Number(raw);
	if (!(n > 0)) fail(`Not a positive count: ${raw}`);
	return n;
}

const db = new Database(DB);
const now = new Date().toISOString();

function recipe(title) {
	const r = db
		.prepare(`SELECT id, content_version FROM recipe WHERE title = ? AND deleted_at IS NULL`)
		.get(title);
	if (!r) fail(`No live recipe titled "${title}" in ${DB}`);
	return r;
}

function insertFailedJob(kind, refs, input) {
	db.prepare(
		`INSERT INTO job (id, kind, status, recipe_id, variation_id, input_json, error_code, error_text,
		   attempts, created_at, started_at, finished_at)
		 VALUES (?, ?, 'failed', ?, ?, ?, 'api_error', ?, 1, ?, ?, ?)`
	).run(ulid(), kind, refs.recipe_id ?? null, refs.variation_id ?? null, JSON.stringify(input), API_ERROR, now, now, now);
}

const commands = {
	reset(title) {
		const r = recipe(title);
		db.transaction(() => {
			db.prepare(
				`DELETE FROM job WHERE recipe_id = ?
				   OR variation_id IN (SELECT id FROM variation WHERE recipe_id = ?)`
			).run(r.id, r.id);
			db.prepare(
				`UPDATE variation SET deleted_at = ? WHERE recipe_id = ? AND is_original = 0 AND deleted_at IS NULL`
			).run(now, r.id);
			db.prepare(
				`UPDATE variation SET hand_edited = 0, based_on_content_version = ?
				 WHERE recipe_id = ? AND deleted_at IS NULL`
			).run(r.content_version, r.id);
		})();
	},

	'fail-scale'(title, raw) {
		const r = recipe(title);
		const toCount = count(raw);
		// Idempotent: a failure already forged for this count within the
		// 15-minute window is the same state.
		const existing = db
			.prepare(
				`SELECT id FROM job WHERE kind = 'scale' AND recipe_id = ? AND variation_id IS NULL
				   AND status = 'failed' AND json_extract(input_json, '$.to_count') = ? AND finished_at > ?`
			)
			.get(r.id, toCount, new Date(Date.now() - 15 * 60_000).toISOString());
		if (!existing) insertFailedJob('scale', { recipe_id: r.id }, { recipe_id: r.id, to_count: toCount });
	},

	// A running job nobody runs: the runner claims only queued rows, so the
	// app shows "Calculating" until reset removes it, and no call is spent.
	'stuck-scale'(title, raw) {
		const r = recipe(title);
		const toCount = count(raw);
		const existing = db
			.prepare(
				`SELECT id FROM job WHERE kind = 'scale' AND recipe_id = ? AND variation_id IS NULL
				   AND status = 'running' AND json_extract(input_json, '$.to_count') = ?`
			)
			.get(r.id, toCount);
		if (existing) return;
		db.prepare(
			`INSERT INTO job (id, kind, status, recipe_id, input_json, attempts, created_at, started_at)
			 VALUES (?, 'scale', 'running', ?, ?, 1, ?, ?)`
		).run(ulid(), r.id, JSON.stringify({ recipe_id: r.id, to_count: toCount }), now, now);
	},

	// Also moves the original's based_on_content_version, as a real edit does
	// (recipes.ts updateRecipe): otherwise the original reads stale too and
	// opening it queues a refresh of the original. The new version is one past
	// the newest scaled variation, so a rerun lands on the same state.
	stale(title) {
		const r = recipe(title);
		db.transaction(() => {
			const { version } = db
				.prepare(
					`SELECT COALESCE(MAX(based_on_content_version), ? - 1) + 1 AS version FROM variation
					 WHERE recipe_id = ? AND is_original = 0 AND deleted_at IS NULL`
				)
				.get(r.content_version, r.id);
			db.prepare(`UPDATE recipe SET content_version = ? WHERE id = ?`).run(version, r.id);
			db.prepare(
				`UPDATE variation SET based_on_content_version = ?
				 WHERE recipe_id = ? AND is_original = 1 AND deleted_at IS NULL`
			).run(version, r.id);
		})();
	},

	'hand-edit'(title, raw) {
		const r = recipe(title);
		const changes = db
			.prepare(
				`UPDATE variation SET hand_edited = 1
				 WHERE recipe_id = ? AND yield_count = ? AND deleted_at IS NULL`
			)
			.run(r.id, count(raw)).changes;
		if (!changes) fail(`"${title}" has no live ${raw} variation`);
	},

	'fail-reconvert'(title) {
		const r = recipe(title);
		const v = db
			.prepare(`SELECT id FROM variation WHERE recipe_id = ? AND is_original = 1 AND deleted_at IS NULL`)
			.get(r.id);
		if (!v) fail(`"${title}" has no live original variation`);
		const latest = db
			.prepare(
				`SELECT status FROM job WHERE variation_id = ? AND kind = 'reconvert'
				 ORDER BY created_at DESC, id DESC LIMIT 1`
			)
			.get(v.id);
		if (latest?.status === 'failed') return;
		const { unit_system } = db
			.prepare(`SELECT unit_system FROM body WHERE variation_id = ? AND is_source = 1`)
			.get(v.id);
		insertFailedJob(
			'reconvert',
			{ variation_id: v.id },
			{ variation_id: v.id, target_units: unit_system === 'us' ? 'metric' : 'us' }
		);
	}
};

const [name, ...args] = process.argv.slice(2);
const command = commands[name];
if (!command || args.length < command.length) {
	fail(`Usage: unit5-prep.mjs <${Object.keys(commands).join('|')}> <title> [count]`);
}
command(...args);
console.log(`${name} ${args.join(' ')}: done`);
