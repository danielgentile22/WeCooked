<script lang="ts">
	import { enhance } from '$app/forms';

	let { form } = $props();
</script>

<svelte:head>
	<title>We Cooked</title>
</svelte:head>

<main>
	<h1>We Cooked</h1>
	<form method="POST" use:enhance>
		<!-- svelte-ignore a11y_autofocus -->
		<input
			type="password"
			name="password"
			autofocus
			autocomplete="current-password"
			aria-label="Password"
			required
		/>
		<button type="submit">Sign in</button>
		{#if form?.error}
			<p role="alert">{form.error}</p>
		{/if}
	</form>
</main>

<style>
	main {
		max-width: 20rem;
		margin: 30vh auto 0;
		padding: 0 1rem;
	}
	h1 {
		font-size: 1.4rem;
		text-align: center;
	}
	form {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		margin-top: 1.5rem;
	}
	input,
	button {
		font-size: inherit;
		padding: 0.65rem 0.8rem;
		border-radius: 0.5rem;
	}
	input {
		border: 1px solid light-dark(#ccc, #444);
		background: light-dark(#fff, #1c1c1e);
		color: inherit;
	}
	button {
		border: none;
		background: light-dark(#b45309, #f59e0b);
		color: light-dark(#fff, #2a1a00);
		font-weight: 600;
	}
	p[role='alert'] {
		margin: 0;
		text-align: center;
	}
</style>
