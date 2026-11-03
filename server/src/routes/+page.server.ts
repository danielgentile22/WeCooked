import type { PageServerLoad } from './$types';
import db from '$lib/server/db';
import { browseView } from '$lib/server/views';
import { jobDeps } from '$lib/jobs';

export const load: PageServerLoad = async ({ url, depends }) => {
	depends(jobDeps.drafts);
	return browseView(db, url.searchParams);
};
