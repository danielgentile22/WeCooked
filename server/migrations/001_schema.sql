-- SPEC section 4. Per-connection PRAGMAs (WAL, foreign_keys, busy_timeout,
-- synchronous) are set in src/lib/server/db.ts, not here.

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
                 'scale','reconvert','shopping_merge')),
  status       TEXT NOT NULL CHECK (status IN ('queued','running','done','failed')),
  recipe_id    TEXT REFERENCES recipe(id) ON DELETE CASCADE,
  variation_id TEXT REFERENCES variation(id) ON DELETE CASCADE,
  list_id      TEXT REFERENCES shopping_list(id) ON DELETE CASCADE,
  input_json   TEXT NOT NULL,
  result_json  TEXT,
  error_code   TEXT,      -- machine-readable, see SPEC 6.4
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
