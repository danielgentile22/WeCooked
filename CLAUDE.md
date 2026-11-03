# We Cooked

- **Two clients, one backend.** The iOS app (`WeCooked/`, `WeCookedKit/`) is the phone client. The SvelteKit web app in `server/` is the laptop client, used propped on the kitchen counter while cooking, and `server/` is also the backend (`/api/v1`, jobs, storage). A behaviour added to one client is added to the other unless it is platform-bound (share extension, widget, push). `docs/PARITY.md` is the matrix: update its row in the same change as the feature, and when a side is platform-bound say so in the row. `/parity-audit` regenerates the gap table.
- **The web app is laptop-first.** Phones use the native app, so web layout decisions favour a 1100 to 1400px content area (docs/UI.md D12). It must still degrade on a phone, but phone polish is not a goal.

## Gotchas

- **PARITY.md cites `file:line`.** Editing a cited file makes its refs stale: re-point the ones in files you changed. Parallel branches collide on the next row number; on a conflict take main's table and re-add your row at the next free number.
- **`make server-test` rewrites `WeCookedKit/Tests/Fixtures/*.json`.** Commit them with the change. A new job or row in `api.test.ts` shifts every later `01TEST…` fixture id, and Kit tests hardcode some of those ids.
- **Rebuilding the `job` table** must recreate the generated columns (`cover_owner`, `conversion_draft`) and leave them out of `INSERT … SELECT`. Lookups on them filter on the column alone; adding a `kind` term makes the planner pick the wrong index (the plan test in `migrate.test.ts` catches it).
- **Schema property order is the order Claude writes in.** Put reasoning fields (`damage_reasoning`) before the field they inform.
- **Benchmarks:** `node --env-file=server/.env server/scripts/model-bench.mjs <model> 3 <cases>` makes real, billed calls. Worktrees have no `server/.env`.
- **`RecipeModelTests.aCalculateThatEndedSwitchesToTheNewChip` is timing-based** and fails under heavy machine load. Rerun it alone before treating it as a regression.
- **No Prettier config:** `prettier --write` reformats whole files to the wrong style. Edit by hand.
