import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import db from '$lib/server/db';
import {
	deleteRecipe,
	restoreRecipe,
	restoreVariation,
	listTrash
} from '$lib/server/recipes';

export const load: PageServerLoad = async () => ({ trash: listTrash(db) });

export const actions: Actions = {
	// The edit form's destructive zone posts here (D10); all Trash mutations
	// live on this route.
	delete_recipe: async ({ request }) => {
		const id = (await request.formData()).get('id');
		if (typeof id !== 'string') return fail(400);
		deleteRecipe(db, id);
		redirect(303, '/');
	},
	restore_recipe: async ({ request }) => {
		const id = (await request.formData()).get('id');
		if (typeof id !== 'string') return fail(400);
		restoreRecipe(db, id);
		return { restored: true, displaced: false };
	},
	restore_variation: async ({ request }) => {
		const id = (await request.formData()).get('id');
		if (typeof id !== 'string') return fail(400);
		try {
			return { restored: true, ...restoreVariation(db, id) };
		} catch (e) {
			return fail(400, { error: e instanceof Error ? e.message : 'Could not restore.' });
		}
	}
};
