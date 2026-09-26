<script lang="ts">
	import { enhance } from '$app/forms';
	import { Camera, Keyboard, LoaderCircle, Sparkles, X } from '@lucide/svelte';
	import Banner from '$lib/components/Banner.svelte';
	import { uploadPhoto, type FormImage } from '$lib/images';

	let { form } = $props();
	let submitting = $state(false);

	// SPEC 7.1 photo path: camera or library (accept="image/*" gives iOS the
	// chooser), multiple pages per extraction, uploaded on pick (ADR-024) so
	// the extract submit only carries ids.
	let fileInput: HTMLInputElement | undefined = $state();
	let photos = $state<FormImage[]>([]);
	let uploading = $state(0);
	let uploadError = $state<string | null>(null);
	async function onPickFiles() {
		const files = [...(fileInput?.files ?? [])];
		if (fileInput) fileInput.value = '';
		uploadError = null;
		uploading += files.length;
		for (const file of files) {
			try {
				photos.push(await uploadPhoto(file, 'capture'));
			} catch {
				uploadError = 'Could not upload a photo. Check the connection and try again.';
			}
			uploading -= 1;
		}
	}
	// Removal only drops the id from the list. The uploaded row stays behind as
	// an orphan (recipe_id NULL, referenced by no job); sweep them if R2 fills.
	function removePhoto(id: string) {
		photos = photos.filter((p) => p.id !== id);
	}
</script>

<svelte:head>
	<title>Add · We Cooked</title>
</svelte:head>

<main>
	<header>
		<h1>Add a recipe</h1>
	</header>

	<!-- D3: paste box first. -->
	<section>
		<form
			method="POST"
			action="?/paste"
			use:enhance={() => {
				submitting = true;
				return async ({ update }) => {
					submitting = false;
					await update();
				};
			}}
		>
			<textarea
				name="text"
				rows="7"
				placeholder="Paste recipe text here"
				aria-label="Recipe text"
			></textarea>
			{#if form?.error}
				<Banner text={form.error} />
			{/if}
			<button type="submit" class="extract" disabled={submitting}>
				<Sparkles aria-hidden="true" />
				{submitting ? 'Starting…' : 'Extract'}
			</button>
		</form>
	</section>

	<section>
		{#if photos.length > 0}
			<div class="strip" role="group" aria-label="Cookbook pages, in order">
				{#each photos as p (p.id)}
					<div class="thumbwrap">
						<img src={p.url} alt="Cookbook page" />
						<button type="button" class="remove" aria-label="Remove photo" onclick={() => removePhoto(p.id)}>
							<X aria-hidden="true" />
						</button>
					</div>
				{/each}
			</div>
		{/if}
		{#if uploadError || form?.photoError}
			<Banner text={uploadError ?? form?.photoError ?? ''} />
		{/if}
		<input
			bind:this={fileInput}
			type="file"
			accept="image/*"
			multiple
			hidden
			onchange={onPickFiles}
		/>
		<button type="button" class="photo" onclick={() => fileInput?.click()} disabled={uploading > 0}>
			{#if uploading > 0}
				<LoaderCircle class="spin" aria-hidden="true" /> Uploading…
			{:else}
				<Camera aria-hidden="true" />
				{photos.length > 0 ? 'Add another page' : 'Photograph a cookbook'}
			{/if}
		</button>
		{#if photos.length > 0}
			<form
				method="POST"
				action="?/photos"
				use:enhance={() => {
					submitting = true;
					return async ({ update }) => {
						submitting = false;
						await update();
					};
				}}
			>
				<input type="hidden" name="image_ids" value={JSON.stringify(photos.map((p) => p.id))} />
				<button type="submit" class="extract" disabled={submitting || uploading > 0}>
					<Sparkles aria-hidden="true" />
					{submitting ? 'Starting…' : `Extract ${photos.length === 1 ? 'this page' : `these ${photos.length} pages`}`}
				</button>
			</form>
		{/if}
	</section>

	<section>
		<a class="manual" href="/recipes/new"><Keyboard aria-hidden="true" /> Type it in myself</a>
	</section>
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
		margin-bottom: 0.6rem;
	}
	.extract,
	.manual,
	.photo {
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
		text-decoration: none;
		cursor: pointer;
	}
	.photo {
		background: none;
		border: 1px solid var(--line);
		color: var(--ink);
	}
	.extract:disabled,
	.photo:disabled {
		opacity: 0.6;
	}
	.extract :global(svg),
	.manual :global(svg),
	.photo :global(svg) {
		width: 1.2em;
		height: 1.2em;
	}
	.photo :global(.spin) {
		animation: spin 1.2s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	.strip {
		display: flex;
		gap: 0.5rem;
		overflow-x: auto;
		margin-bottom: 0.6rem;
	}
	.thumbwrap {
		position: relative;
		flex: none;
	}
	.thumbwrap img {
		width: 5.5rem;
		height: 5.5rem;
		object-fit: cover;
		border-radius: 0.5rem;
		border: 1px solid var(--line);
		display: block;
	}
	.remove {
		position: absolute;
		top: 0.2rem;
		right: 0.2rem;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		border: 0;
		border-radius: 50%;
		background: rgb(0 0 0 / 55%);
		color: #fff;
		cursor: pointer;
	}
	.remove :global(svg) {
		width: 0.9em;
		height: 0.9em;
	}
	.photo + form .extract {
		margin-top: 0.6rem;
	}
</style>
