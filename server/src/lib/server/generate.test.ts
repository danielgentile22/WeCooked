import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import candidates from '../../../fixtures/candidates.json';
import type { GenerateResult } from '$lib/extract';
import { claudeCall } from './claude';
import { CONVERSION_RULES, EXTRACT_SYSTEM, RECIPE_RULES } from './extract';
import { GENERATE_SYSTEM, generate } from './generate';
import type { JobRow } from './jobs';

vi.mock('./claude', () => ({ claudeCall: vi.fn() }));

const fixture = () => structuredClone(candidates) as GenerateResult;
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
		expect(result.candidates.map((c) => c.title)).toEqual(fixture().candidates.map((c) => c.title));
		expect(claudeCall).toHaveBeenCalledTimes(1);
		const content = vi.mocked(claudeCall).mock.calls[0][1].messages[0].content;
		expect(content).toContain('the chicken thighs and half a cabbage, under 40 minutes');
		expect(content).toMatch(/\b2\b/);
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

	it('shares the rubric and conversion rules with the extraction prompt', () => {
		expect(GENERATE_SYSTEM).toContain(RECIPE_RULES);
		expect(EXTRACT_SYSTEM).toContain(RECIPE_RULES);
		expect(EXTRACT_SYSTEM).toContain('Damage rubric. Count the things that need washing');
		expect(EXTRACT_SYSTEM).toContain(CONVERSION_RULES);
		expect(EXTRACT_SYSTEM).toContain('Do not add ingredients that are not stated.');
	});
});
