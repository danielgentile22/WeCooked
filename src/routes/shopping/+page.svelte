<svelte:head>
	<title>Shopping — We Cooked</title>
</svelte:head>

<main>
	<h1>Shopping</h1>
	<!-- D13 empty state; the real list is build-order phase 9 -->
	<p class="empty">Pick recipes to build a list</p>
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
	.empty {
		text-align: center;
		color: var(--muted);
		margin-top: 3rem;
	}
</style>
