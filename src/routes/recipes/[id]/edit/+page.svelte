<script lang="ts">
	import { enhance } from '$app/forms';
	import RecipeForm from '$lib/components/RecipeForm.svelte';
	import { otherUnits } from '$lib/tags';

	let { data, form } = $props();

	// The counterpart body seeds the form's toggle; while a reconvert is
	// pending or failed it may be stale, which the banner explains.
	const counterpart = $derived(data.recipe.bodies[otherUnits(data.recipe.source_units)]);

	// D6 tap-to-retry through the hidden form + use:enhance (repo convention),
	// so a fail(400) lands in `form` instead of vanishing into a fetch.
	let retryForm: HTMLFormElement | undefined = $state();
</script>

<svelte:head>
	<title>Edit: {data.recipe.title} · We Cooked</title>
</svelte:head>

<main>
	<header>
		<h1>Edit recipe</h1>
	</header>
	{#key data.recipe.id}
		<RecipeForm
			initial={{ ...data.recipe, counterpart }}
			draftKey="wc-draft:recipe:{data.recipe.id}"
			action="?/save"
			error={form?.error ?? null}
			reconvert={data.recipe.reconvert}
			onretry={() => retryForm?.requestSubmit()}
		/>
	{/key}
	<form method="POST" action="?/retry" use:enhance bind:this={retryForm} hidden></form>

	<!-- D10: destructive zone at the bottom. confirm() is the native-style sheet. -->
	<form
		class="danger"
		method="POST"
		action="/trash?/delete_recipe"
		onsubmit={(e) => {
			if (!confirm(`Delete “${data.recipe.title}”? You can restore it from Trash.`))
				e.preventDefault();
		}}
	>
		<input type="hidden" name="id" value={data.recipe.id} />
		<button>Delete recipe</button>
	</form>
</main>

<style>
	main {
		max-width: 44rem;
		margin: 0 auto;
		padding-top: 1rem;
	}
	header {
		padding: 0 1rem 0.25rem;
	}
	h1 {
		font-size: 1.4rem;
		margin: 0;
		letter-spacing: -0.01em;
	}
	.danger {
		margin: 2rem 1rem 6rem;
		padding-top: 1rem;
		border-top: 1px solid var(--line);
	}
	.danger button {
		width: 100%;
		min-height: 2.75rem;
		border: 1.5px solid var(--danger);
		border-radius: 0.7rem;
		background: none;
		color: var(--danger);
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}
</style>
