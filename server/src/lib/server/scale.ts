import type { Database } from 'better-sqlite3';
import type { BodyText, IngredientGroup, UnitSystem } from '$lib/tags';
import { claudeCall } from './claude';
import { BODY_SCHEMA, CONVERSION_RULES } from './extract';
import { JobError, createJob, type JobHandler } from './jobs';
import { ulid } from './ids';

// The scale call (SPEC 5.5, ADR-012): scaling is not multiplication. One
// handler serves two input shapes:
//   { recipe_id, to_count }  create a new variation at that yield
//   { variation_id }         refresh a stale untouched variation in place
// Both read the ORIGINAL variation's metric body at run time (staleness is
// measured against the original, and grams scale cleanly where cups do not).

export type BodyPair = {
	source_units: UnitSystem;
	us: BodyText;
	metric: BodyText;
};

export const SCALE_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		body: {
			type: 'object',
			additionalProperties: false,
			properties: {
				source_units: { enum: ['us', 'metric'] },
				us: BODY_SCHEMA,
				metric: BODY_SCHEMA
			},
			required: ['source_units', 'us', 'metric']
		},
		scaling_note: { type: 'string' }
	},
	required: ['body', 'scaling_note']
};

// SPEC 5.5 prompt rules, verbatim.
export const SCALE_SYSTEM = `You rescale recipes for a private two-person recipe book.

- Do NOT scale everything linearly. Salt, spices, chilli, and strong aromatics
  scale sublinearly. Leavening (yeast, baking powder) scales sublinearly when
  scaling up. Fat for greasing a pan scales with the pan, not the recipe.
- Adjust pan and tin sizes, and say the new size explicitly.
- Adjust cook times, but state them as guidance and give a sensory check
  ("until the edges pull away"), because scaled times are genuinely uncertain.
- Rewrite the STEPS as well as the ingredients: quantities, tins, and times all
  appear in step text and must agree with the ingredient list.
- Produce both US and metric bodies.
- In scaling_note, in one to three short lines, name what did NOT scale
  linearly and anything the cook must watch. This is the part that makes the
  result trustworthy.

${CONVERSION_RULES}`;

// SPEC 5.5: outside 0.25x to 4x the job still runs, but the note must lead
// with a warning.
export const RANGE_WARNING =
	'This is far outside the tested range (0.25x to 4x): scaling_note MUST lead with a warning that this is a large change and times are a starting point only.';

const now = () => new Date().toISOString();

type ScaleInput = {
	recipe_id?: string;
	variation_id?: string;
	to_count?: number;
};

/** Handler for the scale job kind. Result is { variation_id } of the scaled variation. */
export const scale: JobHandler = async (job, db) => {
	const input = JSON.parse(job.input_json) as ScaleInput;

	// Refresh case: the target variation supplies recipe and yield.
	let target: { id: string; yield_count: number } | null = null;
	let recipeId = input.recipe_id;
	let toCount = input.to_count;
	if (input.variation_id) {
		const v = db
			.prepare(
				`SELECT id, recipe_id, yield_count, hand_edited FROM variation
				 WHERE id = ? AND deleted_at IS NULL`
			)
			.get(input.variation_id) as
			| {
					id: string;
					recipe_id: string;
					yield_count: number;
					hand_edited: number;
			  }
			| undefined;
		if (!v) return null; // deleted since queued: nothing to refresh
		// A hand edit made while this job was queued must never be overwritten
		// (SPEC 7.5: hand-edited variations are never touched automatically).
		if (v.hand_edited) return null;
		target = v;
		recipeId = v.recipe_id;
		toCount = v.yield_count;
	}
	if (!recipeId || !toCount) throw new JobError('api_error', 'Malformed scale job input.');

	const src = db
		.prepare(
			`SELECT v.yield_count, r.yield_unit, r.content_version,
			        b.unit_system, b.ingredients_json, b.steps_json
			 FROM recipe r
			 JOIN variation v ON v.recipe_id = r.id AND v.is_original = 1 AND v.deleted_at IS NULL
			 JOIN body b ON b.variation_id = v.id
			 WHERE r.id = ? AND r.deleted_at IS NULL
			 ORDER BY (b.unit_system = 'metric') DESC LIMIT 1`
		)
		.get(recipeId) as
		| {
				yield_count: number;
				yield_unit: string;
				content_version: number;
				unit_system: UnitSystem;
				ingredients_json: string;
				steps_json: string;
		  }
		| undefined;
	if (!src) throw new JobError('api_error', `No original body for recipe ${recipeId}.`);

	// Asking for a yield that already exists switches to it instead of
	// generating (SPEC 4). Checked again here so a race between two phones
	// cannot bill twice or hit the unique index.
	if (!target) {
		const existing = db
			.prepare(
				`SELECT id FROM variation WHERE recipe_id = ? AND yield_count = ? AND deleted_at IS NULL`
			)
			.get(recipeId, toCount) as { id: string } | undefined;
		if (existing) {
			db.prepare(`UPDATE job SET variation_id = ? WHERE id = ?`).run(existing.id, job.id);
			return { variation_id: existing.id };
		}
	}

	const ratio = toCount / src.yield_count;
	const result = await claudeCall<{ body: BodyPair; scaling_note: string }>(db, {
		system: SCALE_SYSTEM,
		messages: [
			{
				role: 'user',
				content:
					`Rescale this recipe from ${src.yield_count} ${src.yield_unit} to ${toCount} ${src.yield_unit}.` +
					(ratio < 0.25 || ratio > 4 ? `\n${RANGE_WARNING}` : '') +
					`\n\nThe recipe, in ${src.unit_system === 'metric' ? 'metric' : 'US'} units:` +
					`\n\nIngredients:\n${src.ingredients_json}\n\nSteps:\n${src.steps_json}`
			}
		],
		schema: SCALE_SCHEMA
	});

	const ts = now();
	const variationId = db.transaction(() => {
		const vid = target?.id ?? ulid();
		if (target) {
			// Refresh guard again inside the write: the variation may have been
			// hand-edited or deleted during the Claude call.
			const v = db
				.prepare(`SELECT hand_edited FROM variation WHERE id = ? AND deleted_at IS NULL`)
				.get(vid) as { hand_edited: number } | undefined;
			if (!v || v.hand_edited) return null;
			db.prepare(
				`UPDATE variation SET based_on_content_version = ?, scaling_note = ?, updated_at = ?
				 WHERE id = ?`
			).run(src.content_version, result.scaling_note, ts, vid);
		} else {
			db.prepare(
				`INSERT INTO variation (id, recipe_id, yield_count, is_original, hand_edited,
				   based_on_content_version, scaling_note, created_at, updated_at)
				 VALUES (?, ?, ?, 0, 0, ?, ?, ?, ?)`
			).run(vid, recipeId, toCount, src.content_version, result.scaling_note, ts, ts);
		}
		const upsert = db.prepare(
			`INSERT INTO body (id, variation_id, unit_system, is_source, ingredients_json,
			   steps_json, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(variation_id, unit_system) DO UPDATE SET
			   is_source = excluded.is_source, ingredients_json = excluded.ingredients_json,
			   steps_json = excluded.steps_json, updated_at = excluded.updated_at`
		);
		for (const units of ['us', 'metric'] as const) {
			const b = result.body[units];
			upsert.run(
				ulid(),
				vid,
				units,
				// Scaling reasons in metric, so metric is the closest thing a
				// machine-scaled variation has to an as-written body.
				units === 'metric' ? 1 : 0,
				JSON.stringify(b.ingredients as IngredientGroup[]),
				JSON.stringify(b.steps),
				ts,
				ts
			);
		}
		db.prepare(`UPDATE job SET variation_id = ? WHERE id = ?`).run(vid, job.id);
		return vid;
	})();
	return variationId ? { variation_id: variationId } : null;
};

/** Round to one decimal, reject zero and negatives (ADR-037). */
export function normaliseYield(raw: unknown): number {
	const n = Math.round(Number(raw) * 10) / 10;
	if (!Number.isFinite(n) || n <= 0) throw new Error('Yield must be a positive number.');
	return n;
}

/**
 * The Calculate-for-N button (SPEC 7.5): the only thing that spends money.
 * Returns the existing variation when the yield already has one, else the
 * scale job to poll (reusing a pending job so a double tap cannot bill twice).
 */
export function requestScale(
	db: Database,
	recipeId: string,
	rawCount: unknown
): { variation_id: string } | { job_id: string } {
	const toCount = normaliseYield(rawCount);
	return db.transaction(() => {
		const existing = db
			.prepare(
				`SELECT id FROM variation WHERE recipe_id = ? AND yield_count = ? AND deleted_at IS NULL`
			)
			.get(recipeId, toCount) as { id: string } | undefined;
		if (existing) return { variation_id: existing.id };
		const pending = db
			.prepare(
				`SELECT id FROM job WHERE kind = 'scale' AND recipe_id = ? AND variation_id IS NULL
				   AND status IN ('queued','running')
				   AND json_extract(input_json, '$.to_count') = ?`
			)
			.get(recipeId, toCount) as { id: string } | undefined;
		if (pending) return { job_id: pending.id };
		return {
			job_id: createJob(
				db,
				'scale',
				{ recipe_id: recipeId, to_count: toCount },
				{ recipe_id: recipeId }
			)
		};
	})();
}

/**
 * SPEC 7.5 stale-while-revalidate (ADR-029): queue a refresh for a stale
 * untouched variation unless one is already pending, or the latest attempt
 * failed (then the banner offers tap-to-retry instead of auto-looping into
 * the daily cap). Returns the pending job id, or null when nothing was or
 * needed to be queued.
 */
export function ensureFresh(db: Database, variationId: string): string | null {
	return db.transaction(() => {
		const v = db
			.prepare(
				`SELECT v.hand_edited, v.based_on_content_version, r.content_version
				 FROM variation v JOIN recipe r ON r.id = v.recipe_id
				 WHERE v.id = ? AND v.deleted_at IS NULL`
			)
			.get(variationId) as
			| {
					hand_edited: number;
					based_on_content_version: number;
					content_version: number;
			  }
			| undefined;
		if (!v || v.hand_edited || v.based_on_content_version >= v.content_version) return null;
		const latest = db
			.prepare(
				`SELECT id, status FROM job WHERE kind = 'scale' AND variation_id = ?
				 ORDER BY created_at DESC, id DESC LIMIT 1`
			)
			.get(variationId) as { id: string; status: string } | undefined;
		if (latest?.status === 'queued' || latest?.status === 'running') return latest.id;
		if (latest?.status === 'failed') return null;
		return createJob(db, 'scale', { variation_id: variationId }, { variation_id: variationId });
	})();
}

/** D6 tap-to-retry for a failed stale refresh: requeue it. */
export function retryScale(db: Database, variationId: string): string {
	return db.transaction(() => {
		const requeued = db
			.prepare(
				`UPDATE job SET status = 'queued', error_code = NULL, error_text = NULL,
				   result_json = NULL, started_at = NULL, finished_at = NULL
				 WHERE id = (SELECT id FROM job
				             WHERE kind = 'scale' AND variation_id = ? AND status = 'failed'
				             ORDER BY created_at DESC, id DESC LIMIT 1)
				 RETURNING id`
			)
			.get(variationId) as { id: string } | undefined;
		return (
			requeued?.id ??
			createJob(db, 'scale', { variation_id: variationId }, { variation_id: variationId })
		);
	})();
}

/**
 * SPEC 7.5 Recalculate on a hand-edited stale variation (ADR-025): the whole
 * variation goes to Trash and a fresh one is generated at the same yield.
 */
export function recalcVariation(db: Database, variationId: string): string {
	return db.transaction(() => {
		const v = db
			.prepare(
				`SELECT recipe_id, yield_count, is_original FROM variation
				 WHERE id = ? AND deleted_at IS NULL`
			)
			.get(variationId) as
			{ recipe_id: string; yield_count: number; is_original: number } | undefined;
		if (!v) throw new Error('Variation not found.');
		if (v.is_original) throw new Error('The original variation cannot be recalculated.');
		db.prepare(`UPDATE variation SET deleted_at = ? WHERE id = ?`).run(now(), variationId);
		return createJob(
			db,
			'scale',
			{ recipe_id: v.recipe_id, to_count: v.yield_count },
			{ recipe_id: v.recipe_id }
		);
	})();
}

export type CalcJob = {
	job_id: string;
	status: 'pending' | 'failed';
	error_text: string | null;
	to_count: number;
};

/** Working/failed state of the calculate-for-N job, resumed across reloads
 *  (SPEC 7.5: survives a locked phone). Failures surface for 15 minutes, then
 *  read as history. */
export function getCalcJob(db: Database, recipeId: string): CalcJob | null {
	const row = db
		.prepare(
			`SELECT id, status, error_text, json_extract(input_json, '$.to_count') AS to_count
			 FROM job WHERE kind = 'scale' AND recipe_id = ? AND variation_id IS NULL
			   AND (status IN ('queued','running') OR (status = 'failed' AND finished_at > ?))
			 ORDER BY created_at DESC, id DESC LIMIT 1`
		)
		.get(recipeId, new Date(Date.now() - 15 * 60_000).toISOString()) as
		| { id: string; status: string; error_text: string | null; to_count: number }
		| undefined;
	if (!row) return null;
	return {
		job_id: row.id,
		status: row.status === 'failed' ? 'failed' : 'pending',
		error_text: row.error_text,
		to_count: row.to_count
	};
}

/** SPEC 7.5 Keep mine: dismiss the stale banner permanently. */
export function keepMine(db: Database, variationId: string): void {
	db.prepare(
		`UPDATE variation SET based_on_content_version =
		   (SELECT content_version FROM recipe WHERE id = variation.recipe_id),
		   updated_at = ?
		 WHERE id = ? AND deleted_at IS NULL`
	).run(now(), variationId);
}
