<script lang="ts">
	import RecipeForm from '$lib/components/RecipeForm.svelte';

	let { form } = $props();
</script>

<svelte:head>
	<title>New recipe — We Cooked</title>
</svelte:head>

<main>
	<header>
		<h1>New recipe</h1>
	</header>
	<RecipeForm draftKey="wc-draft:manual" error={form?.error ?? null} />
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
