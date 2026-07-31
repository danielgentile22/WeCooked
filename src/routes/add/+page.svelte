<script lang="ts">
	import { enhance } from '$app/forms';
	import { Keyboard, Sparkles } from '@lucide/svelte';
	import Banner from '$lib/components/Banner.svelte';

	let { form } = $props();
	let submitting = $state(false);
</script>

<svelte:head>
	<title>Add · We Cooked</title>
</svelte:head>

<main>
	<header>
		<h1>Add a recipe</h1>
	</header>

	<!-- D3: paste box first. Photo path arrives with the photos issue. -->
	<section>
		<form
			method="POST"
			use:enhance={() => {
				submitting = true;
				return async ({ update }) => {
					submitting = false;
					await update();
				};
			}}
		>
			<textarea
				name="text"
				rows="7"
				placeholder="Paste recipe text here"
				aria-label="Recipe text"
			></textarea>
			{#if form?.error}
				<Banner text={form.error} />
			{/if}
			<button type="submit" class="extract" disabled={submitting}>
				<Sparkles aria-hidden="true" />
				{submitting ? 'Starting…' : 'Extract'}
			</button>
		</form>
	</section>

	<section>
		<a class="manual" href="/recipes/new"><Keyboard aria-hidden="true" /> Type it in myself</a>
		<p class="hint">Paste a link or snap a photo: coming in a later phase.</p>
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
		margin-bottom: 0.75rem;
	}
	textarea {
		width: 100%;
		box-sizing: border-box;
		font: inherit;
		padding: 0.55rem 0.6rem;
		border: 1px solid var(--line);
		border-radius: 0.5rem;
		background: var(--card);
		color: var(--ink);
		resize: vertical;
		margin-bottom: 0.6rem;
	}
	.extract,
	.manual {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		width: 100%;
		min-height: 3rem;
		border: 0;
		border-radius: 0.7rem;
		background: var(--accent);
		color: var(--on-accent);
		font: inherit;
		font-weight: 700;
		text-decoration: none;
		cursor: pointer;
	}
	.extract:disabled {
		opacity: 0.6;
	}
	.extract :global(svg),
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
