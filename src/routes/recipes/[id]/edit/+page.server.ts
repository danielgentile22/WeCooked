import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import db from '$lib/server/db';
import { getRecipe, updateRecipe } from '$lib/server/recipes';

export const load: PageServerLoad = async ({ params }) => {
	const recipe = getRecipe(db, params.id);
	if (!recipe) error(404, 'Recipe not found');
	return { recipe };
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
