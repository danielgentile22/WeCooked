# iOS port handoff

State as of 2026-09-28, end of the first session. Read this before picking
the work up. The plan is `PLAN.md`, the spec for behaviour is
`web-inventory.md`, the acceptance list is `parity-checklist.md`, the app's
design is `ios-design.md`, and `decisions.tsv` is the trail of every choice
with its evidence.

## Where things stand

Units 1, 2 and 3 of the plan are done and verified. Unit 3 landed in the
second session (2026-09-28, evening).

- `server/` is the SvelteKit app, unchanged for the web and now also serving
  `/api/v1` (table in `server/src/routes/api/v1/README.md`). Its tests write
  the JSON fixtures in `WeCookedKit/Tests/Fixtures`, and the Swift package
  tests decode every one of them, so the server and the app cannot drift
  silently.
- The repo root holds the XcodeGen spec, the `WeCookedKit` package, the app
  target and a share extension target that builds but does nothing yet.
- The app signs in, shows the three tabs, lists recipes with search and tag
  filters, and has the cooking screen: pinned ingredients, strikes, units
  toggle with the "as written" marker, stepper, variation chips, banners and
  wake lock. `RecipeModel` is fully implemented and tested (67 package
  tests). The editor, draft, shopping and trash screens are still stubs.
- `WeCookedUITests` is an XCUITest target that drives the app on the
  simulator against a local seeded server and writes screenshots to
  `screenshots/`. It is the lever for ticking the Sim column: there is no
  tap tool on this Mac and the Simulator window is not scriptable from the
  shell. `Unit3Tests.swift` covers rows 5 to 7, 10 to 15, 17, 18, 24, 26,
  27 and 29. Its first run caught four screen bugs the build never would
  (lines dropped by duplicate list identities, a stepper that wrapped at
  390 pt, the wrong empty-state copy, and the "as written" marker vanishing
  on the converted side).
- `server/scripts/seed-local.mjs` fills a local server with six recipes
  through the API (idempotent by title). No photos: uploads go to R2 only,
  so the photo strip is unverified on the simulator until a device build
  against production, or a local image store exists.
- The dev password is `wecooked`; `server/.env` (untracked) now carries a
  matching `APP_PASSWORD_HASH` and a `SESSION_SECRET`.

Checks a reviewer reruns, one command each, from the root `Makefile`:
`make server-test`, `make kit-test`, `make ios-build`, `make ios-test`
(package tests on the simulator, no server needed) and `make ios-ui-test`
(needs `npm run dev` in `server/` plus the seed script). Logs of the last
runs are in `logs/`.

## Owner decisions taken

- Backend stays on Fly. The SvelteKit app is the API and the web v1.
- Layout: `server/` for the web app, Xcode project at the root, generated
  `.xcodeproj` ignored, `project.yml` is the source.
- Bundle id `kitchen.wecooked.ios`, app name "We Cooked", iOS 26 minimum.
- Strikes on the cooking screen persist 12 hours across relaunch.
- Unsaved editor drafts persist 7 days.
- Shopping ticks made without signal are queued and sent when signal
  returns. This is the one deliberate exception to the no-offline rule in
  `PRODUCT.md`.
- Commits go straight to main, three for this session's work.

## Still needed from the owner

- **Apple Team ID**, for device builds and TestFlight. Two ways to find it:
  open <https://developer.apple.com/account>, then Membership details, and
  copy the 10-character Team ID. Or run `xcodegen generate`, open
  `WeCooked.xcodeproj`, select the WeCooked target, Signing & Capabilities,
  and pick your team in the Team dropdown, which shows the ID in
  parentheses. Put it in `Config/Local.xcconfig` (copy
  `Config/Local.xcconfig.example`). That file is ignored by git.
- A tap-through of wecooked.kitchen after the next deploy. The curl smoke in
  `logs/unit1-web-smoke.log` covers every page, but six route files were
  rewritten to share code with the API, and a real click-through is the
  honest check.

## Units left, in order

Each unit ends with its checklist rows ticked in the Sim column on the
simulator with seeded data, then in the Phone column by the owner.

3. **Done.** Rows 8 and 9 (draft cards) wait for unit 4 because a draft
   needs a Claude extraction job; row 28 (wake lock) is code-only
   (`keepsScreenAwake` in `Components.swift`); rows 16, 19 to 23 and 25
   render from the reply but need a second variation, so they are ticked
   with unit 5.
4. **Capture and the editor.** Rows 30 to 53. `EditorForm.payload()` is
   real and tested (10 cases). `EditorModel` still traps in `init`. Photo
   upload uses `JPEG.normalise` from the package.
5. **Variations.** Rows 16 and 19 to 25. The screen already renders every
   banner and the confirmations, and `RecipeModel` has `commitStepper`,
   `retryCalculation`, `retryRefresh`, `recalculate`, `keepMine`,
   `deleteVariation` and `retryReconvert`, all unit-tested against a stub
   server. What is left is running them against a real Claude-backed
   server and adding `Unit5Tests` for the flows. Note `recalculate` lands as
   the recipe's `calcJob`, not the variation's `refresh` (the server trashes
   the variation and queues a new scale job), so the model switches to the
   original first.
6. **Shopping.** Rows 54 to 64. `ShoppingModel`, the tick outbox and the
   section layout are real and tested. Verify two-phone sync with two
   simulators against one local server.
7. **Trash.** Rows 65 to 67.
8. **Polish and TestFlight.** Rows 68 to 70 plus: app icon (regenerate from
   the pot glyph in `server/scripts/make-icons.mjs`), dark mode pass,
   transitions and haptics, launch screen, first device build, TestFlight
   to both phones. The Keychain access group is exercised only on a device,
   so the token store is unproven until then.

`make ios-test` runs the whole `WeCooked` scheme minus the UI tests. To
grow the UI suite for a unit, add `UnitNTests.swift` next to `Unit3Tests`
and reuse its `launch`, `snap` and `openRecipe` helpers.

Also before the next commit that touches CI: add a macOS job that runs
`swift test` in `WeCookedKit`. It needs a runner image with Xcode 27, which
was not confirmed this session.

## After parity

- **Share sheet capture.** The extension target exists with the app group
  and Keychain group. It should accept a URL, text or images, post to
  `/captures` itself, and hand off to the app through the app group. For
  Instagram reels the page blocks fetchers, so carry the caption text with
  the URL, and offer the screenshot path as the fallback.
- **Wegmans export.** Start with sharing the list as plain text into the
  Wegmans app, then investigate a URL scheme or list import.
- **Recipe generation.** A `generate` job kind on the server from a
  description, returning several candidate drafts, shown as swipeable cards
  comparing damage, effort, prep and cook time, protein and cuisine.
- **Widgets and push.** A shopping list widget, and an APNs push when a
  capture is ready to review, which also gives the share extension its way
  back into the app.

## Running the app locally

```sh
cd server && npm run dev           # needs SESSION_SECRET and APP_PASSWORD_HASH in .env
make ios-build                     # generates the project and builds for the simulator
```

Seed it once: `cd server && SEED_PASSWORD=wecooked node scripts/seed-local.mjs`.

Debug builds point at `http://localhost:5173/api/v1/`. Two Debug-only
launch arguments help automation: `-wc-password <pw>` prefills the sign-in
field and `-wc-autologin YES` submits it. On the simulator the token store
is in memory, so every launch signs in again. On a device it is the shared
Keychain.
