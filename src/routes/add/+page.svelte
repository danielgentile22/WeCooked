<script lang="ts">
	import { Keyboard } from '@lucide/svelte';
</script>

<svelte:head>
	<title>Add — We Cooked</title>
</svelte:head>

<main>
	<header>
		<h1>Add a recipe</h1>
	</header>

	<!-- D3: the paste box and photo path arrive with extraction (phases 5-6).
	     Until then the manual path is the whole Add tab. -->
	<section>
		<a class="manual" href="/recipes/new"><Keyboard aria-hidden="true" /> Type it in myself</a>
		<p class="hint">Paste a link, paste text, or snap a photo — coming in a later phase.</p>
	</section>
</main>

<style>
	main {
		max-width: 44rem;
		margin: 0 auto;
		padding: 1rem 1rem 6rem;
	}
	h1 {
		font-size: 1.4rem;
		margin: 0 0 0.6rem;
		letter-spacing: -0.01em;
	}
	section {
		background: var(--card);
		border: 1px solid var(--line);
		border-radius: 1rem;
		padding: 0.9rem;
	}
	.manual {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		min-height: 3rem;
		border-radius: 0.7rem;
		background: var(--accent);
		color: var(--on-accent);
		font-weight: 700;
		text-decoration: none;
	}
	.manual :global(svg) {
		width: 1.2em;
		height: 1.2em;
	}
	.hint {
		color: var(--muted);
		font-size: 0.9rem;
		text-align: center;
		margin: 0.7rem 0 0;
	}
</style>
