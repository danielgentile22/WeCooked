<script lang="ts">
	import { page } from '$app/state';
	import { BookOpen, Plus, ShoppingCart, Trash2 } from '@lucide/svelte';
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

<div class:withnav={showTabs}>
	{@render children()}
</div>

{#if showTabs}
	<nav aria-label="Main">
		<span class="brand">We Cooked</span>
		{#each tabs as tab (tab.href)}
			<a href={tab.href} aria-current={active(tab.href) ? 'page' : undefined}>
				<tab.icon aria-hidden="true" />
				<span>{tab.label}</span>
			</a>
		{/each}
		<!-- D1: phones keep Trash as a link under the browse list; wide screens
		     have room for it at the foot of the sidebar. -->
		<a class="trash" href="/trash" aria-current={active('/trash') ? 'page' : undefined}>
			<Trash2 aria-hidden="true" />
			<span>Trash</span>
		</a>
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
		--danger: light-dark(#b91c1c, #f87171);
		--surface: var(--card);
	}
	:global(body) {
		margin: 0;
		/* SPEC 8.7: standalone + black-translucent lets content run under the
		   status bar; pad it back out (scrolls away, sticky elements re-inset). */
		padding-top: env(safe-area-inset-top);
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
		/* SPEC 8.7: home indicator + notch in landscape */
		padding-bottom: env(safe-area-inset-bottom);
		padding-left: env(safe-area-inset-left);
		padding-right: env(safe-area-inset-right);
	}
	a {
		position: relative;
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
	/* Shape, not color alone, marks the active tab (UI.md constraint) */
	a[aria-current='page']::after {
		content: '';
		position: absolute;
		top: -1px;
		left: 50%;
		transform: translateX(-50%);
		width: 2.2rem;
		height: 3px;
		border-radius: 0 0 3px 3px;
		background: currentColor;
	}
	a :global(svg) {
		width: 1.5rem;
		height: 1.5rem;
	}
	.brand,
	.trash {
		display: none;
	}

	/* Laptop: the tab bar becomes a fixed left sidebar. Pages keep their own
	   max-width and padding inside the offset content area. */
	@media (min-width: 900px) {
		.withnav {
			padding-left: 14rem;
		}
		nav {
			top: 0;
			right: auto;
			width: 14rem;
			box-sizing: border-box;
			flex-direction: column;
			gap: 0.15rem;
			padding: 1.25rem 0.75rem calc(1rem + env(safe-area-inset-bottom));
			border-top: 0;
			border-right: 1px solid var(--line);
		}
		.brand {
			display: block;
			padding: 0 0.75rem 1rem;
			font-size: 1.15rem;
			font-weight: 700;
			letter-spacing: -0.01em;
		}
		a {
			flex: none;
			flex-direction: row;
			gap: 0.7rem;
			padding: 0.55rem 0.75rem;
			border-radius: 0.6rem;
			font-size: 0.95rem;
			color: var(--ink);
		}
		a:hover {
			background: color-mix(in srgb, var(--line) 50%, transparent);
		}
		a[aria-current='page'] {
			background: color-mix(in srgb, var(--accent) 12%, transparent);
		}
		a[aria-current='page']::after {
			top: 50%;
			left: 0;
			transform: translateY(-50%);
			width: 3px;
			height: 1.4rem;
			border-radius: 0 3px 3px 0;
		}
		a :global(svg) {
			width: 1.25rem;
			height: 1.25rem;
		}
		.trash {
			display: flex;
			margin-top: auto;
			color: var(--muted);
		}
	}
</style>
