<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { LoaderCircle, Info, Check, RotateCw } from '@lucide/svelte';
	import Banner from '$lib/components/Banner.svelte';
	import Chip from '$lib/components/Chip.svelte';
	import RecipeForm from '$lib/components/RecipeForm.svelte';
	import { pollJob } from '$lib/jobs';

	let { data, form } = $props();

	const working = $derived(data.status === 'queued' || data.status === 'running');
	const draftKey = $derived(`wc-draft:job:${data.id}`);

	// A generation before its pick is the deck (GenerationView); running,
	// failed or picked it is a DraftView of kind 'generate'. Wording follows
	// the kind (EditorScreen.workingText).
	const deck = $derived('candidates' in data ? data : null);
	const generating = $derived(deck !== null || data.kind === 'generate');
	const SHOWN_LINES = 10;

	// A warning like "step 4 was cut off" jumps to the section it talks about
	// (the extraction warnings banner, SPEC 7.2 field 1).
	const jumpTarget = (w: string) =>
		/step/i.test(w) ? '#steps' : /ingredient/i.test(w) ? '#ingredients' : null;
	const jump = (w: string) =>
		document.querySelector(jumpTarget(w)!)?.scrollIntoView({ behavior: 'smooth' });

	// Retry must drop the autosave: edits typed into the failed view would
	// otherwise shadow the fresh extraction.
	let retryForm: HTMLFormElement | undefined = $state();
	function retry() {
		localStorage.removeItem(draftKey);
		retryForm?.requestSubmit();
	}

	$effect(() => {
		if (working) pollJob(data.id).then(() => invalidateAll());
	});

	// Discard throws away the draft and any typed edits: two-step confirm.
	let confirmDiscard = $state(false);
</script>

{#snippet discardForm(what: string)}
	<form
		method="POST"
		action="?/discard"
		use:enhance
		onsubmit={() => localStorage.removeItem(draftKey)}
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
			{confirmDiscard ? `Really discard this ${what}? Press again` : `Discard ${what}`}
		</button>
	</form>
{/snippet}

<svelte:head>
	<title>{deck ? 'Choose a recipe' : 'Review draft'} · We Cooked</title>
</svelte:head>

<main class:wide={deck !== null}>
	<header>
		<h1>{deck ? 'Choose a recipe' : 'Review draft'}</h1>
	</header>

	{#if 'candidates' in data}
		<p class="description pad">{data.description}</p>
		{#if form?.error}
			<div class="pad"><Banner text={form.error} /></div>
		{/if}
		<ul class="deck">
			{#each data.candidates as c, i (i)}
				<li class="card">
					<div class="chips">
						<Chip label={c.damage} quiet />
						<Chip label={c.effort} quiet />
						{#if c.prep_minutes !== null}<Chip label="prep {c.prep_minutes} min" quiet />{/if}
						{#if c.cook_minutes !== null}<Chip label="cook {c.cook_minutes} min" quiet />{/if}
						{#if c.protein}<Chip label={c.protein} quiet />{/if}
						{#if c.cuisine}<Chip label={c.cuisine} quiet />{/if}
					</div>
					<h2>{c.title}</h2>
					<ul class="ingredients">
						{#each c.ingredients.slice(0, SHOWN_LINES) as line, j (j)}
							<li>{line}</li>
						{/each}
						{#if c.ingredients.length > SHOWN_LINES}
							<li class="more">and {c.ingredients.length - SHOWN_LINES} more</li>
						{/if}
					</ul>
					<form method="POST" action="?/pick" use:enhance>
						<input type="hidden" name="index" value={i} />
						<button type="submit" class="pick"><Check aria-hidden="true" /> Pick this one</button>
					</form>
				</li>
			{/each}
		</ul>
		<div class="pad actions">
			<form method="POST" action="?/tryAgain" use:enhance>
				<button type="submit" class="again"><RotateCw aria-hidden="true" /> Try again</button>
			</form>
			{@render discardForm('generation')}
		</div>
	{:else if working}
		<p class="working" role="status">
			<LoaderCircle class="spin" aria-hidden="true" />
			{#if generating}
				Generating… You can leave this page; the card on Recipes will be ready to choose from.
			{:else}
				Extracting… You can leave this page; the draft card on Recipes will be ready to review.
			{/if}
		</p>
	{:else}
		{#if data.status === 'failed' && data.error_text}
			<div class="pad">
				<Banner text={data.error_text} action="Try again" onaction={retry} />
				<form method="POST" action="?/retry" use:enhance bind:this={retryForm} hidden></form>
			</div>
		{/if}

		{#if data.warnings.length > 0}
			<!-- D6: extraction warnings go through the one Banner component. -->
			<div class="pad">
				{#each data.warnings as w (w)}
					<Banner
						text={w}
						action={jumpTarget(w) ? `Jump to ${jumpTarget(w) === '#steps' ? 'steps' : 'ingredients'}` : null}
						onaction={jumpTarget(w) ? () => jump(w) : undefined}
					/>
				{/each}
			</div>
		{/if}

		{#if data.damage_reasoning}
			<p class="reasoning pad"><Info aria-hidden="true" /> Damage: {data.damage_reasoning}</p>
		{/if}

		{#if data.source_text}
			<details class="pad">
				<summary>{generating ? 'Description' : 'Pasted text'}</summary>
				<pre>{data.source_text}</pre>
			</details>
		{/if}

		<!-- editing only when an extraction fixed source_units; a failed draft's
		     initial is just the carried source_url and the user picks the system. -->
		<RecipeForm
			initial={data.initial}
			editing={data.status === 'done'}
			{draftKey}
			action="?/save"
			error={form?.error ?? null}
			coverJobId={data.cover_job_id}
			findCover={data.status === 'done'}
		/>

		<div class="pad">
			{@render discardForm('draft')}
		</div>
	{/if}
</main>

<style>
	main {
		max-width: 44rem;
		margin: 0 auto;
		padding: 1rem 0 calc(6rem + env(safe-area-inset-bottom));
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
	.description {
		color: var(--muted);
		font-size: 0.95rem;
		margin-top: 0.25rem;
	}
	.deck {
		list-style: none;
		margin: 0.5rem 0.75rem;
		padding: 0;
		display: grid;
		gap: 0.75rem;
	}
	.card {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 1rem;
		border: 1px solid var(--line);
		border-radius: 1rem;
		background: var(--card);
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
	}
	.card h2 {
		font-size: 1.25rem;
		margin: 0;
		letter-spacing: -0.01em;
	}
	.ingredients {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: 0.9rem;
		flex: 1;
	}
	.ingredients .more {
		color: var(--muted);
	}
	.pick,
	.again {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		width: 100%;
		min-height: 2.75rem;
		border: 0;
		border-radius: 0.7rem;
		background: var(--accent);
		color: var(--on-accent);
		font: inherit;
		font-weight: 700;
		cursor: pointer;
	}
	.again {
		background: none;
		border: 1px solid var(--line);
		color: var(--ink);
		font-weight: 600;
		margin-bottom: 0.5rem;
	}
	.pick :global(svg),
	.again :global(svg) {
		width: 1.1em;
		height: 1.1em;
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

	/* Laptop: the three candidates sit side by side. */
	@media (min-width: 900px) {
		main.wide {
			max-width: 72rem;
			padding: 1.5rem 1.25rem 3rem;
		}
		.deck {
			grid-template-columns: repeat(3, minmax(0, 1fr));
			gap: 1rem;
		}
		.actions {
			max-width: 24rem;
			margin-left: auto;
			margin-right: auto;
		}
	}
</style>
