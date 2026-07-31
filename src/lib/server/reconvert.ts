import type { Database } from 'better-sqlite3';
import type { BodyText } from '$lib/tags';
import { claudeCall } from './claude';
import { BODY_SCHEMA, CONVERSION_RULES } from './extract';
import { JobError, type JobHandler } from './jobs';
import { ulid } from './ids';

// The reconvert call (SPEC 5.6, ADR-019): a human edited one body, so the
// counterpart is regenerated from it. Input names only the variation and the
// target system; the source text is read at run time, so a job queued before a
// second edit still converts the latest source.

export const RECONVERT_SYSTEM = `You convert one recipe body between US and metric units for a private
two-person recipe book. You are given the recipe as a human wrote it; produce
the SAME recipe in the other unit system.

- Transcribe faithfully: do not improve, shorten, reorder, or modernise.
  Keep group headings and the number of steps identical.
- Return only the converted ingredients and steps.

${CONVERSION_RULES}`;

/** Handler for the reconvert job kind: input_json is { variation_id, target_units }. */
export const reconvert: JobHandler = async (job, db) => {
	const { variation_id, target_units } = JSON.parse(job.input_json) as {
		variation_id: string;
		target_units: 'us' | 'metric';
	};
	const src = db
		.prepare(
			`SELECT unit_system, ingredients_json, steps_json FROM body
			 WHERE variation_id = ? AND is_source = 1`
		)
		.get(variation_id) as
		| { unit_system: 'us' | 'metric'; ingredients_json: string; steps_json: string }
		| undefined;
	if (!src) throw new JobError('api_error', `No source body for variation ${variation_id}.`);
	// Superseded job: is_source moved onto the target after this was queued
	// (enqueueReconvert retargets queued jobs, but not one already running).
	// Converting the source into itself would overwrite the human-authored
	// body with machine output — the exact failure ADR-028 exists to prevent.
	if (src.unit_system === target_units) return null;

	const body = await claudeCall<BodyText>(db, {
		system: RECONVERT_SYSTEM,
		messages: [
			{
				role: 'user',
				content:
					`Convert this recipe from ${src.unit_system === 'us' ? 'US' : 'metric'} to ` +
					`${target_units === 'us' ? 'US' : 'metric'} units.\n\n` +
					`Ingredients:\n${src.ingredients_json}\n\nSteps:\n${src.steps_json}`
			}
		],
		schema: BODY_SCHEMA
	});

	const ts = new Date().toISOString();
	db.prepare(
		`INSERT INTO body (id, variation_id, unit_system, is_source, ingredients_json,
		   steps_json, created_at, updated_at)
		 VALUES (?, ?, ?, 0, ?, ?, ?, ?)
		 ON CONFLICT(variation_id, unit_system) DO UPDATE SET
		   is_source = 0, ingredients_json = excluded.ingredients_json,
		   steps_json = excluded.steps_json, updated_at = excluded.updated_at`
	).run(
		ulid(),
		variation_id,
		target_units,
		JSON.stringify(body.ingredients),
		JSON.stringify(body.steps),
		ts,
		ts
	);
	return null;
};
