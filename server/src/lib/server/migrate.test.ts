import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from './migrate';

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
		expect(version(db)).toBe(2);
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
			'recipe_fts'
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
});
