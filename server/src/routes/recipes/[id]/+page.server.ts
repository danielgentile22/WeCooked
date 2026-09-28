import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import db from '$lib/server/db';
import { retryReconvert, deleteVariation } from '$lib/server/recipes';
import { keepMine, recalcVariation, requestScale, retryScale } from '$lib/server/scale';
import { recipeView } from '$lib/server/views';

export const load: PageServerLoad = async ({ params, url }) => {
	const view = recipeView(db, params.id, url.searchParams.get('v') ?? undefined);
	if (!view) error(404, 'Recipe not found');
	return view;
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
