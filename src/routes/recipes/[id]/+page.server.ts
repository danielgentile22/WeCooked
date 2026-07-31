import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import db from '$lib/server/db';
import { getRecipe, retryReconvert } from '$lib/server/recipes';
import { presignGet } from '$lib/server/r2';

export const load: PageServerLoad = async ({ params }) => {
	const recipe = getRecipe(db, params.id);
	if (!recipe) error(404, 'Recipe not found');
	return {
		recipe: {
			...recipe,
			images: recipe.images.map((i) => ({
				id: i.id,
				url: presignGet(i.r2_key_display),
				width: i.width,
				height: i.height
			}))
		}
	};
};

export const actions: Actions = {
	// D6 "tap to retry": requeue (or start) the counterpart reconvert.
	retry: async ({ params }) => {
		try {
			retryReconvert(db, params.id);
		} catch (e) {
			return fail(400, { error: e instanceof Error ? e.message : 'Could not retry.' });
		}
		return { ok: true };
	}
};
