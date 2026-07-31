<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { LoaderCircle, Info } from '@lucide/svelte';
	import Banner from '$lib/components/Banner.svelte';
	import RecipeForm from '$lib/components/RecipeForm.svelte';
	import { pollJob } from '$lib/jobs';

	let { data, form } = $props();

	const extracting = $derived(data.status === 'queued' || data.status === 'running');
	const draftKey = $derived(`wc-draft:job:${data.id}`);

	// A warning like "step 4 was cut off" links to the section it talks about.
	const jumpTarget = (w: string) =>
		/step/i.test(w) ? '#steps' : /ingredient/i.test(w) ? '#ingredients' : null;

	$effect(() => {
		if (extracting) pollJob(data.id).then(() => invalidateAll());
	});

	// Discard throws away the draft and any typed edits: two-step confirm.
	let confirmDiscard = $state(false);
</script>

<svelte:head>
	<title>Review draft · We Cooked</title>
</svelte:head>

<main>
	<header>
		<h1>Review draft</h1>
	</header>

	{#if extracting}
		<p class="working" role="status">
			<LoaderCircle class="spin" aria-hidden="true" /> Extracting… You can leave this page; the draft
			card on Recipes will be ready to review.
		</p>
	{:else}
		{#if data.status === 'failed' && data.error_text}
			<div class="pad">
				<Banner text={data.error_text} />
				<form method="POST" action="?/retry" use:enhance>
					<button type="submit" class="retry">Try again</button>
				</form>
			</div>
		{/if}

		{#if data.warnings.length > 0}
			<div class="pad">
				<div class="warnings" role="alert">
					<p class="whead">The extraction flagged:</p>
					<ul>
						{#each data.warnings as w (w)}
							<li>
								{#if jumpTarget(w)}
									<a href={jumpTarget(w)}>{w}</a>
								{:else}
									{w}
								{/if}
							</li>
						{/each}
					</ul>
				</div>
			</div>
		{/if}

		{#if data.damage_reasoning}
			<p class="reasoning pad"><Info aria-hidden="true" /> Damage: {data.damage_reasoning}</p>
		{/if}

		{#if data.source_text}
			<details class="pad">
				<summary>Pasted text</summary>
				<pre>{data.source_text}</pre>
			</details>
		{/if}

		<RecipeForm initial={data.initial} {draftKey} action="?/save" error={form?.error ?? null} />

		<div class="pad">
			<form
				method="POST"
				action="?/discard"
				use:enhance
				onsubmit={() => sessionStorage.removeItem(draftKey)}
			>
				<button
					type="submit"
					class="discard"
					onclick={(e) => {
						if (!confirmDiscard) {
							e.preventDefault();
							confirmDiscard = true;
						}
					}}
				>
					{confirmDiscard ? 'Really discard this draft? Tap again' : 'Discard draft'}
				</button>
			</form>
		</div>
	{/if}
</main>

<style>
	main {
		max-width: 44rem;
		margin: 0 auto;
		padding: 1rem 0 6rem;
	}
	header {
		padding: 0 1rem 0.25rem;
	}
	h1 {
		font-size: 1.4rem;
		margin: 0;
		letter-spacing: -0.01em;
	}
	.pad {
		margin: 0.6rem 0.75rem;
	}
	.working {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		margin: 2rem 1rem;
		color: var(--muted);
	}
	.working :global(.spin) {
		flex: none;
		width: 1.2em;
		height: 1.2em;
		animation: spin 1.2s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	.retry {
		width: 100%;
		min-height: 3rem;
		border: 0;
		border-radius: 0.7rem;
		background: var(--accent);
		color: var(--on-accent);
		font: inherit;
		font-weight: 700;
		cursor: pointer;
	}
	.warnings {
		border: 1px solid var(--line);
		border-left: 4px solid var(--accent);
		border-radius: 0.6rem;
		background: var(--card);
		padding: 0.7rem 0.9rem;
		font-size: 0.95rem;
	}
	.whead {
		font-weight: 600;
		margin: 0 0 0.3rem;
	}
	.warnings ul {
		margin: 0;
		padding-left: 1.2rem;
	}
	.warnings a {
		color: var(--accent);
	}
	.reasoning {
		display: flex;
		align-items: flex-start;
		gap: 0.4rem;
		color: var(--muted);
		font-size: 0.9rem;
	}
	.reasoning :global(svg) {
		flex: none;
		width: 1.1em;
		height: 1.1em;
		margin-top: 0.15rem;
	}
	details {
		border: 1px solid var(--line);
		border-radius: 0.6rem;
		background: var(--card);
		padding: 0.5rem 0.9rem;
	}
	summary {
		cursor: pointer;
		font-weight: 600;
		min-height: 2rem;
		display: flex;
		align-items: center;
	}
	pre {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		font: inherit;
		font-size: 0.9rem;
		color: var(--muted);
		margin: 0.4rem 0 0.2rem;
	}
	.discard {
		width: 100%;
		min-height: 2.75rem;
		border: 0;
		background: none;
		color: var(--muted);
		font: inherit;
		font-size: 0.9rem;
		text-decoration: underline;
		cursor: pointer;
	}
</style>
