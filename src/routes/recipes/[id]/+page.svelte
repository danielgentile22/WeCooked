<script lang="ts">
	import { Pencil, LoaderCircle } from '@lucide/svelte';
	import { onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import Chip from '$lib/components/Chip.svelte';
	import Banner from '$lib/components/Banner.svelte';
	import { pollJob } from '$lib/jobs';

	let { data } = $props();
	const r = $derived(data.recipe);

	// D15: US/metric per device, metric default. Read after mount so SSR and
	// hydration agree, then flip if this device prefers US.
	let units = $state<'us' | 'metric'>('metric');
	onMount(() => {
		if (localStorage.getItem('units') === 'us') units = 'us';
	});
	function setUnits(u: 'us' | 'metric') {
		units = u;
		localStorage.setItem('units', u);
	}

	// The chosen body; while it is missing (reconvert pending or failed) the
	// source body stays readable behind the banner, stale-while-revalidate.
	const body = $derived(r.bodies[units] ?? r.bodies[r.source_units]!);
	// The banner belongs to the derived body only (ADR-028).
	const showReconvert = $derived(r.reconvert !== null && units !== r.source_units);

	// While a reconvert is pending, wait on the job and reload once, so "the US
	// body updates within seconds" without the user doing anything.
	let polling: string | null = null;
	$effect(() => {
		const job = r.reconvert;
		if (job?.status !== 'pending' || !job.job_id || polling === job.job_id) return;
		polling = job.job_id;
		pollJob(job.job_id).then(() => invalidateAll());
	});

	async function retry() {
		await fetch('?/retry', { method: 'POST', body: new FormData() });
		await invalidateAll(); // picks up the requeued job; the effect polls it
	}

	const UNIT_OPTIONS = ['metric', 'us'] as const;
	const cover = $derived(r.images.find((i) => i.id === r.cover_image_id) ?? null);
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
	<title>{r.title} · We Cooked</title>
</svelte:head>

<main>
	<header>
		<h1>{r.title}</h1>
		<p class="meta">
			{r.yield_count}
			{r.yield_unit}{#if times}&nbsp;· {times}{/if}
		</p>
		<!-- SPEC 7.4 order: title, cover image, source line -->
		{#if cover}
			<img class="cover" src={cover.url} alt={r.title} width={cover.width} height={cover.height} />
		{/if}
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

	<!-- SPEC 7.4 unit toggle: per device, "as written" marks the human-authored
	     body (ADR-028). Marker is a word, never color alone. -->
	<div class="seg" role="group" aria-label="Unit system">
		{#each UNIT_OPTIONS as u (u)}
			<button type="button" aria-pressed={units === u} onclick={() => setUnits(u)}>
				{u === 'us' ? 'US' : 'Metric'}
				{#if r.source_units === u}<span class="aswritten">as written</span>{/if}
			</button>
		{/each}
	</div>

	{#if showReconvert}
		{#if r.reconvert?.status === 'pending'}
			<Banner
				role="status"
				icon={LoaderCircle}
				text="Not yet updated from your edit. Updating…"
			/>
		{:else}
			<Banner text="Couldn't update from your edit." action="Tap to retry" onaction={retry} />
		{/if}
	{/if}

	<section aria-label="Ingredients">
		<h2>Ingredients</h2>
		{#each body.ingredients as group (group)}
			{#if group.heading}
				<h3>{group.heading}</h3>
			{/if}
			<ul>
				{#each group.items as item, i (i)}
					<li>{item}</li>
				{/each}
			</ul>
		{/each}
	</section>

	{#if body.steps.length > 0}
		<section aria-label="Steps">
			<h2>Steps</h2>
			<ol>
				{#each body.steps as step, i (i)}
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

	{#if r.images.length > 0}
		<section aria-label="Photos">
			<h2>Photos</h2>
			<div class="strip">
				{#each r.images as img (img.id)}
					<img src={img.url} alt="" loading="lazy" />
				{/each}
			</div>
		</section>
	{/if}
</main>

<style>
	main {
		max-width: 44rem;
		margin: 0 auto;
		padding: 1rem 1rem 6rem;
	}
	.cover {
		width: 100%;
		height: auto;
		max-height: 40vh;
		object-fit: cover;
		border-radius: 1rem;
		margin: 0.6rem 0 0.2rem;
	}
	.strip {
		display: flex;
		gap: 0.6rem;
		overflow-x: auto;
	}
	.strip img {
		height: 7rem;
		border-radius: 0.6rem;
		display: block;
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
	.seg {
		display: inline-flex;
		border: 1.5px solid var(--line);
		border-radius: 0.7rem;
		overflow: hidden;
		margin: 0.8rem 0 0.6rem;
	}
	.seg button {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.45rem 1.1rem;
		min-height: 2.75rem;
		font: inherit;
		font-size: 0.95rem;
		border: 0;
		background: none;
		color: inherit;
		cursor: pointer;
	}
	.seg button[aria-pressed='true'] {
		background: var(--accent);
		color: var(--on-accent);
		font-weight: 600;
	}
	.aswritten {
		font-size: 0.7rem;
		font-style: italic;
		opacity: 0.85;
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
