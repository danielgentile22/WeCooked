# Runbook

## Restore the database from R2 (SPEC 8.4)

Litestream replicates `/data/wecooked.db` continuously to the private R2
bucket `wecooked` under the `litestream/` prefix. Litestream version is
pinned to **0.5.11** in the Dockerfile; restore with the same minor version
(`brew install litestream`, check `litestream version`).

### Credentials

From the Cloudflare R2 API token (same one the app uses, stored as Fly
secrets). Never paste them into a file that gets committed.

```sh
export LITESTREAM_ACCESS_KEY_ID=...      # R2 token access key ID
export LITESTREAM_SECRET_ACCESS_KEY=...  # R2 token secret
export R2_ENDPOINT_HOST=<account_id>.r2.cloudflarestorage.com
```

### The restore command

```sh
litestream restore -o wecooked-restored.db \
  "s3://wecooked.$R2_ENDPOINT_HOST/litestream/wecooked.db"
```

### Verify

```sh
sqlite3 wecooked-restored.db "PRAGMA integrity_check;"
sqlite3 wecooked-restored.db ".tables"
sqlite3 wecooked-restored.db "SELECT count(*) FROM recipes;"
```

Once photos exist: pick a few `r2_key_full` values from the restored database
and confirm the objects exist in the bucket.

### Drill log

| Date | Restored by | Result |
|------|-------------|--------|
| _pending_ | | |

## Fly volume snapshots

Secondary safety net only (Fly's docs: snapshots "may not have your latest
data"). Retention is set to 30 days in `fly.toml` (`snapshot_retention`).
Litestream is the real backup (ADR-021).
