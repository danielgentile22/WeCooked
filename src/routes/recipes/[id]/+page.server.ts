import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import db from '$lib/server/db';
import { getRecipe } from '$lib/server/recipes';
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
				full_url: presignGet(i.r2_key_full),
				width: i.width,
				height: i.height
			}))
		}
	};
};
