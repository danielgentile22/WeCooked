-- Issue #41: job.kind gains 'generate'. SQLite cannot alter a CHECK, so the
-- table is rebuilt. Nothing references job, so no foreign_keys pragma is needed.

CREATE TABLE job_new (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN (
                 'extract_url','extract_paste','extract_photos',
                 'scale','reconvert','shopping_merge','generate')),
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
