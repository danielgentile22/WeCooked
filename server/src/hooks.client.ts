import { onUnauthorized } from '$lib/unauthorized';

// A full load, not goto: it drops every poll and timer of the old session.
window.fetch = onUnauthorized(window.fetch.bind(window), location.origin, () =>
	location.assign('/login')
);
