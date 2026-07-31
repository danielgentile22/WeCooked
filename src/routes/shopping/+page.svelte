<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { enhance } from '$app/forms';
	import {
		Check,
		ChevronDown,
		ListPlus,
		LoaderCircle,
		Minus,
		Pencil,
		Plus,
		ShoppingCart,
		Trash2
	} from '@lucide/svelte';
	import Banner from '$lib/components/Banner.svelte';
	import { pollJob } from '$lib/jobs';
	import type { ShoppingItem, ShoppingState } from '$lib/server/shopping';

	let { data } = $props();

	// Local copy of the list, so ticks apply optimistically and the 5 s poll
	// can refresh it without a full page invalidation (ADR-033).
	// svelte-ignore state_referenced_locally -- the $effect below re-syncs it
	let list = $state<ShoppingState>(data.list);
	$effect(() => {
		list = data.list;
	});

	const SECTION_LABELS: Record<string, string> = {
		produce: 'Produce',
		'meat-fish': 'Meat and fish',
		dairy: 'Dairy',
		'dry-goods': 'Dry goods',
		spices: 'Spices',
		frozen: 'Frozen',
		other: 'Other'
	};

	// ---- screens ----
	let mode = $state<'list' | 'pick'>('list');
	const building = $derived(list.build?.status === 'pending');
	const hasList = $derived(list.items.length > 0);

	// ---- units (D15: per device, shared key with the recipe view) ----
	let units = $state<'us' | 'metric'>('metric');
	$effect(() => {
		if (localStorage.getItem('units') === 'us') units = 'us';
	});
	function setUnits(u: 'us' | 'metric') {
		units = u;
		localStorage.setItem('units', u);
	}

	// ---- shared ticks (SPEC 7.6, ADR-033) ----
	let ticksInFlight = 0;
	function tick(item: ShoppingItem) {
		item.ticked = !item.ticked; // optimistic
		ticksInFlight++;
		fetch(`/api/shopping-list/items/${item.id}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ ticked: item.ticked })
		}).finally(() => ticksInFlight--);
	}

	// 5 s visibility-aware poll; refetch immediately on return to visible.
	async function refresh() {
		if (document.visibilityState !== 'visible' || ticksInFlight > 0) return;
		try {
			const res = await fetch('/api/shopping-list');
			if (res.ok) list = await res.json();
		} catch {
			// offline blip: the next poll tries again
		}
	}
	$effect(() => {
		const t = setInterval(refresh, 5000);
		document.addEventListener('visibilitychange', refresh);
		return () => {
			clearInterval(t);
			document.removeEventListener('visibilitychange', refresh);
		};
	});

	// Rebuild banner (SPEC 7.6): shown once when a build is seen completing,
	// naming any reset ticks. Transition-based so it also fires when the other
	// phone rebuilt.
	let rebuildBanner = $state<string | null>(null);
	let lastBuild = $state<string | null>(null);
	$effect(() => {
		const b = list.build;
		const key = b ? `${b.job_id}:${b.status}` : null;
		if (key === lastBuild) return;
		const wasPending = lastBuild?.startsWith(b?.job_id ?? '') && lastBuild?.endsWith('pending');
		lastBuild = key;
		if (b?.status === 'done' && wasPending && b.result) {
			mode = 'list';
			const { kept, reset } = b.result;
			rebuildBanner = reset.length
				? `${kept} tick${kept === 1 ? '' : 's'} kept. ${reset.length} reset because the line changed: ${reset.join(', ')}.`
				: null;
		}
		if (b?.status === 'pending') watchBuild(b.job_id);
	});

	// SPEC 6.3 job polling for a fast flip; the 5 s poll is the backstop.
	const watched = new Set<string>();
	function watchBuild(jobId: string) {
		if (watched.has(jobId)) return;
		watched.add(jobId);
		pollJob(jobId)
			.then(() => invalidateAll())
			.catch(() => watched.delete(jobId));
	}

	// ---- pick mode (D11) ----
	let selected = $state<Record<string, boolean>>({});
	let yields = $state<Record<string, number>>({});
	function openPick() {
		selected = Object.fromEntries(list.picks.map((p) => [p.recipe_id, true]));
		yields = Object.fromEntries([
			...data.recipes.map((r) => [r.id, r.yield_count]),
			...list.picks.map((p) => [p.recipe_id, p.yield_count])
		]);
		mode = 'pick';
	}
	const pickCount = $derived(Object.values(selected).filter(Boolean).length);
	const picksJson = $derived(
		JSON.stringify(
			data.recipes
				.filter((r) => selected[r.id])
				.map((r) => ({ recipe_id: r.id, yield_count: yields[r.id] }))
		)
	);
	function step(id: string, d: number) {
		yields[id] = Math.max(1, Math.round(yields[id] + d));
	}

	// ---- done shopping: two-step confirmation (SPEC 7.6) ----
	let confirming = $state(false);
	let retryForm = $state<HTMLFormElement>();

	const totals = $derived({
		total: list.items.length,
		ticked: list.items.filter((i) => i.ticked).length
	});
	const sectionItems = (section: string) =>
		list.items
			.filter((i) => i.section === section)
			.sort((a, b) => Number(a.is_manual) - Number(b.is_manual) || a.position - b.position);
	const staples = $derived(sectionItems('staples'));
	const primary = (i: ShoppingItem) => (units === 'us' ? i.text_us : i.text_metric);
	const alt = (i: ShoppingItem) => (units === 'us' ? i.text_metric : i.text_us);
</script>

<svelte:head>
	<title>Shopping · We Cooked</title>
</svelte:head>

<main>
	<header>
		<h1>{mode === 'pick' ? 'New shopping list' : 'Shopping'}</h1>
		<p class="sub" aria-live="polite">
			{#if mode === 'pick'}Pick recipes and portions{:else if building}Building…{:else if hasList}{totals.ticked}
				of {totals.total} ticked · ticks sync to both phones{/if}
		</p>
	</header>

	{#if mode === 'pick'}
		{#if data.recipes.length === 0}
			<p class="empty">No recipes yet. <a href="/add">Add one first.</a></p>
		{:else}
			{#each data.recipes as r (r.id)}
				<div class="pickrow">
					<input type="checkbox" id="sel-{r.id}" bind:checked={selected[r.id]} />
					<label class="name" for="sel-{r.id}">
						{r.title}
						<small>written for {r.yield_count} {r.yield_unit}</small>
					</label>
					<div class="stepper">
						<button
							type="button"
							onclick={() => step(r.id, -1)}
							aria-label="Fewer {r.yield_unit} of {r.title}"><Minus /></button
						>
						<output>{yields[r.id]}<small>{r.yield_unit}</small></output>
						<button
							type="button"
							onclick={() => step(r.id, 1)}
							aria-label="More {r.yield_unit} of {r.title}"><Plus /></button
						>
					</div>
				</div>
			{/each}
			<div class="pickactions">
				<form
					method="POST"
					action="?/build"
					use:enhance={() => {
						mode = 'list'; // the building banner lives on the list screen
						return async ({ update }) => update();
					}}
				>
					<input type="hidden" name="picks" value={picksJson} />
					<button class="btn primary" disabled={pickCount === 0}>
						{pickCount
							? `Build list from ${pickCount} recipe${pickCount > 1 ? 's' : ''}`
							: 'Pick at least one recipe'}
					</button>
				</form>
				{#if hasList}
					<button type="button" class="btn secondary" onclick={() => (mode = 'list')}>
						Cancel, keep current list
					</button>
				{/if}
			</div>
			<Banner
				role="status"
				icon={ShoppingCart}
				text="Builds from saved variations, generating any missing ones first. One job; it survives a locked phone."
			/>
		{/if}
	{:else if building}
		<div class="building">
			<Banner
				role="status"
				icon={LoaderCircle}
				text="Building your list. You can lock your phone; the build carries on."
			/>
		</div>
		{#each { length: 5 }, i (i)}<div class="skel"></div>{/each}
	{:else}
		{#if list.build?.status === 'failed'}
			<form method="POST" action="?/retry" use:enhance bind:this={retryForm}>
				<input type="hidden" name="list_id" value={list.list_id} />
				<Banner
					text={list.build.error_text ?? 'The build failed.'}
					action="Tap to retry"
					onaction={() => retryForm?.requestSubmit()}
				/>
			</form>
		{/if}
		{#if rebuildBanner}
			<Banner role="status" icon={Check} text={rebuildBanner} />
		{/if}

		{#if !hasList}
			<div class="empty">
				<p>Pick recipes to build a list.</p>
				<button type="button" class="btn primary narrow" onclick={openPick}>
					<ListPlus aria-hidden="true" />Add recipes
				</button>
			</div>
		{:else}
			{#each Object.keys(SECTION_LABELS) as section (section)}
				{@const its = sectionItems(section)}
				{#if its.length > 0}
					<section>
						<h2>{SECTION_LABELS[section]}</h2>
						<ul class="items">
							{#each its as item (item.id)}
								<li class:ticked={item.ticked}>
									<label>
										<input
											type="checkbox"
											checked={item.ticked}
											onchange={() => tick(item)}
										/>
										<span class="txt">
											{primary(item)}
											<span class="meta">
												{#if item.is_manual}added by hand{:else}
													{alt(item) !== primary(item) ? `about ${alt(item)} · ` : ''}{item.from_titles.join(
														', '
													)}{/if}
											</span>
										</span>
									</label>
								</li>
							{/each}
						</ul>
					</section>
				{/if}
			{/each}

			{#if staples.length > 0}
				<!-- Staples are separated, never dropped (SPEC 7.6), collapsed at the bottom. -->
				<details class="staples">
					<summary>Check you have ({staples.length}) <ChevronDown aria-hidden="true" /></summary>
					<ul class="items">
						{#each staples as item (item.id)}
							<li class:ticked={item.ticked}>
								<label>
									<input type="checkbox" checked={item.ticked} onchange={() => tick(item)} />
									<span class="txt">
										{primary(item)}
										<span class="meta">from {item.from_titles.join(', ')}</span>
									</span>
								</label>
							</li>
						{/each}
					</ul>
				</details>
			{/if}

			<form
				class="addrow"
				method="POST"
				action="?/manual"
				use:enhance={() =>
					async ({ update }) => {
						await update(); // clears the input, invalidates
					}}
			>
				<input name="text" placeholder="Add item (bin bags, milk…)" aria-label="Add item by hand" />
				<button type="submit"><Plus aria-hidden="true" />Add</button>
			</form>

			<div class="unitsrow">
				<span id="unitslabel">Show amounts in</span>
				<div class="seg" role="group" aria-labelledby="unitslabel">
					<button type="button" aria-pressed={units === 'metric'} onclick={() => setUnits('metric')}>
						{#if units === 'metric'}<Check aria-hidden="true" />{/if}Metric
					</button>
					<button type="button" aria-pressed={units === 'us'} onclick={() => setUnits('us')}>
						{#if units === 'us'}<Check aria-hidden="true" />{/if}US
					</button>
				</div>
			</div>

			<div class="donezone">
				{#if !confirming}
					<button type="button" class="btn secondary" onclick={() => (confirming = true)}>
						<Trash2 aria-hidden="true" />Done shopping
					</button>
				{:else}
					<div class="confirm" role="alertdialog" aria-label="Confirm clear list">
						<p>
							Clear {totals.total} items and all ticks on <strong>both phones</strong>? The list
							cannot be brought back.
						</p>
						<div class="row2">
							<button type="button" class="btn secondary" onclick={() => (confirming = false)}>
								Cancel
							</button>
							<form method="POST" action="?/done" use:enhance>
								<button class="btn primary danger">
									<Trash2 aria-hidden="true" />Clear list
								</button>
							</form>
						</div>
					</div>
				{/if}
			</div>
			<button type="button" class="btn secondary editbtn" onclick={openPick}>
				<Pencil aria-hidden="true" />Add or remove recipes
			</button>
		{/if}
	{/if}
</main>

<style>
	main {
		max-width: 44rem;
		margin: 0 auto;
		padding: 1rem 1rem 6rem;
	}
	h1 {
		font-size: 1.4rem;
		margin: 0;
		letter-spacing: -0.01em;
	}
	.sub {
		margin: 0.1rem 0 0.8rem;
		font-size: 0.85rem;
		color: var(--muted);
		min-height: 1.2em;
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

	.btn {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		justify-content: center;
		width: 100%;
		min-height: 3rem;
		padding: 0.7rem 1rem;
		border-radius: 0.8rem;
		border: 0;
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}
	.btn :global(svg) {
		width: 1.2em;
		height: 1.2em;
	}
	.btn.primary {
		background: var(--accent);
		color: var(--on-accent);
	}
	.btn.primary:disabled {
		background: var(--line);
		color: var(--muted);
		cursor: default;
	}
	.btn.secondary {
		background: var(--card);
		border: 1.5px solid var(--line);
		color: var(--ink);
	}
	.btn.narrow {
		max-width: 15rem;
		margin: 1rem auto 0;
	}

	/* ---- pick mode ---- */
	.pickrow {
		display: flex;
		align-items: center;
		gap: 0.7rem;
		background: var(--card);
		border: 1px solid var(--line);
		border-radius: 0.8rem;
		padding: 0.6rem 0.7rem;
		margin-bottom: 0.6rem;
		min-height: 3.3rem;
	}
	.pickrow input[type='checkbox'] {
		width: 1.5rem;
		height: 1.5rem;
		accent-color: var(--accent);
		flex: none;
	}
	.pickrow .name {
		flex: 1;
		min-width: 0;
		font-weight: 600;
	}
	.pickrow .name small {
		display: block;
		font-size: 0.8rem;
		font-weight: 400;
		color: var(--muted);
	}
	.stepper {
		display: inline-flex;
		align-items: center;
		border: 1.5px solid var(--line);
		border-radius: 0.7rem;
		overflow: hidden;
		background: var(--card);
	}
	.stepper button {
		width: 2.75rem;
		height: 2.75rem;
		display: grid;
		place-items: center;
		border: 0;
		background: none;
		color: var(--ink);
		cursor: pointer;
	}
	.stepper button :global(svg) {
		width: 1.1rem;
		height: 1.1rem;
	}
	.stepper output {
		min-width: 2.6rem;
		text-align: center;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	.stepper output small {
		display: block;
		font-size: 0.7rem;
		font-weight: 400;
		color: var(--muted);
		line-height: 1.1;
	}
	.pickactions {
		margin: 0.9rem 0;
		display: grid;
		gap: 0.5rem;
	}

	/* ---- building ---- */
	.building :global(svg) {
		animation: spin 1.2s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	.skel {
		height: 3.3rem;
		border-radius: 0.8rem;
		background: var(--card);
		border: 1px solid var(--line);
		margin-bottom: 0.5rem;
		opacity: 0.6;
	}

	/* ---- list ---- */
	section h2,
	details.staples summary {
		font-size: 0.8rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--muted);
		margin: 1rem 0 0.4rem;
		font-weight: 600;
	}
	ul.items {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	ul.items li {
		margin-bottom: 0.4rem;
	}
	ul.items label {
		display: flex;
		gap: 0.7rem;
		align-items: center;
		background: var(--card);
		border: 1px solid var(--line);
		border-radius: 0.8rem;
		padding: 0.5rem 0.7rem;
		min-height: 3.1rem;
		cursor: pointer;
	}
	ul.items input[type='checkbox'] {
		width: 1.6rem;
		height: 1.6rem;
		accent-color: var(--accent);
		flex: none;
	}
	.txt {
		flex: 1;
		min-width: 0;
		overflow-wrap: anywhere;
		font-weight: 600;
	}
	.meta {
		display: block;
		font-size: 0.8rem;
		font-weight: 400;
		color: var(--muted);
	}
	/* strike + checkbox, never colour alone */
	li.ticked .txt {
		text-decoration: line-through;
		color: var(--muted);
	}

	details.staples {
		margin-top: 1.1rem;
		border-top: 1px solid var(--line);
	}
	details.staples summary {
		display: flex;
		gap: 0.4rem;
		align-items: center;
		padding: 0.7rem 0;
		margin: 0;
		cursor: pointer;
		list-style: none;
		min-height: 2.75rem;
	}
	details.staples summary::-webkit-details-marker {
		display: none;
	}
	details.staples summary :global(svg) {
		margin-left: auto;
		width: 1.1rem;
		height: 1.1rem;
		transition: transform 0.15s;
	}
	details.staples[open] summary :global(svg) {
		transform: rotate(180deg);
	}

	.addrow {
		display: flex;
		gap: 0.5rem;
		margin-top: 1.1rem;
	}
	.addrow input {
		flex: 1;
		min-width: 0;
		font: inherit;
		padding: 0.6rem 0.7rem;
		min-height: 3rem;
		border: 1.5px solid var(--line);
		border-radius: 0.7rem;
		background: var(--card);
		color: var(--ink);
		box-sizing: border-box;
	}
	.addrow button {
		display: flex;
		gap: 0.3rem;
		align-items: center;
		border: 1.5px solid var(--line);
		background: var(--card);
		color: var(--ink);
		border-radius: 0.7rem;
		padding: 0 1rem;
		min-height: 3rem;
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}
	.addrow button :global(svg) {
		width: 1.1rem;
		height: 1.1rem;
	}

	.unitsrow {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		margin-top: 1.1rem;
		font-size: 0.85rem;
		color: var(--muted);
	}
	.seg {
		display: inline-flex;
		border: 1.5px solid var(--line);
		border-radius: 0.7rem;
		overflow: hidden;
	}
	.seg button {
		display: flex;
		gap: 0.3rem;
		align-items: center;
		padding: 0.55rem 0.9rem;
		min-height: 2.75rem;
		font: inherit;
		font-size: 0.85rem;
		border: 0;
		background: var(--card);
		color: var(--muted);
		cursor: pointer;
	}
	/* D5: selected is filled plus a checkmark, never colour alone */
	.seg button[aria-pressed='true'] {
		background: var(--accent);
		color: var(--on-accent);
		font-weight: 600;
	}
	.seg button :global(svg) {
		width: 1em;
		height: 1em;
	}

	.donezone {
		margin-top: 1.4rem;
		border-top: 1px solid var(--line);
		padding-top: 1rem;
	}
	.confirm {
		background: var(--card);
		border: 1.5px solid var(--line);
		border-radius: 0.8rem;
		padding: 0.8rem;
	}
	.confirm p {
		margin: 0 0 0.7rem;
	}
	.row2 {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.5rem;
	}
	.editbtn {
		margin-top: 0.5rem;
	}
</style>
