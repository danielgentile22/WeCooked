import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import db from '$lib/server/db';
import { getRecipe, retryReconvert, deleteVariation } from '$lib/server/recipes';
import {
	ensureFresh,
	keepMine,
	recalcVariation,
	requestScale,
	retryScale
} from '$lib/server/scale';
import { presignGet } from '$lib/server/r2';

/** Working/failed state of the calculate-for-N job, resumed across reloads
 *  (SPEC 7.5: survives a locked phone). Failures surface for 15 minutes, then
 *  read as history. */
function calcJob(recipeId: string) {
	const row = db
		.prepare(
			`SELECT id, status, error_text, json_extract(input_json, '$.to_count') AS to_count
			 FROM job WHERE kind = 'scale' AND recipe_id = ? AND variation_id IS NULL
			   AND (status IN ('queued','running') OR (status = 'failed' AND finished_at > ?))
			 ORDER BY created_at DESC, id DESC LIMIT 1`
		)
		.get(recipeId, new Date(Date.now() - 15 * 60_000).toISOString()) as
		| {
				id: string;
				status: string;
				error_text: string | null;
				to_count: number;
		  }
		| undefined;
	if (!row) return null;
	return {
		job_id: row.id,
		status: row.status === 'failed' ? ('failed' as const) : ('pending' as const),
		error_text: row.error_text,
		to_count: row.to_count
	};
}

export const load: PageServerLoad = async ({ params, url }) => {
	const recipe = getRecipe(db, params.id, url.searchParams.get('v') ?? undefined);
	if (!recipe) error(404, 'Recipe not found');
	// SPEC 7.5 stale-while-revalidate (ADR-029): opening a stale untouched
	// variation queues its refresh; the stale body renders behind the banner.
	// ensureFresh returning null here means the last attempt failed (it never
	// auto-requeues after a failure), so the banner offers tap-to-retry.
	let refresh: { job_id: string | null; status: 'pending' | 'failed' } | null = null;
	if (recipe.stale && !recipe.hand_edited) {
		const jid = ensureFresh(db, recipe.variation_id);
		refresh = jid ? { job_id: jid, status: 'pending' } : { job_id: null, status: 'failed' };
	}
	return {
		recipe: {
			...recipe,
			images: recipe.images.map((i) => ({
				id: i.id,
				url: presignGet(i.r2_key_display),
				width: i.width,
				height: i.height
			}))
		},
		refresh,
		calcJob: calcJob(recipe.id)
	};
};

export const actions: Actions = {
	// D6 "tap to retry": requeue (or start) the counterpart reconvert.
	retry: async ({ params, request }) => {
		try {
			const vid = String((await request.formData()).get('variation_id') ?? '') || undefined;
			retryReconvert(db, params.id, vid);
		} catch (e) {
			return fail(400, {
				error: e instanceof Error ? e.message : 'Could not retry.'
			});
		}
		return { ok: true };
	},
	// SPEC 7.5: the only action that spends money.
	calculate: async ({ params, request }) => {
		const to_count = (await request.formData()).get('to_count');
		try {
			return requestScale(db, params.id, to_count);
		} catch (e) {
			return fail(400, {
				error: e instanceof Error ? e.message : 'Could not calculate.'
			});
		}
	},
	// D6 tap-to-retry for a failed stale refresh.
	retryScale: async ({ request }) => {
		const vid = String((await request.formData()).get('variation_id') ?? '');
		return { job_id: retryScale(db, vid) };
	},
	recalculate: async ({ request }) => {
		const vid = String((await request.formData()).get('variation_id') ?? '');
		try {
			return { job_id: recalcVariation(db, vid) };
		} catch (e) {
			return fail(400, {
				error: e instanceof Error ? e.message : 'Could not recalculate.'
			});
		}
	},
	keepMine: async ({ request }) => {
		keepMine(db, String((await request.formData()).get('variation_id') ?? ''));
		return { ok: true };
	},
	deleteVariation: async ({ request }) => {
		try {
			deleteVariation(db, String((await request.formData()).get('variation_id') ?? ''));
		} catch (e) {
			return fail(400, {
				error: e instanceof Error ? e.message : 'Could not delete.'
			});
		}
		return { ok: true };
	}
};
