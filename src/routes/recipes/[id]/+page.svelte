<script lang="ts">
	import { Pencil } from '@lucide/svelte';
	import Chip from '$lib/components/Chip.svelte';

	let { data } = $props();
	const r = $derived(data.recipe);
	const tags = $derived(
		[...r.meal_types, r.cuisine, r.protein, r.effort, r.damage].filter((t) => t !== null)
	);
	const times = $derived(
		[
			r.prep_minutes !== null ? `prep ${r.prep_minutes} min` : null,
			r.cook_minutes !== null ? `cook ${r.cook_minutes} min` : null
		]
			.filter(Boolean)
			.join(' · ')
	);
</script>

<svelte:head>
	<title>{r.title} — We Cooked</title>
</svelte:head>

<main>
	<header>
		<h1>{r.title}</h1>
		<p class="meta">
			{r.yield_count}
			{r.yield_unit}{#if times}&nbsp;· {times}{/if}
		</p>
		{#if r.source_url}
			<p class="source"><a href={r.source_url}>{r.source_text ?? r.source_url}</a></p>
		{:else if r.source_text}
			<p class="source">{r.source_text}</p>
		{/if}
		<a class="edit" href="/recipes/{r.id}/edit"><Pencil aria-hidden="true" /> Edit</a>
	</header>

	<div class="chips">
		{#each tags as tag (tag)}
			<Chip label={tag} quiet />
		{/each}
	</div>

	<section aria-label="Ingredients">
		<h2>Ingredients</h2>
		{#each r.ingredients as group (group)}
			{#if group.heading}
				<h3>{group.heading}</h3>
			{/if}
			<ul>
				{#each group.items as item (item)}
					<li>{item}</li>
				{/each}
			</ul>
		{/each}
	</section>

	{#if r.steps.length > 0}
		<section aria-label="Steps">
			<h2>Steps</h2>
			<ol>
				{#each r.steps as step, i (i)}
					<li>{step}</li>
				{/each}
			</ol>
		</section>
	{/if}

	{#if r.notes}
		<section aria-label="Notes">
			<h2>Notes</h2>
			<p class="notes">{r.notes}</p>
		</section>
	{/if}
</main>

<style>
	main {
		max-width: 44rem;
		margin: 0 auto;
		padding: 1rem 1rem 6rem;
	}
	header {
		position: relative;
		padding-right: 4.5rem;
	}
	h1 {
		font-size: 1.5rem;
		margin: 0;
		letter-spacing: -0.01em;
	}
	.meta {
		color: var(--muted);
		margin: 0.25rem 0 0;
		font-size: 0.95rem;
	}
	.source {
		color: var(--muted);
		font-size: 0.9rem;
		margin: 0.25rem 0 0;
	}
	.source a {
		color: var(--accent);
	}
	.edit {
		position: absolute;
		top: 0;
		right: 0;
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		min-height: 2.75rem;
		padding: 0 0.6rem;
		color: var(--accent);
		font-weight: 600;
		text-decoration: none;
	}
	.edit :global(svg) {
		width: 1.1em;
		height: 1.1em;
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		margin: 0.8rem 0 0;
	}
	section {
		background: var(--card);
		border: 1px solid var(--line);
		border-radius: 1rem;
		padding: 0.9rem;
		margin-top: 0.8rem;
	}
	h2 {
		font-size: 1.05rem;
		margin: 0 0 0.5rem;
	}
	h3 {
		font-size: 0.9rem;
		font-style: italic;
		color: var(--muted);
		margin: 0.7rem 0 0.2rem;
	}
	ul,
	ol {
		margin: 0;
		padding-left: 1.3rem;
		/* SPEC 7.4: large type sized for arm's length */
		font-size: 1.15rem;
		line-height: 1.55;
	}
	li {
		margin: 0.3rem 0;
	}
	ol li::marker {
		font-weight: 700;
		color: var(--accent);
	}
	.notes {
		margin: 0;
		white-space: pre-wrap;
	}
</style>
