import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import db from '$lib/server/db';
import { getRecipe } from '$lib/server/recipes';

export const load: PageServerLoad = async ({ params }) => {
	const recipe = getRecipe(db, params.id);
	if (!recipe) error(404, 'Recipe not found');
	return { recipe };
};
