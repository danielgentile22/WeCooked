import { describe, expect, it } from 'vitest';
import { loadedBodies, payload, swapBodies, type FormState } from './recipeForm';
import type { BodyText } from './tags';

// One case per payload branch in iOS's EditorPayloadTests (validation, its
// incomplete case, stays in the component): a saved
// recipe with a metric source body and a known-good US counterpart.
const metric: BodyText = {
	ingredients: [{ heading: null, items: ['200 g flour', '2 eggs'] }],
	steps: ['Mix.', 'Bake.']
};
const us: BodyText = {
	ingredients: [{ heading: null, items: ['1 2/3 cups flour', '2 eggs'] }],
	steps: ['Mix.', 'Bake.']
};
const saved = (): FormState => ({
	title: 'Cake',
	yield_count: 4,
	yield_unit: 'servings',
	prep_minutes: 10,
	cook_minutes: 30,
	source_text: null,
	source_url: null,
	notes: null,
	source_units: 'metric',
	meal_types: [],
	cuisine: null,
	protein: null,
	effort: 'quick',
	damage: 'tidy',
	...structuredClone(metric),
	images: [
		{ id: 'img1', url: 'https://x/1', source_url: null },
		{ id: 'img2', url: 'https://x/2', source_url: null }
	],
	cover_image_id: 'img1',
	shown_units: 'metric',
	other: structuredClone(us)
});
const loaded = loadedBodies(saved());
const edit = (b: { ingredients: BodyText['ingredients'] }) =>
	(b.ingredients[0].items[0] += ' (edited)');
const send = (f: FormState, editing = true) => payload(f, loaded, editing);

describe('recipe form payload', () => {
	it('sends the source and the known-good counterpart when neither changed', () => {
		const p = send(saved());
		expect(p.source_units).toBe('metric');
		expect(p.ingredients).toEqual(metric.ingredients);
		expect(p.counterpart).toEqual(us);
	});

	it('nulls the counterpart when only the source changed, so the server reconverts', () => {
		const f = saved();
		edit(f);
		const p = send(f);
		expect(p.source_units).toBe('metric');
		expect(p.counterpart).toBeNull();
		expect(p.ingredients[0].items[0]).toMatch(/\(edited\)$/);
	});

	it('submits the other body as the source, in its units, when only it changed', () => {
		const f = saved();
		edit(f.other!);
		const p = send(f);
		expect(p.source_units).toBe('us');
		expect(p.counterpart).toBeNull();
		expect(p.ingredients).toEqual(f.other!.ingredients);
	});

	it('submits the visible body with its units when both changed', () => {
		const f = saved();
		edit(f);
		edit(f.other!);
		expect(send(f).source_units).toBe('metric');
		swapBodies(f, 'us');
		const p = send(f);
		expect(p.source_units).toBe('us');
		expect(p.ingredients).toEqual(f.ingredients);
		expect(p.counterpart).toBeNull();
	});

	it('changes nothing when units are toggled without typing', () => {
		const f = saved();
		const before = send(f);
		swapBodies(f, 'us');
		swapBodies(f, 'metric');
		expect(send(f)).toEqual(before);
		swapBodies(f, 'us');
		const viewedInUS = send(f);
		expect(viewedInUS.source_units).toBe('metric');
		expect(viewedInUS.counterpart).not.toBeNull();
	});

	it('opens in the device preference without making it the baseline', () => {
		const f = saved();
		swapBodies(f, 'us'); // withDevicePref applies to the draft only
		const p = send(f);
		expect(p.source_units).toBe('metric');
		expect(p.counterpart).toEqual(us);
	});

	it('does not count whitespace-only edits as edits', () => {
		const f = saved();
		f.ingredients[0].items[0] += '   ';
		f.steps.push('  ');
		expect(send(f).counterpart).not.toBeNull();
	});

	it('sends a new recipe as shown, with no counterpart, in the toggled units', () => {
		const f: FormState = { ...saved(), source_units: 'us', shown_units: 'us', other: null };
		const p = send(f, false);
		expect(p.source_units).toBe('us');
		expect(p.counterpart).toBeNull();
	});

	it('carries image ids and the cover, and no display-only fields', () => {
		const p = send(saved());
		expect(p.image_ids).toEqual(['img1', 'img2']);
		expect(p.cover_image_id).toBe('img1');
		expect(p).not.toHaveProperty('images');
		expect(p).not.toHaveProperty('other');
		expect(p).not.toHaveProperty('shown_units');
	});
});
