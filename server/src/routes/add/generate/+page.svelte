<script lang="ts">
	import { enhance } from '$app/forms';
	import { Minus, Plus, WandSparkles } from '@lucide/svelte';
	import Banner from '$lib/components/Banner.svelte';

	let { form } = $props();
	let submitting = $state(false);

	// GenerateModel.yieldRange: the steppers clamp, the field keeps what was
	// typed, and the server refuses anything out of range.
	const MIN = 1;
	const MAX = 100;
	let yieldCount = $state(4);
	const clamp = (n: number) => Math.min(Math.max(n, MIN), MAX);
	function step(delta: number) {
		yieldCount = clamp((Number.isInteger(yieldCount) ? yieldCount : 4) + delta);
	}
</script>

<svelte:head>
	<title>Describe what you want · We Cooked</title>
</svelte:head>

<main>
	<header>
		<h1>Describe what you want</h1>
	</header>

	<form
		method="POST"
		use:enhance={() => {
			submitting = true;
			return async ({ update }) => {
				submitting = false;
				await update();
			};
		}}
	>
		<section>
			<textarea
				name="description"
				rows="6"
				maxlength="1000"
				placeholder="What is in the fridge, how long you have, how much mess you can take"
				aria-label="Description"
				value={form?.description ?? ''}
			></textarea>
		</section>

		<section>
			<h2>Yield</h2>
			<div class="yield">
				<button type="button" class="stepbtn" aria-label="Decrease yield" onclick={() => step(-1)}>
					<Minus aria-hidden="true" />
				</button>
				<input
					type="number"
					name="yield_count"
					inputmode="numeric"
					min={MIN}
					max={MAX}
					step="1"
					required
					aria-label="Yield count"
					bind:value={yieldCount}
				/>
				<button type="button" class="stepbtn" aria-label="Increase yield" onclick={() => step(1)}>
					<Plus aria-hidden="true" />
				</button>
				<span class="unit">servings</span>
			</div>
		</section>

		{#if form?.error}
			<Banner text={form.error} />
		{/if}

		<button type="submit" class="generate" disabled={submitting}>
			<WandSparkles aria-hidden="true" />
			{submitting ? 'Starting…' : 'Generate'}
		</button>
	</form>
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
		font-weight: 600;
		color: var(--muted);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		margin: 0 0 0.5rem;
	}
	section {
		background: var(--card);
		border: 1px solid var(--line);
		border-radius: 1rem;
		padding: 0.9rem;
		margin-bottom: 0.75rem;
	}
	textarea {
		width: 100%;
		box-sizing: border-box;
		font: inherit;
		padding: 0.55rem 0.6rem;
		border: 1px solid var(--line);
		border-radius: 0.5rem;
		background: var(--card);
		color: var(--ink);
		resize: vertical;
		display: block;
	}
	.yield {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.stepbtn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.75rem;
		height: 2.75rem;
		border: 1px solid var(--line);
		border-radius: 0.6rem;
		background: none;
		color: var(--ink);
		cursor: pointer;
	}
	.stepbtn :global(svg) {
		width: 1.1em;
		height: 1.1em;
	}
	input[type='number'] {
		width: 4.5rem;
		min-height: 2.75rem;
		box-sizing: border-box;
		text-align: center;
		font: inherit;
		font-weight: 600;
		border: 1px solid var(--line);
		border-radius: 0.6rem;
		background: var(--bg);
		color: var(--ink);
	}
	.unit {
		color: var(--muted);
		font-size: 0.95rem;
	}
	.generate {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
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
	.generate:disabled {
		opacity: 0.6;
	}
	.generate :global(svg) {
		width: 1.2em;
		height: 1.2em;
	}
	@media (min-width: 900px) {
		main {
			padding: 1.5rem 2rem 3rem;
		}
		textarea {
			min-height: 11rem;
		}
	}
</style>
