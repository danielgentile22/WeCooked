-- Issue #64: indexes for the reads that run on every poll, recipe view and
-- job claim, so they search instead of walking the whole table as job
-- history and the book grow.

-- The runner's claim: the oldest queued job. Partial, so it holds only the
-- handful of queued rows however long the history gets.
CREATE INDEX job_queued ON job(created_at, id) WHERE status = 'queued';
-- job_queued replaces it for the claim. Left in place it wins over the
-- selective indexes below for any status IN ('queued','running') lookup.
DROP INDEX job_pending;

-- A variation's latest reconvert or scale job; a recipe's latest scale job,
-- and the draft that became a recipe (cover lookup); a list's latest build
-- and the draft list, by kind.
CREATE INDEX job_variation_kind ON job(variation_id, kind, created_at);
CREATE INDEX job_recipe_kind ON job(recipe_id, kind, created_at);
CREATE INDEX job_kind ON job(kind, created_at);

-- A cover job's owner, the draft or the recipe it looks for, as a real
-- column. input_json stays the one place it is written: the column is
-- generated from it, so no insert path has to keep it in step. Declared TEXT
-- so it compares with job.id and recipe.id through the index (a bare
-- json_extract has no affinity, and SQLite will not use an expression index
-- against a TEXT column).
ALTER TABLE job ADD COLUMN cover_owner TEXT GENERATED ALWAYS AS (
  CASE WHEN kind = 'cover'
       THEN coalesce(json_extract(input_json, '$.draft_id'), json_extract(input_json, '$.recipe_id'))
  END) VIRTUAL;
-- Lookups filter on cover_owner alone, not kind = 'cover' as well: the
-- column is null on every other kind, and a kind term lets job_kind win.
CREATE INDEX job_cover_owner ON job(cover_owner, created_at);

CREATE INDEX image_recipe ON image(recipe_id, created_at);
CREATE INDEX shopping_list_item_position ON shopping_list_item(list_id, position, id);
