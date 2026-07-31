<script lang="ts">
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{@render children()}

<style>
	:global(:root) {
		color-scheme: light dark;
		font-family: system-ui, sans-serif;
		font-size: 17px; /* D4 */
		--accent: light-dark(#b45309, #f59e0b); /* D4 saffron */
		--on-accent: light-dark(#fff, #2a1a00);
		--surface: light-dark(#fff, #1c1c1e);
	}
	:global(body) {
		margin: 0;
		background: var(--surface);
		color: light-dark(#1a1a1a, #f2f2f2);
	}
</style>
