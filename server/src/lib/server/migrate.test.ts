import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from './migrate';
import { coverJobs, createJob, getJobPoll, pendingCoverJob, startRunner } from './jobs';
import { getShoppingState } from './shopping';
import { listDrafts } from './drafts';
import { createRecipe, getRecipe } from './recipes';
import { ensureFresh, getCalcJob } from './scale';

vi.mock('./r2', () => ({ presignGet: (key: string) => `https://r2/${key}` }));

function version(db: Database.Database): number {
	return db.pragma('user_version', { simple: true }) as number;
}

describe('migrate', () => {
	it('applies numbered files in order and bumps user_version', () => {
		const dir = mkdtempSync(join(tmpdir(), 'mig-'));
		writeFileSync(join(dir, '002_second.sql'), 'CREATE TABLE b (id TEXT);');
		writeFileSync(join(dir, '001_first.sql'), 'CREATE TABLE a (id TEXT);');
		writeFileSync(join(dir, '010_tenth.sql'), 'ALTER TABLE a ADD COLUMN x TEXT;');
		const db = new Database(':memory:');
		migrate(db, dir);
		expect(version(db)).toBe(10);
		db.prepare('INSERT INTO a (id, x) VALUES (?, ?)').run('1', 'y');
		db.prepare('INSERT INTO b (id) VALUES (?)').run('1');
	});

	it('is idempotent and skips already-applied files', () => {
		const dir = mkdtempSync(join(tmpdir(), 'mig-'));
		writeFileSync(join(dir, '001_first.sql'), 'CREATE TABLE a (id TEXT);');
		const db = new Database(':memory:');
		migrate(db, dir);
		migrate(db, dir); // would throw "table a already exists" if reapplied
		expect(version(db)).toBe(1);
	});

	it('only applies files newer than user_version', () => {
		const dir = mkdtempSync(join(tmpdir(), 'mig-'));
		writeFileSync(join(dir, '001_first.sql'), 'CREATE TABLE a (id TEXT);');
		writeFileSync(join(dir, '002_second.sql'), 'CREATE TABLE b (id TEXT);');
		const db = new Database(':memory:');
		db.pragma('user_version = 1');
		migrate(db, dir);
		expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'a'").get()).toBeUndefined();
		expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'b'").get()).toBeDefined();
	});

	it('rolls back a failing migration and keeps user_version', () => {
		const dir = mkdtempSync(join(tmpdir(), 'mig-'));
		writeFileSync(join(dir, '001_bad.sql'), 'CREATE TABLE a (id TEXT); THIS IS NOT SQL;');
		const db = new Database(':memory:');
		expect(() => migrate(db, dir)).toThrow();
		expect(version(db)).toBe(0);
		expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'a'").get()).toBeUndefined();
	});

	it('applies the real schema', () => {
		const db = new Database(':memory:');
		migrate(db, 'migrations');
		expect(version(db)).toBe(6);
		const tables = db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
			.all()
			.map((r) => (r as { name: string }).name);
		for (const t of [
			'recipe',
			'recipe_meal_type',
			'variation',
			'body',
			'image',
			'job',
			'job_quota',
			'shopping_list',
			'shopping_list_recipe',
			'shopping_list_item',
			'recipe_fts',
			'device'
		])
			expect(tables).toContain(t);
	});

	it('002 lets the job table take generate jobs and keeps its rows and index', () => {
		const dir = mkdtempSync(join(tmpdir(), 'mig-'));
		copyFileSync('migrations/001_schema.sql', join(dir, '001_schema.sql'));
		const db = new Database(':memory:');
		migrate(db, dir);
		const insert = db.prepare(
			`INSERT INTO job (id, kind, status, input_json, created_at) VALUES (?, ?, 'queued', '{}', '2026')`
		);
		insert.run('old', 'extract_paste');
		expect(() => insert.run('early', 'generate')).toThrow(/CHECK/);

		copyFileSync('migrations/002_generate_kind.sql', join(dir, '002_generate_kind.sql'));
		migrate(db, dir);
		expect(version(db)).toBe(2);
		insert.run('gen', 'generate');
		expect(() => insert.run('bad', 'bogus')).toThrow(/CHECK/);
		expect(db.prepare('SELECT id FROM job ORDER BY id').all()).toEqual([{ id: 'gen' }, { id: 'old' }]);
		expect(
			db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'job'`).all()
		).toContainEqual({ name: 'job_pending' });
	});

	it('003 adds image.source_url and the cover kind without touching covers', () => {
		const dir = mkdtempSync(join(tmpdir(), 'mig-'));
		for (const f of ['001_schema.sql', '002_generate_kind.sql'])
			copyFileSync(`migrations/${f}`, join(dir, f));
		const db = new Database(':memory:');
		db.pragma('foreign_keys = ON');
		migrate(db, dir);
		db.prepare(
			`INSERT INTO recipe (id, title, yield_unit, source_units, effort, damage, created_at, updated_at)
			 VALUES ('r', 'Soup', 'servings', 'metric', 'quick', 'tidy', '2026', '2026')`
		).run();
		db.prepare(
			`INSERT INTO image (id, recipe_id, r2_key_full, r2_key_display, width, height, role, created_at)
			 VALUES ('i', 'r', 'f', 'd', 1, 1, 'photo', '2026')`
		).run();
		db.prepare(`UPDATE recipe SET cover_image_id = 'i' WHERE id = 'r'`).run();
		const insert = db.prepare(
			`INSERT INTO job (id, kind, status, input_json, created_at) VALUES (?, ?, 'queued', '{}', '2026')`
		);
		expect(() => insert.run('early', 'cover')).toThrow(/CHECK/);

		copyFileSync('migrations/003_cover.sql', join(dir, '003_cover.sql'));
		migrate(db, dir);
		expect(version(db)).toBe(3);
		insert.run('c', 'cover');
		expect(db.prepare(`SELECT cover_image_id FROM recipe WHERE id = 'r'`).get()).toEqual({ cover_image_id: 'i' });
		expect(db.prepare(`SELECT source_url FROM image WHERE id = 'i'`).get()).toEqual({ source_url: null });
		expect(
			db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'job'`).all()
		).toContainEqual({ name: 'job_pending' });
	});
});

describe('005 (issue #64)', () => {
	it('gives existing cover jobs their owner as a column, and nothing else one', () => {
		const dir = mkdtempSync(join(tmpdir(), 'mig-'));
		for (const f of ['001_schema.sql', '002_generate_kind.sql', '003_cover.sql', '004_devices.sql'])
			copyFileSync(`migrations/${f}`, join(dir, f));
		const db = new Database(':memory:');
		migrate(db, dir);
		const insert = db.prepare(
			`INSERT INTO job (id, kind, status, input_json, created_at) VALUES (?, ?, 'done', ?, '2026')`
		);
		insert.run('draft-cover', 'cover', JSON.stringify({ draft_id: 'D' }));
		insert.run('recipe-cover', 'cover', JSON.stringify({ recipe_id: 'R' }));
		insert.run('reconvert', 'reconvert', JSON.stringify({ recipe_id: 'R' }));

		copyFileSync('migrations/005_hot_indexes.sql', join(dir, '005_hot_indexes.sql'));
		migrate(db, dir);
		expect(version(db)).toBe(5);
		expect(db.prepare('SELECT id, cover_owner FROM job ORDER BY id').all()).toEqual([
			{ id: 'draft-cover', cover_owner: 'D' },
			{ id: 'recipe-cover', cover_owner: 'R' },
			{ id: 'reconvert', cover_owner: null }
		]);
		insert.run('new-cover', 'cover', JSON.stringify({ draft_id: 'E' }));
		expect(db.prepare(`SELECT cover_owner FROM job WHERE id = 'new-cover'`).get()).toEqual({
			cover_owner: 'E'
		});
	});
});

// Issue #64: the reads behind every poll, recipe view and job claim must
// search an index, not walk a whole table. Each case runs the real function
// against the real schema, records the statements it ran with their
// arguments, and asks SQLite for each one's plan.
describe('hot query plans (issue #64)', () => {
	type Ran = { sql: string; args: unknown[] };

	function recording(): { db: Database.Database; ran: Ran[] } {
		const db = new Database(':memory:');
		db.pragma('foreign_keys = ON');
		migrate(db, 'migrations');
		const ran: Ran[] = [];
		const prepare = db.prepare.bind(db);
		db.prepare = ((sql: string) => {
			const stmt = prepare(sql);
			return new Proxy(stmt, {
				get(target, prop, receiver) {
					const value = Reflect.get(target, prop, receiver);
					if (!['get', 'all', 'run', 'iterate'].includes(prop as string)) return value;
					return (...args: unknown[]) => {
						ran.push({ sql, args });
						return (value as (...a: unknown[]) => unknown).apply(target, args);
					};
				}
			});
		}) as typeof db.prepare;
		return { db, ran };
	}

	// A whole-table walk reads "SCAN job"; an index walk reads "SCAN job USING
	// INDEX x". The tiny singleton shopping_list table may be scanned.
	function plans(db: Database.Database, ran: Ran[]): { detail: string; sql: string }[] {
		const prepare = Database.prototype.prepare;
		return ran.flatMap(({ sql, args }) =>
			((prepare.call(db, `EXPLAIN QUERY PLAN ${sql}`) as Database.Statement).all(...args) as { detail: string }[]).map(
				(r) => ({ detail: r.detail, sql: sql.replace(/\s+/g, ' ').trim() })
			)
		);
	}

	const fullScans = (db: Database.Database, ran: Ran[]): string[] =>
		plans(db, ran)
			.filter(({ detail }) => /^SCAN \w+$/.test(detail) && detail !== 'SCAN shopping_list')
			.map(({ detail, sql }) => `${detail}  <-  ${sql}`);

	const recipe = (db: Database.Database) =>
		createRecipe(db, {
			title: 'Chickpea stew',
			yield_count: 4,
			yield_unit: 'servings',
			prep_minutes: 10,
			cook_minutes: 30,
			source_text: null,
			source_url: null,
			notes: null,
			source_units: 'metric',
			meal_types: ['dinner'],
			cuisine: null,
			protein: 'beans',
			effort: 'weeknight',
			damage: 'messy',
			ingredients: [{ heading: null, items: ['400 g tinned chickpeas'] }],
			steps: ['Simmer.'],
			counterpart: null,
			image_ids: [],
			cover_image_id: null
		});

	it('claims the next queued job from an index', async () => {
		const { db, ran } = recording();
		createJob(db, 'extract_paste', { text: 'soup' });
		ran.length = 0;
		const runner = startRunner(db, {}, 60_000);
		await runner.tick();
		runner.stop();
		expect(ran.some((r) => r.sql.includes("status = 'running'"))).toBe(true);
		expect(fullScans(db, ran)).toEqual([]);
	});

	it('answers a job poll from an index', () => {
		const { db, ran } = recording();
		const id = createJob(db, 'extract_paste', { text: 'soup' });
		ran.length = 0;
		getJobPoll(db, id);
		expect(fullScans(db, ran)).toEqual([]);
	});

	it('reads the shopping state from indexes', () => {
		const { db, ran } = recording();
		getShoppingState(db);
		expect(fullScans(db, ran)).toEqual([]);
	});

	it('lists drafts from an index', () => {
		const { db, ran } = recording();
		listDrafts(db);
		expect(fullScans(db, ran)).toEqual([]);
	});

	it('finds a draft or recipe cover job from an index', () => {
		const { db, ran } = recording();
		const recipeId = recipe(db);
		ran.length = 0;
		pendingCoverJob(db, { draft_id: 'D' });
		pendingCoverJob(db, { recipe_id: recipeId });
		coverJobs(db, { recipe_id: recipeId }, ['done']);
		expect(fullScans(db, ran)).toEqual([]);
		// A search on kind alone would walk every cover job ever made.
		expect(plans(db, ran).filter((p) => p.detail.includes('job_kind'))).toEqual([]);
	});

	it('reads a recipe view and its scale state from indexes', () => {
		const { db, ran } = recording();
		const recipeId = recipe(db);
		const variationId = getRecipe(db, recipeId)!.variation_id;
		ran.length = 0;
		getRecipe(db, recipeId);
		getCalcJob(db, recipeId);
		ensureFresh(db, variationId);
		expect(fullScans(db, ran)).toEqual([]);
	});
});
