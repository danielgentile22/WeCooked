<script lang="ts">
	import { enhance } from '$app/forms';
	import { Undo2 } from '@lucide/svelte';
	import Banner from '$lib/components/Banner.svelte';

	let { data, form } = $props();

	const fmt = (iso: string) =>
		new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
</script>

<svelte:head>
	<title>Trash · We Cooked</title>
</svelte:head>

<main>
	<header>
		<h1>Trash</h1>
	</header>

	{#if form?.error}
		<Banner text={form.error} />
	{:else if form?.displaced}
		<Banner
			role="status"
			icon={Undo2}
			text="Restored your version; the variation that held the same yield is in Trash."
		/>
	{:else if form?.restored}
		<Banner role="status" icon={Undo2} text="Restored." />
	{/if}

	{#if data.trash.recipes.length === 0 && data.trash.variations.length === 0}
		<p class="empty">Trash is empty.</p>
	{/if}

	{#if data.trash.recipes.length > 0}
		<h2>Recipes</h2>
		<ul>
			{#each data.trash.recipes as r (r.id)}
				<li>
					<span class="what">
						<span class="title">{r.title}</span>
						<span class="date">deleted {fmt(r.deleted_at)}</span>
					</span>
					<form method="POST" action="?/restore_recipe" use:enhance>
						<input type="hidden" name="id" value={r.id} />
						<button>Restore</button>
					</form>
				</li>
			{/each}
		</ul>
	{/if}

	{#if data.trash.variations.length > 0}
		<h2>Variations</h2>
		<ul>
			{#each data.trash.variations as v (v.id)}
				<li>
					<span class="what">
						<span class="title">{v.title} · {v.yield_count} {v.yield_unit}</span>
						<span class="date">deleted {fmt(v.deleted_at)}</span>
					</span>
					<form method="POST" action="?/restore_variation" use:enhance>
						<input type="hidden" name="id" value={v.id} />
						<button>Restore</button>
					</form>
				</li>
			{/each}
		</ul>
	{/if}
</main>

<style>
	main {
		max-width: 44rem;
		margin: 0 auto;
		padding: 1rem 1rem calc(6rem + env(safe-area-inset-bottom));
	}
	h1 {
		font-size: 1.4rem;
		margin: 0 0 0.6rem;
		letter-spacing: -0.01em;
	}
	h2 {
		font-size: 0.85rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--muted);
		margin: 1.2rem 0 0.2rem;
	}
	.empty {
		text-align: center;
		color: var(--muted);
		margin-top: 3rem;
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	li {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		min-height: 3.4rem;
		padding: 0.5rem 0.2rem;
		border-bottom: 1px solid var(--line);
	}
	.what {
		flex: 1;
		display: flex;
		flex-direction: column;
	}
	.title {
		font-weight: 600;
	}
	.date {
		color: var(--muted);
		font-size: 0.85rem;
	}
	button {
		border: 1.5px solid var(--line);
		border-radius: 999px;
		background: var(--card);
		color: var(--accent);
		font: inherit;
		font-size: 0.9rem;
		font-weight: 600;
		min-height: 2.75rem;
		padding: 0 0.9rem;
		cursor: pointer;
	}
</style>
