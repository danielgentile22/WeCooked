import type { PageServerLoad } from './$types';
import db from '$lib/server/db';
import { browseView } from '$lib/server/views';

export const load: PageServerLoad = async ({ url }) => browseView(db, url.searchParams);
