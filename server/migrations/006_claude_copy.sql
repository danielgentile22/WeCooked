-- Issue #71: the copy of a capture photo that Claude reads, built at upload so
-- the photo job only downloads it. NULL for recipe photos, which never go to
-- Claude, and for captures uploaded before this column existed (the job
-- derives those from r2_key_full).
ALTER TABLE image ADD COLUMN r2_key_claude TEXT;
