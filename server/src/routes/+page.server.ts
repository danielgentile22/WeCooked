import type { PageServerLoad } from './$types';
import db from '#lib/server/db.js';
import { browseView } from '#lib/server/views.js';
import { jobDeps } from '#lib/jobs.js';

export const load: PageServerLoad = async ({ url, depends }) => {
	depends(jobDeps.drafts);
	return browseView(db, url.searchParams);
};
