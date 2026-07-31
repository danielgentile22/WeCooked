import type { PageServerLoad } from './$types';
import db from '$lib/server/db';
import { listRecipes } from '$lib/server/recipes';
import { presignGet } from '$lib/server/r2';

// SPEC 6.5: every capture job without a recipe is a draft card above the
// saved recipes. Read from the job table; there are no phantom recipe rows.
export type DraftCard = {
	id: string;
	status: 'extracting' | 'failed' | 'ready';
	title: string;
};

function listDrafts(): DraftCard[] {
	const rows = db
		.prepare(
			`SELECT id, status, input_json, result_json FROM job
			 WHERE kind IN ('extract_url','extract_paste','extract_photos') AND recipe_id IS NULL
			 ORDER BY created_at DESC`
		)
		.all() as { id: string; status: string; input_json: string; result_json: string | null }[];
	return rows.map((j) => {
		const title =
			(j.result_json && (JSON.parse(j.result_json) as { title?: string })?.title) ||
			(JSON.parse(j.input_json) as { text?: string }).text?.trim().split('\n')[0]?.slice(0, 80) ||
			'Draft';
		return {
			id: j.id,
			status: j.status === 'done' ? 'ready' : j.status === 'failed' ? 'failed' : 'extracting',
			title
		};
	});
}

export const load: PageServerLoad = async ({ url }) => {
	const p = url.searchParams;
	return {
		drafts: listDrafts(),
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
