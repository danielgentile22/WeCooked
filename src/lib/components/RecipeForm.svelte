<script lang="ts">
	import { enhance } from '$app/forms';
	import { Plus, X, ArrowUp, ArrowDown, Minus, TriangleAlert } from '@lucide/svelte';
	import Chip from './Chip.svelte';
	import {
		MEAL_TYPES,
		CUISINES,
		PROTEINS,
		EFFORTS,
		DAMAGES,
		type RecipeInput
	} from '$lib/tags';

	let {
		initial = null as Partial<RecipeInput> | null,
		draftKey, // ADR-038: sessionStorage key; recipe id when editing, fixed for manual
		error = null as string | null
	} = $props();

	const empty = (): RecipeInput => ({
		title: '',
		yield_count: 4,
		yield_unit: 'servings',
		prep_minutes: null,
		cook_minutes: null,
		source_text: null,
		source_url: null,
		notes: null,
		source_units: 'metric', // D15 default
		meal_types: [],
		cuisine: null,
		protein: null,
		effort: 'weeknight',
		damage: 'messy',
		ingredients: [{ heading: null, items: [''] }],
		steps: ['']
	});

	// Restore a draft silently if one exists, else seed from the recipe being
	// edited (ADR-038). Deliberately reads props once, before first render; the
	// edit page re-keys the component when the recipe changes.
	// svelte-ignore state_referenced_locally
	const stored = typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(draftKey);
	// svelte-ignore state_referenced_locally
	let data = $state<RecipeInput>(stored ? JSON.parse(stored) : { ...empty(), ...initial });

	// Written on every change, cleared on Save (ADR-038).
	$effect(() => {
		sessionStorage.setItem(draftKey, JSON.stringify(data));
	});

	function move<T>(arr: T[], i: number, delta: number) {
		const j = i + delta;
		if (j < 0 || j >= arr.length) return;
		[arr[i], arr[j]] = [arr[j], arr[i]];
	}
	const single = <T extends string>(cur: T | null, v: T): T | null => (cur === v ? null : v);
	function toggleMeal(v: (typeof MEAL_TYPES)[number]) {
		const i = data.meal_types.indexOf(v);
		if (i >= 0) data.meal_types.splice(i, 1);
		else data.meal_types.push(v);
	}
	function bumpYield(delta: number) {
		const next = Math.round((data.yield_count + delta) * 10) / 10;
		if (next > 0) data.yield_count = next;
	}

	// Show-all collapse for long tag groups (prototype verdict A note).
	const CUTOFF = 8;
	let expanded = $state<Record<string, boolean>>({});
	function visible<T extends string>(group: string, values: readonly T[], picked: T[]): T[] {
		if (expanded[group] || values.length <= CUTOFF) return [...values];
		return values.filter((v, i) => i < CUTOFF || picked.includes(v));
	}
</script>

<form
	method="POST"
	use:enhance={() =>
		async ({ result, update }) => {
			if (result.type === 'redirect') sessionStorage.removeItem(draftKey);
			await update();
		}}
>
	<input type="hidden" name="payload" value={JSON.stringify(data)} />

	<section>
		<label class="fld" for="title">Title</label>
		<input id="title" type="text" bind:value={data.title} required />
	</section>

	<section>
		<h2 class="sec">Yield</h2>
		<div class="row">
			<div class="stepper">
				<button type="button" aria-label="Decrease yield" onclick={() => bumpYield(-1)}>
					<Minus aria-hidden="true" />
				</button>
				<input
					class="count"
					type="number"
					min="0.1"
					step="0.1"
					inputmode="decimal"
					aria-label="Yield count"
					bind:value={data.yield_count}
				/>
				<button type="button" aria-label="Increase yield" onclick={() => bumpYield(1)}>
					<Plus aria-hidden="true" />
				</button>
			</div>
			<input
				type="text"
				aria-label="Yield unit"
				placeholder="servings"
				bind:value={data.yield_unit}
			/>
		</div>
	</section>

	<section>
		<h2 class="sec">Times</h2>
		<div class="row">
			<div>
				<label class="fld" for="prep">Prep minutes</label>
				<input id="prep" type="number" min="0" inputmode="numeric" bind:value={data.prep_minutes} />
			</div>
			<div>
				<label class="fld" for="cook">Cook minutes</label>
				<input id="cook" type="number" min="0" inputmode="numeric" bind:value={data.cook_minutes} />
			</div>
		</div>
	</section>

	<section>
		<h2 class="sec">Ingredients</h2>
		<p class="fld">Written in</p>
		<div class="seg" role="group" aria-label="Unit system the recipe is written in">
			{#each ['metric', 'us'] as u (u)}
				<button
					type="button"
					aria-pressed={data.source_units === u}
					onclick={() => (data.source_units = u as 'us' | 'metric')}
				>
					{u === 'us' ? 'US' : 'Metric'}
				</button>
			{/each}
		</div>
		{#each data.ingredients as group, gi (group)}
			<div class="grouphead">
				<input
					type="text"
					placeholder="Group heading (optional)"
					aria-label="Group heading"
					bind:value={group.heading}
				/>
				{#if data.ingredients.length > 1}
					<button
						type="button"
						class="ctlbtn"
						aria-label="Remove group"
						onclick={() => data.ingredients.splice(gi, 1)}
					>
						<X aria-hidden="true" />
					</button>
				{/if}
			</div>
			{#each group.items as _, i (i)}
				<div class="linewrap">
					<input type="text" aria-label="Ingredient line" bind:value={group.items[i]} />
					<div class="ctl">
						<button
							type="button"
							class="ctlbtn"
							aria-label="Move ingredient up"
							disabled={i === 0}
							onclick={() => move(group.items, i, -1)}
						>
							<ArrowUp aria-hidden="true" />
						</button>
						<button
							type="button"
							class="ctlbtn"
							aria-label="Move ingredient down"
							disabled={i === group.items.length - 1}
							onclick={() => move(group.items, i, 1)}
						>
							<ArrowDown aria-hidden="true" />
						</button>
						<span class="sp"></span>
						<button
							type="button"
							class="ctlbtn"
							aria-label="Remove ingredient"
							onclick={() => group.items.splice(i, 1)}
						>
							<X aria-hidden="true" />
						</button>
					</div>
				</div>
			{/each}
			<button type="button" class="addbtn" onclick={() => group.items.push('')}>
				<Plus aria-hidden="true" /> Add ingredient
			</button>
		{/each}
		<div>
			<button
				type="button"
				class="addbtn"
				onclick={() => data.ingredients.push({ heading: null, items: [''] })}
			>
				<Plus aria-hidden="true" /> Add group
			</button>
		</div>
	</section>

	<section>
		<h2 class="sec">Steps</h2>
		<p class="hint">Steps may be empty; a spice mix is a legal recipe.</p>
		{#each data.steps as _, i (i)}
			<div class="linewrap">
				<div class="steprow">
					<span class="stepnum">{i + 1}</span>
					<textarea rows="2" aria-label="Step {i + 1}" bind:value={data.steps[i]}></textarea>
				</div>
				<div class="ctl">
					<button
						type="button"
						class="ctlbtn"
						aria-label="Move step up"
						disabled={i === 0}
						onclick={() => move(data.steps, i, -1)}
					>
						<ArrowUp aria-hidden="true" />
					</button>
					<button
						type="button"
						class="ctlbtn"
						aria-label="Move step down"
						disabled={i === data.steps.length - 1}
						onclick={() => move(data.steps, i, 1)}
					>
						<ArrowDown aria-hidden="true" />
					</button>
					<span class="sp"></span>
					<button
						type="button"
						class="ctlbtn"
						aria-label="Remove step"
						onclick={() => data.steps.splice(i, 1)}
					>
						<X aria-hidden="true" />
					</button>
				</div>
			</div>
		{/each}
		<button type="button" class="addbtn" onclick={() => data.steps.push('')}>
			<Plus aria-hidden="true" /> Add step
		</button>
	</section>

	<section>
		<h2 class="sec">Tags</h2>

		<p class="fld">Meal type</p>
		<div class="chips">
			{#each visible('meal', MEAL_TYPES, data.meal_types) as v (v)}
				<Chip label={v} selected={data.meal_types.includes(v)} onclick={() => toggleMeal(v)} />
			{/each}
			{#if !expanded['meal'] && MEAL_TYPES.length > CUTOFF}
				<Chip label="Show all {MEAL_TYPES.length}" onclick={() => (expanded['meal'] = true)} />
			{/if}
		</div>

		<p class="fld">Cuisine</p>
		<div class="chips">
			{#each visible('cuisine', CUISINES, data.cuisine ? [data.cuisine] : []) as v (v)}
				<Chip
					label={v}
					selected={data.cuisine === v}
					onclick={() => (data.cuisine = single(data.cuisine, v))}
				/>
			{/each}
			{#if !expanded['cuisine'] && CUISINES.length > CUTOFF}
				<Chip label="Show all {CUISINES.length}" onclick={() => (expanded['cuisine'] = true)} />
			{/if}
		</div>

		<p class="fld">Protein</p>
		<div class="chips">
			{#each visible('protein', PROTEINS, data.protein ? [data.protein] : []) as v (v)}
				<Chip
					label={v}
					selected={data.protein === v}
					onclick={() => (data.protein = single(data.protein, v))}
				/>
			{/each}
			{#if !expanded['protein'] && PROTEINS.length > CUTOFF}
				<Chip label="Show all {PROTEINS.length}" onclick={() => (expanded['protein'] = true)} />
			{/if}
		</div>

		<p class="fld">Effort (required)</p>
		<div class="chips">
			{#each EFFORTS as v (v)}
				<Chip label={v} selected={data.effort === v} onclick={() => (data.effort = v)} />
			{/each}
		</div>

		<p class="fld">Damage (required)</p>
		<div class="chips">
			{#each DAMAGES as v (v)}
				<Chip label={v} selected={data.damage === v} onclick={() => (data.damage = v)} />
			{/each}
		</div>
	</section>

	<section>
		<h2 class="sec">Source</h2>
		<label class="fld" for="srctext">Where it came from</label>
		<input
			id="srctext"
			type="text"
			placeholder="Ottolenghi, Simple, p.112"
			bind:value={data.source_text}
		/>
		<label class="fld gap" for="srcurl">URL</label>
		<input id="srcurl" type="url" bind:value={data.source_url} />
	</section>

	<section>
		<label class="fld" for="notes">Notes</label>
		<textarea id="notes" rows="3" bind:value={data.notes}></textarea>
	</section>

	<section>
		{#if error}
			<p class="banner" role="alert"><TriangleAlert aria-hidden="true" /> {error}</p>
		{/if}
		<button type="submit" class="save">Save recipe</button>
	</section>
</form>

<style>
	form {
		padding-bottom: 6rem; /* clear the tab bar */
	}
	section {
		background: var(--card);
		margin: 0.6rem 0.75rem;
		border: 1px solid var(--line);
		border-radius: 1rem;
		padding: 0.9rem;
	}
	.sec {
		font-size: 1.05rem;
		margin: 0 0 0.6rem;
	}
	.fld {
		display: block;
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--muted);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		margin: 0 0 0.3rem;
	}
	.fld.gap {
		margin-top: 0.6rem;
	}
	.hint {
		font-size: 0.85rem;
		color: var(--muted);
		margin: 0 0 0.5rem;
	}
	input[type='text'],
	input[type='url'],
	input[type='number'],
	textarea {
		width: 100%;
		box-sizing: border-box;
		font: inherit;
		padding: 0.55rem 0.6rem;
		border: 1px solid var(--line);
		border-radius: 0.5rem;
		background: var(--card);
		color: var(--ink);
		min-height: 2.75rem;
	}
	textarea {
		resize: vertical;
	}
	.row {
		display: flex;
		gap: 0.6rem;
		align-items: end;
	}
	.row > * {
		flex: 1;
	}

	.stepper {
		display: inline-flex;
		align-items: center;
		border: 1.5px solid var(--line);
		border-radius: 999px;
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
		color: inherit;
		cursor: pointer;
	}
	.stepper .count {
		width: 3.2rem;
		min-height: 0;
		border: 0;
		text-align: center;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		-moz-appearance: textfield;
		appearance: textfield;
	}

	.seg {
		display: inline-flex;
		border: 1.5px solid var(--line);
		border-radius: 0.7rem;
		overflow: hidden;
		margin-bottom: 0.6rem;
	}
	.seg button {
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

	.grouphead {
		display: flex;
		gap: 0.35rem;
		align-items: center;
		margin: 1rem 0 0.2rem;
	}
	.grouphead input {
		flex: 1;
		font-style: italic;
	}
	.linewrap {
		margin: 0.5rem 0 0.9rem;
	}
	.steprow {
		display: flex;
		gap: 0.4rem;
		align-items: flex-start;
	}
	.stepnum {
		flex: none;
		width: 1.4rem;
		text-align: right;
		font-weight: 700;
		color: var(--accent);
		padding-top: 0.55rem;
		font-variant-numeric: tabular-nums;
	}
	.ctl {
		display: flex;
		gap: 0.35rem;
		margin-top: 0.35rem;
	}
	.ctl .sp {
		flex: 1;
	}
	.ctlbtn {
		width: 2.75rem;
		height: 2.75rem;
		flex: none;
		display: grid;
		place-items: center;
		border: 1px solid var(--line);
		border-radius: 0.5rem;
		background: var(--card);
		color: inherit;
		cursor: pointer;
	}
	.ctlbtn:disabled {
		opacity: 0.35;
	}
	.addbtn {
		margin-top: 0.25rem;
		padding: 0.55rem 0.9rem;
		min-height: 2.75rem;
		font: inherit;
		font-size: 0.95rem;
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		border: 1px dashed var(--muted);
		border-radius: 0.5rem;
		background: var(--card);
		color: inherit;
		cursor: pointer;
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin: 0.35rem 0 1rem;
	}
	.banner {
		display: flex;
		align-items: flex-start;
		gap: 0.6rem;
		margin: 0 0 0.7rem;
		padding: 0.7rem 0.9rem;
		border: 1px solid var(--line);
		border-left: 4px solid var(--accent);
		border-radius: 0.6rem;
		font-size: 0.95rem;
	}
	.banner :global(svg) {
		color: var(--accent);
		flex: none;
		width: 1.15em;
		height: 1.15em;
		margin-top: 0.15rem;
	}
	.save {
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
	.ctlbtn :global(svg),
	.addbtn :global(svg),
	.stepper :global(svg) {
		width: 1.15em;
		height: 1.15em;
	}
</style>
