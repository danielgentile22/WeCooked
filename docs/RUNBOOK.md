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

The variable names are in `.env.example` (they match SPEC 9.3).

### The restore command

Run from a checkout of this repo (it uses the committed `litestream.yml`).
Do not use the `s3://bucket.host/path` URL form: litestream 0.5 misparses
R2 endpoints there and the request goes to AWS.

```sh
set -a; . ./.env; set +a
export DATABASE_PATH=/data/wecooked.db
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
sqlite3 wecooked-restored.db "SELECT count(*) FROM variation;"
sqlite3 wecooked-restored.db "PRAGMA user_version;"      # migration version
```

Once photos exist: pick a few `r2_key_full` values from the restored database
and confirm the objects exist in the bucket.

### Outstanding

SPEC 8.4 steps 1, 3 and 4 (several real recipes with photos, confirm recipes
and variations, confirm R2 image keys resolve) cannot be performed until the
capture feature exists. **Re-run the full drill before trusting the app with
real recipes.** The 2026-07-30 drill proves the pipeline (replicate, survive
a deploy, restore, integrity), not the full spec.

### Drill log

| Date | Restored by | litestream | Result |
|------|-------------|------------|--------|
| 2026-07-30 | Claude (with Daniel) | 0.5.11 (laptop and container) | Pipeline drill: integrity_check ok, all app tables present, marker recipe row `drill-2026-07-30` restored, user_version 1. Replication survived a fly deploy (clean shutdown, resumed on new machine). Steps 1/3/4 of SPEC 8.4 outstanding, see above. |

## Fly volume snapshots

Secondary safety net only (Fly's docs: snapshots "may not have your latest
data"). Retention is 30 days: `snapshot_retention` in `fly.toml` covers
future volumes, and the existing volume was updated on 2026-07-30 with
`fly volumes update <vol_id> --snapshot-retention 30 -a wecooked`. Verify
with `fly volumes list -a wecooked` then `fly volumes show <vol_id>`.
Litestream is the real backup (ADR-021).
