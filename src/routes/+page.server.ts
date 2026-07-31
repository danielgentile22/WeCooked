import type { PageServerLoad } from './$types';
import db from '$lib/server/db';
import { listRecipes } from '$lib/server/recipes';
import { presignGet } from '$lib/server/r2';

export const load: PageServerLoad = async ({ url }) => {
	const p = url.searchParams;
	return {
		recipes: listRecipes(db, {
			q: p.get('q') ?? undefined,
			meal_type: p.getAll('meal'),
			cuisine: p.getAll('cuisine'),
			protein: p.getAll('protein'),
			effort: p.getAll('effort'),
			damage: p.getAll('damage')
		}).map(({ cover_key, ...r }) => ({
			...r,
			cover_url: cover_key ? presignGet(cover_key) : null
		}))
	};
};
