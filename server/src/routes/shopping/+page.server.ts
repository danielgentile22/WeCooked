import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import db from '$lib/server/db';
import { shoppingView } from '$lib/server/views';
import { addManual, doneShopping, requestBuild, retryBuild } from '$lib/server/shopping';

export const load: PageServerLoad = async () => shoppingView(db);

export const actions: Actions = {
	// SPEC 7.6: one shopping_merge job for the whole build (ADR-027).
	build: async ({ request }) => {
		try {
			const picks = JSON.parse(String((await request.formData()).get('picks') ?? '[]')) as {
				recipe_id: string;
				yield_count: number;
			}[];
			return requestBuild(db, picks);
		} catch (e) {
			return fail(400, { error: e instanceof Error ? e.message : 'Could not build.' });
		}
	},
	// D6 tap-to-retry for a failed build.
	retry: async ({ request }) => {
		const listId = String((await request.formData()).get('list_id') ?? '');
		return retryBuild(db, listId);
	},
	manual: async ({ request }) => {
		try {
			addManual(db, String((await request.formData()).get('text') ?? ''));
		} catch (e) {
			return fail(400, { error: e instanceof Error ? e.message : 'Could not add.' });
		}
		return { ok: true };
	},
	// Behind the prototype's two-step confirmation (SPEC 7.6, ADR-034).
	done: async () => {
		doneShopping(db);
		return { ok: true };
	}
};
