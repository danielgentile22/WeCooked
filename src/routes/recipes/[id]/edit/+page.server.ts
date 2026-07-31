import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import db from '$lib/server/db';
import { getRecipe, updateRecipe } from '$lib/server/recipes';
import { presignGet } from '$lib/server/r2';

export const load: PageServerLoad = async ({ params }) => {
	const recipe = getRecipe(db, params.id);
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
	default: async ({ request, params }) => {
		const payload = (await request.formData()).get('payload');
		if (typeof payload !== 'string') return fail(400, { error: 'Malformed submission.' });
		try {
			updateRecipe(db, params.id, JSON.parse(payload));
		} catch (e) {
			return fail(400, { error: e instanceof Error ? e.message : 'Could not save.' });
		}
		redirect(303, `/recipes/${params.id}`);
	}
};
