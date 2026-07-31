# Runbook

## Restore the database from R2 (SPEC 8.4)

Litestream replicates `/data/wecooked.db` continuously to the private R2
bucket `wecooked` under the `litestream/` prefix. Litestream version is
pinned to **0.5.11** in the Dockerfile; restore with the same minor version
(`brew install litestream`, check `litestream version`).

### Credentials

From the Cloudflare R2 API token (Object Read & Write, scoped to the
`wecooked` bucket; the same one the app uses as Fly secrets). Locally they
live in the project `.env`, which is gitignored. Never commit them.

```
R2_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com
LITESTREAM_ACCESS_KEY_ID=...
LITESTREAM_SECRET_ACCESS_KEY=...
```

### The restore command

Run from a checkout of this repo (it uses the committed `litestream.yml`).
Do not use the `s3://bucket.host/path` URL form: litestream 0.5 misparses
R2 endpoints there and the request goes to AWS.

```sh
set -a; . ./.env; set +a
export DATABASE_PATH=/data/wecooked.db R2_BUCKET=wecooked
litestream restore -config litestream.yml -o wecooked-restored.db /data/wecooked.db
```

`/data/wecooked.db` is the production path the replica is registered under,
not a path on your laptop; `-o` writes the restored copy to the current
directory.

### Verify

```sh
sqlite3 wecooked-restored.db "PRAGMA integrity_check;"   # expect: ok
sqlite3 wecooked-restored.db ".tables"
sqlite3 wecooked-restored.db "SELECT count(*) FROM recipe;"
sqlite3 wecooked-restored.db "PRAGMA user_version;"      # migration version
```

Once photos exist: pick a few `r2_key_full` values from the restored database
and confirm the objects exist in the bucket.

### Drill log

| Date | Restored by | Result |
|------|-------------|--------|
| 2026-07-30 | Claude (with Daniel) | ok. integrity_check ok, all 17 tables present, marker row `drill-2026-07-30` restored, user_version 1. Replication survived a fly deploy (clean shutdown, resumed on new machine). Image-key check pending until photos exist. |

## Fly volume snapshots

Secondary safety net only (Fly's docs: snapshots "may not have your latest
data"). Retention is set to 30 days in `fly.toml` (`snapshot_retention`).
Litestream is the real backup (ADR-021).
