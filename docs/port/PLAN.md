# iOS port plan

Written 2026-09-28. The owner's brief: the repo becomes a native iOS app, the
SvelteKit app stays as the backend and as a working v1, and the result has to
be a clearly better experience than the web app. New features (share sheet
capture, Wegmans export, recipe generation) come after parity.

Companion files: `web-inventory.md` is the full inventory of what the web app
does, produced from the code. `decisions.tsv` is the decision trail for the
run.

## Definition of done for the parity phase

Every row of the checklist in `parity-checklist.md` passes on a real iPhone
against the production server, ticked by the owner, and the following hold
mechanically:

- `server/`: `npm test` and `npm run check` pass, including the new API
  integration tests that exercise every `/api/v1` endpoint against a
  temporary SQLite file.
- Root: `xcodebuild test` passes for the `WeCookedKit` package, and its
  decoding tests run against JSON fixtures recorded by the server tests, so
  the Swift models and the server agree by construction.
- The app builds for the simulator and for a device from a clean checkout
  with `xcodegen generate && xcodebuild`.
- The web app still works unchanged for anyone who opens wecooked.kitchen.

## Layout

```
server/         the SvelteKit app, deployed to Fly as before (API + web v1)
WeCooked/       the iOS app target (SwiftUI)
WeCookedShare/  share extension target (later phase)
WeCookedKit/    Swift package: models, API client, store, unit logic, tests
project.yml     XcodeGen spec; the .xcodeproj is generated and ignored
docs/port/      this plan, the inventory, the checklist, the decision log
```

## Backend

The Fly server stays. Reasons, in order: the Claude key cannot ship inside
an app, the job queue and spend cap and private-network-safe fetcher are
tested and working, and the household is two people. What changes:

- A JSON API under `/api/v1` that calls the same `$lib/server/*` functions
  the form actions call. No logic moves; the routes gain a second front door.
- Bearer tokens. The session cookie value is already a stateless signed
  token, so login returns it in JSON and the app sends it as
  `Authorization: Bearer`. The hook accepts either. Unauthenticated `/api`
  requests get a 401 JSON body, not a redirect.
- One-off SQL that lives in page loads (draft cards, the pending calc job,
  the shopping picker) moves into `$lib/server` so both fronts share it.
- Later, for the new features: an APNs push when an extraction finishes, and
  a `generate` job kind for recipes from a description.

## Units, riskiest first

Each unit ends in a check a reviewer can rerun. A unit that fails its check
is reverted, not patched around.

1. **Server API v1.** Bearer auth, 401s, every endpoint from the inventory,
   integration tests, JSON fixtures written to `WeCookedKit/Tests/Fixtures`.
   Check: tests green, fixtures present, web app unchanged (existing tests).
2. **iOS scaffold.** XcodeGen project, `WeCookedKit` with models decoded
   from the fixtures, API client, Keychain token store, login screen, tab
   shell. Check: package tests green, simulator boots to the login screen,
   logs in against a local server, lands on an empty Recipes tab.
3. **Browse and the cooking screen.** Search, tag filters, recipe view with
   sticky ingredients, strikes, unit toggle, wake lock, photo strip. This is
   95 percent of use, so it gets the design attention first. Check: the
   checklist rows for browse and recipe pass in the simulator on seeded data.
4. **Capture and the editor.** Add tab (paste, photos, type it in), draft
   cards and polling, draft review, the editor with the payload rule ported
   exactly and unit-tested, edit and delete. Check: checklist rows plus Swift
   tests mirroring the TypeScript payload cases.
5. **Variations.** Stepper, calculate, show existing, stale refresh, keep
   mine, recalculate, reconvert banners. Check: checklist rows.
6. **Shopping.** List, sections, optimistic ticks with polling, pick mode,
   build with rebuild banner, manual lines, done shopping. Check: checklist
   rows on two simulators at once.
7. **Trash.** Check: checklist rows.
8. **Polish and TestFlight.** App icon, dark mode pass, transitions and
   haptics, launch screen, a device build on both phones through TestFlight.
   Check: owner ticks the on-device checklist.

## After parity

- **Share sheet capture.** A share extension that accepts URLs, text, and
  images, queues the capture, and shows the draft. Instagram reels need
  design work: their pages block fetchers, so the extension should carry the
  caption text along with the URL and fall back to a screenshot path.
- **Wegmans export.** Start with the plain export (copy or share the list
  as text the Wegmans app accepts), then investigate whether the Wegmans app
  exposes a URL scheme or a Shopping List import.
- **Recipe generation.** A `generate` job kind from a description, returning
  several candidate drafts shown as swipeable cards comparing damage, effort,
  prep and cook time, protein, and cuisine.
- **Widgets and push.** A shopping list widget and a push when a capture is
  ready to review.

## Rigor

High on the API contract (unit 1) and the editor payload rule (unit 4),
because those are where a silent mismatch loses data. Medium elsewhere.
Screens are verified on the simulator against a local server with seeded
data, then by the owner on device.
