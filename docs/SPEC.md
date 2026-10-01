# We Cooked: Build Specification v1

Status: v1 shipped. Written 2026-07-27. Amended 2026-07-29 after a pre-build
review that resolved contradictions and gaps; those changes are recorded as
ADR-024 to ADR-032. Amended 2026-07-30 after a second grilling round that
settled the questions the prototypes and the first review left open; recorded
as ADR-033 to ADR-040.

This document is the contract for building v1. An implementer should be
able to implement the whole application from this file without asking a design
question. Where a decision looks arbitrary, the reasoning lives in
[DECISIONS.md](./DECISIONS.md) as a numbered ADR, referenced inline as `ADR-nn`.

Supporting research, with primary sources, is in
[research/tech-stack.md](./research/tech-stack.md).

---

## 1. What this is

A private recipe book for two people. It holds the
recipes they actually cook with, and it uses Claude at runtime to do the work
that would otherwise need fiddly hand-rolled machinery: reading a recipe off a
web page, reading one off a photo of a cookbook page, rescaling a recipe to a
different number of portions, converting between US and metric units, and
merging several recipes into one shopping list.

Primary device is an iPhone, added to the home screen. Desktop is secondary but
must work properly. Nothing is iOS-specific, so an Android move costs nothing.

### 1.1 Goals

1. Every recipe in the book has been read by a human at least once, so the book
   is trustworthy at the stove.
2. Getting a recipe in is fast and never fails outright: there is always a path
   that works, including for sites that block us and books that are not online.
3. Reading a recipe while cooking is pleasant on a propped-up phone with wet
   hands.
4. Nobody ever recalculates portions by hand.
5. Nobody ever converts cups to grams by hand.
6. The book cannot be lost.

### 1.2 Non-goals for v1

Listed so they are not re-litigated during the build. Each was considered and
deliberately cut (ADR-014).

- Offline support. Explicitly ruled out by the owner.
- Semantic search ("that lemon and chickpea thing"). Strongest v2 candidate.
- Fridge search ("what can I make with these five things").
- Meal planning or calendars.
- Timers parsed out of step text.
- Cook log, favourites, last-cooked dates.
- Sharing outside the app, public links, export, print stylesheets.
- Web push notifications.
- Per-user accounts and attribution.
- Edit history and rollback.
- Voice control.
- Staging environment, error-tracking SaaS.

### 1.3 Scale

Two users. Low hundreds of recipes. Perhaps 30 new recipes a month at an
enthusiastic pace. A few hundred photos. No feature should be justified by
scale, and no design should be complicated to survive load that will not
arrive.

---

## 2. Architecture

### 2.1 Stack

| Layer | Choice | ADR |
|---|---|---|
| Application | SvelteKit (Svelte 5), TypeScript, `adapter-node` | ADR-001 |
| Server | SvelteKit server routes in the same process. No second service. | ADR-002 |
| Database | SQLite on a Fly volume, WAL mode | ADR-021 |
| Durability | Litestream, continuous WAL replication to Cloudflare R2 | ADR-021 |
| Object storage | Cloudflare R2 (photos) | ADR-022 |
| Host | Fly.io, one machine, region `iad` | ADR-017 |
| Domain | `wecooked.kitchen`, Cloudflare Registrar, Cloudflare DNS | ADR-018 |
| LLM | Anthropic Claude Opus 5 (`claude-opus-5`), effort `medium` | ADR-016 |
| Auth | One shared password, signed `HttpOnly` session cookie | ADR-008 |

### 2.2 Shape

One Node process. SvelteKit serves the UI and the API from the same origin.
SQLite is a file on the mounted volume. A single in-process job runner drains a
`job` table. Litestream runs as a sidecar process in the same container,
streaming the WAL to R2. Photos go to R2 and are served directly from R2 to the
phones (free egress, keeps image bytes off the Fly bandwidth bill).

```
iPhone / laptop
      |
      | HTTPS, wecooked.kitchen (Fly TLS, Cloudflare DNS-only)
      v
+-----------------------------------------+
|  Fly machine (iad, shared-cpu-1x, 1 GB) |
|                                         |
|  node (SvelteKit adapter-node)          |
|    - UI routes                          |
|    - API routes                         |
|    - job runner (in-process)  ----------|---> Anthropic API
|                                         |
|  SQLite on /data (volume)               |
|  litestream (sidecar) ------------------|---> R2 bucket (db replica)
+-----------------------------------------+
                                           \
                          photos read/write  --> R2 bucket (images)
```

There is no queue service, no Redis, no separate worker, no websocket server.
The client polls (ADR-010).

### 2.3 Why a job runner rather than request/response

Extraction and scaling take seconds to tens of seconds. iOS aggressively kills
in-flight fetches when the user backgrounds Safari or locks the phone, which is
exactly what a person does while waiting. Work therefore lives in a database
row that survives all of that. See ADR-010 and section 6.

---

## 3. Domain model

### 3.1 Concepts

**Recipe.** The thing you cook. Owns metadata (title, source, tags, times,
notes), a set of images, and one or more variations.

**Variation.** A rendering of the recipe at a particular yield. Exactly one
variation per recipe is flagged `is_original` and is labelled "original" in the
UI, permanently. Other variations are produced by scaling. A variation is
**saved data, not a cache**: it can contain human edits made at the stove, and
those must never be silently destroyed (ADR-012).

**Body.** The actual ingredients and steps, in one unit system. Every variation
has exactly two bodies: `us` and `metric`. One of them is flagged `is_source`,
meaning it is the way the recipe was written; the other is derived
(ADR-019).

**Image.** A photo attached to a recipe. One image per recipe may be flagged as
the cover. Cookbook-page captures live here alongside photos of finished dishes
(ADR-009).

**Job.** A unit of Claude work with a lifecycle the client can poll. For
capture jobs the row is also the draft: until a human saves the review form,
the extraction lives in the job row and nowhere else (ADR-024).

**Shopping list.** A single active list, built from a set of (recipe, yield)
pairs plus manually added lines (ADR-015).

### 3.2 Ingredients and steps

Ingredients are **plain strings, grouped under optional headings** (ADR-003).

```json
[
  { "heading": null,            "items": ["1 onion, finely diced", "2 tbsp olive oil"] },
  { "heading": "For the sauce", "items": ["400 g tinned tomatoes", "1 tsp sugar"] }
]
```

A recipe with no sections has exactly one group with `heading: null`. Nothing
is parsed into quantity, unit, and name. That parsing is what a hand-rolled app
does badly, and it is precisely the job handed to Claude instead.

Steps are a flat ordered array of strings.

```json
["Heat the oil in a wide pan over medium heat.", "Add the onion and cook 8 minutes."]
```

### 3.3 Yield

Yield is a **count plus a unit word** (ADR-020): `4 servings`, `12 muffins`,
`2 loaves`, `1 litre`. Scaling changes the count and never the unit word.
Default unit word is `servings` when the source does not say.

### 3.4 Tags

Five groups, fixed closed vocabulary, assigned by Claude at extraction and
editable by hand (ADR-006, ADR-007). Claude picks only from these lists and
leaves a field empty rather than inventing a value.

**meal_type** (zero or more): `breakfast` `lunch` `dinner` `side` `salad`
`soup` `bread` `dessert` `snack` `sauce` `drink`

**cuisine** (at most one): `italian` `french` `spanish` `greek`
`middle-eastern` `north-african` `indian` `thai` `vietnamese` `chinese`
`japanese` `korean` `mexican` `american` `british` `central-european` `nordic`
`caribbean` `west-african`

**protein** (at most one): `chicken` `beef` `pork` `lamb` `fish` `seafood`
`egg` `tofu` `beans` `cheese` `none`

**effort** (exactly one): `quick` (under 30 minutes total) · `weeknight` (30 to
60) · `project` (over 60, or overnight rests, or proving)

**damage** (exactly one): `tidy` · `messy` · `carnage`

Damage is scored with an explicit rubric so it means the same thing every time.
Count the things that need washing:

| Thing | Points |
|---|---|
| Each pot, pan, baking tray, or mixing bowl | 1 |
| Board and knife together | 1 |
| Blender, food processor, or stand mixer | 2 |
| Deep or shallow frying in oil | +2 |
| Flour, dough, breading, anything dusted | +1 |
| More than one heat source running at once | +1 |

Plates and cutlery you eat off do not count. Anything rinsed and reused
mid-recipe does not count. Total 0 to 2 is `tidy`, 3 to 5 is `messy`, 6 or more
is `carnage`.

Budget roughly three to six tags per recipe.

---

## 4. Database schema

SQLite, WAL mode, foreign keys on. IDs are `TEXT` ULIDs generated in the
application (sortable, no coordination needed). Timestamps are ISO 8601 UTC
strings.

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;   -- safe with WAL + Litestream

CREATE TABLE recipe (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  source_text       TEXT,                 -- "Ottolenghi, Simple, p.112"
  source_url        TEXT,
  yield_unit        TEXT NOT NULL DEFAULT 'servings',
                                          -- shared by every variation; the original
                                          -- COUNT lives on the is_original variation,
                                          -- nowhere else (ADR-030)
  prep_minutes      INTEGER,
  cook_minutes      INTEGER,
  notes             TEXT,                 -- human only, Claude never writes here
  cover_image_id    TEXT REFERENCES image(id) ON DELETE SET NULL,
  source_units      TEXT NOT NULL CHECK (source_units IN ('us','metric')),
  cuisine           TEXT CHECK (cuisine IN (
                      'italian','french','spanish','greek','middle-eastern',
                      'north-african','indian','thai','vietnamese','chinese',
                      'japanese','korean','mexican','american','british',
                      'central-european','nordic','caribbean','west-african')),
  protein           TEXT CHECK (protein IN (
                      'chicken','beef','pork','lamb','fish','seafood','egg',
                      'tofu','beans','cheese','none')),
  effort            TEXT NOT NULL CHECK (effort IN ('quick','weeknight','project')),
  damage            TEXT NOT NULL CHECK (damage IN ('tidy','messy','carnage')),
  content_version   INTEGER NOT NULL DEFAULT 1,   -- bumps on substantive edits only
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  deleted_at        TEXT
);

CREATE TABLE recipe_meal_type (
  recipe_id  TEXT NOT NULL REFERENCES recipe(id) ON DELETE CASCADE,
  meal_type  TEXT NOT NULL CHECK (meal_type IN (
               'breakfast','lunch','dinner','side','salad','soup','bread',
               'dessert','snack','sauce','drink')),
  PRIMARY KEY (recipe_id, meal_type)
);

CREATE TABLE variation (
  id                      TEXT PRIMARY KEY,
  recipe_id               TEXT NOT NULL REFERENCES recipe(id) ON DELETE CASCADE,
  yield_count             REAL NOT NULL,
  is_original             INTEGER NOT NULL DEFAULT 0,
  hand_edited             INTEGER NOT NULL DEFAULT 0,
  based_on_content_version INTEGER NOT NULL,
  scaling_note            TEXT,           -- "what changed" prose, scaled variations only
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  deleted_at              TEXT
);
CREATE UNIQUE INDEX variation_one_original
  ON variation(recipe_id) WHERE is_original = 1 AND deleted_at IS NULL;
CREATE UNIQUE INDEX variation_unique_yield
  ON variation(recipe_id, yield_count) WHERE deleted_at IS NULL;

CREATE TABLE body (
  id               TEXT PRIMARY KEY,
  variation_id     TEXT NOT NULL REFERENCES variation(id) ON DELETE CASCADE,
  unit_system      TEXT NOT NULL CHECK (unit_system IN ('us','metric')),
  is_source        INTEGER NOT NULL DEFAULT 0,
  ingredients_json TEXT NOT NULL,   -- [{heading, items[]}]
  steps_json       TEXT NOT NULL,   -- [string]
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX body_unique ON body(variation_id, unit_system);

CREATE TABLE image (
  id             TEXT PRIMARY KEY,
  recipe_id      TEXT REFERENCES recipe(id) ON DELETE CASCADE,
                                  -- NULL until the draft is saved: capture photos are
                                  -- uploaded before any recipe exists, referenced by id
                                  -- from the job's input_json, and claimed on save
                                  -- (ADR-024)
  r2_key_full    TEXT NOT NULL,   -- normalised upload, long edge <= 3000
  r2_key_display TEXT NOT NULL,   -- long edge 1200, for the UI
  width          INTEGER NOT NULL,
  height         INTEGER NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('capture','photo')),
  created_at     TEXT NOT NULL,
  deleted_at     TEXT
);

CREATE TABLE job (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN (
                 'extract_url','extract_paste','extract_photos',
                 'scale','reconvert','shopping_merge','generate')),  -- generate: migration 002
  status       TEXT NOT NULL CHECK (status IN ('queued','running','done','failed')),
  recipe_id    TEXT REFERENCES recipe(id) ON DELETE CASCADE,
  variation_id TEXT REFERENCES variation(id) ON DELETE CASCADE,
  list_id      TEXT REFERENCES shopping_list(id) ON DELETE CASCADE,
  input_json   TEXT NOT NULL,
  result_json  TEXT,
  error_code   TEXT,      -- machine-readable, see 6.4
  error_text   TEXT,      -- human-readable, shown in the UI
  attempts     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  started_at   TEXT,
  finished_at  TEXT
);
CREATE INDEX job_pending ON job(status, created_at) WHERE status IN ('queued','running');

CREATE TABLE job_quota (
  day   TEXT PRIMARY KEY,   -- 'YYYY-MM-DD' in America/New_York
  count INTEGER NOT NULL    -- Claude API calls made, not jobs created (ADR-027)
);

CREATE TABLE shopping_list (
  id         TEXT PRIMARY KEY,   -- exactly one row, ever (ADR-034)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE shopping_list_recipe (
  list_id     TEXT NOT NULL REFERENCES shopping_list(id) ON DELETE CASCADE,
  recipe_id   TEXT NOT NULL REFERENCES recipe(id) ON DELETE CASCADE,
  yield_count REAL NOT NULL,
  PRIMARY KEY (list_id, recipe_id)
);

CREATE TABLE shopping_list_item (
  id           TEXT PRIMARY KEY,
  list_id      TEXT NOT NULL REFERENCES shopping_list(id) ON DELETE CASCADE,
  section      TEXT NOT NULL,     -- produce | meat-fish | dairy | dry-goods |
                                  -- spices | frozen | other | staples
  text_us      TEXT NOT NULL,
  text_metric  TEXT NOT NULL,
  from_recipes TEXT NOT NULL DEFAULT '[]',  -- json array of recipe ids
  is_manual    INTEGER NOT NULL DEFAULT 0,
  ticked       INTEGER NOT NULL DEFAULT 0,
  position     INTEGER NOT NULL
);

-- Full-text search over the source-unit body of the original variation.
CREATE VIRTUAL TABLE recipe_fts USING fts5(
  recipe_id UNINDEXED,
  title,
  ingredients,
  tags,
  tokenize = 'unicode61 remove_diacritics 2'
);
```

Notes on the schema:

- `content_version` bumps **only** on substantive edits: ingredients, steps, or
  the original yield (which is the `yield_count` of the `is_original` variation,
  ADR-030). Title, tags, notes, source, and images do not bump it (ADR-012).
  Variations compare their `based_on_content_version` to it to know they are
  stale.
- `variation_unique_yield` means you cannot have two variations at 6 portions.
  Asking for a yield that already exists switches to it instead of generating.
- Deletion is always soft (ADR-013). Every read path filters
  `deleted_at IS NULL`. There is no hard delete in the application; purging is a
  manual maintenance task, and at this size may simply never happen.
- `recipe_fts` is rebuilt from the source-unit body of the original variation on
  every save. Do not use triggers; a plain function called from the save path is
  easier to reason about and this is not a hot path.

### 4.1 Migrations

Schema changes after launch (a new tag value, a v2 table) are numbered SQL
files in `migrations/`, applied at boot by a ~15-line runner: read
`PRAGMA user_version`, apply each newer file in its own transaction, bump the
pragma (ADR-032). No migration dependency or tool.

Caveat to plan around: SQLite has no `ALTER COLUMN`, so changing a `CHECK`
constraint (the ADR-007 tag lists) means create-new-table, copy, rename. That
is a property of SQLite, not of the runner.

---

## 5. Claude integration

### 5.1 Model configuration

| Setting | Value | Env var |
|---|---|---|
| Model | `claude-opus-5` | `CLAUDE_MODEL` |
| Effort | `medium` | `CLAUDE_EFFORT` |
| Output | structured outputs via `output_config.format` | |
| SDK retries | `maxRetries: 1` (SDK default is 2) | |
| Timeout | 180 s per call | |

Both model and effort are environment variables so they can change without a
deploy. The API default effort on this generation is `high`; `medium` must be
set explicitly or you get more than you asked for.

`maxRetries: 1` is deliberate and load-bearing. The SDK default of 2 means one
transient failure silently bills three full extractions (ADR-016).

**Prompt caching is off.** Minimum cacheable prefix on Opus 5 is 512 tokens and
the TTL is five minutes. Two people adding a recipe every few days will
essentially never hit a warm cache, so caching would pay the 1.25x write premium
every single time and read it back never. Revisit if a chat-style feature
arrives in v2, where the whole recipe collection becomes a reusable prefix.

**Batch API is off.** It trades latency for cost, and a human is waiting.

### 5.2 The five call kinds

| Kind | Input | Output | Approx cost |
|---|---|---|---|
| `extract` | HTML text, or pasted text, or 1-N images | full `RecipeDraft` | $0.05 to $0.09 |
| `scale` | source body + target yield | `BodyPair` + scaling note | ~$0.06 |
| `reconvert` | one edited body | the counterpart body | ~$0.05 |
| `shopping_merge` | N ingredient lists | grouped shopping items | ~$0.05 |
| `generate` | a description + yield count | three `RecipeDraft` candidates (ADR-042) | ~$0.10 |

### 5.3 Shared output shapes

`BodyPair` is the unit that both `extract` and `scale` produce. Every recipe
body exists in both unit systems at all times (ADR-019).

```jsonc
// BodyPair
{
  "source_units": "us",              // which of the two is as-written
  "us": {
    "ingredients": [{ "heading": "string|null", "items": ["string"] }],
    "steps": ["string"]
  },
  "metric": {
    "ingredients": [{ "heading": "string|null", "items": ["string"] }],
    "steps": ["string"]
  }
}
```

Conversion rules that apply everywhere a `BodyPair` is produced:

1. Convert quantities **ingredient-aware**: a cup of flour is about 120 g, a cup
   of honey is about 340 g. Never apply a generic volume-to-weight ratio.
2. Convert **inside step text** too, not just the ingredient list.
3. Convert **every temperature**: oven, internal, oil, sugar. Round oven
   temperatures to real oven settings (375°F becomes 190°C, not 190.6°C) and
   other temperatures to the nearest whole degree.
4. Convert **pan and tin sizes** (9 inch becomes 23 cm).
5. **Each body uses only its own units.** When the source gives both, as in
   "225°F (110°C)" or "1 lb (450 g)", keep only the matching one. This
   overrides faithful transcription.
6. Convert **nothing else**: leave ingredient names, technique, and phrasing
   identical between the two bodies. The two versions must read as the same
   recipe.
7. Round to quantities a cook can measure. Prefer "1/3 cup" over "0.33 cups" and
   "500 g" over "497 g".

### 5.4 `extract`

Called for all three capture paths: URL, pasted text, and photos. One prompt,
three input types (ADR-011). The URL path always calls Claude even when
schema.org JSON-LD is present, because the derived fields (effort, damage,
cuisine, protein, group headings, unit conversion) do not exist on any page.
When JSON-LD is present it is supplied as **authoritative input**, which makes
it a quality floor rather than a shortcut.

Output schema:

```jsonc
// RecipeDraft
{
  "title": "string",
  "yield_count": 4,
  "yield_unit": "servings",
  "prep_minutes": 15,          // nullable
  "cook_minutes": 40,          // nullable
  "source_text": "string|null",
  "body": { /* BodyPair */ },
  "tags": {
    "meal_type": ["dinner"],
    "cuisine": "italian",      // nullable
    "protein": "beef",         // nullable
    "effort": "weeknight",
    "damage": "messy"
  },
  "damage_reasoning": "string",   // short, shows the rubric arithmetic
  "extraction_warnings": ["string"]  // e.g. "step 4 was cut off at the page edge"
}
```

`extraction_warnings` is surfaced at the top of the review form. It is not a
confidence score (those were rejected, ADR-004); it is for concrete, observable
gaps such as a cropped photo or a paywalled page.

System prompt skeleton:

```
You extract recipes into structured data for a private two-person recipe book.

Rules:
- Transcribe ingredients and steps faithfully. Do not improve, shorten, or
  modernise the recipe. Do not add ingredients that are not stated.
- Preserve ingredient section headings ("For the sauce") as groups. If the
  recipe has no sections, return one group with a null heading.
- Ingredients stay as human-readable strings, exactly as a cook would read them.
- Produce the recipe in BOTH US and metric units. Follow the conversion rules.
- Assign tags ONLY from the fixed vocabulary below. Never invent a tag value.
  Leave cuisine or protein null if unsure. effort and damage are required.
- Score damage with the rubric below and show your arithmetic in
  damage_reasoning.
- If part of the source is unreadable, missing, or cut off, transcribe what you
  can and describe the gap in extraction_warnings. Never invent the missing
  part.

[tag vocabulary]
[damage rubric]
[conversion rules]
```

User content per path:

- **URL**: `{stripped page text}`, then `Page description: {og:description
  or meta description}` when the page has one (an Instagram reel keeps its
  caption there), then, when found, `Authoritative structured data from the
  page (schema.org Recipe JSON-LD), use these ingredients and steps verbatim:
  {json}`. Blocks are joined by blank lines and empty ones are skipped.
- **Paste**: the pasted text as-is.
- **Photos**: 1 to N image blocks, then `These images are pages of a printed
  cookbook, in order. They may be a two-page spread or a recipe continued on a
  later page. Treat them as one recipe.`

### 5.5 `scale`

Scaling is not multiplication (ADR-012). Input is the **metric** body of the
source variation and the target yield; scaling reasons in metric because grams
scale cleanly and cups do not. Output is a full `BodyPair` plus a note.

```jsonc
{
  "body": { /* BodyPair */ },
  "scaling_note": "string"
}
```

Prompt rules:

```
Rescale this recipe from {from_count} {unit} to {to_count} {unit}.

- Do NOT scale everything linearly. Salt, spices, chilli, and strong aromatics
  scale sublinearly. Leavening (yeast, baking powder) scales sublinearly when
  scaling up. Fat for greasing a pan scales with the pan, not the recipe.
- Adjust pan and tin sizes, and say the new size explicitly.
- Adjust cook times, but state them as guidance and give a sensory check
  ("until the edges pull away"), because scaled times are genuinely uncertain.
- Rewrite the STEPS as well as the ingredients: quantities, tins, and times all
  appear in step text and must agree with the ingredient list.
- Produce both US and metric bodies.
- In scaling_note, in one to three short lines, name what did NOT scale
  linearly and anything the cook must watch. This is the part that makes the
  result trustworthy.
```

Range is capped at 0.25x to 4x of the original yield. Outside the cap the job
still runs, but `scaling_note` must lead with a warning that this is a large
change and times are a starting point only.

### 5.6 `reconvert`

Triggered when a human edits a body (ADR-019). Input is the edited body and its
unit system; output is the counterpart body only. This preserves the invariant
that the two unit systems always agree.

```jsonc
{ "ingredients": [...], "steps": [...] }
```

### 5.7 `shopping_merge`

Input is a list of `{recipe_title, recipe_id, ingredients}` drawn from the
**metric** body of the correct variation for each recipe, plus the US body for
the dual-unit output. Output is a flat list of grouped items.

```jsonc
{
  "items": [
    {
      "section": "produce",
      "text_us": "3 cloves garlic",
      "text_metric": "3 cloves garlic",
      "from_recipes": ["<recipe_id>", "<recipe_id>"],
      "is_staple": false
    }
  ]
}
```

Prompt rules:

```
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
- Record which recipes each line came from.
- Do not add anything that is not in the input lists.
```

Lines returned with `is_staple: true` are stored with `section = 'staples'`,
which is why the schema's `CHECK` list has eight values and the prompt names
seven.

The `shopping_merge` **job** is the whole build: when the runner executes it,
it first generates any missing variations inline via `scale` calls (each saved
as a real variation, per ADR-015), then makes the single merge call (ADR-027).
The client polls one job for the whole thing.

### 5.8 Images sent to Claude

- Long edge resized to **2576 px**, JPEG quality 85.
- Never send the raw camera file: iPhone photos are 12 to 24 MP and over 10 MB,
  the API caps at 10 MB, and the server downscales anyway, so full resolution
  buys nothing and costs latency and tokens.
- Do not push JPEG quality below 80. Anthropic's own docs warn heavy compression
  makes text hard to read, and this is a page of printed text.
- **Claude does not read EXIF orientation.** Pixels must be physically rotated
  before sending. See section 8.2; this is the single most likely
  implementation bug in the whole app.

### 5.9 Spend guards

Three independent backstops, because each can fail on its own (ADR-016):

1. **`DAILY_CALL_CAP = 50`** Claude calls per calendar day (America/New_York),
   counted in `job_quota` and checked inside the API wrapper before every call
   (ADR-027). Calls rather than jobs, because one shopping-list build job can
   make several calls. Hitting the cap fails the job with a clear error rather
   than silently queueing. A stuck loop at the cap costs about $4.50 a day
   rather than an unbounded amount.
2. **`maxRetries: 1`** on the SDK.
3. **A spend limit set in the Anthropic Console**, which does not depend on the
   application code being correct.

---

## 6. Job system

### 6.1 Lifecycle

```
queued --> running --> done
                  \--> failed
```

Created by an API route, drained by an in-process runner. Concurrency 2 (two
users, and Opus latency is moderate). The runner polls the table every 500 ms
and takes work with a transactional claim (`UPDATE job SET status='running' ...
WHERE id = ? AND status='queued'`), so a future second process cannot double-run
a job.

### 6.2 Startup recovery

On boot, any job left in `running` is reset to `failed` with
`error_code = 'interrupted'`. A deploy mid-extraction should surface as a
visible failure the user can retry, not as a row that hangs forever.

### 6.3 Polling contract

`GET /api/jobs/:id` returns `{status, error_code, error_text, result_ref}`.

Client polls every **1.5 s**, backing off to 5 s after 30 s, and stops at 5
minutes with a timeout message. No websockets for two users.

### 6.4 Error codes and what the UI says

| `error_code` | Cause | UI copy |
|---|---|---|
| `fetch_blocked` | 403 or 401 from the recipe site | "This site blocks automated readers. Copy the recipe text and paste it instead, or screenshot the page." |
| `fetch_failed` | timeout, DNS, 5xx | "Could not load that page. Paste the text instead?" |
| `no_recipe_found` | model found nothing recipe-shaped | "Could not find a recipe there. Try pasting the text or a photo." |
| `image_unreadable` | model could not read the photo | "Could not read that photo. Try again with more light, or crop tighter on the recipe." |
| `quota_exceeded` | daily cap hit | "Daily limit reached (50 Claude calls). This usually means something is stuck." |
| `api_error` | Anthropic 5xx or timeout | "Claude is unavailable right now. Try again in a minute." |
| `interrupted` | server restarted mid-job | "That was interrupted by a restart. Tap to try again." |

Every failed capture job leaves a **draft the user can open**: the review form,
empty, with the source URL, pasted text, or photos already attached (ADR-004).
A failure is never a dead end.

### 6.5 The job row is the draft

There is no draft state in the `recipe` table and no placeholder rows
(ADR-024). Until Save, a capture lives entirely in its job row: `input_json`
holds the source (URL, pasted text, or uploaded image ids), `result_json`
holds the extraction once done. The review form is seeded from those. Photos
uploaded before extraction have `recipe_id = NULL` and are claimed by the
recipe on save. The browse list unions in every capture job that has not yet
produced a recipe, as cards above the saved recipes: queued and running
("extracting"), failed ("failed, tap to fix"), and done but unsaved ("ready
to review"). On Save the new recipe's id is written to the job row's
`recipe_id`, so the card condition is simply capture kind plus
`recipe_id IS NULL`; saved jobs disappear from browse but stay in the table
(ADR-035). A recipe row always means a human confirmed it (Goal 1).

Failed and ready-to-review drafts carry a **Discard** action (in the review
form, not a swipe gesture). Discard hard-deletes the job row and soft-deletes
its capture images: a job row is machine output, not human work, so the
no-silent-destruction principle does not apply to it (ADR-035). Running jobs
cannot be cancelled; they finish in seconds and can then be discarded.

A **generation** (issue #41, ADR-042) is a fourth draft kind. Its job row
holds the description and yield count as input and three candidate
`RecipeDraft`s as result. Browse shows it as one card ("generating", then
"choose a recipe"). Picking a candidate records the index on the same row,
which then reads as a ready draft seeded from that candidate; the review
form and Save are the ones above. The saved recipe records the description
as its `source_text` and has no `source_url`.

---

## 7. Features

### 7.1 Capture

Four entry points, **one destination**: the review form (ADR-004). This is the
single most important structural decision in the app. There is exactly one
recipe editor, and everything funnels into it.

```
  paste a URL  -----\
  paste text   ------\
  take photos  -------> [ extract job ] --> review form --> saved recipe
  type it      -------------------------------^
```

**URL path.**

1. The phone renders the page first (ADR-041). The share sheet and the Add tab
   load the URL in an offscreen WKWebView and post the rendered HTML alongside
   the link as `{url, html}`. A real WebKit on a residential address is what
   the big publishers let through; the server's own fetcher is not.
2. The server reduces the rendered HTML at ingest: readable text, the page's
   `og:description` (an Instagram reel keeps its whole caption there and
   nothing in the body), and the schema.org Recipe JSON-LD as authoritative
   input. The job row stores the reduced content, never the raw page.
3. Without `html` (the web app, or a phone that could not render the page),
   the server fetches the URL itself: timeout 10 s, `User-Agent` set to a
   normal desktop browser string, follow up to 5 redirects, trailing
   punctuation Google appends to redirect targets stripped.
4. On 401, 402, 403 or 429 from that fetch, fail immediately with
   `fetch_blocked`. Do not retry, do not escalate to a headless browser
   (ADR-010).
5. Parse `<script type="application/ld+json">` for a `Recipe` object (including
   inside `@graph` arrays). If found, pass it as authoritative input.
6. Strip the HTML to readable text before sending: a modern recipe blog is
   300 kB of HTML around 2 kB of recipe, and stripping cuts input tokens by an
   order of magnitude and stops the model latching onto the wrong content.
7. Run `extract`. When the page yields nothing and the capture carried a
   caption (`text`), extract from the caption with the link as the source.

**Paste path.** The same input box accepts a URL or a block of text. If it
parses as a URL, take the URL path; otherwise treat it as recipe text. This is
the universal escape hatch: it works for blocked sites, paywalled sites you are
logged into on your phone, emails, and text messages.

**Photo path.** Camera or library, **multiple images per extraction** (a
two-page spread, or a recipe continued overleaf). Images upload before any
recipe exists (`recipe_id` null, ids recorded in the job's `input_json`,
ADR-024), get `role = 'capture'`, and are claimed by the recipe on save. They
stay attached forever, so the source is always there when an extraction turns
out to have dropped a step.

**Manual path.** Straight to an empty review form. A first-class path, not an
afterthought.

**iOS limitation worth writing down:** the Share Sheet cannot hand a URL to a
web app. The Web Share Target API is Chrome and Android only. Copy and paste is
the ceiling on iOS, and this is not something to keep trying to solve.

### 7.2 Review form (the single editor)

Used for: reviewing an extraction, editing an existing recipe, manual entry.

Fields, in order:

1. Extraction warnings banner, if any.
2. Title (required).
3. Cover image picker, plus the image strip.
4. Yield: number stepper plus unit word.
5. Prep minutes, cook minutes (both optional).
6. Unit-system indicator showing which body is the source, and a toggle to view
   or edit the other.
7. Ingredient groups: heading (optional) plus a list of lines. Add and remove
   groups, add, remove, and reorder lines.
8. Steps: ordered lines, add, remove, reorder.
9. Tags: chips per group, meal type multi-select, cuisine and protein single,
   effort and damage required single.
10. Source text, source URL.
11. Notes.

Save rules:

- Required: title, yield count, at least one ingredient line.
- Steps may be empty (a spice mix is a legal recipe).
- Editing **either** body marks the variation `hand_edited`, moves `is_source`
  to the edited body (ADR-028), and enqueues a `reconvert` job for the
  counterpart (ADR-019). Save returns immediately; the counterpart updates
  within seconds. While that reconvert is queued, running, or failed, the
  counterpart body shows a banner: "Not yet updated from your edit" or
  "Couldn't update, tap to retry" (ADR-028). Detected from the job table, no
  schema for it.
- Editing ingredients, steps, or the original yield bumps `content_version` and
  therefore marks scaled variations stale (ADR-012). Editing title, tags, notes,
  source, or images does not.
- Saving rebuilds the `recipe_fts` row.
- The form keeps a **sessionStorage draft**, keyed by job id (recipe id when
  editing an existing recipe, a fixed key for manual entry): written on every
  change, restored silently when the same form reopens, cleared on Save or
  Discard (ADR-038). No server-side drafts, no beforeunload prompt; iOS
  evicting the PWA mid-edit must not cost typed corrections.
- Concurrent saves from both phones are **last write wins**, accepted and
  recorded as known risk 7 (ADR-039).

### 7.3 Browse and search

One list, newest first. Each row: cover thumbnail, title, effort chip, damage
chip. A recipe with no cover shows a neutral tile: surface color with the D16
pot glyph, identical for every coverless recipe (UI.md D17). Unsaved capture
jobs appear as cards at the top (section 6.5); they are read from the `job`
table, not phantom recipe rows.

A search box filters as you type, server-side, over `recipe_fts` (title,
ingredients, tags). Below it, tag chips act as filters, combined with AND across
groups and OR within a group.

Chips are never colour-only. Every chip carries its word (`carnage`, `quick`),
because meaning encoded in red versus green is unreadable for this user.

### 7.4 Recipe view and cooking screen

This is where 95% of the time is spent: phone propped up, wet hands, glancing
across the kitchen (ADR-005).

Layout, top to bottom:

- Title, cover image, source line.
- Tag chips.
- **Yield control**: chips for every existing variation (`4 · original`, `8`,
  `12`) plus a stepper for a new number. See 7.5 for the interaction rules.
- **Unit toggle**: US / metric, remembered per device, with a small "as written"
  marker on whichever body carries `is_source`, which means the body a human
  last authored; the other is always machine-converted (ADR-028).
- Ingredients: a **collapsible sticky block** that stays reachable while
  scrolling the steps. Scroll position is never lost.
- Steps.
- Notes.
- Image strip, including the original cookbook captures.

Behaviour:

- **Wake lock while a recipe is open.** `navigator.wakeLock.request('screen')`,
  re-acquired on `visibilitychange`, released on navigate away. Non-negotiable
  for a cooking app.
- **Tap a step or ingredient to strike it through.** Per session, per device:
  kept in `sessionStorage` keyed by variation id, so strikes survive a locked
  phone or an accidental tab-away mid-cook, and evaporate by the next day
  (ADR-036). No DB writes, no sync. (Contrast with shopping list ticks, which
  are shared and persisted, because one person is in the shop and the other is
  at home.)
- **Large type by default**, sized for arm's length rather than phone-in-hand.

### 7.5 Portion variations

The rule that governs the whole interaction: **changing the number never
triggers work** (ADR-012).

- Existing variations are chips. Tapping one switches instantly, no call, no
  spinner, because they are saved rows.
- The stepper picks a number you do not have. Moving 4 to 5 to 6 to 7 does
  nothing at all.
- The stepper moves in whole steps, and the number itself is a tappable
  numeric input accepting any positive value with up to one decimal place
  (ADR-037): 0.5 halves a 1-litre stock, and "2 loaves" can become 1. Input
  is rounded to one decimal; zero and negatives are rejected. Chips display
  the decimal as typed.
- When the chosen number has no variation, a button appears: **"Calculate for
  7"**. Only that button spends money.
- While the job runs, the screen keeps showing the recipe you were reading, with
  a working indicator. Lock the phone and it still finishes.
- On completion the new count becomes a chip and is instant forever.
- The stepper snaps back to the currently-viewed yield when you navigate away
  and return, so no stale "Calculate for 5" button lingers.
- Variations are deletable. The original is not.

**Staleness.** When `recipe.content_version` advances past a variation's
`based_on_content_version`:

| Variation | Behaviour |
|---|---|
| `hand_edited = 0` | Regenerates lazily on next open, stale-while-revalidate (ADR-029): the old body shows immediately with a banner "The original changed, updating this version…", the scale job runs behind it, and the body swaps in when done (banner flips to "updated"). On failure or a cap hit, the stale body stays fully usable and the banner reads "couldn't update, tap to retry". Cooking is never blocked, and you never pay for variations you never open again. |
| `hand_edited = 1` | Never touched automatically. Shows a banner: "The original changed after you edited this version." Two actions: **Recalculate** (warns that your edits will be lost, then soft-deletes the whole variation into Trash and creates a fresh one at the same yield, ADR-025) or **Keep mine** (dismisses permanently by advancing `based_on_content_version`). |

This asymmetry is the point: an untouched variation is a Claude call worth
fractions of a cent, and a hand-edited one contains work done at the stove that
must never be destroyed silently.

### 7.6 Shopping list

One active list (ADR-015).

1. Multi-select recipes from the browse list.
2. Set a yield per recipe.
3. **Build list.**

The build **uses variations, never raw originals**. If a 6-portion variation
exists it is used, including any stove-side corrections. If it does not exist,
it is generated first and saved as a variation. Slightly more work than one
big prompt, and it guarantees the shopping list and the recipe you cook from
can never disagree.

The whole build is **one `shopping_merge` job** (ADR-027): the runner
generates any missing variations inline via `scale` calls, then makes the
merge call. One job to poll, survives a locked phone, and a mid-build failure
is benign because variations saved before the failure persist, so a retry
only pays for what is left.

List behaviour:

- Sections in order: produce, meat and fish, dairy, dry goods, spices, frozen,
  other, then **"check you have"** (staples) collapsed at the bottom. Staples
  are separated, never dropped.
- Every line shows both unit systems, primary first per the device toggle:
  "500 g flour (about 1 lb 2 oz)".
- Every line records which recipes it came from, so removing a recipe makes the
  consequences visible.
- **Ticking is shared and persisted.** Both phones see the same ticks. This is
  the one piece of state that must sync, and it syncs by polling (ADR-033):
  while the Shopping tab is visible, the client polls `GET /api/shopping-list`
  every 5 s, pauses when the page is hidden, and refetches immediately on
  `visibilitychange` back to visible. A tick is a per-item POST, applied
  optimistically on the ticking phone. Conflicts are last write wins per item;
  a double tick is idempotent. No websockets.
- Manual lines can be added by hand and survive rebuilds.
- **Share as text** (native app). A toolbar share button opens the system
  share sheet with the list as plain text: unticked lines one per line in
  list order, then the unticked staples under a "Check you have" line. Ticked
  lines are left out. The button is disabled while a build runs and when
  nothing is left to buy. No server involvement; the sheet's own Copy is how
  the list gets into another shop's app.
- Changing the recipe set rebuilds the merge. Ticks are preserved where item
  text matches exactly and reset otherwise. This is a deliberately dumb rule:
  fuzzy matching would sometimes keep a tick it should not, which is worse in a
  shop than an extra unticked line.
- **"Done shopping"** hard-deletes every item (manual lines included: done
  means you bought the bin bags) and every `shopping_list_recipe` row, behind
  the two-step confirmation settled in the prototype. The single
  `shopping_list` row lives for the app's whole life; there is no archive and
  no list history (ADR-034).

### 7.7 Trash

One screen listing soft-deleted recipes and variations (ADR-013). A
recalculation replaces the whole variation, so the trashed row carries the
hand-edited bodies with it (ADR-025); there is no separate body-level trash.
Restore puts things back, and **Restore always wins** (ADR-025): if a live
variation occupies the same yield, it is displaced into Trash and the restored
one takes the slot, with a message saying so. Reversible in both directions.
Nothing purges automatically in v1; a few hundred rows weigh nothing.

Trash is the safety net for deletions, and the review form is the safety net for
extractions. **Nothing catches a bad edit to an existing recipe**: edit history
was considered and cut. This is a known, accepted gap.

---

## 8. Implementation notes that will otherwise bite

### 8.1 Image pipeline

The camera file never reaches the server intact, on purpose:

1. **Client**: read the file, decode with `createImageBitmap(file, {
   imageOrientation: 'from-image' })`, draw to a canvas at a long edge of at
   most 3000 px, export JPEG at quality 90. Upload that.
   - This bakes EXIF orientation into the pixels, sidesteps HEIC decoding on the
     server entirely (Safari decodes HEIC natively; `sharp` needs libheif), and
     caps a 10 MB camera file at 1 to 2 MB, which matters on cellular.
2. **Server**: store the upload as `r2_key_full`. Derive `r2_key_display` at
   1200 px long edge, and a 2576 px quality-85 JPEG for Claude.

**Deliberate deviation, stated plainly:** "store the original" means the
normalised 3000 px JPEG, not the untouched camera file. The true original is not
retained. The trade is a much simpler pipeline and no server-side HEIC support,
against losing the ability to re-derive from full sensor resolution years later.
At 3000 px a cookbook page is already far beyond what any model needs.

### 8.2 The EXIF trap

Claude does **not** read EXIF orientation. A resize step that strips metadata
without rotating pixels hands Claude a sideways cookbook page, and the failure
looks like "the model is bad at photos" rather than like a bug. The client-side
canvas step above is what prevents it. **Write a test that runs a known
rotated-EXIF fixture through the pipeline and asserts the output dimensions
flip.**

### 8.3 SQLite and Litestream

- `min_machines_running = 1`. Do **not** enable scale-to-zero to save three
  dollars: cold start is latency in front of "I want to look at a recipe right
  now", and a SQLite app with a volume does not want to be stopped.
- Exactly one machine. Two machines with one volume is data corruption.
- Litestream runs as a sidecar in the same container, replicating to R2.
- Raise Fly volume snapshot retention above the 5-day default. Snapshots are
  under the free tier at this size.
- Fly's own docs state a single volume can lose data and that daily snapshots
  "may not have your latest data". Litestream is therefore mandatory, not
  optional (ADR-021).
- LiteFS was considered and rejected: no commits since April 2025, and Fly's
  docs say they cannot support it.

### 8.4 Restore drill

**This is a build step, not a suggestion.** Before the app is trusted with real
recipes:

1. Add several recipes with photos.
2. `litestream restore` the database to a laptop.
3. Open the restored file, confirm the recipes and their variations are present.
4. Confirm the R2 image keys referenced in that database resolve.
5. Write down the exact restore command in `docs/RUNBOOK.md`.

An untested backup is a belief, not a backup. The failure mode here is losing a
book built over years.

### 8.5 Auth details

- One shared password. No usernames, no accounts (ADR-008).
- `APP_PASSWORD_HASH` is an Argon2id hash in a Fly secret. The plaintext is
  never in the repo, the database, or a log line.
- Session is a signed cookie (HMAC over an issued-at timestamp with
  `SESSION_SECRET`), one year expiry, `HttpOnly`, `Secure`, `SameSite=Lax`,
  `Path=/`. No session table: rotating `SESSION_SECRET` invalidates every
  session, which is the entire revocation story and is correct for two people.
- **The year slides** (ADR-031): on any authenticated request whose cookie
  issued-at is older than 30 days, re-issue a fresh cookie in the response.
  Anyone using the app even monthly never sees the login screen again.
- Rate limit failed logins: 5 attempts per IP per 15 minutes, in memory. Read
  the client IP from the `Fly-Client-IP` header, not the socket address, or
  every attempt appears to come from Fly's proxy. The whole app is one long
  brute-force target otherwise.
- Every route except `/login` and the health check requires the cookie. Enforce
  in a single `hooks.server.ts` handle, not per route, so a new route cannot
  forget.
- Incident response if the password leaks: change it, redeploy, both people
  re-enter it once. That is the whole plan.

### 8.6 Serving images from R2

The bucket is **private**; its contents include photographed pages of
copyrighted cookbooks and photos from inside the house (ADR-026). The server
generates presigned GET URLs (SigV4) when rendering a page, expiry 7 days
(the SigV4 maximum), and phones fetch the bytes directly from R2, so free
egress and zero Fly bandwidth are preserved.

One line that matters: round the signing timestamp to the day, so URLs are
stable for 24 hours and the browser cache works within a cooking session.
A naively-signed URL changes on every render and defeats caching entirely.

### 8.7 PWA

- `manifest.webmanifest`: `name` "We Cooked", `short_name` "We Cooked",
  `display: standalone`, `theme_color`, `background_color`, icons at 180, 192,
  512, plus a maskable 512.
- `apple-mobile-web-app-capable` and status bar style meta tags for iOS.
- Respect `env(safe-area-inset-*)` on every fixed element, or the sticky
  ingredient block collides with the home indicator.
- No service worker in v1. Offline is out of scope, and a service worker with
  nothing to cache is a stale-asset bug waiting to happen.

### 8.8 Tests

Vitest (already in the SvelteKit template), unit tests only, covering the
handful of pure logic where a silent bug costs real work (ADR-040):

1. The EXIF rotation fixture (section 8.2), the one test the spec mandates.
2. `content_version` bump rules: which edits mark variations stale.
3. Tick preservation on rebuild: exact text match keeps, anything else resets.
4. The migration runner.
5. The daily-cap check in the API wrapper.

No browser or E2E suite, no component tests, no coverage targets. Two users,
and the review form is the integration test.

---

## 9. Deployment and operations

### 9.1 Fly

- App region `iad` (Ashburn, Northern Virginia).
- One machine, `shared-cpu-1x`. Start at **1 GB** rather than 512 MB: server-side
  image derivation with `sharp` wants headroom. About $5.92/month.
- One volume, 3 GB, mounted at `/data`.
- `min_machines_running = 1`, `auto_stop_machines = false`.
- Health check on `/healthz`, which checks the SQLite file is writable.

### 9.2 DNS

`wecooked.kitchen`, registered at Cloudflare Registrar, DNS at Cloudflare.

Point `A` and `AAAA` records at Fly with the **proxy off** (grey cloud, DNS
only). Orange-cloud proxying in front of Fly means two CDNs, a more awkward TLS
handshake, and Cloudflare's certificate handling fighting Fly's automatic
issuance. Fly terminates TLS itself.

### 9.3 Secrets and configuration

| Name | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | API access |
| `APP_PASSWORD_HASH` | Argon2id hash of the shared password |
| `SESSION_SECRET` | Cookie signing key; rotating it logs everyone out |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | Object storage |
| `LITESTREAM_*` | Replica credentials (may reuse the R2 pair) |
| `CLAUDE_MODEL` | `claude-opus-5` |
| `CLAUDE_EFFORT` | `medium` |
| `DAILY_CALL_CAP` | `50` (Claude calls per day, ADR-027) |

All set with `fly secrets set`. Locally they live in `.env`, which is
gitignored **in the first commit**, before any key is ever written to it.

### 9.4 Deploy

`fly deploy` from the laptop. GitHub repo, work on branches, PRs for
review.

No GitHub Actions pipeline in v1: it is a deploy token, a workflow file, and a
slower feedback loop, to automate a command run twice a week. Add it the first
time something broken ships from an uncommitted working directory.

No staging environment. A second copy of a two-person recipe book is a second
thing to keep alive for no benefit.

### 9.5 Cost

| Line | Monthly |
|---|---|
| Fly machine, shared-cpu-1x, 1 GB | $5.92 |
| Fly volume, 3 GB | $0.45 |
| Volume snapshots | $0.00 (under the free tier) |
| Bandwidth | ~$0.10 |
| Cloudflare R2 | $0.00 (under the 10 GB free tier) |
| Anthropic, Opus 5 at medium effort | ~$3.50 |
| **Total** | **~$10/month** |
| Domain | ~$25/year at Cloudflare wholesale |

Anthropic estimate assumes 30 new recipes, 20 scalings, and 8 shopping lists per
month. Per-call estimates are in section 5.2. The medium-effort reasoning-token
overhead is an assumption, not a documented figure; if it is heavier than
estimated the monthly total moves to about $12, which changes nothing.

---

## 10. Build order

Each phase ends somewhere usable. Do not build phase N+1 before N works on a
phone.

1. **Skeleton.** SvelteKit app, Dockerfile, `fly.toml`, volume, SQLite with the
   schema and the migration runner (section 4.1), `/healthz`, deployed at
   `wecooked.kitchen`. Auth and the session cookie. Nothing else. Confirm it
   loads on both phones.
2. **Durability.** Litestream sidecar, R2 bucket, and the section 8.4 restore
   drill. Do this before there is anything worth losing, not after.
3. **Manual recipes.** The review form, the recipe view, the browse list, soft
   delete, Trash. No Claude at all yet. At the end of this phase the app is
   already a usable recipe book.
4. **Images.** Client-side normalisation, R2 upload, derived sizes, cover
   selection, the EXIF fixture test.
5. **The job system.** Table, in-process runner, polling endpoint, startup
   recovery, the daily cap, and every error code rendered in the UI.
6. **Extraction.** Paste path first (no fetching, no images, simplest input),
   then URL with JSON-LD, then photos. Each lands in the review form.
7. **Units.** Dual bodies, the toggle, `reconvert` on edit.
8. **Variations.** The yield control, the calculate button, staleness rules.
9. **Shopping list.**
10. **Polish.** Wake lock, strike-through, large type, safe-area insets, the
    PWA manifest and icons.

UI prototypes for the review form, the cooking screen, the browse list, and the
shopping list are produced before phase 3, and reviewed by the owner.

---

## 11. Known risks

1. **A bad edit to an existing recipe is unrecoverable.** Edit history was cut
   (ADR-013). Accepted.
2. **Reliance on Claude's judgment for damage, effort, and conversions.** The
   review form is the only check. Mitigated by using Opus 5 rather than a
   cheaper tier, which was an explicit cost-for-quality trade (ADR-016).
3. **Site blocking will get worse.** Four major recipe sites already 403 a
   server-side fetch. The paste path is the permanent answer and must stay
   first-class, never buried (ADR-010).
4. **Single machine, single volume.** No redundancy. Recovery is Litestream, and
   recovery time is however long a `fly deploy` and a restore take. For a recipe
   book, correct.
5. **Ingredient-aware unit conversion can be wrong**, and a wrong conversion in
   baking ruins a bake. The "as written" marker means the human-authored body
   is always identifiable, even after edits, because `is_source` follows the
   last hand-edited body (ADR-028). That is the mitigation.
6. **Medium-effort token overhead is estimated, not documented.** Watch the
   first month's actual bill.
7. **Concurrent edits are last write wins.** Both phones saving the same
   recipe means the first save is silently overwritten (ADR-039). Accepted:
   it is the same exposure as risk 1, and locking machinery for a two-person
   household is not worth it.
