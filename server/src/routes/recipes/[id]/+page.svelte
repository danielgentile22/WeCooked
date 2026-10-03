<script lang="ts">
	import {
		Pencil,
		LoaderCircle,
		Check,
		Minus,
		Plus,
		ChevronDown,
		Ellipsis,
		Trash2
	} from '@lucide/svelte';
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
	let lastRecipe: string | null = null;
	$effect(() => {
		// The route component is reused across recipes, so a job belongs to the
		// recipe that started it and goes when that recipe does.
		if (r.id !== lastRecipe) {
			lastRecipe = r.id;
			calc = null;
			seededCalcJob = null;
		}
		// snap to the viewed yield on switch, and back on return (remount), and
		// drop banners and detail that belonged to the previous variation
		if (r.variation_id !== lastVariation) {
			lastVariation = r.variation_id;
			countStr = String(r.yield_count);
			justUpdated = false;
			if (calc?.phase !== 'running') calc = null;
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

	// The calculate/recalculate job as this tab sees it. Seeded from the server
	// (so it survives a locked phone and reload) or from a just-submitted
	// action. "Try again" resubmits the same to_count (iOS retryCalculation).
	type Calc =
		| { phase: 'running'; job_id: string; to_count: number; recipe_id: string }
		| { phase: 'failed'; text: string; to_count: number }
		| { phase: 'timed_out'; to_count: number };
	let calc = $state<Calc | null>(null);
	let justUpdated = $state(false);
	let seededCalcJob: string | null = null;
	$effect(() => {
		const job = data.calcJob;
		if (!job || seededCalcJob === job.job_id) return;
		seededCalcJob = job.job_id;
		if (job.status === 'pending' && calc?.phase !== 'running')
			calc = { phase: 'running', job_id: job.job_id, to_count: job.to_count, recipe_id: r.id };
		else if (job.status === 'failed' && !calc)
			calc = { phase: 'failed', text: job.error_text ?? 'Could not calculate.', to_count: job.to_count };
	});
	let calcPolled: string | null = null;
	$effect(() => {
		if (calc?.phase !== 'running' || calcPolled === calc.job_id) return;
		const { job_id, to_count, recipe_id } = calc;
		calcPolled = job_id;
		pollJob(job_id)
			.then(async (job) => {
				calcPolled = null;
				if (recipe_id !== r.id) return;
				if (job.status === 'done' && job.result_ref) {
					calc = null;
					await goto(`/recipes/${recipe_id}?v=${job.result_ref}`, {
						noScroll: true,
						invalidateAll: true
					});
				} else if (job.status === 'timeout') {
					calc = { phase: 'timed_out', to_count };
				} else {
					calc = { phase: 'failed', text: job.error_text ?? 'Could not calculate.', to_count };
					await invalidateAll();
				}
			})
			.catch(() => {
				calcPolled = null;
				if (recipe_id === r.id)
					calc = { phase: 'failed', text: 'Lost track of the calculation.', to_count };
			});
	});
	let retryCalcForm: HTMLFormElement | undefined = $state();

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
	const watchJob: import('./$types').SubmitFunction = ({ formData }) => {
		const to_count = Number(formData.get('to_count'));
		calc = null;
		return async ({ result, update }) => {
			if (result.type === 'success' && result.data) {
				const d = result.data as { job_id?: string; variation_id?: string };
				if (d.variation_id) return void switchTo(d.variation_id);
				if (d.job_id) calc = { phase: 'running', job_id: d.job_id, to_count, recipe_id: r.id };
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

	// SPEC 7.4 / ADR-036 strikes, matching iOS DeviceState: localStorage keyed
	// by variation id, per device, never synced. A record lives 12 idle hours
	// across tab closes and is dropped when the recipe's content_version moves
	// (an edit reorders lines, so old positions would strike the wrong ones).
	// Line identity is positional, unlike shopping ticks (text): text would
	// drop every strike on a unit toggle, a real mid-cook action.
	type StrikeRecord = { content_version: number; touched: number; lines: string[] };
	const STRIKE_LIFETIME = 12 * 3600_000;
	const strikeKey = (variationId: string) => `strikes:${variationId}`;
	function readStrikes(variationId: string, contentVersion: number): ReadonlySet<string> {
		try {
			const rec: StrikeRecord | null = JSON.parse(localStorage.getItem(strikeKey(variationId)) ?? 'null');
			if (
				rec &&
				rec.content_version === contentVersion &&
				Date.now() - rec.touched < STRIKE_LIFETIME
			)
				return new Set(rec.lines);
		} catch {
			/* corrupt entry: start clean */
		}
		return new Set();
	}
	function pruneStrikes() {
		for (const key of Object.keys(localStorage)) {
			if (!key.startsWith('strikes:')) continue;
			try {
				const rec: StrikeRecord = JSON.parse(localStorage.getItem(key) ?? 'null');
				if (!rec || Date.now() - rec.touched >= STRIKE_LIFETIME || rec.lines.length === 0)
					localStorage.removeItem(key);
			} catch {
				localStorage.removeItem(key);
			}
		}
	}
	let strikes = $state<ReadonlySet<string>>(new Set());
	$effect(() => {
		strikes = readStrikes(r.variation_id, r.content_version);
	});
	function toggleStrike(key: string) {
		const next = new Set(strikes);
		if (!next.delete(key)) next.add(key);
		strikes = next;
		const rec: StrikeRecord = {
			content_version: r.content_version,
			touched: Date.now(),
			lines: [...next]
		};
		localStorage.setItem(strikeKey(r.variation_id), JSON.stringify(rec));
		pruneStrikes();
	}
	function setUnits(u: 'us' | 'metric') {
		units = u;
		localStorage.setItem('units', u);
	}

	// The chosen body; while it is missing (reconvert pending or failed) the
	// source body stays readable behind the banner, stale-while-revalidate.
	const body = $derived(r.bodies[units] ?? r.bodies[r.source_units]!);
	const isFallback = $derived(r.bodies[units] === null);
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

	// The phone's collapsible ingredients (SPEC 7.4) become a fixed column at
	// the shell's 900px switch: forced open and out of the tab order there.
	let wide = $state(false);
	let ingOpen = $state(true);
	onMount(() => {
		const mq = matchMedia('(min-width: 900px)');
		const sync = () => (wide = mq.matches);
		sync();
		mq.addEventListener('change', sync);
		return () => mq.removeEventListener('change', sync);
	});
	$effect(() => {
		if (wide) ingOpen = true;
	});

	const UNIT_OPTIONS = ['metric', 'us'] as const;
	const unitName = (u: 'us' | 'metric') => (u === 'us' ? 'US' : 'Metric');
	const cover = $derived(r.images.find((i) => i.id === r.cover_image_id) ?? null);
	const tags = $derived(
		[...r.meal_types, r.cuisine, r.protein, r.effort, r.damage].filter((t) => t !== null)
	);
	const facts = $derived(
		[
			`${r.yield_count} ${r.yield_unit}`,
			r.prep_minutes !== null ? `prep ${r.prep_minutes} min` : null,
			r.cook_minutes !== null ? `cook ${r.cook_minutes} min` : null
		].filter((f) => f !== null)
	);
</script>

<svelte:head>
	<title>{r.title} · We Cooked</title>
</svelte:head>

<main>
	<header class:withcover={cover !== null}>
		{#if cover}
			<img class="cover" src={cover.url} alt={r.title} width={cover.width} height={cover.height} />
		{/if}
		<div class="titleblock">
			<h1>{r.title}</h1>
			<ul class="facts" aria-label="Yield and times">
				{#each facts as fact (fact)}
					<li>{fact}</li>
				{/each}
			</ul>
			{#if r.source_url}
				<p class="source"><a href={r.source_url}>{r.source_text ?? r.source_url}</a></p>
			{:else if r.source_text}
				<p class="source">{r.source_text}</p>
			{/if}
			<div class="chips tags">
				{#each tags as tag (tag)}
					<Chip label={tag} quiet />
				{/each}
			</div>
		</div>
		<div class="tools">
			<!-- Editing a scaled variation edits its body (hand edits, SPEC 7.5). -->
			<a class="edit" href="/recipes/{r.id}/edit{r.is_original ? '' : `?v=${r.variation_id}`}"
				><Pencil aria-hidden="true" /> Edit</a
			>
			<!-- D10: nothing destructive in the open on the cooking screen. Delete
			     recipe sits behind More with a confirm; Trash is the safety net. -->
			<details class="more">
				<summary aria-label="More"><Ellipsis aria-hidden="true" /></summary>
				<form
					method="POST"
					action="?/deleteRecipe"
					use:enhance={() =>
						async ({ result, update }) => {
							if (result.type === 'redirect') await goto(result.location, { invalidateAll: true });
							else await update();
						}}
				>
					<button
						type="submit"
						class="delrecipe"
						onclick={(e) => {
							if (!confirm(`Delete "${r.title}"? It goes to Trash.`)) e.preventDefault();
						}}
					>
						<Trash2 aria-hidden="true" /> Delete recipe
					</button>
				</form>
			</details>
		</div>
	</header>

	<!-- SPEC 7.5 yield control: chips switch instantly, the stepper is free,
	     only the Calculate button spends money. The unit toggle sits beside it
	     so neither crowds the recipe text. -->
	<div class="controls">
		<div class="yield" role="group" aria-label="Yield">
			<div class="chips">
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
				{:else if countValid && !matching && calc?.phase !== 'running'}
					<button type="submit" class="calc">Calculate for {count}</button>
				{/if}
			</form>
		</div>

		<!-- SPEC 7.4 unit toggle: per device, "as written" marks the human-authored
		     body (ADR-028). Marker is a word, never color alone. -->
		<div class="seg" role="group" aria-label="Unit system">
			{#each UNIT_OPTIONS as u (u)}
				<button type="button" aria-pressed={units === u} onclick={() => setUnits(u)}>
					{unitName(u)}
					<!-- Machine-scaled variations have no human-authored body to mark. -->
					{#if r.source_units === u && (r.is_original || r.hand_edited)}<span class="aswritten"
							>as written</span
						>{/if}
				</button>
			{/each}
		</div>
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

	<div class="notices">
		{#if calc}
			<form method="POST" action="?/calculate" use:enhance={watchJob} bind:this={retryCalcForm} hidden>
				<input type="hidden" name="to_count" value={calc.to_count} />
			</form>
			{#if calc.phase === 'running'}
				<Banner role="status" icon={LoaderCircle} text="Calculating for {calc.to_count}…" />
			{:else if calc.phase === 'timed_out'}
				<Banner
					text="Still working after 5 minutes."
					action="Try again"
					onaction={() => retryCalcForm?.requestSubmit()}
				/>
			{:else}
				<Banner text={calc.text} action="Try again" onaction={() => retryCalcForm?.requestSubmit()} />
			{/if}
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
				action="Retry"
				onaction={() => retryScaleForm?.requestSubmit()}
			/>
		{:else if justUpdated}
			<Banner role="status" icon={Check} text="Updated to match the original." />
		{/if}
		{#if r.stale && r.hand_edited}
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
		{/if}

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
					action="Retry"
					onaction={() => retryForm?.requestSubmit()}
				/>
				<form method="POST" action="?/retry" use:enhance bind:this={retryForm} hidden>
					{#if !r.is_original}
						<input type="hidden" name="variation_id" value={r.variation_id} />
					{/if}
				</form>
			{/if}
		{/if}

		<!-- SPEC 5.5: the note that names what did not scale linearly. -->
		{#if r.scaling_note && !r.is_original}
			<p class="aside">{r.scaling_note}</p>
		{/if}
		{#if isFallback}
			<p class="aside">
				The {unitName(units)} version is not ready yet, so this is the recipe as written.
			</p>
		{/if}
	</div>

	<div class="cook">
		<!-- SPEC 7.4 on a phone: collapsible block whose heading stays reachable
		     deep in the steps. On a wide screen it is a sticky column. -->
		<details class="ing" bind:open={ingOpen}>
			<summary tabindex={wide ? -1 : 0}>
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

		<div class="main">
			{#if body.steps.length > 0}
				<section aria-label="Steps">
					<h2>Steps</h2>
					<ol class="strikable steps">
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
		</div>
	</div>
</main>

<style>
	main {
		max-width: 44rem;
		margin: 0 auto;
		padding: 1rem 1rem calc(6rem + env(safe-area-inset-bottom));
	}

	/* ---- Header: title block, cover, tools ---- */
	header {
		position: relative;
		display: grid;
		gap: 0.6rem;
	}
	.titleblock {
		min-width: 0;
		padding-right: 7.5rem;
	}
	h1 {
		font-size: 1.6rem;
		line-height: 1.2;
		margin: 0;
		letter-spacing: -0.01em;
		text-wrap: balance;
	}
	.facts {
		display: flex;
		flex-wrap: wrap;
		gap: 0.2rem 0.5rem;
		list-style: none;
		margin: 0.35rem 0 0;
		padding: 0;
		color: var(--muted);
		font-size: 1rem;
	}
	.facts li {
		white-space: nowrap;
	}
	.facts li:not(:last-child)::after {
		content: '·';
		margin-left: 0.5rem;
	}
	.source {
		color: var(--muted);
		font-size: 0.9rem;
		margin: 0.3rem 0 0;
		overflow-wrap: anywhere;
	}
	.source a {
		color: var(--accent);
	}
	.cover {
		width: 100%;
		height: auto;
		aspect-ratio: 16 / 10;
		object-fit: cover;
		border-radius: 1rem;
		order: 1;
	}
	.tools {
		position: absolute;
		top: 0;
		right: 0;
		display: flex;
		align-items: center;
	}
	.edit {
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
	.more {
		position: relative;
	}
	.more summary {
		list-style: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2.75rem;
		min-height: 2.75rem;
		border-radius: 0.7rem;
		color: var(--muted);
		cursor: pointer;
	}
	.more summary::-webkit-details-marker {
		display: none;
	}
	.more[open] summary {
		background: var(--card);
	}
	.more summary :global(svg) {
		width: 1.3rem;
		height: 1.3rem;
	}
	.more form {
		position: absolute;
		top: 100%;
		right: 0;
		z-index: 10;
		min-width: 12rem;
		margin-top: 0.3rem;
		padding: 0.4rem;
		background: var(--card);
		border: 1px solid var(--line);
		border-radius: 0.8rem;
		box-shadow: 0 8px 24px rgb(0 0 0 / 0.12);
	}
	.delrecipe {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		min-height: 2.75rem;
		padding: 0 0.7rem;
		border: 0;
		border-radius: 0.5rem;
		background: none;
		color: var(--danger);
		font: inherit;
		font-weight: 600;
		text-align: left;
		cursor: pointer;
	}
	.delrecipe :global(svg) {
		width: 1.1em;
		height: 1.1em;
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}
	.tags {
		margin-top: 0.6rem;
	}

	/* ---- Controls: yield and units, kept out of the recipe text ---- */
	.controls {
		display: grid;
		gap: 0.8rem;
		margin-top: 1rem;
	}
	.yield {
		display: grid;
		gap: 0.6rem;
	}
	.stepper {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
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
	.chipdetail {
		margin-top: 0.6rem;
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
		align-self: start;
		border: 1.5px solid var(--line);
		border-radius: 0.7rem;
		overflow: hidden;
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

	/* ---- Banners and notes between the controls and the recipe ---- */
	.notices {
		margin-top: 0.8rem;
	}
	.notices:empty {
		display: none;
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
	.aside {
		color: var(--muted);
		font-size: 0.95rem;
		font-style: italic;
		margin: 0 0 0.6rem;
	}

	/* ---- The recipe itself ---- */
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
	/* Step numbers: big, in the accent, in their own gutter */
	.steps {
		list-style: none;
		padding-left: 0;
		counter-reset: step;
	}
	.steps li {
		display: grid;
		grid-template-columns: 2rem 1fr;
		gap: 0.5rem;
		counter-increment: step;
	}
	.steps li::before {
		content: counter(step);
		color: var(--accent);
		font-weight: 700;
		font-size: 1.25em;
		line-height: 1.2;
		padding-top: 0.45rem;
	}
	.notes {
		margin: 0;
		white-space: pre-wrap;
		font-size: 1.1rem;
		line-height: 1.55;
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

	/* ---- Laptop cooking layout (matches the shell's 900px sidebar switch) ---- */
	@media (min-width: 900px) {
		main {
			max-width: 84rem;
			padding: 1.5rem 2rem 4rem;
		}
		header {
			grid-template-columns: minmax(0, 1fr);
			align-items: start;
			column-gap: 1.75rem;
		}
		header.withcover {
			grid-template-columns: 22rem minmax(0, 1fr);
		}
		.cover {
			order: 0;
			border-radius: 1rem;
		}
		.titleblock {
			padding-right: 8rem;
		}
		h1 {
			font-size: 2.4rem;
		}
		.facts {
			font-size: 1.15rem;
			margin-top: 0.5rem;
		}
		.source {
			font-size: 1rem;
		}
		.controls {
			grid-template-columns: 1fr auto;
			align-items: start;
			margin-top: 1.4rem;
			padding: 0.9rem 1rem;
			background: var(--card);
			border: 1px solid var(--line);
			border-radius: 1rem;
		}
		.notices {
			margin-top: 1rem;
		}
		.cook {
			display: grid;
			grid-template-columns: 38fr 62fr;
			gap: 1.5rem;
			align-items: start;
			margin-top: 1rem;
		}
		/* The column is always in view; the phone's disclosure is inert here. */
		.ing {
			position: sticky;
			top: 1rem;
			margin-top: 0;
		}
		.ing summary {
			pointer-events: none;
			padding: 1.1rem 1.25rem 0.4rem;
		}
		.ing summary :global(svg) {
			display: none;
		}
		.ingbody {
			max-height: calc(100vh - 7rem);
			padding: 0 1.25rem 1.1rem;
		}
		.main > section:first-child {
			margin-top: 0;
		}
		section {
			padding: 1.1rem 1.25rem;
			margin-top: 1.25rem;
		}
		h2 {
			font-size: 1.6rem;
			margin-bottom: 0.6rem;
		}
		h3 {
			font-size: 1.15rem;
			margin: 1rem 0 0.2rem;
		}
		ul,
		ol {
			font-size: 1.4rem;
			line-height: 1.5;
		}
		.strikable button {
			padding: 0.5rem 0;
		}
		.ing li {
			margin: 0.2rem 0;
		}
		.steps li {
			grid-template-columns: 2.6rem 1fr;
			gap: 0.6rem;
			margin: 0.6rem 0;
		}
		.steps li::before {
			font-size: 1.75rem;
			line-height: 1;
			padding-top: 0.6rem;
		}
		.notes {
			font-size: 1.25rem;
		}
		.strip img {
			height: 10rem;
		}
	}
</style>
