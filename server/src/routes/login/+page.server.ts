import { fail, redirect } from '@sveltejs/kit';
import { setSessionCookie } from '$lib/server/session';
import { attemptLogin } from '$lib/server/login';
import type { Actions } from './$types';

export const actions: Actions = {
	default: async ({ request, cookies, getClientAddress }) => {
		// Fly-Client-IP, not the socket address, or every attempt is Fly's proxy
		const ip = request.headers.get('fly-client-ip') ?? getClientAddress();
		const result = await attemptLogin(ip, (await request.formData()).get('password'));
		if (!result.ok) return fail(result.status, { error: result.error });
		setSessionCookie(cookies, Date.now());
		redirect(303, '/');
	}
};
