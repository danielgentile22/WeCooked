-- A draft conversion's draft (issue #67), as a real column, for the same
-- reasons as 005's cover_owner: generated from input_json so no insert path
-- keeps it in step, declared TEXT so it compares with job.id through the
-- index. Null on every other job, a variation's reconvert included, so it
-- also tells the claim and the prune which reconverts the cook is waiting on
-- and which hold a draft's counterpart body.
ALTER TABLE job ADD COLUMN conversion_draft TEXT GENERATED ALWAYS AS (
  CASE WHEN kind = 'reconvert' THEN json_extract(input_json, '$.draft_id') END) VIRTUAL;
CREATE INDEX job_conversion_draft ON job(conversion_draft, created_at);
