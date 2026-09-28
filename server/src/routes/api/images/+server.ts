import type { RequestHandler } from './$types';
import { serve } from '$lib/server/api/serve';

// Photos upload here before any recipe exists (ADR-024); a later save claims
// them. The web client's path for POST /api/v1/images. Auth via hooks.server.ts.
export const POST: RequestHandler = (event) => serve(event, '/images');
