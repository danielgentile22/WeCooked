# iOS port handoff

State as of 2026-09-28, end of the first session. Read this before picking
the work up. The plan is `PLAN.md`, the spec for behaviour is
`web-inventory.md`, the acceptance list is `parity-checklist.md`, the app's
design is `ios-design.md`, and `decisions.tsv` is the trail of every choice
with its evidence.

## Where things stand

Units 1 to 6 of the plan are done and verified, except the three shopping
flows that spend Claude calls (see unit 6 below). Unit 3 landed in the
second session (2026-09-28, evening), unit 4 in the third, unit 5 in the
fourth and unit 6 in the fifth (all 2026-09-29).

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
  wake lock. The Add tab captures pasted text, URLs and photos; the one
  editor reviews drafts, edits recipes and takes typed-in ones.
  The Shopping tab lists the built list by section with optimistic ticks
  that sync between phones, pick mode, manual lines and Done shopping.
  `RecipeModel`, `CaptureModel`, `EditorModel` and `ShoppingModel` are
  implemented and tested (117 package tests). The trash screen is still a
  stub.
- `WeCookedUITests` is an XCUITest target that drives the app on the
  simulator against a local seeded server and writes screenshots to
  `screenshots/`. It is the lever for ticking the Sim column: there is no
  tap tool on this Mac and the Simulator window is not scriptable from the
  shell. Shared helpers live in `PortUITest.swift` (launch, snap, reveal
  for the lazy Form, pickPhotos for the system picker). `Unit3Tests.swift`
  covers rows 5 to 7, 10 to 15, 17, 18, 24, 26, 27 and 29, `Unit4Tests.swift`
  the editor and Add rows, `Unit4DraftTests.swift` the draft rows and
  `Unit5Tests.swift` the variation rows and `Unit6Tests.swift` the shopping
  rows. The draft and variation tests spend
  Claude calls, so they skip unless `TEST_RUNNER_WC_CLAUDE=1` is set. The
  variation tests each start from a server state that
  `server/scripts/unit5-prep.mjs` forges in `local.db` (a failed or stuck
  calculate, a stale or hand-edited variation, a failed reconvert), so
  `WeCookedUITests/run-unit5.sh` (`make ios-ui-test-unit5`) runs them one at
  a time with their prep; it spends up to 5 calls. Its first run caught four screen bugs the build never would
  (lines dropped by duplicate list identities, a stepper that wrapped at
  390 pt, the wrong empty-state copy, and the "as written" marker vanishing
  on the converted side).
- `server/scripts/seed-local.mjs` fills a local server with six recipes
  through the API (idempotent by title), without photos.
- `IMAGE_STORE=local` in `server/.env` makes a dev server keep photos in
  `server/.dev-images` and serve them at `/dev-images/`, instead of writing
  to the production R2 bucket whose credentials the dev `.env` holds. It is
  refused outside dev. The UI tests need it for the photo rows.
- The dev password is `wecooked`; `server/.env` (untracked) now carries a
  matching `APP_PASSWORD_HASH` and a `SESSION_SECRET`.

Checks a reviewer reruns, one command each, from the root `Makefile`:
`make server-test`, `make kit-test`, `make ios-build`, `make ios-test`
(package tests on the simulator, no server needed), `make ios-ui-test`
(needs `npm run dev` in `server/` plus the seed script) and
`make ios-ui-test-unit5` (the same server, and it spends Claude calls) and
`make ios-ui-test-unit6` (the same server; free by default, `WC_CLAUDE=1`
adds the three tests that spend up to four calls). Logs of the last runs are
in `logs/`.

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
- **A Claude allowance for unit 6's three gated tests** (four calls: one
  build, two for a rebuild that keeps and resets ticks, one retry of a
  forged failure), then `WC_CLAUDE=1 make ios-ui-test-unit6`. Until then row
  59 stays unticked: the building banner and skeletons are proven from a
  forged running job, the switch to the finished list is not.
- **Ratify the row 57 second phone.** The simulator is phone A and the test
  process is phone B over the API (`Unit6Tests.testRow57TickSyncsBothWays`),
  instead of two simulators; see decisions.tsv. The offline half (a tick
  queued without signal) is proven by the `DeviceState` and `ShoppingModel`
  tests only, so tick it on the phone like rows 33, 42 and 50.
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
4. **Done.** Rows 8, 9, 30 to 32, 34 to 41, 43 to 49 and 51 to 53 ticked. Rows 33
   (upload failure copy), 42 (a saved draft reopened goes to its recipe) and
   50 (server validation inline) have no cheap simulator trigger and are
   proven by package tests only (`aFailedUploadShowsTheWebCopy`,
   `aSavedDraftGoesStraightToItsRecipe`,
   `aServerRefusalBecomesAnIssueAndTheFormStaysOpen`); tick them on the
   phone. Not ported yet: the editor's reconvert banner ("Not yet updated
   from your edit. Updating…"), which needs the recipe's `reconvert`
   exposed on `EditorModel`.
5. **Done.** Rows 16, 19 to 23, 25 and 28 ticked; the editor's reconvert
   banner is ported (`EditorModel.reconvert` and `retryReconvert`). Two
   gaps the earlier sessions had not seen: nothing switched the screen to
   the new chip when a calculate ended, and nothing produced "Updated to
   match the original." Both are now one rule in `RecipeModel.noticed`,
   which compares each reply of the viewed variation with the last one
   (`seen`), driven by an `Observations` loop at the end of `appear()`. Two
   more things learned the hard way, both fixed: `Store.invalidate`
   refetches only watched resources, so an action taken from the editor
   (nothing watches the recipe there) or on a just-tapped chip has to
   `revalidate()` its own resource; and the `.watching` modifier now follows
   a resource swap, so a chip tap refetches the variation it lands on. A
   server fact worth knowing: a finished scale job is filed under its
   variation, so a failure from the last 15 minutes becomes the recipe's
   `calcJob` again and its banner shows beside the fresh chip; the web page
   does the same, and the app switches on the chip, not the job. Claude
   calls spent on verification for units 4 and 5: 10 of the 10 the owner
   allowed (unit 5 spent 9: five planned, three on reruns after the two
   fixes above, one on an automatic refresh a mis-ordered rerun queued).
   Ask the owner before any further Claude-spending run.
6. **Done, except row 59's finish.** Rows 54 to 58 and 60 to 64 ticked, all
   from list states that `server/scripts/unit6-prep.mjs` forges in
   `local.db` (a built list, a running build, a failed build, a done build
   with resets not yet seen), so the unit spent no Claude calls. Row 60's
   banner is proven from a forged result; the real kept and reset counts,
   row 59's finished list and row 61's retry are the gated tests. Two rules
   worth knowing: the pick sheet runs on a `ShoppingModel` of its own (the
   `Router` opens it with no arguments), so the tab's model learns of a new
   build from the reply, and a pending build clears the old rebuild notice
   there. The tab's confirmation button says "Clear list" as the web's does,
   so `Unit6Tests.confirm` needs no frame trick. `ShoppingLayout` now joins
   several source titles with ", " as the web does, not " · ".
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
cd server && IMAGE_STORE=local npm run dev   # needs SESSION_SECRET and APP_PASSWORD_HASH in .env
make ios-build                     # generates the project and builds for the simulator
```

Seed it once: `cd server && SEED_PASSWORD=wecooked node scripts/seed-local.mjs`.

Debug builds point at `http://localhost:5173/api/v1/`. Two Debug-only
launch arguments help automation: `-wc-password <pw>` prefills the sign-in
field and `-wc-autologin YES` submits it. On the simulator the token store
is in memory, so every launch signs in again. On a device it is the shared
Keychain.
