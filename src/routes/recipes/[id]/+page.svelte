<script lang="ts">
	import { Pencil, LoaderCircle, Check, Minus, Plus, ChevronDown } from '@lucide/svelte';
	import { onMount } from 'svelte';
	import { enhance } from '$app/forms';
	import { goto, invalidateAll } from '$app/navigation';
	import Chip from '$lib/components/Chip.svelte';
	import Banner from '$lib/components/Banner.svelte';
	import { pollJob } from '$lib/jobs';

	let { data, form } = $props();
	const r = $derived(data.recipe);

	// --- Yield control (SPEC 7.5). Changing the number never triggers work:
	// only the Calculate button submits anything.
	let countStr = $state('');
	let showChipDetail = $state(false);
	let lastVariation: string | null = null;
	$effect(() => {
		// snap to the viewed yield on switch, and back on return (remount), and
		// drop banners and detail that belonged to the previous variation
		if (r.variation_id !== lastVariation) {
			lastVariation = r.variation_id;
			countStr = String(r.yield_count);
			justUpdated = false;
			calcError = null;
			showChipDetail = false;
		}
	});
	const count = $derived(Math.round(Number(countStr) * 10) / 10);
	const countValid = $derived(Number.isFinite(count) && count > 0);
	const matching = $derived(r.variations.find((v) => v.yield_count === count));
	function step(delta: number) {
		const base = countValid ? count : r.yield_count;
		const next = Math.round((base + delta) * 10) / 10;
		if (next > 0) countStr = String(next);
	}
	function switchTo(id: string) {
		goto(`/recipes/${r.id}?v=${id}`, { noScroll: true });
	}

	// The calculate/recalculate job in flight. Seeded from the server (so it
	// survives a locked phone and reload) or from a just-submitted action.
	let calc = $state<{ job_id: string; to_count: number } | null>(null);
	let calcError = $state<string | null>(null);
	let justUpdated = $state(false);
	$effect(() => {
		if (data.calcJob?.status === 'pending' && !calc)
			calc = { job_id: data.calcJob.job_id, to_count: data.calcJob.to_count };
	});
	let calcPolled: string | null = null;
	$effect(() => {
		if (!calc || calcPolled === calc.job_id) return;
		calcPolled = calc.job_id;
		pollJob(calc.job_id).then(async (job) => {
			calc = null;
			if (job.status === 'done' && job.result_ref) {
				await goto(`/recipes/${r.id}?v=${job.result_ref}`, {
					noScroll: true,
					invalidateAll: true
				});
			} else {
				calcError = job.error_text;
				await invalidateAll();
			}
		});
	});

	// Stale-while-revalidate refresh of an untouched variation (ADR-029).
	let refreshPolled: string | null = null;
	$effect(() => {
		const jid = data.refresh?.status === 'pending' ? data.refresh.job_id : null;
		if (!jid || refreshPolled === jid) return;
		refreshPolled = jid;
		pollJob(jid).then(async (job) => {
			justUpdated = job.status === 'done';
			await invalidateAll();
		});
	});

	// Action results that hand back a job to watch or a variation to show.
	const watchJob: import('./$types').SubmitFunction = () => {
		calcError = null;
		return async ({ result, update }) => {
			if (result.type === 'success' && result.data) {
				const d = result.data as { job_id?: string; variation_id?: string };
				if (d.variation_id) return void switchTo(d.variation_id);
				if (d.job_id) calc = { job_id: d.job_id, to_count: count };
			}
			await update({ invalidateAll: true, reset: false });
		};
	};

	// D15: US/metric per device, metric default. Read after mount so SSR and
	// hydration agree, then flip if this device prefers US.
	let units = $state<'us' | 'metric'>('metric');
	onMount(() => {
		if (localStorage.getItem('units') === 'us') units = 'us';
	});

	// SPEC 7.4 wake lock: held while a recipe is open, re-acquired when the
	// phone unlocks or the tab comes back, released on navigate away.
	onMount(() => {
		let lock: WakeLockSentinel | null = null;
		const acquire = () =>
			navigator.wakeLock
				?.request('screen')
				.then((l) => (lock = l))
				.catch(() => {}); // denied (low battery, unsupported): cook on
		const onVis = () => {
			if (document.visibilityState === 'visible') acquire();
		};
		acquire();
		document.addEventListener('visibilitychange', onVis);
		return () => {
			document.removeEventListener('visibilitychange', onVis);
			lock?.release().catch(() => {});
		};
	});

	// SPEC 7.4 / ADR-036 strikes: sessionStorage keyed by variation id, per
	// device, never synced. Survives lock and tab-away, gone by tomorrow.
	// Line identity is positional, unlike shopping ticks (text): text would
	// drop every strike on a unit toggle, a real mid-cook action, while a
	// mid-cook edit that reorders lines is not.
	let strikes = $state<ReadonlySet<string>>(new Set());
	$effect(() => {
		let saved: string[] = [];
		try {
			saved = JSON.parse(sessionStorage.getItem(`strikes:${r.variation_id}`) ?? '[]');
		} catch {
			/* corrupt entry: start clean */
		}
		strikes = new Set(saved);
	});
	function toggleStrike(key: string) {
		const next = new Set(strikes);
		if (!next.delete(key)) next.add(key);
		strikes = next;
		sessionStorage.setItem(`strikes:${r.variation_id}`, JSON.stringify([...next]));
	}
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

	// D6 tap-to-retry goes through the hidden form + use:enhance, same as the
	// drafts page, so a fail(400) surfaces instead of vanishing into a fetch.
	let retryForm: HTMLFormElement | undefined = $state();
	let retryScaleForm: HTMLFormElement | undefined = $state();

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
		<!-- Editing a scaled variation edits its body (hand edits, SPEC 7.5). -->
		<a class="edit" href="/recipes/{r.id}/edit{r.is_original ? '' : `?v=${r.variation_id}`}"
			><Pencil aria-hidden="true" /> Edit</a
		>
	</header>

	<div class="chips">
		{#each tags as tag (tag)}
			<Chip label={tag} quiet />
		{/each}
	</div>

	<!-- SPEC 7.5 yield control: chips switch instantly, the stepper is free,
	     only the Calculate button spends money. -->
	<div class="yield" role="group" aria-label="Yield">
		<div class="chips ychips">
			{#each r.variations as v (v.id)}
				<!-- Tapping the viewed chip opens its detail (D10 delete lives there). -->
				<Chip
					label={v.is_original ? `${v.yield_count} · original` : String(v.yield_count)}
					selected={v.id === r.variation_id}
					onclick={() =>
						v.id === r.variation_id
							? (showChipDetail = !showChipDetail && !v.is_original)
							: switchTo(v.id)}
				/>
			{/each}
		</div>
		{#if showChipDetail && !r.is_original}
			<!-- D10: delete variation behind the chip's detail; the original never
			     deletable (SPEC 7.5). Trash is the safety net. -->
			<form
				class="chipdetail"
				method="POST"
				action="?/deleteVariation"
				use:enhance={() =>
					async ({ result, update }) => {
						if (result.type === 'success') await goto(`/recipes/${r.id}`, { invalidateAll: true });
						else await update();
					}}
			>
				<input type="hidden" name="variation_id" value={r.variation_id} />
				<button
					type="submit"
					class="delvar"
					onclick={(e) => {
						if (!confirm(`Delete the ${r.yield_count}-${r.yield_unit} version? It goes to Trash.`))
							e.preventDefault();
					}}
				>
					Delete this variation
				</button>
			</form>
		{/if}
		<form method="POST" action="?/calculate" class="stepper" use:enhance={watchJob}>
			<button type="button" onclick={() => step(-1)} aria-label="Fewer {r.yield_unit}">
				<Minus aria-hidden="true" />
			</button>
			<input
				name="to_count"
				type="text"
				inputmode="decimal"
				bind:value={countStr}
				aria-label="Yield count"
				onkeydown={(e) => {
					// Enter must never spend money (SPEC 7.5); it just commits the number.
					if (e.key === 'Enter') {
						e.preventDefault();
						e.currentTarget.blur();
					}
				}}
			/>
			<button type="button" onclick={() => step(1)} aria-label="More {r.yield_unit}">
				<Plus aria-hidden="true" />
			</button>
			<span class="yunit">{r.yield_unit}</span>
			{#if countValid && matching && matching.id !== r.variation_id}
				<button type="button" class="calc" onclick={() => switchTo(matching.id)}>
					Show {count}
				</button>
			{:else if countValid && !matching && !calc}
				<button type="submit" class="calc">Calculate for {count}</button>
			{/if}
		</form>
	</div>

	{#if calc}
		<Banner role="status" icon={LoaderCircle} text="Calculating for {calc.to_count}…" />
	{:else if calcError}
		<Banner text={calcError} />
	{:else if data.calcJob?.status === 'failed'}
		<Banner text={data.calcJob.error_text ?? 'Could not calculate.'} />
	{/if}
	{#if form?.error}
		<Banner text={form.error} />
	{/if}

	<!-- SPEC 7.5 staleness. Untouched: stale-while-revalidate behind a status
	     banner. Hand-edited: never touched automatically, ask first. -->
	{#if data.refresh?.status === 'pending'}
		<Banner role="status" icon={LoaderCircle} text="The original changed, updating this version…" />
	{:else if data.refresh?.status === 'failed'}
		<!-- Plain enhance: success invalidates, load sees the requeued job and
		     shows the updating banner (not the calculate one). -->
		<form method="POST" action="?/retryScale" use:enhance bind:this={retryScaleForm} hidden>
			<input type="hidden" name="variation_id" value={r.variation_id} />
		</form>
		<Banner
			text="The original changed, but this version couldn't update."
			action="Tap to retry"
			onaction={() => retryScaleForm?.requestSubmit()}
		/>
	{:else if justUpdated}
		<Banner role="status" icon={Check} text="Updated to match the original." />
	{/if}
	{#if r.stale && r.hand_edited}
		<div class="stale-edited">
			<Banner text="The original changed after you edited this version." />
			<div class="stale-actions">
				<form method="POST" action="?/recalculate" use:enhance={watchJob}>
					<input type="hidden" name="variation_id" value={r.variation_id} />
					<button
						type="submit"
						onclick={(e) => {
							if (
								!confirm(
									'Recalculate this version? Your edits will be lost (the edited version goes to Trash).'
								)
							)
								e.preventDefault();
						}}
					>
						Recalculate
					</button>
				</form>
				<form method="POST" action="?/keepMine" use:enhance>
					<input type="hidden" name="variation_id" value={r.variation_id} />
					<button type="submit">Keep mine</button>
				</form>
			</div>
		</div>
	{/if}

	<!-- SPEC 7.4 unit toggle: per device, "as written" marks the human-authored
	     body (ADR-028). Marker is a word, never color alone. -->
	<div class="seg" role="group" aria-label="Unit system">
		{#each UNIT_OPTIONS as u (u)}
			<button type="button" aria-pressed={units === u} onclick={() => setUnits(u)}>
				{u === 'us' ? 'US' : 'Metric'}
				<!-- Machine-scaled variations have no human-authored body to mark. -->
				{#if r.source_units === u && (r.is_original || r.hand_edited)}<span class="aswritten"
						>as written</span
					>{/if}
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
			<Banner
				text="Couldn't update from your edit."
				action="Tap to retry"
				onaction={() => retryForm?.requestSubmit()}
			/>
			<form method="POST" action="?/retry" use:enhance bind:this={retryForm} hidden>
				{#if !r.is_original}
					<input type="hidden" name="variation_id" value={r.variation_id} />
				{/if}
			</form>
		{/if}
		{#if form?.error}
			<Banner text={form.error} />
		{/if}
	{/if}

	<!-- SPEC 5.5: the note that names what did not scale linearly. -->
	{#if r.scaling_note && !r.is_original}
		<p class="scalenote">{r.scaling_note}</p>
	{/if}

	<!-- SPEC 7.4: collapsible sticky block, reachable while deep in the steps.
	     Its body scrolls internally, so page scroll position is never lost. -->
	<details class="ing" open>
		<summary>
			<h2>Ingredients</h2>
			<ChevronDown aria-hidden="true" />
		</summary>
		<div class="ingbody">
			{#each body.ingredients as group, gi (gi)}
				{#if group.heading}
					<h3>{group.heading}</h3>
				{/if}
				<ul class="strikable">
					{#each group.items as item, i (i)}
						<li>
							<button
								type="button"
								aria-pressed={strikes.has(`i${gi}.${i}`)}
								onclick={() => toggleStrike(`i${gi}.${i}`)}>{item}</button
							>
						</li>
					{/each}
				</ul>
			{/each}
		</div>
	</details>

	{#if body.steps.length > 0}
		<section aria-label="Steps">
			<h2>Steps</h2>
			<ol class="strikable">
				{#each body.steps as step, i (i)}
					<li>
						<button
							type="button"
							aria-pressed={strikes.has(`s${i}`)}
							onclick={() => toggleStrike(`s${i}`)}>{step}</button
						>
					</li>
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
		padding: 1rem 1rem calc(6rem + env(safe-area-inset-bottom));
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
	.yield {
		margin: 0.8rem 0 0;
	}
	.ychips {
		margin: 0;
	}
	.stepper {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
		margin-top: 0.6rem;
	}
	.stepper > button:not(.calc) {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2.75rem;
		min-height: 2.75rem;
		border: 1.5px solid var(--line);
		border-radius: 0.7rem;
		background: var(--card);
		color: inherit;
		font: inherit;
		cursor: pointer;
	}
	.stepper > button:not(.calc) :global(svg) {
		width: 1.2em;
		height: 1.2em;
	}
	.chipdetail {
		margin-top: 0.4rem;
	}
	.stepper input {
		width: 4rem;
		min-height: 2.75rem;
		border: 1.5px solid var(--line);
		border-radius: 0.7rem;
		background: var(--card);
		color: inherit;
		font: inherit;
		font-size: 1.1rem;
		font-weight: 600;
		text-align: center;
	}
	.yunit {
		color: var(--muted);
		font-size: 0.95rem;
	}
	.calc {
		min-height: 2.75rem;
		padding: 0 1rem;
		border: 0;
		border-radius: 0.7rem;
		background: var(--accent);
		color: var(--on-accent);
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}
	.stale-actions {
		display: flex;
		gap: 0.6rem;
		margin: -0.2rem 0 0.7rem;
	}
	.stale-actions button {
		min-height: 2.75rem;
		padding: 0 0.9rem;
		border: 1.5px solid var(--line);
		border-radius: 0.7rem;
		background: var(--card);
		color: var(--accent);
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}
	.scalenote {
		color: var(--muted);
		font-size: 0.9rem;
		font-style: italic;
		margin: 0.6rem 0 0;
	}
	.delvar {
		min-height: 2.75rem;
		padding: 0 0.5rem;
		border: 0;
		background: none;
		color: var(--danger);
		font: inherit;
		font-size: 0.95rem;
		font-weight: 600;
		cursor: pointer;
		text-decoration: underline;
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
	/* Collapsible ingredients (SPEC 7.4): scrolls away when open,
	   sticks only when collapsed so it stays reachable mid-steps. */
	.ing {
		background: var(--card);
		border: 1px solid var(--line);
		border-radius: 1rem;
		margin-top: 0.8rem;
	}
	.ing:not([open]) {
		position: sticky;
		top: calc(env(safe-area-inset-top) + 0.4rem);
		z-index: 5;
		box-shadow: 0 4px 16px rgb(0 0 0 / 0.08);
	}
	.ing summary {
		list-style: none;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-height: 2.75rem;
		box-sizing: border-box;
		padding: 0.7rem 0.9rem;
		cursor: pointer;
		-webkit-tap-highlight-color: transparent;
	}
	.ing summary::-webkit-details-marker {
		display: none;
	}
	.ing summary h2 {
		margin: 0;
	}
	.ing summary :global(svg) {
		margin-left: auto;
		flex: none;
		width: 1.2rem;
		height: 1.2rem;
		color: var(--muted);
		transition: transform 0.15s;
	}
	.ing[open] summary :global(svg) {
		transform: rotate(180deg);
	}
	.ingbody {
		max-height: 44vh;
		overflow-y: auto;
		overscroll-behavior: contain;
		padding: 0 0.9rem 0.9rem;
	}
	@media (prefers-reduced-motion: reduce) {
		.ing summary :global(svg) {
			transition: none;
		}
	}
	/* Tap-to-strike (SPEC 7.4): whole-line buttons with a real pressed state */
	.strikable li {
		margin: 0;
	}
	.strikable button {
		display: block;
		width: 100%;
		padding: 0.45rem 0;
		border: 0;
		background: none;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
		-webkit-tap-highlight-color: transparent;
	}
	.strikable button[aria-pressed='true'] {
		text-decoration: line-through;
		text-decoration-thickness: 2px;
		color: var(--muted);
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
