-- Issue #44: found covers. image.source_url marks an image fetched from the
-- web; role stays 'photo'. image is altered, not rebuilt: recipe.cover_image_id
-- references it ON DELETE SET NULL, so a rebuild would null every cover.
ALTER TABLE image ADD COLUMN source_url TEXT;

-- job.kind gains 'cover', rebuilt as in 002. Nothing references job.
CREATE TABLE job_new (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN (
                 'extract_url','extract_paste','extract_photos',
                 'scale','reconvert','shopping_merge','generate','cover')),
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

INSERT INTO job_new (id, kind, status, recipe_id, variation_id, list_id, input_json,
                     result_json, error_code, error_text, attempts, created_at,
                     started_at, finished_at)
SELECT id, kind, status, recipe_id, variation_id, list_id, input_json,
       result_json, error_code, error_text, attempts, created_at,
       started_at, finished_at
FROM job;

DROP TABLE job;
ALTER TABLE job_new RENAME TO job;
CREATE INDEX job_pending ON job(status, created_at) WHERE status IN ('queued','running');
