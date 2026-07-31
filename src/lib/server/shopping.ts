import type { Database } from 'better-sqlite3';
import { claudeCall } from './claude';
import { JobError, createJob, type JobHandler, type JobRow } from './jobs';
import { normaliseYield, scale } from './scale';
import { ulid } from './ids';
import type { IngredientGroup } from '$lib/tags';

// The shopping list (SPEC 7.6, ADR-015, ADR-034): one list forever, built by
// one shopping_merge job that scales missing variations inline (SPEC 5.7)
// then makes the single merge call.

/** SPEC 7.6 section order; staples always last, collapsed in the UI. */
export const SECTION_ORDER = [
	'produce',
	'meat-fish',
	'dairy',
	'dry-goods',
	'spices',
	'frozen',
	'other',
	'staples'
] as const;
export type Section = (typeof SECTION_ORDER)[number];

export const MERGE_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		items: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				properties: {
					// The prompt names seven sections; staples arrive as a flag and are
					// stored as the eighth (SPEC 5.7).
					section: { enum: SECTION_ORDER.slice(0, 7) },
					text_us: { type: 'string' },
					text_metric: { type: 'string' },
					from_recipes: { type: 'array', items: { type: 'string' } },
					is_staple: { type: 'boolean' }
				},
				required: ['section', 'text_us', 'text_metric', 'from_recipes', 'is_staple']
			}
		}
	},
	required: ['items']
};

export type MergeItem = {
	section: Section;
	text_us: string;
	text_metric: string;
	from_recipes: string[];
	is_staple: boolean;
};

// SPEC 5.7 prompt rules, verbatim.
export const MERGE_SYSTEM = `You merge recipe ingredient lists into one shopping list for a private two-person recipe book.

Merge these ingredient lists into one shopping list.

- Combine the same ingredient across recipes when the units are compatible
  ("2 cloves garlic" + "1 clove garlic" = "3 cloves garlic").
- When units are NOT reliably combinable, keep separate lines rather than
  inventing a conversion.
- Give every line in both US and metric.
- Assign each line one section: produce, meat-fish, dairy, dry-goods, spices,
  frozen, other.
- Set is_staple = true for things a home kitchen normally already has: salt,
  black pepper, cooking oil, plain flour, sugar, common dried herbs and spices,
  butter, water. These go to a separate "check you have" section rather than
  being dropped.
- Record which recipes each line came from, by recipe_id.
- Do not add anything that is not in the input lists.`;

const now = () => new Date().toISOString();

/** ADR-034: exactly one shopping_list row, ever. Created lazily. */
export function getListId(db: Database): string {
	const row = db.prepare('SELECT id FROM shopping_list').get() as { id: string } | undefined;
	if (row) return row.id;
	const id = ulid();
	const ts = now();
	db.prepare('INSERT INTO shopping_list (id, created_at, updated_at) VALUES (?, ?, ?)').run(
		id,
		ts,
		ts
	);
	return id;
}

/**
 * Replace the picked (recipe, yield) set and queue the build (SPEC 7.6). The
 * whole build is one shopping_merge job (ADR-027); an already-queued job is
 * reused because the handler reads the picks at run time, so a double tap
 * cannot bill twice. A running job is NOT reused: it may have read the old
 * picks already, so a fresh job queues behind it and last write wins.
 */
export function requestBuild(
	db: Database,
	picks: { recipe_id: string; yield_count: unknown }[]
): { job_id: string } {
	if (picks.length === 0) throw new Error('Pick at least one recipe.');
	const normalised = picks.map((p) => ({
		recipe_id: p.recipe_id,
		yield_count: normaliseYield(p.yield_count)
	}));
	return db.transaction(() => {
		const listId = getListId(db);
		db.prepare('DELETE FROM shopping_list_recipe WHERE list_id = ?').run(listId);
		const ins = db.prepare(
			'INSERT INTO shopping_list_recipe (list_id, recipe_id, yield_count) VALUES (?, ?, ?)'
		);
		for (const p of normalised) ins.run(listId, p.recipe_id, p.yield_count);
		const pending = db
			.prepare(
				`SELECT id FROM job WHERE kind = 'shopping_merge' AND list_id = ? AND status = 'queued'`
			)
			.get(listId) as { id: string } | undefined;
		return {
			job_id: pending?.id ?? createJob(db, 'shopping_merge', { list_id: listId }, { list_id: listId })
		};
	})();
}

/** D6 tap-to-retry for a failed build: requeue it (picks are unchanged). */
export function retryBuild(db: Database, listId: string): { job_id: string } {
	return db.transaction(() => {
		const requeued = db
			.prepare(
				`UPDATE job SET status = 'queued', error_code = NULL, error_text = NULL,
				   result_json = NULL, started_at = NULL, finished_at = NULL
				 WHERE id = (SELECT id FROM job
				             WHERE kind = 'shopping_merge' AND list_id = ? AND status = 'failed'
				             ORDER BY created_at DESC, id DESC LIMIT 1)
				 RETURNING id`
			)
			.get(listId) as { id: string } | undefined;
		return {
			job_id:
				requeued?.id ?? createJob(db, 'shopping_merge', { list_id: listId }, { list_id: listId })
		};
	})();
}

/**
 * Rebuild tick preservation (SPEC 7.6): a tick survives only when a new
 * generated line matches an old one exactly, section and both texts. This is
 * deliberately dumb; fuzzy matching would sometimes keep a tick it should
 * not, which is worse in a shop than an extra unticked line.
 */
const tickKey = (i: { section: string; text_us: string; text_metric: string }) =>
	`${i.section}|${i.text_us}|${i.text_metric}`;

export type BuildResult = { kept: number; reset: string[] };

/**
 * Replace the generated items with the merge output. Manual lines survive
 * untouched. Returns which ticks were kept and which reset, for the banner.
 */
export function applyMerge(db: Database, listId: string, items: MergeItem[]): BuildResult {
	return db.transaction(() => {
		const old = db
			.prepare(
				`SELECT section, text_us, text_metric, ticked FROM shopping_list_item
				 WHERE list_id = ? AND is_manual = 0`
			)
			.all(listId) as { section: string; text_us: string; text_metric: string; ticked: number }[];
		const oldTicked = new Map(old.filter((i) => i.ticked).map((i) => [tickKey(i), i]));

		db.prepare('DELETE FROM shopping_list_item WHERE list_id = ? AND is_manual = 0').run(listId);
		const ins = db.prepare(
			`INSERT INTO shopping_list_item (id, list_id, section, text_us, text_metric,
			   from_recipes, is_manual, ticked, position)
			 VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
		);
		let kept = 0;
		const seen = new Set<string>();
		// Section order first, then the model's order within a section.
		const ordered = [...items].sort(
			(a, b) => SECTION_ORDER.indexOf(sectionOf(a)) - SECTION_ORDER.indexOf(sectionOf(b))
		);
		ordered.forEach((item, i) => {
			const section = sectionOf(item);
			const key = tickKey({ ...item, section });
			const ticked = oldTicked.has(key) ? 1 : 0;
			if (ticked) {
				kept++;
				seen.add(key);
			}
			ins.run(
				ulid(),
				listId,
				section,
				item.text_us,
				item.text_metric,
				JSON.stringify(item.from_recipes),
				ticked,
				i
			);
		});
		const reset = [...oldTicked.entries()]
			.filter(([key]) => !seen.has(key))
			.map(([, i]) => i.text_metric);
		db.prepare('UPDATE shopping_list SET updated_at = ? WHERE id = ?').run(now(), listId);
		return { kept, reset };
	})();
}

const sectionOf = (i: MergeItem): Section => (i.is_staple ? 'staples' : i.section);

/**
 * The whole build in one job (SPEC 5.7, ADR-027): generate and save any
 * missing variations inline, then make the single merge call. Each variation
 * saves in its own transaction, so a mid-build failure keeps what is done and
 * a retry only pays for what is left.
 */
export const shoppingMerge: JobHandler = async (job, db) => {
	const { list_id } = JSON.parse(job.input_json) as { list_id: string };
	const picks = db
		.prepare(
			`SELECT slr.recipe_id, slr.yield_count, r.title
			 FROM shopping_list_recipe slr
			 JOIN recipe r ON r.id = slr.recipe_id AND r.deleted_at IS NULL
			 WHERE slr.list_id = ?`
		)
		.all(list_id) as { recipe_id: string; yield_count: number; title: string }[];
	if (picks.length === 0) throw new JobError('api_error', 'No recipes picked for this list.');

	// The build uses variations, never raw originals (SPEC 7.6), so the list
	// and the recipe you cook from can never disagree.
	const variationIds: string[] = [];
	for (const p of picks) {
		const existing = db
			.prepare(
				`SELECT id FROM variation WHERE recipe_id = ? AND yield_count = ? AND deleted_at IS NULL`
			)
			.get(p.recipe_id, p.yield_count) as { id: string } | undefined;
		if (existing) {
			variationIds.push(existing.id);
			continue;
		}
		// Reuse the scale handler on a synthetic row: it saves a real variation
		// (visible on the recipe afterwards) and double-checks the yield race.
		// The synthetic id matches no job row, so its bookkeeping is a no-op.
		const scaled = (await scale(
			{ ...job, id: ulid(), input_json: JSON.stringify({ recipe_id: p.recipe_id, to_count: p.yield_count }) } as JobRow,
			db
		)) as { variation_id: string } | null;
		if (!scaled) throw new JobError('api_error', `Could not scale ${p.title}.`);
		variationIds.push(scaled.variation_id);
	}

	// SPEC 5.7 input: metric ingredients per recipe, plus US for dual-unit output.
	const lists = picks.map((p, i) => {
		const bodies = db
			.prepare(`SELECT unit_system, ingredients_json FROM body WHERE variation_id = ?`)
			.all(variationIds[i]) as { unit_system: 'us' | 'metric'; ingredients_json: string }[];
		const flat = (units: 'us' | 'metric') => {
			const b = bodies.find((x) => x.unit_system === units);
			return b
				? (JSON.parse(b.ingredients_json) as IngredientGroup[]).flatMap((g) => g.items)
				: [];
		};
		return {
			recipe_id: p.recipe_id,
			recipe_title: p.title,
			ingredients_metric: flat('metric'),
			ingredients_us: flat('us')
		};
	});

	const result = await claudeCall<{ items: MergeItem[] }>(db, {
		system: MERGE_SYSTEM,
		messages: [{ role: 'user', content: JSON.stringify(lists, null, 1) }],
		schema: MERGE_SCHEMA
	});

	// Add nothing: a line whose provenance is entirely hallucinated ids keeps
	// its text but drops the unknown ids.
	const known = new Set(picks.map((p) => p.recipe_id));
	const items = result.items.map((i) => ({
		...i,
		from_recipes: i.from_recipes.filter((id) => known.has(id))
	}));
	return applyMerge(db, list_id, items);
};

/** Manual lines land in "other" and survive rebuilds (SPEC 7.6). */
export function addManual(db: Database, text: string): void {
	const t = text.trim();
	if (!t) throw new Error('Nothing to add.');
	const listId = getListId(db);
	const pos = (
		db
			.prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS p FROM shopping_list_item WHERE list_id = ?`)
			.get(listId) as { p: number }
	).p;
	db.prepare(
		`INSERT INTO shopping_list_item (id, list_id, section, text_us, text_metric,
		   from_recipes, is_manual, ticked, position)
		 VALUES (?, ?, 'other', ?, ?, '[]', 1, 0, ?)`
	).run(ulid(), listId, t, t, pos);
	db.prepare('UPDATE shopping_list SET updated_at = ? WHERE id = ?').run(now(), listId);
}

/** A tick is shared, persisted, last write wins per item (ADR-033). */
export function setTicked(db: Database, itemId: string, ticked: boolean): void {
	db.prepare('UPDATE shopping_list_item SET ticked = ? WHERE id = ?').run(ticked ? 1 : 0, itemId);
}

/**
 * Done shopping (ADR-034): hard-deletes every item, manual lines included
 * (done means you bought the bin bags), and every pick. The list row stays.
 */
export function doneShopping(db: Database): void {
	db.transaction(() => {
		const listId = getListId(db);
		db.prepare('DELETE FROM shopping_list_item WHERE list_id = ?').run(listId);
		db.prepare('DELETE FROM shopping_list_recipe WHERE list_id = ?').run(listId);
		db.prepare('UPDATE shopping_list SET updated_at = ? WHERE id = ?').run(now(), listId);
	})();
}

export type ShoppingItem = {
	id: string;
	section: Section;
	text_us: string;
	text_metric: string;
	from_titles: string[];
	is_manual: boolean;
	ticked: boolean;
	position: number;
};

export type ShoppingState = {
	list_id: string;
	items: ShoppingItem[];
	picks: { recipe_id: string; yield_count: number; title: string; yield_unit: string }[];
	/** The latest build job, for resuming the working/failed banner across
	 *  reloads. Null when the list has never been built or history is old. */
	build: {
		job_id: string;
		status: 'pending' | 'failed' | 'done';
		error_text: string | null;
		result: BuildResult | null;
	} | null;
};

/** Everything the Shopping tab and the 5 s poll need (ADR-033). */
export function getShoppingState(db: Database): ShoppingState {
	const listId = getListId(db);
	const rows = db
		.prepare(
			`SELECT id, section, text_us, text_metric, from_recipes, is_manual, ticked, position
			 FROM shopping_list_item WHERE list_id = ?
			 ORDER BY position, id`
		)
		.all(listId) as {
		id: string;
		section: Section;
		text_us: string;
		text_metric: string;
		from_recipes: string;
		is_manual: number;
		ticked: number;
		position: number;
	}[];
	const ids = [...new Set(rows.flatMap((r) => JSON.parse(r.from_recipes) as string[]))];
	const titles = new Map(
		ids.length
			? (
					db
						.prepare(`SELECT id, title FROM recipe WHERE id IN (${ids.map(() => '?').join(',')})`)
						.all(...ids) as { id: string; title: string }[]
				).map((r) => [r.id, r.title])
			: []
	);
	const picks = db
		.prepare(
			`SELECT slr.recipe_id, slr.yield_count, r.title, r.yield_unit
			 FROM shopping_list_recipe slr JOIN recipe r ON r.id = slr.recipe_id
			 WHERE slr.list_id = ? ORDER BY r.title`
		)
		.all(listId) as ShoppingState['picks'];
	const job = db
		.prepare(
			`SELECT id, status, error_text, result_json FROM job
			 WHERE kind = 'shopping_merge' AND list_id = ?
			 ORDER BY created_at DESC, id DESC LIMIT 1`
		)
		.get(listId) as
		| { id: string; status: string; error_text: string | null; result_json: string | null }
		| undefined;
	return {
		list_id: listId,
		items: rows.map((r) => ({
			id: r.id,
			section: r.section,
			text_us: r.text_us,
			text_metric: r.text_metric,
			from_titles: (JSON.parse(r.from_recipes) as string[])
				.map((id) => titles.get(id))
				.filter((t): t is string => !!t),
			is_manual: !!r.is_manual,
			ticked: !!r.ticked,
			position: r.position
		})),
		picks,
		build: job
			? {
					job_id: job.id,
					status:
						job.status === 'failed' ? 'failed' : job.status === 'done' ? 'done' : 'pending',
					error_text: job.error_text,
					result: job.result_json ? (JSON.parse(job.result_json) as BuildResult) : null
				}
			: null
	};
}
