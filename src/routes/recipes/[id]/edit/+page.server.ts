import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import db from '$lib/server/db';
import { getRecipe, retryReconvert, updateRecipe } from '$lib/server/recipes';
import { presignGet } from '$lib/server/r2';

export const load: PageServerLoad = async ({ params, url }) => {
	// ?v= edits a specific variation's body (hand edits at the stove, SPEC 7.5);
	// without it, the original.
	const recipe = getRecipe(db, params.id, url.searchParams.get('v') ?? undefined);
	if (!recipe) error(404, 'Recipe not found');
	// The form strip wants {id, url}, not R2 keys.
	return {
		recipe: {
			...recipe,
			images: recipe.images.map((i) => ({ id: i.id, url: presignGet(i.r2_key_display) }))
		}
	};
};

export const actions: Actions = {
	// Named, not default: a page cannot mix a default action with ?/retry.
	save: async ({ request, params }) => {
		const data = await request.formData();
		const payload = data.get('payload');
		const variationId = String(data.get('variation_id') ?? '') || undefined;
		if (typeof payload !== 'string') return fail(400, { error: 'Malformed submission.' });
		try {
			updateRecipe(db, params.id, JSON.parse(payload), variationId);
		} catch (e) {
			return fail(400, { error: e instanceof Error ? e.message : 'Could not save.' });
		}
		redirect(303, `/recipes/${params.id}${variationId ? `?v=${variationId}` : ''}`);
	},

	// D6 "tap to retry" for a failed counterpart reconvert.
	retry: async ({ request, params }) => {
		try {
			const vid = String((await request.formData()).get('variation_id') ?? '') || undefined;
			retryReconvert(db, params.id, vid);
		} catch (e) {
			return fail(400, { error: e instanceof Error ? e.message : 'Could not retry.' });
		}
		return { ok: true };
	}
};
