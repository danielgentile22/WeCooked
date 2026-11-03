import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import candidates from '../../../fixtures/candidates.json';
import type { BodyPair, GenerateResult, RecipeDraft } from '$lib/extract';
import { claudeCall, takeQuota } from './claude';
import { EXTRACT_SYSTEM, RECIPE_RULES } from './extract';
import { migrate } from './migrate';
import { GENERATE_SYSTEM, anglesFor, generate } from './generate';
import { JobError, type JobRow } from './jobs';

vi.mock('./claude', async (actual) => ({
	...(await actual<typeof import('./claude')>()),
	claudeCall: vi.fn()
}));

/** The fixture's candidates as one call now writes them: metric only. */
const metricOnly = (): RecipeDraft[] =>
	(structuredClone(candidates.candidates) as (Omit<RecipeDraft, 'body'> & { body: BodyPair })[]).map(
		(c) => ({ ...c, body: { ...c.body.metric, source_units: 'metric' } })
	);

const DESCRIPTION = 'the chicken thighs and half a cabbage, under 40 minutes';
const jobRow = {
	kind: 'generate',
	input_json: JSON.stringify({ description: DESCRIPTION, yield_count: 2, picked: null })
} as JobRow;

let db: Database.Database;
const reply = (...drafts: RecipeDraft[]) => {
	const queue = [...drafts];
	vi.mocked(claudeCall).mockImplementation(async () => queue.shift()!);
};
const userText = (call: number) =>
	(vi.mocked(claudeCall).mock.calls[call][1].messages[0].content as string).toString();

describe('generate (issues #41, #68)', () => {
	beforeEach(() => {
		db = new Database(':memory:');
		migrate(db, 'migrations');
		vi.mocked(claudeCall).mockReset();
	});

	it('writes each candidate in its own call, all three in flight at once', async () => {
		const pending: ((d: RecipeDraft) => void)[] = [];
		vi.mocked(claudeCall).mockImplementation(() => new Promise((r) => pending.push(r)));
		const run = generate(jobRow, db);
		await vi.waitFor(() => expect(pending).toHaveLength(3));
		const drafts = metricOnly();
		pending.forEach((resolve, i) => resolve(drafts[i]));
		const result = (await run) as GenerateResult;
		expect(result.candidates.map((c) => c.title)).toEqual(drafts.map((c) => c.title));
	});

	it('gives each call a distinct angle', async () => {
		reply(...metricOnly());
		await generate(jobRow, db);
		const angles = anglesFor(DESCRIPTION);
		expect(new Set(angles.map((a) => a.text)).size).toBe(3);
		angles.forEach((a, i) => expect(userText(i)).toContain(a.text));
	});

	it('asks for the metric body only and keeps candidates that way', async () => {
		reply(...metricOnly());
		const result = (await generate(jobRow, db)) as GenerateResult;
		const { schema } = vi.mocked(claudeCall).mock.calls[0][1];
		const body = (schema as { properties: { body: { properties: object } } }).properties.body;
		expect(Object.keys(body.properties)).toEqual(['source_units', 'ingredients', 'steps']);
		expect(body.properties).toMatchObject({ source_units: { enum: ['metric'] } });
		for (const c of result.candidates) {
			expect(c.body.source_units).toBe('metric');
			expect(c.counterpart).toBeUndefined();
		}
		expect(GENERATE_SYSTEM).not.toContain('Conversion rules');
	});

	it('fails the job when any of the three calls fails', async () => {
		const [a, b] = metricOnly();
		vi.mocked(claudeCall)
			.mockResolvedValueOnce(a)
			.mockRejectedValueOnce(new JobError('api_error', 'overloaded'))
			.mockResolvedValueOnce(b);
		await expect(generate(jobRow, db)).rejects.toMatchObject({ code: 'api_error' });
	});

	it('fails with api_error when a candidate has no ingredients', async () => {
		const drafts = metricOnly();
		drafts[2].body.ingredients = [{ heading: null, items: [] }];
		reply(...drafts);
		await expect(generate(jobRow, db)).rejects.toMatchObject({ code: 'api_error' });
	});

	it('counts three calls against the daily cap', async () => {
		const drafts = metricOnly();
		vi.mocked(claudeCall).mockImplementation(async (d) => {
			takeQuota(d);
			return drafts.shift()!;
		});
		await generate(jobRow, db);
		expect(db.prepare('SELECT SUM(count) AS n FROM job_quota').get()).toEqual({ n: 3 });
	});

	it('builds both prompts on the shared recipe rules', () => {
		expect(EXTRACT_SYSTEM.endsWith(RECIPE_RULES)).toBe(true);
		expect(GENERATE_SYSTEM.endsWith(RECIPE_RULES)).toBe(true);
	});
});

describe('anglesFor (issue #68)', () => {
	const axisOf = (d: string) => new Set(anglesFor(d).map((a) => a.axis));

	it('returns three distinct angles on one axis', () => {
		for (const d of [DESCRIPTION, 'something warm', 'a thai dinner with prawns, vegan friends']) {
			const angles = anglesFor(d);
			expect(angles).toHaveLength(3);
			expect(new Set(angles.map((a) => a.text)).size).toBe(3);
			expect(axisOf(d).size).toBe(1);
		}
	});

	it('varies protein when the description leaves it open', () => {
		expect(axisOf('something warm for a rainy night')).toEqual(new Set(['protein']));
	});

	it('varies cuisine when the description names the protein or a diet', () => {
		expect(axisOf(DESCRIPTION)).toEqual(new Set(['cuisine']));
		expect(axisOf('a vegetarian lunch')).toEqual(new Set(['cuisine']));
	});

	it('varies technique when the description names both protein and cuisine', () => {
		expect(axisOf('an Italian salmon dinner')).toEqual(new Set(['technique']));
	});

	it('is stable for a description, and differs across descriptions', () => {
		expect(anglesFor('something warm')).toEqual(anglesFor('something warm'));
		const seen = new Set(
			['a', 'b', 'c', 'd', 'e', 'f'].map((s) => anglesFor(`soup ${s}`).map((a) => a.text).join())
		);
		expect(seen.size).toBeGreaterThan(1);
	});
});
