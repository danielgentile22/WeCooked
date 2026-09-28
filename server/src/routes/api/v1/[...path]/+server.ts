import type { RequestHandler } from './$types';
import { serve } from '$lib/server/api/serve';

// Every /api/v1 route is a row in $lib/server/api/v1.ts. Auth via hooks.server.ts.
export const fallback: RequestHandler = (event) => serve(event, `/${event.params.path}`);
