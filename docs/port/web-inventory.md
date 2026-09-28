# Web app inventory for the iOS port

Produced on 2026-09-28 from the SvelteKit code, before any API work.

I read everything in scope. I also read `scale.ts`, `images.ts`, `r2.ts`, `reconvert.ts`, `RecipeForm.svelte`, `Banner.svelte` and `Chip.svelte`, because the routes depend on them. Paths below are relative to `server/`, where the SvelteKit app now lives.

The biggest finding for the port: there are only 5 JSON endpoints. Nearly every mutation is a SvelteKit form action, so a native client needs a new JSON API alongside them (details in §0).

---

## 0. Things that shape the native API

- **Most mutations are form actions, not a JSON API.** Only 5 `+server.ts` endpoints exist: `/api/images`, `/api/jobs/[id]`, `/api/shopping-list`, `/api/shopping-list/items/[id]` and `/healthz`. Everything else is a form action (`POST /path?/name`, form-encoded). Called with `use:enhance`, an action replies in SvelteKit's devalue-serialized `{type, status, data}` envelope. Without it, you get HTML or a 303. A native client needs a parallel JSON API that calls the same `$lib/server/*` functions.
- **CSRF.** There is no `server/svelte.config.*` in the repo, so SvelteKit's default `csrf.checkOrigin` applies. Cross-origin form-encoded POSTs to actions get a 403 unless `Origin` matches.
- **Unauthenticated API calls get a 303 to `/login`, not a 401.** This applies to `/api/*` too (`server/src/hooks.server.ts:40`). A native client would need 401s.
- **Page loads use one-off SQL** that isn't in shared modules: `listDrafts` (`server/src/routes/+page.server.ts:16-42`), `calcJob` (`server/src/routes/recipes/[id]/+page.server.ts:17-40`), the shopping recipe picker (`server/src/routes/shopping/+page.server.ts:10-17`) and the draft image lookup (`server/src/routes/drafts/[id]/+page.server.ts:29-41`).

---

## 1. Auth

**Cookie** (`server/src/lib/server/session.ts`)
- Name: `session` (line 9).
- Value: `"<iat_ms>.<base64url HMAC-SHA256(iat_ms, SESSION_SECRET)>"` (lines 19-21, 37-45).
- Attributes: `path=/`, `httpOnly`, `secure: !dev`, `sameSite: 'lax'`, `maxAge` = 1 year (`YEAR_S = 365*24*3600`, line 10).
- `verifySession` returns `null` if the cookie is missing, has no `.`, fails a timing-safe MAC compare, has a non-finite iat, or is older than 1 year (lines 24-35). There is no session table; rotating `SESSION_SECRET` logs everyone out. `secret()` throws if the env var is unset (lines 14-17).
- Sliding renewal: `REISSUE_AFTER_MS` = 30 days (line 11). Any authenticated request with an iat older than that gets a fresh cookie (`hooks.server.ts:41`).

**Login** (`server/src/routes/login/+page.server.ts`)
- Default action, `POST /login`, form field `password`.
- Rate limit: 5 failures per IP per 15 min, kept in an in-memory Map (lines 9-18).
  - IP comes from the `fly-client-ip` header, falling back to `getClientAddress()` (line 23).
  - Once limited: `fail(429, { error: 'Too many attempts. Try again in 15 minutes.' })` (line 26).
  - The attempt is counted before verifying (line 30).
- The password is verified with argon2 `verify(env.APP_PASSWORD_HASH, password)`. An empty or non-string password fails.
- Failure: `fail(400, { error: 'Wrong password.' })` (line 36).
- Success: clears the IP's failures, sets the cookie, `redirect(303, '/')` (lines 37-39).
- The page (`login/+page.svelte`) is one password input plus `form.error` shown in `role=alert`. There is no logout route anywhere.

**Gate** (`server/src/hooks.server.ts:33-46`)
- `PUBLIC_PATHS = {'/login', '/healthz'}`.
- Any other path with no valid session gets `redirect(303, '/login')`.
- Visiting `/login` with a valid session gets `redirect(303, '/')`.
- The hook also boots the DB and migrations (line 8), runs `recoverInterrupted` and starts the job runner once, guarded by `globalThis.__jobRunner` (lines 24-31). Handler map: lines 15-22.

**Health check** (`server/src/routes/healthz/+server.ts`)
- `GET /healthz` runs `BEGIN IMMEDIATE; ROLLBACK;`.
- Returns `200 "ok"` (text), or `500 "db not writable"`.
- No auth required.

---

## 2. Routes

The layout (`server/src/routes/+layout.svelte:8-35`) has a bottom tab bar: Recipes `/` (also active on `/recipes/*`), Add `/add`, Shopping `/shopping`. It is hidden on `/login`.

### `/` Browse (`server/src/routes/+page.server.ts`, `+page.svelte`)

**Load (lines 44-60).** Query params:
- `q` (string)
- `meal`, `cuisine`, `protein`, `effort`, `damage`, each repeatable (`getAll`)

Returns:
```ts
{
  drafts: DraftCard[];   // { id: string; status: 'extracting'|'failed'|'ready'; title: string }
  recipes: { id: string; title: string; effort: string; damage: string; cover_url: string | null }[];
}
```

**`listDrafts`** (lines 16-42):
- Selects capture-kind jobs with `recipe_id IS NULL`, newest first.
- Status mapping: `done` → `ready`, `failed` → `failed`, anything else → `extracting`.
- Title: `result_json.title`, else the first line of the pasted text (max 80 chars), else the URL, else `'Draft'`.
- Drafts are never filtered by search or tags.

**`listRecipes`** (`server/src/lib/server/recipes.ts:594-637`):
- Newest first by `created_at DESC`, excluding soft-deleted recipes.
- FTS: each token is quoted and prefix-matched (`"tok"*`).
- Filters: AND across groups, OR within a group. Values outside the vocabulary are silently dropped.
- Cover: `r2_key_display` of `cover_image_id`, presigned by the route.

**UI-only behaviour** (`+page.svelte`):
- Search is debounced 250 ms and uses `goto('/?…', {replaceState})` (lines 46-58).
- Tag toggles edit the query params (lines 60-67). The accordion shows one filter group at a time, and a tap outside closes it (lines 69-73).
- Every draft with `extracting` status is polled with `pollJob`, then the page is invalidated (lines 13-22).
- Draft rows:
  - Extracting rows are not links and read "Extracting…".
  - Failed rows read "Failed: tap to fix". Ready rows read "Ready to review". Both link to `/drafts/{id}`.
- Recipe rows: thumbnail (or a CookingPot tile), title, and quiet chips for effort and damage.
- Empty states: "No recipes match." when filters are active; "Add your first recipe" (→ `/recipes/new`) when there are no drafts either.
- A Trash link at the bottom goes to `/trash`.

### `/add` Capture (`server/src/routes/add/+page.server.ts`, `+page.svelte`)

There is no load function.

**Action `paste`** (lines 8-18):
- Input: form field `text`, trimmed.
- Empty text: `fail(400, {error:'Paste some recipe text first.'})`.
- `asUrl(text)` (`server/src/lib/extract.ts:25-29`):
  - `^https?://\S+$` counts as a URL.
  - `^www\.\S+$` becomes `https://…`.
  - Anything else is text.
- A URL creates an `extract_url` job with `{url}`. Text creates `extract_paste` with `{text}`.
- Then `redirect(303,'/')`.

**Action `photos`** (lines 22-40):
- Input: form field `image_ids`, a JSON string array.
- Errors, all `fail(400, {photoError})`:
  - Parse failure: "Malformed submission."
  - Empty array or non-strings: "Add at least one photo first."
  - More than 8: "At most 8 pages per recipe."
- Creates an `extract_photos` job with `{image_ids}`, then `redirect(303,'/')`.

**UI** (`add/+page.svelte`):
- Paste textarea plus an Extract button.
- Photo picker (`accept=image/*`, multiple). Each photo is uploaded immediately with `uploadPhoto(file,'capture')` (lines 17-30).
- A thumbnail strip with remove buttons. Removing a photo only drops it client-side, leaving an orphaned image row (lines 31-35).
- Photo button text: "Extract this page" / "Extract these N pages".
- A "Type it in myself" link goes to `/recipes/new`.

### `/drafts/[id]` Review draft (`server/src/routes/drafts/[id]/+page.server.ts`, `+page.svelte`)

**`getCaptureJob`** (lines 13-17): returns `404 'No such draft.'` unless the job exists and is a capture kind.

**Load** (lines 19-57):
- If the job already has `recipe_id`, `redirect(303, /recipes/{recipe_id})`.
- Returns:
```ts
{
  id: string;
  status: 'queued'|'running'|'done'|'failed';
  error_text: string | null;
  source_text: string | null;          // input.text (the pasted text)
  initial:
    | (Partial<RecipeInput> & { source_url: string|null; images: {id:string;url:string}[] })  // done: draftToInput(draft) + url + images
    | { source_url: string|null; images: {id;url}[] }   // failed/not done but has url or images
    | null;
  warnings: string[];                  // draft.extraction_warnings
  damage_reasoning: string | null;
}
```
- `images` are the capture `input.image_ids` that are still live, in input order, with presigned display URLs.

**Action `save`** (lines 62-75):
- If the job already has a recipe: 303 to that recipe.
- Input: form field `payload`, a JSON `RecipeInput`.
- A non-string payload fails with "Malformed submission." It then calls `createRecipe(db, JSON.parse(payload))`; a validation throw becomes `fail(400,{error: message})`.
- On success: `UPDATE job SET recipe_id`, then `redirect(303, /recipes/{newId})`.

**Action `discard`** (lines 79-90):
- A queued or running job gives `fail(400,{error:'Still extracting; wait for it to finish.'})`.
- Otherwise it soft-deletes the capture images that have `recipe_id IS NULL`, hard-deletes the job row, then `redirect(303,'/')`.

**Action `retry`** (lines 94-102):
- Requeues the job only if `status='failed'`, clearing `error_*`, `result_json` and the timestamps.
- Then `redirect(303, /drafts/{id})`.

**UI** (`drafts/[id]/+page.svelte`):
- While queued or running: a spinner message and `pollJob`, then invalidate (lines 29-31, 46-50).
- Failed: a Banner with `error_text` and a "Try again" action. It removes the sessionStorage draft before submitting `?/retry` (lines 21-27).
- Warnings: one Banner each, with a jump link to `#steps` if the text matches `/step/i`, or `#ingredients` if it matches `/ingredient/i` (lines 16-19, 59-70).
- A "Damage: {reasoning}" line, and a collapsible "Pasted text".
- `RecipeForm` is given `editing = status==='done'`, `draftKey = wc-draft:job:{id}` and action `?/save`.
- Discard asks for a second tap ("Really discard this draft? Tap again") and clears the sessionStorage draft (lines 93-113).

### `/recipes/new` Manual entry (`server/src/routes/recipes/new/+page.server.ts`)

There is no load function.

**Default action:**
- Input: `payload`, a JSON `RecipeInput`.
- Calls `createRecipe`, then `redirect(303,/recipes/{id})`.
- Errors: `fail(400,{error})`, including "Malformed submission." for a non-string payload.
- The page renders `RecipeForm` with `draftKey="wc-draft:manual"` and no initial values.

### `/recipes/[id]` Recipe view (`server/src/routes/recipes/[id]/+page.server.ts`, `+page.svelte`)

**Load** (lines 42-67):
- Query `v`: optional variation id. An unknown or trashed id falls back to the original (`recipes.ts:404-444`).
- A missing recipe is a 404 "Recipe not found".
- Side effect: if `recipe.stale && !hand_edited`, it calls `ensureFresh`, which may enqueue a scale job.
- Returns:
```ts
{
  recipe: Omit<RecipeDetail,'images'> & { images: { id: string; url: string; width: number; height: number }[] };
  refresh: { job_id: string | null; status: 'pending'|'failed' } | null;
  calcJob: { job_id: string; status: 'pending'|'failed'; error_text: string|null; to_count: number } | null;
}
```
- `calcJob` (lines 17-40) is the latest scale job for this recipe with `variation_id IS NULL`. It covers queued/running jobs, and failed jobs whose `finished_at` is within 15 minutes.

**Actions.** All return `fail(400, {error})` when the server function throws, except where noted.

| Action | Inputs | Calls | Success return |
|---|---|---|---|
| `retry` (71-81) | `variation_id` (optional; empty means original) | `retryReconvert(db, id, vid)` | `{ok:true}` |
| `calculate` (83-92) | `to_count` | `requestScale(db, id, to_count)` | `{variation_id}` if that yield exists, else `{job_id}` |
| `retryScale` (94-97) | `variation_id` | `retryScale` | `{job_id}` (no try/catch) |
| `recalculate` (98-107) | `variation_id` | `recalcVariation` | `{job_id}` |
| `keepMine` (108-111) | `variation_id` | `keepMine` | `{ok:true}` (no try/catch) |
| `deleteVariation` (112-121) | `variation_id` | `deleteVariation` | `{ok:true}` |

**Server functions and their behaviour:**
- `requestScale` (`scale.ts:218-248`):
  - `normaliseYield` rounds to 1 decimal and throws "Yield must be a positive number." for zero or negatives (lines 207-211).
  - If a live variation already has that yield, it returns `{variation_id}`.
  - It reuses a pending scale job with the same `to_count`, otherwise creates `scale {recipe_id, to_count}` (ref `recipe_id`).
- `ensureFresh` (`scale.ts:257-283`): returns the pending job id, or `null` when the latest refresh job failed (it never auto-retries a failure), or creates `scale {variation_id}`.
- `retryScale` (`scale.ts:286-303`): requeues the latest failed scale job for that variation, or creates a new one.
- `recalcVariation` (`scale.ts:309-328`):
  - Throws "Variation not found." or "The original variation cannot be recalculated."
  - Otherwise soft-deletes the variation and creates `scale {recipe_id, to_count: same yield}`.
- `keepMine` (`scale.ts:331-338`): sets `based_on_content_version` to the recipe's `content_version`.
- `deleteVariation` (`recipes.ts:658-665`): throws "Variation not found." or "The original variation cannot be deleted."
- `retryReconvert` (`recipes.ts:538-570`): requeues the latest failed reconvert and rewrites its target units; otherwise calls `enqueueReconvert`. Throws "Recipe not found."

**UI** (`recipes/[id]/+page.svelte`):
- **Header:** title; `"{yield_count} {yield_unit} · prep N min · cook N min"`; cover (the image matching `cover_image_id`); source line (linked when `source_url` is set; text is `source_text ?? url`).
- **Edit link:** `/recipes/{id}/edit`, plus `?v={variation_id}` when viewing a non-original (lines 203-205).
- **Tag chips:** `[...meal_types, cuisine, protein, effort, damage]` with nulls removed (lines 169-171).
- **Variation chips:**
  - Label is `"N · original"` for the original, else `"N"`.
  - Tapping another chip navigates to `?v=`.
  - Tapping the selected non-original chip toggles a detail panel with "Delete this variation", confirmed via `confirm("Delete the N-unit version? It goes to Trash.")`. On success it navigates to `/recipes/{id}` (lines 216-255).
- **Stepper:** see §7. It shows "Show N" when the typed count matches an existing variation, or a "Calculate for N" submit when it doesn't and no calculation is in flight (lines 256-285).
- **Banners** (lines 288-343):
  - "Calculating for N…"
  - `calcError`, or the failed `calcJob.error_text`, or `form.error`.
  - Refresh pending: "The original changed, updating this version…"
  - Refresh failed: "…couldn't update." with "Tap to retry" (submits `?/retryScale`).
  - "Updated to match the original."
  - Stale and hand-edited: "The original changed after you edited this version." with Recalculate (behind a `confirm`) and Keep mine.
- **Unit toggle:** Metric/US. The "as written" marker shows on `source_units` only when `is_original || hand_edited` (lines 347-357).
- **Reconvert banner:** only when `r.reconvert !== null && units !== r.source_units`. Pending reads "Not yet updated from your edit. Updating…"; failed reads "Couldn't update from your edit." with Tap to retry (`?/retry`, sending `variation_id` for non-originals) (lines 359-381).
- **Body:** `scaling_note` (non-original only); an Ingredients block that is sticky, collapsible and open by default, with group headings; the numbered steps list; notes; the photo strip of all images (lines 383-448).

### `/recipes/[id]/edit` (`server/src/routes/recipes/[id]/edit/+page.server.ts`, `+page.svelte`)

**Load:** takes `?v=` like the view page. Returns `{ recipe: RecipeDetail with images: {id,url}[] }` (lines 7-19). A missing recipe is a 404.

**Action `save`** (lines 23-34):
- Inputs: `payload` (JSON `RecipeInput`) and `variation_id` (optional).
- Calls `updateRecipe(db, id, payload, variationId)`.
- Success: `redirect(303, /recipes/{id}[?v=vid])`. Errors: `fail(400,{error})`.

**Action `retry`** (37-45): same as the view page's retry.

**UI:**
- `RecipeForm` gets `initial = {...recipe, counterpart: bodies[otherUnits(source_units)]}` and `draftKey = wc-draft:recipe:{variation_id}`. It also passes `reconvert` and `variationId` (null when editing the original).
- Delete recipe posts `id` to `/trash?/delete_recipe`, behind `confirm('Delete "<title>"? You can restore it from Trash.')` (lines 43-54).

**`updateRecipe`** (`recipes.ts:236-352`). Error messages it can throw:
- "Recipe not found."
- "A variation at that yield already exists. Delete it first."
- "That unit system has not been generated yet." (when no body exists for the submitted `source_units`)

What it does:
- `bodyEdited` compares the stored JSON strings exactly.
- `content_version` goes up by 1 only when editing the original and either the body or the yield changed.
- A body edit sets `hand_edited = 1`, updates that body, moves `is_source` to it, and calls `enqueueReconvert` for the other unit system.
- It also rewrites meal types, calls `setImages` and rebuilds FTS.

**`setImages`** (`recipes.ts:72-91`):
- Claims each submitted image id where `recipe_id IS NULL` or already belongs to this recipe.
- Soft-deletes live images of the recipe that weren't submitted.
- Sets the cover only if it's a live image of this recipe, else NULL.

### `/shopping` (`server/src/routes/shopping/+page.server.ts`, `+page.svelte`)

**Load** (lines 6-18):
```ts
{ list: ShoppingState;
  recipes: { id: string; title: string; yield_unit: string; yield_count: number }[] } // live recipes, original yield, newest first
```

**Actions:**

| Action | Inputs | Calls | Return |
|---|---|---|---|
| `build` (22-32) | `picks`: JSON `[{recipe_id, yield_count}]` | `requestBuild` | `{job_id}`; throw → `fail(400,{error})` (e.g. "Pick at least one recipe.", "Yield must be a positive number.") |
| `retry` (34-37) | `list_id` | `retryBuild` | `{job_id}` |
| `manual` (38-45) | `text` | `addManual` | `{ok:true}`; "Nothing to add." → 400 |
| `done` (47-50) | none | `doneShopping` | `{ok:true}` |

**UI:** described in §7.

### `/trash` (`server/src/routes/trash/+page.server.ts`, `+page.svelte`)

**Load:** `{ trash: Trash }` (`recipes.ts:700-728`).
- `recipes`: `{id, title, deleted_at}[]`.
- `variations`: `{id, title, yield_count, yield_unit, deleted_at}[]`, only for live recipes. Both lists are ordered by `deleted_at DESC`.

**Actions.** Each takes form field `id`; a non-string `id` is a 400 "Malformed submission." (lines 13-17).
- `delete_recipe`: `deleteRecipe`, then `redirect(303,'/')`.
- `restore_recipe`: `restoreRecipe`, returns `{restored:true, displaced:false}`.
- `restore_variation`: `restoreVariation`, returns `{restored:true, displaced:boolean}`. Errors are `fail(400,{error})`: "Variation not found in Trash." or "The original now uses this yield and cannot be displaced." Restore wins: any live non-original at the same yield is soft-deleted (`recipes.ts:671-698`).

**UI messages:** "Restored your version; the variation that held the same yield is in Trash." when displaced, else "Restored.". Dates are formatted with `toLocaleDateString({day:'numeric', month:'short'})`.

### JSON endpoints (`+server.ts`)

| Method + path | Request | Response | Status codes |
|---|---|---|---|
| `POST /api/images?role=photo\|capture` (`api/images/+server.ts`) | Raw JPEG bytes as the body; `role` defaults to `photo` | `{id, url, width, height}` (`UploadedImage`, `server/images.ts:57`) | 400 "Unknown image role." / "Empty upload." / "Could not process image."; 413 "Image too large." (> 8 MiB) |
| `GET /api/jobs/:id` (`api/jobs/[id]/+server.ts`) | none | `JobPoll` `{status, error_code, error_text, result_ref}`; `result_ref = variation_id ?? recipe_id ?? list_id ?? null` (line 26) | 404 "No such job." |
| `GET /api/shopping-list` | none | `ShoppingState` | 200 |
| `POST /api/shopping-list/items/:id` | JSON `{ticked: any}`, coerced with `!!` | `{ok:true}` | 400 "Malformed JSON."; unknown ids still return 200 (no-op UPDATE) |
| `GET /healthz` | none | text `ok` | 500 |

Every endpoint except `/healthz` requires the session cookie.

---

## 3. Domain types (quoted)

**Tags** (`server/src/lib/tags.ts:4-62`):
```ts
export const MEAL_TYPES = ['breakfast','lunch','dinner','side','salad','soup','bread','dessert','snack','sauce','drink'] as const;
export const CUISINES = ['italian','french','spanish','greek','middle-eastern','north-african','indian','thai','vietnamese','chinese','japanese','korean','mexican','american','british','central-european','nordic','caribbean','west-african'] as const;
export const PROTEINS = ['chicken','beef','pork','lamb','fish','seafood','egg','tofu','beans','cheese','none'] as const;
export const EFFORTS = ['quick', 'weeknight', 'project'] as const;
export const DAMAGES = ['tidy', 'messy', 'carnage'] as const;
export type MealType = (typeof MEAL_TYPES)[number]; // …Cuisine, Protein, Effort, Damage likewise
```
- Cardinality (SPEC 3.4, lines 188-202): meal_type is 0 or more; cuisine and protein are at most one; effort and damage are exactly one.
- Effort meaning: quick is under 30 min, weeknight is 30-60, project is over 60.
- Damage rubric: SPEC lines 204-218.

**Ingredients and bodies** (`tags.ts:64-115`):
```ts
export type IngredientGroup = { heading: string | null; items: string[] };
export type UnitSystem = 'us' | 'metric';
export type BodyText = { ingredients: IngredientGroup[]; steps: string[] };
export type RecipeInput = {
	title: string; yield_count: number; yield_unit: string;
	prep_minutes: number | null; cook_minutes: number | null;
	source_text: string | null; source_url: string | null; notes: string | null;
	source_units: 'us' | 'metric'; meal_types: MealType[];
	cuisine: Cuisine | null; protein: Protein | null; effort: Effort; damage: Damage;
	ingredients: IngredientGroup[]; steps: string[];
	counterpart: BodyText | null;   // known-good other-units body, or null → server reconverts
	image_ids: string[]; cover_image_id: string | null;
};
```
- `cleanIngredients` and `cleanBody` (lines 75-89) trim lines, drop empty lines and empty groups, and turn a `''` heading into null.

**Validation** (`validateInput`, `recipes.ts:26-65`). Error messages:
- "Title is required."
- "Yield must be a positive number." (the yield is rounded to 1 decimal first)
- "At least one ingredient line is required."
- "Effort is required." / "Damage is required."
- "Unknown cuisine." / "Unknown protein."
- "Unknown unit system."

Normalisation:
- Invalid meal types are dropped silently. `image_ids` are deduped.
- `yield_unit` defaults to `'servings'`. Empty text fields become null.
- A counterpart with no ingredients becomes null.
- A cover not in `image_ids` becomes null.

**Recipe, Variation, Image** (`recipes.ts:354-402`):
```ts
export type RecipeDetail = {
	id: string; title: string; source_text: string | null; source_url: string | null;
	yield_unit: string; yield_count: number; prep_minutes: number | null; cook_minutes: number | null;
	notes: string | null; source_units: 'us' | 'metric';
	meal_types: RecipeInput['meal_types']; cuisine: RecipeInput['cuisine']; protein: RecipeInput['protein'];
	effort: RecipeInput['effort']; damage: RecipeInput['damage'];
	ingredients: IngredientGroup[]; steps: string[];          // the SOURCE body
	cover_image_id: string | null; images: RecipeImage[];
	variation_id: string; hand_edited: boolean; is_original: boolean;
	stale: boolean; scaling_note: string | null;
	variations: VariationChip[];                                // ascending yield
	bodies: { us: BodyText | null; metric: BodyText | null };
	reconvert: { job_id: string | null; status: 'pending' | 'failed' } | null;
};
export type VariationChip = { id: string; yield_count: number; is_original: boolean; stale: boolean };
export type RecipeImage = { id: string; r2_key_full: string; r2_key_display: string; width: number; height: number };
export type BrowseRow = { id: string; title: string; effort: string; damage: string; cover_key: string | null };
export type BrowseFilters = { q?: string; meal_type?: string[]; cuisine?: string[]; protein?: string[]; effort?: string[]; damage?: string[] };
```
Notes on these fields:
- `source_units` comes from `is_source`, meaning the body a human last authored (`recipes.ts:465-468`).
- `reconvert`:
  - `pending` when the latest reconvert job is queued or running.
  - `failed` when it failed.
  - Also `failed` with `job_id: null` when the counterpart body is missing and there is no job.
  - Otherwise `null` (`recipes.ts:473-486`).
- `stale` is `based_on_content_version < content_version`.
- The DB schema (tables `recipe`, `variation`, `body`, `image`, `job`, `shopping_*`, FTS) is at SPEC lines 230-377. `image.role` is `'capture'|'photo'`. Variation yields are unique per recipe among live rows.

**Draft (extraction result)** (`server/src/lib/extract.ts:18-54`):
```ts
export type CaptureInput = { text?: string; url?: string; image_ids?: string[] };
export type BodyPair = { source_units: 'us' | 'metric'; us: BodyText; metric: BodyText };
export type RecipeDraft = {
	title: string; yield_count: number; yield_unit: string;
	prep_minutes: number | null; cook_minutes: number | null; source_text: string | null;
	body: BodyPair;
	tags: { meal_type: MealType[]; cuisine: Cuisine | null; protein: Protein | null; effort: Effort; damage: Damage };
	damage_reasoning: string; extraction_warnings: string[];
};
```
`draftToInput` (lines 69-89) maps a draft to form input: the body in `source_units` becomes the editable body, and the other becomes `counterpart`.

**Jobs** (`server/src/lib/server/jobs.ts:8-32`, `server/src/lib/jobs.ts:5-34`):
```ts
export type JobKind = 'extract_url' | 'extract_paste' | 'extract_photos' | 'scale' | 'reconvert' | 'shopping_merge';
export const CAPTURE_KINDS = ['extract_url', 'extract_paste', 'extract_photos'] as const;
export type JobRow = { id: string; kind: JobKind; status: 'queued' | 'running' | 'done' | 'failed';
	recipe_id: string | null; variation_id: string | null; list_id: string | null;
	input_json: string; result_json: string | null; error_code: ErrorCode | null; error_text: string | null; attempts: number };
export type ErrorCode = 'fetch_blocked' | 'fetch_failed' | 'no_recipe_found' | 'image_unreadable' | 'quota_exceeded' | 'api_error' | 'interrupted';
export type JobPoll = { status: 'queued' | 'running' | 'done' | 'failed' | 'timeout'; error_code: ErrorCode | null; error_text: string | null; result_ref: string | null };
```

`ERROR_COPY` (`server/src/lib/jobs.ts:14-24`). The server always stores this fixed copy in `error_text` (`server/jobs.ts:106-112`).

| Code | Copy |
|---|---|
| `fetch_blocked` | "This site blocks automated readers. Copy the recipe text and paste it instead, or screenshot the page." |
| `fetch_failed` | "Could not load that page. Paste the text instead?" |
| `no_recipe_found` | "Could not find a recipe there. Try pasting the text or a photo." |
| `image_unreadable` | "Could not read that photo. Try again with more light, or crop tighter on the recipe." |
| `quota_exceeded` | "Daily limit on Claude calls reached. This usually means something is stuck." |
| `api_error` | "Claude is unavailable right now. Try again in a minute." |
| `interrupted` | "That was interrupted by a restart. Tap to try again." |

- The SPEC's `quota_exceeded` copy (line 710) mentions "50 Claude calls"; the code's copy doesn't.
- The cap is `DAILY_CALL_CAP || 50` calls per America/New_York day (`server/claude.ts:29`).

Job inputs and results by kind:

| Kind | `input_json` | `result_json` | Refs set |
|---|---|---|---|
| `extract_*` | `CaptureInput` | `RecipeDraft` | `recipe_id` set on save |
| `scale` | `{recipe_id, to_count}` (new variation) or `{variation_id}` (refresh) | `{variation_id}` or null | `variation_id` written on completion (`scale.ts:135,200`) |
| `reconvert` | `{variation_id, target_units}` | null | — |
| `shopping_merge` | `{list_id}` | `BuildResult {kept:number; reset:string[]}` | `list_id` |

`no_recipe_found` (or `image_unreadable` for photos) is raised when the draft has no non-empty ingredient line (`server/extract.ts:160`).

**Shopping** (`server/src/lib/server/shopping.ts:13-23, 158, 333-356`):
```ts
export const SECTION_ORDER = ['produce','meat-fish','dairy','dry-goods','spices','frozen','other','staples'] as const;
export type Section = (typeof SECTION_ORDER)[number];
export type BuildResult = { kept: number; reset: string[] };   // reset = text_metric of lost ticks
export type ShoppingItem = { id: string; section: Section; text_us: string; text_metric: string;
	from_titles: string[]; is_manual: boolean; ticked: boolean; position: number };
export type ShoppingState = { list_id: string; items: ShoppingItem[];
	picks: { recipe_id: string; yield_count: number; title: string; yield_unit: string }[];
	build: { job_id: string; status: 'pending' | 'failed' | 'done'; error_text: string | null; result: BuildResult | null } | null };
```
- There is exactly one list, created lazily (`getListId`, lines 80-91).
- Manual lines go in `other` with the same text for US and metric, and survive rebuilds (lines 294-313).
- A tick is kept across a rebuild only if both texts match exactly; section is ignored (lines 155-211).
- `doneShopping` hard-deletes all items (including manual lines) and all picks (lines 324-331).
- `requestBuild` replaces the picks and reuses a queued job but not a running one (lines 100-125).

---

## 4. Job polling protocol and the draft → recipe flow

**Server lifecycle** (`server/src/lib/server/jobs.ts`):
- States: `queued → running → done|failed`.
- The runner polls every 500 ms with concurrency 2. It claims jobs with an atomic `UPDATE … RETURNING`, in `created_at, id` order (lines 84-133).
- On boot, any `running` job becomes `failed/interrupted` (lines 73-80).
- Any handler error that isn't a `JobError` becomes `api_error`.

**Client polling** (`pollJob`, `server/src/lib/jobs.ts:42-54`):
- `GET /api/jobs/{id}` every 1.5 s for the first 30 s, then every 5 s.
- Resolves on `done` or `failed`.
- After 5 min it gives up and synthesises `{status:'timeout', error_text:'Still working after 5 minutes. Try again in a bit.'}` (line 34).
- A non-OK response throws.
- There are no websockets.

**What `result_ref` means per kind:**
- `scale`: the new or refreshed variation id. The client navigates to `?v=` (`recipes/[id]/+page.svelte:56-60`).
- `shopping_merge`: the list id. The client refetches.
- Capture jobs: `recipe_id` stays null until save, so `result_ref` is null. The client re-reads the draft.

**Draft → recipe:**
1. `/add` creates an `extract_*` job and redirects to `/`, where it appears as a draft card from the job table.
2. Browse polls extracting cards. When the job is done or failed, the card becomes "Ready to review" or "Failed: tap to fix".
3. `/drafts/{id}` loads the draft:
   - `done`: the form is seeded from `draftToInput(result_json)` plus `source_url` and capture images, with `editing=true` so the counterpart is carried along.
   - `failed`: the form is empty except for `source_url` and images; the pasted text is shown separately; the error banner offers Try again (`?/retry`).
4. Save posts `payload`: `RecipeForm.payload()` (`RecipeForm.svelte:157-190`). It includes `image_ids` for the capture photos, which `setImages` claims onto the recipe.
   - `createRecipe` (`recipes.ts:181-228`) inserts the recipe, meal types, the original variation (`based_on_content_version=1`) and the source body.
   - It inserts the counterpart body if present, otherwise enqueues a reconvert. Then it sets images and rebuilds FTS.
   - The job's `recipe_id` is set, which removes the card from browse, then the client is redirected to the recipe.
5. Discard hard-deletes the job and soft-deletes its unclaimed images. Queued or running drafts can't be discarded.
6. Once saved, reloading the draft redirects to the recipe.

---

## 5. Image handling

**Client** (`server/src/lib/images.ts`):
- `normalise` uses `createImageBitmap(file, {imageOrientation:'from-image'})`, resizes the long edge to at most 3000 px (`FULL_EDGE`), and exports JPEG at q=0.9 (lines 5-18).
- `uploadPhoto` does `POST /api/images?role=…` with the raw blob as the body. The client only keeps `{id, url}` (lines 23-29).

**Server** (`server/src/lib/server/images.ts`):
- Limits: body over 8 MiB gives 413; empty gives 400 (`api/images/+server.ts:13-16`). sharp's `limitInputPixels` is 50,000,000 (line 14).
- `normaliseFull` returns the input untouched if it has no EXIF and orientation 1; otherwise it rotates and re-encodes as q90 JPEG, which strips EXIF and GPS (lines 25-29).
- Display copy: long edge 1200 (`DISPLAY_EDGE`), q85, fit inside, no enlargement (lines 31-37).
- Claude copy: long edge 2576 (`CLAUDE_EDGE`), q85, derived at extraction time and not stored (lines 42-48).
- R2 keys: `images/{ulid}/full.jpg` and `images/{ulid}/display.jpg` (lines 72-73).
- The row is inserted with `recipe_id NULL` and the role. It is claimed on save (`setImages`).

**Key → URL** (`server/src/lib/server/r2.ts`):
- The bucket is private. URLs are SigV4 query-presigned GETs (no aws-sdk) against `https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com/{bucket}/{key}`, with region `auto`, service `s3`, `X-Amz-Expires=604800` (7 days) and `UNSIGNED-PAYLOAD` (lines 34-59).
- `presignGet` rounds the signing time down to UTC midnight, so a URL stays byte-identical for the whole day and caches well (lines 62-66).
- Every URL the UI sees is the **display** key presigned. `r2_key_full` is never sent to the client.
- The phone fetches image bytes directly from R2, not through the app server.
- A native client should treat URLs as opaque and valid for at least 6 days. It can cache by image `id`, since the URL changes daily.

---

## 6. Per-device browser storage

| Store | Key | Value | Where |
|---|---|---|---|
| localStorage | `units` | `'us'` or `'metric'`; anything but `'us'` means metric (the default, D15) | Shared by the recipe view (`recipes/[id]/+page.svelte:95-98,141-144`), shopping (`shopping/+page.svelte:45-52`) and the form's initial body (`RecipeForm.svelte:89-96`) |
| sessionStorage | `strikes:{variation_id}` | JSON array of line keys: `i{groupIndex}.{itemIndex}` for ingredients, `s{stepIndex}` for steps | `recipes/[id]/+page.svelte:125-140` |
| sessionStorage | `wc-draft:job:{jobId}` / `wc-draft:recipe:{variationId}` / `wc-draft:manual` | JSON of the whole form state (`FormState`) | `RecipeForm.svelte:111-120`; removed on a successful save (line 250), Start over (130), draft Discard and Retry (`drafts/[id]/+page.svelte:25,98`) |
| sessionStorage | `shoppingBuildSeen` | The last build `job_id` whose rebuild banner has been shown | `shopping/+page.svelte:96-97` |

Both strikes and form drafts are keyed by **position**. A strike key identifies a line by its index, not its text, so strikes survive a unit toggle (ADR-036).

---

## 7. Client-only behaviour a native app must reimplement

**Recipe view** (`recipes/[id]/+page.svelte`)
- **Choosing a body:** `body = bodies[units] ?? bodies[source_units]`. The source body is the fallback while the counterpart is missing (line 148).
- **Reconvert banner:** only when viewing the non-source units (line 150). While a reconvert is pending, poll it and reload when it finishes (lines 154-160).
- **Yield stepper** (lines 15-39):
  - `count = round(Number(input)*10)/10`, valid when finite and > 0.
  - ± buttons step by 1 from the current value (or the viewed yield if the input is invalid), and never go to zero or below.
  - The typed input accepts decimals. Enter only blurs; it never submits.
  - When the viewed variation changes, the stepper resets to the viewed yield and clears `justUpdated`, `calcError` and the chip detail panel.
  - If the count matches an existing variation's `yield_count`, show "Show N", which switches with no server call. Otherwise show "Calculate for N".
- **Calculate flow** (lines 43-91):
  - A server reply of `{variation_id}` switches straight to that variation.
  - A reply of `{job_id}` shows a "Calculating for N…" banner and polls. `done` navigates to `?v=result_ref`; failure shows `error_text`.
  - A pending calculation is resumed from the load's `calcJob` after a reload or phone lock.
- **Stale refresh** (lines 69-78): poll `refresh.job_id`. When done, show "Updated to match the original." and reload.
- **Confirmations:** delete variation, recalculate and delete recipe all use native `confirm()` dialogs.
- **Wake lock** (lines 102-118): `navigator.wakeLock.request('screen')` on mount, re-acquired on `visibilitychange` to visible, released on unmount. Errors are ignored. On iOS the equivalent is `isIdleTimerDisabled` while the recipe screen is visible.
- **Strike-through** (lines 125-140, 403-426): tapping an ingredient or step toggles it. State is per device and per session, never synced.
- **"as written" marker:** shown on `source_units` only for the original or hand-edited variations (line 352).
- **Display strings:** the tag list and "prep N min · cook N min" (lines 169-179).

**RecipeForm** (`server/src/lib/components/RecipeForm.svelte`)
- **Defaults:** yield 4 `servings`, metric, effort and damage unselected (the server rejects a save without them), one empty group, one empty step (lines 47-68).
- **Opening in the device's units:** if `units` says US and the counterpart exists, the form starts showing that body. This never changes the `loaded` snapshot used for comparison (lines 89-96).
- **Unit toggle:**
  - New recipe: it just sets `source_units`.
  - Editing: it swaps the visible body with the hidden one, and is disabled when there is no counterpart (lines 138-147, 360-372).
- **Payload rule** (lines 157-190). This is the core logic to port exactly:
  - It compares `cleanBody(...)` of each body against the loaded snapshot.
  - Both bodies changed: submit the visible body with its units.
  - Only the other body changed: submit it with the other units.
  - Neither changed (or only the source changed): submit the source body. The counterpart is sent only if the source is unchanged; otherwise it is `null`, which makes the server reconvert.
  - `image_ids` is the image order. `images`, `shown_units` and `other` are removed from the payload.
- **Photos:**
  - Uploaded immediately on pick (`role=photo`). The first photo becomes the cover.
  - Removing the cover moves it to the first remaining photo. Tapping a thumbnail makes it the cover (lines 211-233).
- **Ingredients and steps:** reorder with up/down, add, remove. Groups can be added, and removed while more than one remains.
- **Tags:** meal type is multi-select. Cuisine and protein are single-select, and tapping the selected value clears it. Groups longer than 8 collapse behind "Show all N", but a selected value always stays visible (lines 197-203, 237-242).
- **Autosave:** the draft is written to sessionStorage on every change and restored silently when the form reopens. "Start over" needs a second tap to confirm.

**Shopping** (`shopping/+page.svelte`)
- **Local list:** a local copy of `ShoppingState` that ticks update optimistically.
  - A tick POSTs `{ticked}` with an 8 s abort timeout and increments `ticksInFlight` (lines 55-66).
  - A 5 s poll of `/api/shopping-list` runs only while the page is visible and no ticks are in flight. It also refetches when the page becomes visible again (lines 69-85).
- **Build polling:** a pending build is polled with `pollJob` (lines 105-112).
- **Rebuild banner:** shown once per build, using `shoppingBuildSeen`. Text: "`{kept} tick(s) kept. {n} reset because the line changed: a, b.`", shown only when something was reset (lines 91-102).
- **Pick mode** (lines 115-135, 175-228):
  - Selection is pre-filled from the current picks. Yields default to each recipe's original, overridden by current picks.
  - The stepper is **whole numbers only, minimum 1** (`Math.max(1, round(y+d))`). The server itself accepts 1-decimal yields.
  - Submitting switches straight to the list screen.
  - Button text: "Build list from N recipe(s)", or disabled "Pick at least one recipe".
  - "Cancel, keep current list" is shown only if a list exists.
- **Rendering:**
  - Section labels: Produce, Meat and fish, Dairy, Dry goods, Spices, Frozen, Other (lines 29-37).
  - Within a section: generated items first, then manual, each by `position` (lines 145-148).
  - Staples sit in a collapsed "Check you have (N)" block.
  - Primary text follows the unit setting. The secondary line is:
    - "added by hand" for manual lines;
    - otherwise "about {alt}" (when the other units' text differs) joined with " · " to the source recipe titles (lines 150-159).
  - Header: "{ticked} of {total} ticked · ticks sync to both phones".
  - While building: a banner plus 5 skeleton rows. Failed build: `error_text` with Tap to retry.
- **Done shopping:** two steps. Confirm text: "Clear {total} items and all ticks on both phones? The list cannot be brought back." (lines 332-355).
- **Units toggle:** at the bottom of the list, sharing the `units` key.

**Browse:** the 250 ms debounced search, the multi-value tag params, the one-open-group filter accordion, and polling of extracting drafts (see §2 `/`).

**Add:** photo upload queue with counter (`uploading`); remove before extract; upload error copy "Could not upload a photo. Check the connection and try again."

**Components:** `Banner` (`server/src/lib/components/Banner.svelte`) is one inline row: icon, text, and an optional action button, with role `alert` or `status`. `Chip` (`server/src/lib/components/Chip.svelte`) marks the selected state with fill plus a checkmark, never colour alone; `quiet` is the read-only variant.