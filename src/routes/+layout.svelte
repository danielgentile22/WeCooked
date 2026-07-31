<script lang="ts">
	import { page } from '$app/state';
	import { BookOpen, Plus, ShoppingCart } from '@lucide/svelte';
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();

	const tabs = [
		{ href: '/', label: 'Recipes', icon: BookOpen },
		{ href: '/add', label: 'Add', icon: Plus },
		{ href: '/shopping', label: 'Shopping', icon: ShoppingCart }
	];
	const active = (href: string) =>
		href === '/'
			? page.url.pathname === '/' || page.url.pathname.startsWith('/recipes')
			: page.url.pathname.startsWith(href);
	const showTabs = $derived(page.url.pathname !== '/login');
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{@render children()}

{#if showTabs}
	<nav aria-label="Main">
		{#each tabs as tab (tab.href)}
			<a href={tab.href} aria-current={active(tab.href) ? 'page' : undefined}>
				<tab.icon aria-hidden="true" />
				<span>{tab.label}</span>
			</a>
		{/each}
	</nav>
{/if}

<style>
	/* D4 tokens, adopted from the cooking-screen prototype (warm palette, saffron) */
	:global(:root) {
		color-scheme: light dark;
		font-family:
			-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
		font-size: 17px; /* D4 */
		--bg: light-dark(#faf9f7, #171412);
		--card: light-dark(#fff, #221f1c);
		--ink: light-dark(#1c1917, #f5f5f4);
		--muted: light-dark(#78716c, #a8a29e);
		--line: light-dark(#e7e5e4, #3a3532);
		--accent: light-dark(#b45309, #f59e0b); /* D4 saffron */
		--on-accent: light-dark(#fff, #2a1a00);
		--surface: var(--card);
	}
	:global(body) {
		margin: 0;
		background: var(--bg);
		color: var(--ink);
		-webkit-text-size-adjust: 100%;
	}
	:global(:focus-visible) {
		outline: 3px solid var(--accent);
		outline-offset: 2px;
	}

	nav {
		position: fixed;
		bottom: 0;
		left: 0;
		right: 0;
		display: flex;
		background: var(--card);
		border-top: 1px solid var(--line);
		padding-bottom: env(safe-area-inset-bottom); /* SPEC 8.7 */
	}
	a {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.1rem;
		padding: 0.5rem 0 0.4rem;
		min-height: 2.75rem;
		font-size: 0.7rem;
		font-weight: 600;
		color: var(--muted);
		text-decoration: none;
	}
	a[aria-current='page'] {
		color: var(--accent);
	}
	a :global(svg) {
		width: 1.5rem;
		height: 1.5rem;
	}
</style>
