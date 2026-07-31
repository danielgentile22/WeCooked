<script lang="ts">
	import RecipeForm from '$lib/components/RecipeForm.svelte';

	let { data, form } = $props();
</script>

<svelte:head>
	<title>Edit: {data.recipe.title} — We Cooked</title>
</svelte:head>

<main>
	<header>
		<h1>Edit recipe</h1>
	</header>
	{#key data.recipe.id}
		<RecipeForm
			initial={data.recipe}
			draftKey="wc-draft:recipe:{data.recipe.id}"
			error={form?.error ?? null}
		/>
	{/key}
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
</style>
