import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import db from '$lib/server/db';
import { getShoppingState } from '$lib/server/shopping';

// ADR-033: the Shopping tab polls this every 5 s while visible, so both
// phones see the same ticks. Auth via hooks.server.ts.
export const GET: RequestHandler = () => json(getShoppingState(db));
