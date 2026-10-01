import type { Database } from 'better-sqlite3';
import { getRecipe, listRecipes, type RecipeDetail } from './recipes';
import { ensureFresh, getCalcJob, type CalcJob } from './scale';
import { getShoppingState, listPickable } from './shopping';
import { listDrafts } from './drafts';
import { presignGet } from './r2';

// Page data shared by the web loads and /api/v1, so both fronts serve the
// same shapes by construction. R2 keys never leave the server: every image
// becomes a presigned display URL here.

/** Browse (SPEC 7.3). Query params: q, and repeatable meal, cuisine,
 *  protein, effort, damage. Drafts are never filtered. */
export function browseView(db: Database, p: URLSearchParams) {
	return {
		drafts: listDrafts(db),
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
}

export type RecipeView = {
	recipe: Omit<RecipeDetail, 'images'> & {
		images: { id: string; url: string; width: number; height: number; source_url: string | null }[];
	};
	refresh: { job_id: string | null; status: 'pending' | 'failed' } | null;
	calcJob: CalcJob | null;
};

/** The recipe screen, or null when the recipe is missing or trashed. */
export function recipeView(db: Database, id: string, variationId?: string): RecipeView | null {
	const recipe = getRecipe(db, id, variationId);
	if (!recipe) return null;
	// SPEC 7.5 stale-while-revalidate (ADR-029): opening a stale untouched
	// variation queues its refresh; the stale body renders behind the banner.
	// ensureFresh returning null here means the last attempt failed (it never
	// auto-requeues after a failure), so the banner offers tap-to-retry.
	let refresh: RecipeView['refresh'] = null;
	if (recipe.stale && !recipe.hand_edited) {
		const jid = ensureFresh(db, recipe.variation_id);
		refresh = jid ? { job_id: jid, status: 'pending' } : { job_id: null, status: 'failed' };
	}
	return {
		recipe: {
			...recipe,
			images: recipe.images.map((i) => ({
				id: i.id,
				url: presignGet(i.r2_key_display),
				width: i.width,
				height: i.height,
				source_url: i.source_url
			}))
		},
		refresh,
		calcJob: getCalcJob(db, recipe.id)
	};
}

export function shoppingView(db: Database) {
	return { list: getShoppingState(db), recipes: listPickable(db) };
}
