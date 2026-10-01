-- Issue #42: capture-ready push. One row per phone install that registered
-- for notifications, keyed by the device id the app sends as X-Device-Id.
CREATE TABLE device (
  id          TEXT PRIMARY KEY,
  push_token  TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('sandbox','production')),
  updated_at  TEXT NOT NULL
);

-- The phone that queued the job, so its push reaches only that phone.
ALTER TABLE job ADD COLUMN device_id TEXT;
