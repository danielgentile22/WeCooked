<script lang="ts">
	import { TriangleAlert } from '@lucide/svelte';

	// D6: the one banner component. Inline, icon + text + optional action.
	let {
		text,
		role = 'alert' as 'alert' | 'status',
		icon = TriangleAlert,
		action = null as string | null,
		onaction = undefined as (() => void) | undefined
	} = $props();
	const Icon = $derived(icon);
</script>

<p class="banner" {role}>
	<Icon aria-hidden="true" />
	<span class="txt">{text}</span>
	{#if action && onaction}
		<button type="button" class="act" onclick={onaction}>{action}</button>
	{/if}
</p>

<style>
	.banner {
		display: flex;
		align-items: flex-start;
		gap: 0.6rem;
		margin: 0 0 0.7rem;
		padding: 0.7rem 0.9rem;
		border: 1px solid var(--line);
		/* Accent side border per the owner-approved D6 prototype banner */
		border-left: 4px solid var(--accent);
		border-radius: 0.6rem;
		background: var(--card);
		font-size: 0.95rem;
	}
	.banner :global(svg) {
		color: var(--accent);
		flex: none;
		width: 1.15em;
		height: 1.15em;
		margin-top: 0.15rem;
	}
	.txt {
		flex: 1;
	}
	.act {
		border: 0;
		background: none;
		color: var(--accent);
		font: inherit;
		font-weight: 600;
		white-space: nowrap;
		text-decoration: underline;
		cursor: pointer;
		min-height: 2.75rem;
		margin: -0.55rem 0;
	}
</style>
