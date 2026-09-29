// Seeds a running local server with six varied recipes so the simulator has
// something to browse. Idempotent: a title already listed is skipped.
//
//   cd server && SEED_PASSWORD=<pw> node scripts/seed-local.mjs
//   cd server && node scripts/seed-local.mjs --password <pw>
//
// Photos are not seeded. Run the dev server with IMAGE_STORE=local before
// uploading any: otherwise uploads reach the production R2 bucket, whose
// credentials the dev .env carries.

const BASE = process.env.SEED_BASE ?? 'http://localhost:5173/api/v1';

function passwordFromArgs() {
	const i = process.argv.indexOf('--password');
	if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
	return process.env.SEED_PASSWORD ?? null;
}

async function api(method, path, body, token) {
	const headers = { 'Content-Type': 'application/json' };
	if (token) headers.Authorization = `Bearer ${token}`;
	const res = await fetch(BASE + path, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	const text = await res.text();
	let json = null;
	try {
		json = JSON.parse(text);
	} catch {
		json = null;
	}
	if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${json?.error ?? text}`);
	return json;
}

async function login(password) {
	const { token } = await api('POST', '/login', { password });
	return token;
}

function recipe(fields) {
	return {
		title: fields.title,
		yield_count: fields.yield_count,
		yield_unit: fields.yield_unit ?? 'servings',
		prep_minutes: fields.prep_minutes ?? null,
		cook_minutes: fields.cook_minutes ?? null,
		source_text: fields.source_text ?? null,
		source_url: fields.source_url ?? null,
		notes: fields.notes ?? null,
		source_units: fields.source_units ?? 'metric',
		meal_types: fields.meal_types,
		cuisine: fields.cuisine ?? null,
		protein: fields.protein ?? null,
		effort: fields.effort,
		damage: fields.damage,
		ingredients: fields.ingredients,
		steps: fields.steps,
		counterpart: fields.counterpart,
		image_ids: [],
		cover_image_id: null
	};
}

const RECIPES = [
	recipe({
		title: 'Weeknight chicken thighs with lemon and orzo',
		yield_count: 4,
		prep_minutes: 10,
		cook_minutes: 35,
		source_units: 'metric',
		meal_types: ['dinner'],
		cuisine: 'greek',
		protein: 'chicken',
		effort: 'weeknight',
		damage: 'messy',
		ingredients: [
			{
				heading: null,
				items: [
					'8 boneless chicken thighs (about 900 g)',
					'2 tbsp olive oil',
					'1 onion, finely chopped',
					'3 garlic cloves, sliced',
					'300 g orzo',
					'750 ml chicken stock',
					'1 lemon, zest and juice',
					'100 g feta, crumbled'
				]
			}
		],
		steps: [
			'Season the thighs and brown them in the oil in a wide pan over high heat, 4 minutes a side. Set aside.',
			'Soften the onion and garlic in the same pan for 5 minutes.',
			'Stir in the orzo, then the stock and lemon zest. Nestle the chicken on top.',
			'Simmer covered for 15 minutes until the orzo is tender and the chicken cooked through.',
			'Finish with the lemon juice and feta.'
		],
		counterpart: {
			ingredients: [
				{
					heading: null,
					items: [
						'8 boneless chicken thighs (about 2 lb)',
						'2 tbsp olive oil',
						'1 onion, finely chopped',
						'3 garlic cloves, sliced',
						'1 1/2 cups orzo',
						'3 cups chicken stock',
						'1 lemon, zest and juice',
						'3/4 cup crumbled feta'
					]
				}
			],
			steps: [
				'Season the thighs and brown them in the oil in a wide pan over high heat, 4 minutes a side. Set aside.',
				'Soften the onion and garlic in the same pan for 5 minutes.',
				'Stir in the orzo, then the stock and lemon zest. Nestle the chicken on top.',
				'Simmer covered for 15 minutes until the orzo is tender and the chicken cooked through.',
				'Finish with the lemon juice and feta.'
			]
		}
	}),
	recipe({
		title: 'Shakshuka',
		yield_count: 2,
		prep_minutes: 10,
		cook_minutes: 25,
		source_text: 'Serious Eats',
		source_url:
			'https://www.seriouseats.com/shakshuka-north-african-shirred-eggs-tomato-sauce-recipe',
		notes: 'Serve with bread. Leftover sauce keeps three days.',
		source_units: 'metric',
		meal_types: ['breakfast', 'dinner'],
		cuisine: 'middle-eastern',
		protein: 'egg',
		effort: 'quick',
		damage: 'tidy',
		ingredients: [
			{
				heading: null,
				items: [
					'3 tbsp olive oil',
					'1 onion, sliced',
					'1 red pepper, sliced',
					'3 garlic cloves, sliced',
					'1 tsp ground cumin',
					'800 g tinned whole tomatoes',
					'4 eggs',
					'Handful of coriander'
				]
			}
		],
		steps: [
			'Cook the onion and pepper in the oil over medium heat until soft, about 10 minutes.',
			'Add the garlic and cumin for a minute, then crush in the tomatoes and simmer for 10 minutes.',
			'Make four wells, crack in the eggs, cover and cook until the whites set, about 5 minutes.',
			'Scatter the coriander over and serve from the pan.'
		],
		counterpart: {
			ingredients: [
				{
					heading: null,
					items: [
						'3 tbsp olive oil',
						'1 onion, sliced',
						'1 red bell pepper, sliced',
						'3 garlic cloves, sliced',
						'1 tsp ground cumin',
						'28 oz canned whole tomatoes',
						'4 eggs',
						'Handful of cilantro'
					]
				}
			],
			steps: [
				'Cook the onion and pepper in the oil over medium heat until soft, about 10 minutes.',
				'Add the garlic and cumin for a minute, then crush in the tomatoes and simmer for 10 minutes.',
				'Make four wells, crack in the eggs, cover and cook until the whites set, about 5 minutes.',
				'Scatter the cilantro over and serve from the pan.'
			]
		}
	}),
	recipe({
		title: 'Sunday ragù',
		yield_count: 8,
		prep_minutes: 30,
		cook_minutes: 240,
		source_units: 'metric',
		meal_types: ['dinner'],
		cuisine: 'italian',
		protein: 'beef',
		effort: 'project',
		damage: 'carnage',
		ingredients: [
			{
				heading: 'Soffritto',
				items: [
					'2 onions, finely diced',
					'2 carrots, finely diced',
					'2 celery sticks, finely diced',
					'60 ml olive oil'
				]
			},
			{
				heading: 'Sauce',
				items: [
					'1 kg beef chuck, cut into 4 cm pieces',
					'250 ml red wine',
					'800 g tinned whole tomatoes',
					'500 ml beef stock',
					'2 bay leaves'
				]
			}
		],
		steps: [
			'Brown the beef in batches in a heavy pot. Take it out.',
			'Cook the soffritto in the oil over low heat for 20 minutes, until sweet and soft.',
			'Return the beef, pour in the wine and let it bubble down by half.',
			'Add the tomatoes, stock and bay. Cover and cook at 150 C for 3 to 4 hours, until the beef falls apart.',
			'Shred the beef into the sauce and season. Serve over pappardelle.'
		],
		counterpart: {
			ingredients: [
				{
					heading: 'Soffritto',
					items: [
						'2 onions, finely diced',
						'2 carrots, finely diced',
						'2 celery stalks, finely diced',
						'1/4 cup olive oil'
					]
				},
				{
					heading: 'Sauce',
					items: [
						'2 1/4 lb beef chuck, cut into 1 1/2 inch pieces',
						'1 cup red wine',
						'28 oz canned whole tomatoes',
						'2 cups beef stock',
						'2 bay leaves'
					]
				}
			],
			steps: [
				'Brown the beef in batches in a heavy pot. Take it out.',
				'Cook the soffritto in the oil over low heat for 20 minutes, until sweet and soft.',
				'Return the beef, pour in the wine and let it bubble down by half.',
				'Add the tomatoes, stock and bay. Cover and cook at 300 F for 3 to 4 hours, until the beef falls apart.',
				'Shred the beef into the sauce and season. Serve over pappardelle.'
			]
		}
	}),
	recipe({
		title: 'Buttermilk pancakes',
		yield_count: 12,
		yield_unit: 'pancakes',
		prep_minutes: 10,
		cook_minutes: 20,
		source_text: "Grandma's card",
		source_units: 'us',
		meal_types: ['breakfast'],
		cuisine: 'american',
		protein: 'egg',
		effort: 'quick',
		damage: 'messy',
		ingredients: [
			{
				heading: null,
				items: [
					'2 cups all-purpose flour',
					'2 tbsp sugar',
					'2 tsp baking powder',
					'1 tsp baking soda',
					'1/2 tsp salt',
					'2 cups buttermilk',
					'2 eggs',
					'4 tbsp melted butter'
				]
			}
		],
		steps: [
			'Whisk the dry ingredients together in a large bowl.',
			'Whisk the buttermilk, eggs and butter in another bowl, then fold into the dry mix. Lumps are fine.',
			'Ladle 1/4 cup per pancake onto a medium-hot buttered pan. Flip when bubbles burst on top.',
			'Keep warm in a low oven while you cook the rest.'
		],
		counterpart: {
			ingredients: [
				{
					heading: null,
					items: [
						'250 g plain flour',
						'25 g sugar',
						'2 tsp baking powder',
						'1 tsp bicarbonate of soda',
						'1/2 tsp salt',
						'475 ml buttermilk',
						'2 eggs',
						'60 g melted butter'
					]
				}
			],
			steps: [
				'Whisk the dry ingredients together in a large bowl.',
				'Whisk the buttermilk, eggs and butter in another bowl, then fold into the dry mix. Lumps are fine.',
				'Ladle 60 ml per pancake onto a medium-hot buttered pan. Flip when bubbles burst on top.',
				'Keep warm in a low oven while you cook the rest.'
			]
		}
	}),
	recipe({
		title:
			'Slow-roasted salmon with fennel, citrus and chiles, the one from the back of the magazine that everyone asks about',
		yield_count: 4,
		prep_minutes: 15,
		cook_minutes: 40,
		source_units: 'metric',
		meal_types: ['dinner'],
		cuisine: 'american',
		protein: 'fish',
		effort: 'weeknight',
		damage: 'tidy',
		ingredients: [
			{
				heading: null,
				items: [
					'1 side of salmon (about 900 g), skin on',
					'1 fennel bulb, thinly sliced',
					'1 orange, thinly sliced',
					'1 lemon, thinly sliced',
					'2 red chiles, sliced',
					'120 ml olive oil',
					'Flaky salt'
				]
			}
		],
		steps: [
			'Heat the oven to 135 C.',
			'Lay the fennel, orange, lemon and chiles in a roasting tin. Set the salmon on top and pour the oil over everything.',
			'Roast for 35 to 40 minutes, until the salmon flakes but is still pink in the middle.',
			'Season with flaky salt and spoon the oil and citrus over each portion.'
		],
		counterpart: {
			ingredients: [
				{
					heading: null,
					items: [
						'1 side of salmon (about 2 lb), skin on',
						'1 fennel bulb, thinly sliced',
						'1 orange, thinly sliced',
						'1 lemon, thinly sliced',
						'2 red chiles, sliced',
						'1/2 cup olive oil',
						'Flaky salt'
					]
				}
			],
			steps: [
				'Heat the oven to 275 F.',
				'Lay the fennel, orange, lemon and chiles in a roasting pan. Set the salmon on top and pour the oil over everything.',
				'Roast for 35 to 40 minutes, until the salmon flakes but is still pink in the middle.',
				'Season with flaky salt and spoon the oil and citrus over each portion.'
			]
		}
	}),
	recipe({
		title: 'Chickpea and spinach curry',
		yield_count: 6,
		prep_minutes: 15,
		cook_minutes: 30,
		source_units: 'metric',
		meal_types: ['dinner', 'lunch'],
		cuisine: 'indian',
		protein: 'beans',
		effort: 'weeknight',
		damage: 'tidy',
		ingredients: [
			{
				heading: null,
				items: [
					'2 tbsp vegetable oil',
					'1 onion, chopped',
					'2 tbsp curry paste',
					'800 g tinned chickpeas, drained',
					'400 ml coconut milk',
					'400 g tinned chopped tomatoes',
					'200 g spinach'
				]
			}
		],
		steps: [
			'Fry the onion in the oil until golden, about 8 minutes.',
			'Stir in the curry paste and cook for a minute.',
			'Add the chickpeas, coconut milk and tomatoes. Simmer for 20 minutes.',
			'Wilt in the spinach and season. Serve with rice.'
		],
		counterpart: {
			ingredients: [
				{
					heading: null,
					items: [
						'2 tbsp vegetable oil',
						'1 onion, chopped',
						'2 tbsp curry paste',
						'2 cans (15 oz each) chickpeas, drained',
						'1 can (13.5 oz) coconut milk',
						'1 can (14 oz) diced tomatoes',
						'7 oz spinach'
					]
				}
			],
			steps: [
				'Fry the onion in the oil until golden, about 8 minutes.',
				'Stir in the curry paste and cook for a minute.',
				'Add the chickpeas, coconut milk and tomatoes. Simmer for 20 minutes.',
				'Wilt in the spinach and season. Serve with rice.'
			]
		}
	})
];

async function main() {
	const password = passwordFromArgs();
	if (!password) {
		console.error('usage: SEED_PASSWORD=<pw> node scripts/seed-local.mjs  (or --password <pw>)');
		process.exit(1);
	}
	const token = await login(password);
	const existing = new Set((await api('GET', '/recipes', undefined, token)).recipes.map((r) => r.title));
	for (const input of RECIPES) {
		if (existing.has(input.title)) {
			console.log(`skip ${input.title}`);
			continue;
		}
		const { id } = await api('POST', '/recipes', input, token);
		console.log(`created ${input.title} ${id}`);
	}
}

main().catch((e) => {
	console.error(e.message);
	process.exit(1);
});
