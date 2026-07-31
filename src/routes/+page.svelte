<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { Search, CookingPot, LoaderCircle, TriangleAlert, ClipboardCheck } from '@lucide/svelte';
	import Chip from '$lib/components/Chip.svelte';
	import { pollJob } from '$lib/jobs';
	import { MEAL_TYPES, CUISINES, PROTEINS, EFFORTS, DAMAGES } from '$lib/tags';

	let { data } = $props();

	// Watch running extractions so their cards flip without a manual refresh
	// (SPEC 6.3 polling; survives a locked phone because the job does).
	const watched = new Set<string>();
	$effect(() => {
		for (const d of data.drafts) {
			if (d.status !== 'extracting' || watched.has(d.id)) continue;
			watched.add(d.id);
			pollJob(d.id)
				.then(() => invalidateAll())
				.catch(() => watched.delete(d.id));
		}
	});

	const groups = [
		{ key: 'meal', label: 'Meal', values: MEAL_TYPES },
		{ key: 'cuisine', label: 'Cuisine', values: CUISINES },
		{ key: 'protein', label: 'Protein', values: PROTEINS },
		{ key: 'effort', label: 'Effort', values: EFFORTS },
		{ key: 'damage', label: 'Damage', values: DAMAGES }
	] as const;

	let q = $state(page.url.searchParams.get('q') ?? '');
	let open = $state<string | null>(null); // which accordion group is expanded
	let filterBar: HTMLElement | undefined = $state();

	const selected = $derived(
		Object.fromEntries(groups.map((g) => [g.key, page.url.searchParams.getAll(g.key)]))
	);

	function apply(mutate: (p: URLSearchParams) => void) {
		const p = new URLSearchParams(page.url.searchParams);
		mutate(p);
		goto(`/?${p}`, { replaceState: true, keepFocus: true, noScroll: true });
	}

	// Search-as-you-type over server-side FTS, debounced.
	let timer: ReturnType<typeof setTimeout>;
	function onSearch() {
		clearTimeout(timer);
		timer = setTimeout(
			() =>
				apply((p) => {
					if (q.trim()) p.set('q', q);
					else p.delete('q');
				}),
			250
		);
	}

	function toggle(key: string, value: string) {
		apply((p) => {
			const cur = p.getAll(key);
			p.delete(key);
			for (const v of cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value])
				p.append(key, v);
		});
	}

	// Verdict C: the accordion closes on selection-free outside taps.
	function onDocClick(e: MouseEvent) {
		if (open && filterBar && !filterBar.contains(e.target as Node)) open = null;
	}
</script>

<svelte:head>
	<title>We Cooked</title>
</svelte:head>

<svelte:document onclick={onDocClick} />

<main>
	<header>
		<h1>Recipes</h1>
	</header>

	<div class="search">
		<Search aria-hidden="true" />
		<input
			type="search"
			placeholder="Search recipes"
			aria-label="Search recipes"
			bind:value={q}
			oninput={onSearch}
		/>
	</div>

	<div class="filters" bind:this={filterBar}>
		<div class="catbar" role="group" aria-label="Tag filters">
			{#each groups as g (g.key)}
				<button
					type="button"
					class="cat"
					aria-expanded={open === g.key}
					onclick={() => (open = open === g.key ? null : g.key)}
				>
					{g.label}{selected[g.key].length ? ` · ${selected[g.key].length}` : ''}
				</button>
			{/each}
		</div>
		{#each groups as g (g.key)}
			{#if open === g.key}
				<div class="options">
					{#each g.values as v (v)}
						<Chip
							label={v}
							selected={selected[g.key].includes(v)}
							onclick={() => toggle(g.key, v)}
						/>
					{/each}
				</div>
			{/if}
		{/each}
	</div>

	{#if data.drafts.length > 0}
		<!-- D7: drafts are ordinary rows with a status line instead of tag chips. -->
		<ul class="list">
			{#each data.drafts as d (d.id)}
				<li>
					{#if d.status === 'extracting'}
						<span class="draftrow">
							<span class="thumb tile" aria-hidden="true"><LoaderCircle class="spin" /></span>
							<span class="drafttext">
								<span class="title">{d.title}</span>
								<span class="status">Extracting…</span>
							</span>
						</span>
					{:else}
						<a href="/drafts/{d.id}">
							<span class="thumb tile" aria-hidden="true">
								{#if d.status === 'failed'}<TriangleAlert />{:else}<ClipboardCheck />{/if}
							</span>
							<span class="drafttext">
								<span class="title">{d.title}</span>
								<span class="status">
									{d.status === 'failed' ? 'Failed: tap to fix' : 'Ready to review'}
								</span>
							</span>
						</a>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}

	{#if data.recipes.length === 0}
		{#if data.drafts.length === 0}
			<p class="empty">
				{#if q || groups.some((g) => selected[g.key].length)}
					No recipes match.
				{:else}
					<a href="/recipes/new">Add your first recipe</a>
				{/if}
			</p>
		{/if}
	{:else}
		<ul class="list">
			{#each data.recipes as r (r.id)}
				<li>
					<a href="/recipes/{r.id}">
						{#if r.cover_url}
							<img class="thumb" src={r.cover_url} alt="" loading="lazy" />
						{:else}
							<!-- D17: one identical neutral tile for every coverless recipe.
						     Lucide's CookingPot stands in for the D16 glyph (D14: Lucide only). -->
							<span class="thumb tile" aria-hidden="true"><CookingPot /></span>
						{/if}
						<span class="title">{r.title}</span>
						<span class="rowchips">
							<Chip label={r.effort} quiet />
							<Chip label={r.damage} quiet />
						</span>
					</a>
				</li>
			{/each}
		</ul>
	{/if}

	<p class="trashlink"><a href="/trash">Trash</a></p>
</main>

<style>
	main {
		max-width: 44rem;
		margin: 0 auto;
		padding: 1rem 1rem 6rem;
	}
	header h1 {
		font-size: 1.4rem;
		margin: 0 0 0.6rem;
		letter-spacing: -0.01em;
	}
	.search {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		border: 1px solid var(--line);
		border-radius: 0.7rem;
		background: var(--card);
		padding: 0 0.7rem;
	}
	.search :global(svg) {
		width: 1.1em;
		height: 1.1em;
		color: var(--muted);
		flex: none;
	}
	.search input {
		flex: 1;
		min-height: 2.75rem;
		border: 0;
		background: none;
		font: inherit;
		color: var(--ink);
		outline-offset: -3px;
	}

	.filters {
		margin-top: 0.5rem;
	}
	.catbar {
		display: flex;
		gap: 0.4rem;
		overflow-x: auto;
	}
	.cat {
		flex: none;
		min-height: 2.75rem;
		padding: 0.3rem 0.8rem;
		border: 1.5px solid var(--line);
		border-radius: 999px;
		background: var(--card);
		color: var(--ink);
		font: inherit;
		font-size: 0.9rem;
		font-weight: 600;
		cursor: pointer;
	}
	.cat[aria-expanded='true'] {
		border-color: var(--accent);
		color: var(--accent);
	}
	/* Verdict C note: keep the accordion compact, 44px chips, tight padding */
	.options {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
		padding: 0.5rem 0.1rem 0.2rem;
	}

	.empty {
		text-align: center;
		color: var(--muted);
		margin-top: 3rem;
	}
	.empty a {
		color: var(--accent);
		font-weight: 600;
	}
	.list {
		list-style: none;
		margin: 0.6rem 0 0;
		padding: 0;
	}
	.list a {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		min-height: 3.4rem;
		padding: 0.5rem 0.2rem;
		border-bottom: 1px solid var(--line);
		color: inherit;
		text-decoration: none;
	}
	.thumb {
		flex: none;
		width: 3rem;
		height: 3rem;
		border-radius: 0.6rem;
		object-fit: cover;
	}
	.tile {
		display: grid;
		place-items: center;
		background: var(--card);
		border: 1px solid var(--line);
		color: var(--muted);
	}
	.tile :global(svg) {
		width: 1.4rem;
		height: 1.4rem;
	}
	.title {
		flex: 1;
		font-weight: 600;
	}
	.rowchips {
		display: flex;
		gap: 0.3rem;
		flex: none;
	}
	.draftrow {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		min-height: 3.4rem;
		padding: 0.5rem 0.2rem;
		border-bottom: 1px solid var(--line);
	}
	.drafttext {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
	}
	.status {
		color: var(--muted);
		font-size: 0.85rem;
	}
	.tile :global(.spin) {
		animation: spin 1.2s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	.trashlink {
		text-align: center;
		margin-top: 2rem;
	}
	.trashlink a {
		display: inline-block;
		padding: 0.6rem 1rem;
		color: var(--muted);
		font-size: 0.9rem;
		font-weight: 600;
	}
</style>
