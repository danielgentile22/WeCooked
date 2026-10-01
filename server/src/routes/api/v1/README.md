# /api/v1

JSON API for the native client. Every route is a row in `src/lib/server/api/v1.ts` and calls the same `$lib/server` function as the matching web load or form action. Integration tests: `api.test.ts` in this folder, which also records the reply fixtures in `WeCookedKit/Tests/Fixtures`.

Auth: send `Authorization: Bearer <token>`, where the token comes from `POST /login`. It is the session cookie value, valid for a year. When it is older than 30 days, the reply carries a fresh one in `X-Session-Token`; store it. Without a valid token every `/api` path answers 401 `{"error":"unauthorized"}`. Send JSON bodies as `Content-Type: application/json`.

Errors are always `{"error": string}`. 400 is a validation message fit to show the user. Unknown paths are 404 and wrong methods 405.

| Method | Path | Body | Reply | Errors |
|---|---|---|---|---|
| POST | /login | `{password}` | `{token}` | 400 wrong password, 429 rate limited (5 failures per IP per 15 min) |
| GET | /session | | `{ok:true}` | 401 |
| GET | /tags | | `{meal_types, cuisines, proteins, efforts, damages, section_order, error_copy}` | |
| GET | /recipes?q=&meal=&cuisine=&protein=&effort=&damage= | | `{drafts: DraftCard[], recipes: {id,title,effort,damage,cover_url}[]}` | |
| POST | /recipes | `RecipeInput` | `{id}` | 400 |
| GET | /recipes/:id?v= | | `{recipe, refresh, calcJob}`; may queue a stale refresh. `recipe.images[]` is `{id, url, width, height, source_url}`; `recipe.cover_job_id` is the cover job running for the recipe (directly or through its draft), else null | 404 |
| PUT | /recipes/:id | `{payload: RecipeInput, variation_id?}` | `{id, variation_id}` (null means the original) | 400 |
| DELETE | /recipes/:id | | `{ok:true}` (to Trash) | |
| POST | /recipes/:id/calculate | `{to_count}` | `{variation_id}` if that yield exists, else `{job_id}` | 400 |
| POST | /recipes/:id/retry-reconvert | `{variation_id?}` | `{ok:true}` | 400 |
| POST | /recipes/:id/cover | | `{job_id}`: "Find another photo", a cover job that searches past every image already found for the recipe and replaces a found cover | 400 a cover job is already running, or the cover is a household photo; 404 |
| POST | /variations/:id/retry-scale | | `{job_id}` | 400 |
| POST | /variations/:id/recalculate | | `{job_id}` | 400 |
| POST | /variations/:id/keep-mine | | `{ok:true}` | |
| DELETE | /variations/:id | | `{ok:true}` (to Trash) | 400 |
| POST | /captures | `{text}`, `{url, html?, text?}` or `{image_ids}` | `{job_id}`; a successful extraction queues a cover job | 400 |
| POST | /generations | `{description, yield_count}` | `{job_id}` | 400 empty or over 1000 characters, 400 yield not a whole number from 1 to 100 |
| GET | /drafts/:id | | `DraftView`, `GenerationView` while a generation waits for a pick, or `{recipe_id}` once saved. `DraftView.initial` carries `images: {id, url, source_url}[]` and `cover_image_id` (the found cover, else null); `DraftView.cover_job_id` is the cover job still running for the draft, else null, so the phone can watch it and re-read the draft | 404 |
| POST | /drafts/:id/save | `RecipeInput` | `{recipe_id}` | 400 (also before a generation's pick), 404 |
| POST | /drafts/:id/discard | | `{ok:true}` | 400 while extracting, 404 |
| POST | /drafts/:id/retry | | `{ok:true}` (requeues a failed draft) | 404 |
| POST | /drafts/:id/cover | | `{job_id}`: "Find another photo" for the draft, as for a recipe | 400 still choosing, not done extracting, or a cover job is already running; 404 |
| POST | /drafts/:id/pick | `{index}` | `{ok:true}`; the generation becomes a draft seeded from that candidate and queues a cover job, and the same index again is a no-op | 400 still generating, index not 0 to 2, or already picked another; 404 not a generation |
| POST | /covers/backfill?limit= | | `{queued}`: one cover job per live recipe with no cover, no cover job pending and no cover ever found for it (a removed cover stays removed); at most `limit` (default 20, max 200) per call, since each search-step cover spends one Claude call | 400 |
| GET | /shopping | | `{list: ShoppingState, recipes: {id,title,yield_unit,yield_count}[]}` | |
| POST | /shopping/build | `{picks: {recipe_id, yield_count}[]}` | `{job_id}` | 400 |
| POST | /shopping/retry | | `{job_id}` | |
| POST | /shopping/manual | `{text}` | `{ok:true}` | 400 |
| POST | /shopping/done | | `{ok:true}` (clears items and picks) | |
| PATCH | /shopping/items/:id | `{ticked}` | `{ok:true}` | 400 |
| GET | /trash | | `{trash: {recipes, variations}}` | |
| POST | /trash/recipes/:id/restore | | `{restored:true, displaced:false}` | |
| POST | /trash/variations/:id/restore | | `{restored:true, displaced}` | 400 |
| GET | /jobs/:id | | `JobPoll {status, error_code, error_text, result_ref}` | 404 |
| POST | /images?role=photo\|capture | raw JPEG bytes | `{id, url, width, height}` | 400, 413 over 8 MiB |

Found covers (issue #44, ADR-043): after a capture or a pick, a background `cover` job looks for a photo of the dish and, when it finds one, adds it to the draft as the last image and names it `cover_image_id`. Its `source_url` is where it was fetched from; photos the household took have `source_url: null`. Save it like any photo: send its id in `image_ids` and, if it is still the cover, as `cover_image_id`. The draft does not wait for it, so poll `GET /drafts/:id` again to see a late one.

Job ids are polled with `GET /jobs/:id` (1.5 s, backing off to 5 s). Image URLs are presigned for 7 days and change daily; cache by image id.
