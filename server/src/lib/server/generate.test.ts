import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import candidates from '../../../fixtures/candidates.json';
import type { GenerateResult } from '$lib/extract';
import { claudeCall } from './claude';
import { EXTRACT_SYSTEM, RECIPE_RULES } from './extract';
import { GENERATE_SYSTEM, generate, type GenerateReply } from './generate';
import type { JobRow } from './jobs';

vi.mock('./claude', () => ({ claudeCall: vi.fn() }));

const fixture = () => structuredClone(candidates) as GenerateReply;
const db = new Database(':memory:');
const jobRow = {
	kind: 'generate',
	input_json: JSON.stringify({
		description: 'the chicken thighs and half a cabbage, under 40 minutes',
		yield_count: 2,
		picked: null
	})
} as JobRow;

describe('generate (issue #41)', () => {
	beforeEach(() => {
		vi.mocked(claudeCall).mockReset();
	});

	it('returns the three candidates from one Claude call', async () => {
		vi.mocked(claudeCall).mockResolvedValue(fixture());
		const result = (await generate(jobRow, db)) as GenerateResult;
		expect(result.candidates).toHaveLength(3);
		expect(result.candidates.map((c) => c.title)).toEqual(fixture().candidates.map((c) => c.title));
		expect(claudeCall).toHaveBeenCalledTimes(1);
	});

	it('fails with api_error when Claude returns fewer than three', async () => {
		const short = fixture();
		short.candidates.pop();
		vi.mocked(claudeCall).mockResolvedValue(short);
		await expect(generate(jobRow, db)).rejects.toMatchObject({ code: 'api_error' });
	});

	it('fails with api_error when a candidate has no ingredients', async () => {
		const hollow = fixture();
		hollow.candidates[2].body.metric.ingredients = [{ heading: null, items: [] }];
		vi.mocked(claudeCall).mockResolvedValue(hollow);
		await expect(generate(jobRow, db)).rejects.toMatchObject({ code: 'api_error' });
	});

	it('derives each candidate effort from its minutes and override (issue #70)', async () => {
		const reply = fixture();
		reply.candidates[0].tags.effort_override = 'project';
		reply.candidates[1].prep_minutes = 5;
		reply.candidates[1].cook_minutes = 10;
		vi.mocked(claudeCall).mockResolvedValue(reply);
		const result = (await generate(jobRow, db)) as GenerateResult;
		expect(result.candidates.map((c) => c.tags.effort)).toEqual(['project', 'quick', 'weeknight']);
		expect(result.candidates[0].tags).not.toHaveProperty('effort_override');
	});

	it('builds both prompts on the shared recipe rules', () => {
		expect(EXTRACT_SYSTEM.endsWith(RECIPE_RULES)).toBe(true);
		expect(GENERATE_SYSTEM.endsWith(RECIPE_RULES)).toBe(true);
	});
});
