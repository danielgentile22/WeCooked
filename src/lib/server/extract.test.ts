import { describe, expect, it } from 'vitest';
import { draftToInput, hasRecipe, type RecipeDraft } from '$lib/extract';
import { validateInput } from './recipes';
import type { RecipeInput } from '$lib/tags';

const draft = (over: Partial<RecipeDraft> = {}): RecipeDraft => ({
	title: 'Shakshuka',
	yield_count: 2,
	yield_unit: 'servings',
	prep_minutes: 10,
	cook_minutes: 25,
	source_text: null,
	body: {
		source_units: 'metric',
		us: {
			ingredients: [{ heading: null, items: ['14 oz tinned tomatoes', '4 eggs'] }],
			steps: ['Simmer the tomatoes.', 'Crack in the eggs.']
		},
		metric: {
			ingredients: [{ heading: null, items: ['400 g tinned tomatoes', '4 eggs'] }],
			steps: ['Simmer the tomatoes.', 'Crack in the eggs.']
		}
	},
	tags: {
		meal_type: ['breakfast', 'dinner'],
		cuisine: 'middle-eastern',
		protein: 'egg',
		effort: 'quick',
		damage: 'tidy'
	},
	damage_reasoning: '1 pan + board and knife = 2 points, tidy.',
	extraction_warnings: [],
	...over
});

describe('draftToInput (SPEC 6.5: result_json seeds the review form)', () => {
	it('picks the body matching source_units and maps tags through', () => {
		const input = draftToInput(draft());
		expect(input.source_units).toBe('metric');
		expect(input.ingredients).toEqual([
			{ heading: null, items: ['400 g tinned tomatoes', '4 eggs'] }
		]);
		expect(input.steps).toEqual(['Simmer the tomatoes.', 'Crack in the eggs.']);
		expect(input.meal_types).toEqual(['breakfast', 'dinner']);
		expect(input.cuisine).toBe('middle-eastern');
		expect(input.effort).toBe('quick');
		expect(input.damage).toBe('tidy');
	});

	it('produces something the save path accepts as-is', () => {
		const input = draftToInput(draft()) as RecipeInput;
		expect(() => validateInput({ ...input, image_ids: [], cover_image_id: null })).not.toThrow();
	});

	it('picks the us body when the source is us', () => {
		const d = draft();
		d.body.source_units = 'us';
		expect(draftToInput(d).ingredients![0].items[0]).toBe('14 oz tinned tomatoes');
	});
});

describe('hasRecipe (no_recipe_found detection)', () => {
	it('rejects a draft whose source body has no ingredient lines', () => {
		const d = draft();
		d.body.metric.ingredients = [{ heading: null, items: ['  '] }];
		expect(hasRecipe(d)).toBe(false);
	});

	it('accepts a normal draft', () => {
		expect(hasRecipe(draft())).toBe(true);
	});
});
