<script lang="ts">
	import { Check } from '@lucide/svelte';

	// D5: the one chip component app-wide. Selected state is fill PLUS checkmark,
	// never a color shift alone; the word is always visible.
	let {
		label,
		selected = false,
		onclick = undefined as (() => void) | undefined,
		quiet = false // read-only display chip (recipe view, browse rows)
	} = $props();
</script>

{#if onclick}
	<button type="button" class="chip" class:selected class:quiet aria-pressed={selected} {onclick}>
		{#if selected}<Check aria-hidden="true" />{/if}
		{label}
	</button>
{:else}
	<span class="chip" class:selected class:quiet>
		{#if selected}<Check aria-hidden="true" />{/if}
		{label}
	</span>
{/if}

<style>
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		min-height: 2.75rem; /* 44px targets */
		border: 1.5px solid var(--line);
		border-radius: 999px;
		padding: 0.3rem 0.8rem;
		font: inherit;
		font-size: 0.95rem;
		background: var(--card);
		color: var(--ink);
		cursor: default;
	}
	button.chip {
		cursor: pointer;
	}
	.selected {
		background: var(--accent);
		color: var(--on-accent);
		border-color: var(--accent);
		font-weight: 600;
	}
	.quiet {
		min-height: 1.9rem;
		padding: 0.1rem 0.6rem;
		font-size: 0.85rem;
		color: var(--muted);
	}
	.chip :global(svg) {
		width: 1em;
		height: 1em;
	}
</style>
