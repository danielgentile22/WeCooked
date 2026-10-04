---
name: parity-audit
description: Audit the iOS and web clients against each other and docs/PARITY.md, and emit the gap table. Use for /parity-audit, "parity audit", "what does the web lack", or before closing an issue that touches both clients.
---

# Parity audit

Read-only. The deliverable is a gap table, not a fix. Run it in one background
subagent with the prompt below; it takes a few minutes. Keep the table in the
main thread and the file dumps out of it.

## Prompt for the subagent

> Read-only in this repo. Produce a gap table: every behaviour the iOS app
> (`WeCooked/*.swift`, `WeCookedKit/Sources`) has that the web pages
> (`server/src/routes/**`, `server/src/lib/components`) lack or do differently,
> and the reverse. For each: iOS source (file and view), server capability used
> (`lib/server/api/v1.ts` route or module), web equivalent (path) or none, and
> what the missing side needs. Then compare the table against `docs/PARITY.md`:
> list rows whose cells no longer point at the code, and behaviours in the
> code that have no row. Also list data shape differences between the v1 views
> and the `+page.server.ts` loaders. Read the code, cite `file:line`, no
> speculation.

## After the table

- A gap that is platform-bound (share extension, widget, push, wake lock) is
  not a gap. Make sure its PARITY.md row says so.
- Every other gap becomes a Behaviour issue (`gh issue create`, template
  `behaviour.yml`) or is closed in the same change, with its PARITY.md row.
- Stale cells in PARITY.md are fixed in the same change as the audit.
