# iOS port handoff

State as of 2026-09-29, end of the seventh session. Read this before picking
the work up. The plan is `PLAN.md`, the spec for behaviour is
`web-inventory.md`, the acceptance list is `parity-checklist.md`, the app's
design is `ios-design.md`, and `decisions.tsv` is the trail of every choice
with its evidence.

## Where things stand

Units 1 to 7 of the plan are done and verified, except the three shopping
flows that spend Claude calls (see unit 6 below). Unit 8's simulator half
(icon, launch screen, haptics, the dark pass, rows 68 to 70) is done. Its
device half is done up to TestFlight: build 0.1.0 (1) is on TestFlight and
installed on the owner's phone (see unit 8 and TestFlight below). Unit 3
landed in the second session (2026-09-28, evening), unit 4 in the third,
unit 5 in the fourth, unit 6 in the fifth, unit 7 in the sixth, unit 8's
simulator half in the seventh (all 2026-09-29) and the device and
TestFlight block in the eighth (2026-09-30).

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
  Trash lists deleted recipes and variations with Restore per row.
  `RecipeModel`, `CaptureModel`, `EditorModel`, `ShoppingModel` and
  `TrashModel` are implemented and tested (121 package tests).
- `WeCookedUITests` is an XCUITest target that drives the app on the
  simulator against a local seeded server and writes screenshots to
  `screenshots/`. It is the lever for ticking the Sim column: there is no
  tap tool on this Mac and the Simulator window is not scriptable from the
  shell. Shared helpers live in `PortUITest.swift` (launch, snap, reveal
  for the lazy Form, pickPhotos for the system picker). `Unit3Tests.swift`
  covers rows 5 to 7, 10 to 15, 17, 18, 24, 26, 27 and 29, `Unit4Tests.swift`
  the editor and Add rows, `Unit4DraftTests.swift` the draft rows and
  `Unit5Tests.swift` the variation rows, `Unit6Tests.swift` the shopping
  rows and `Unit7Tests.swift` the trash rows. The draft and variation tests spend
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
adds the three tests that spend up to four calls) and
`make ios-ui-test-unit7` (the same server, free) and `make ios-ui-test-unit8`
(the same server, free; it switches the simulator to dark for the second
half and back). Logs of the last runs are in `logs/`.

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

- **Proof of the shared Keychain on a device.** Sign in on the phone, kill
  the app, reopen it. Landing on Recipes without the password is the
  proof. Haptics and the icon in light and dark are also the owner's to
  feel and see, and the Phone column of the parity checklist is theirs.
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
7. **Done.** Rows 65 to 67 ticked, no Claude calls spent. `TrashModel`
   holds one `Notice` (restored, displaced or failed) as the web's `form`
   does, and both restores refetch the model's own resource after
   `Store.restored()`. The banner sits above the list in a top safe-area
   inset rather than in it, because Restore is tapped on rows far down a
   long Trash and the outcome must show where the tap happened; the first
   UI run failed on exactly that. Row 67's reachable error ("The original
   now uses this yield and cannot be displaced.") comes from a trashed
   variation at the original's yield that `server/scripts/unit7-prep.mjs
   forge-clash` forges under the fixed id `01UNIT7CLASH00000000000000`;
   the other error ("Variation not found in Trash.") needs an id the
   server no longer knows, so `TrashModelTests` proves it. `reset` puts
   `local.db` back by rule (Lemony White Beans on Toast trashed, the
   newest Shakshuka 6 live and the other three trashed, pancakes 13
   trashed), and `run-unit7.sh` runs it on exit. The `Phone` helper that
   talks to `/api/v1` from the test process now lives in `PortUITest`.
8. **Simulator half done, device half blocked on the Team ID.** Rows 68 to
   70 ticked in the Sim column, no Claude calls spent. `make-icons.mjs` now
   also writes the iOS icon (light, dark and tinted, one glyph) and the
   launch glyph into `Assets.xcassets`; the launch screen is that glyph on
   the web's background colours. Haptics are `sensoryFeedback` modifiers on
   the tapped view keyed to a view-local tap counter, so a tick synced from
   the other phone never buzzes: light impact per tick and strike, success
   when a tick completes the list, selection on any chip. The shopping
   header rolls its numbers and the variation chips row animates when a chip
   appears or the selection moves. Nothing else moves; the design doc's tone
   is restraint. The dark pass read fourteen screenshots and found one
   defect: accent-filled buttons drew their `Label` icon in the tint on the
   fill, so `prominentButton()` in `Components.swift` sets the D4 on-fill
   colour and the four such buttons use it. Two things learned: the app
   ignores `-AppleInterfaceStyle Dark` as a launch argument, so
   `ios-ui-test-unit8` switches the simulator with `simctl ui appearance`
   and the dark test skips unless the Makefile says the switch happened; and
   the simulator's home screen keeps light icons in dark mode, so the dark
   icon is proven by `assetutil` on the built `Assets.car`, not a
   screenshot. Haptics do not play on the simulator; the owner feels them on
   the phone. The device half landed in the eighth session: the Team ID
   is in `Config/Local.xcconfig` (ignored), both targets sign automatically
   with the app group and the Keychain group, a Release build against
   production runs on the owner's iPhone 15 Pro Max, the App Store Connect
   record exists and build 0.1.0 (1) is on TestFlight. The inert share
   extension ships in the build; the test notes say so. `blast-radius`
   still applies before any signing or entitlement change since both
   targets share the groups. A Debug device build needs `WC_BASE_URL` in
   `Local.xcconfig` pointing at the Mac's LAN address.

`make ios-test` runs the whole `WeCooked` scheme minus the UI tests. To
grow the UI suite for a unit, add `UnitNTests.swift` next to `Unit3Tests`
and reuse its `launch`, `snap` and `openRecipe` helpers.

Also before the next commit that touches CI: add a macOS job that runs
`swift test` in `WeCookedKit`. It needs a runner image with Xcode 27, which
was not confirmed this session.

## TestFlight

`make ios-upload` archives and uploads; `make ios-archive` and
`make ios-export` are its two halves. Bump `CURRENT_PROJECT_VERSION` in
`project.yml` before each upload; build 1 shipped on 2026-09-30, build 3 is the phone-side fetch (#43),
build 4 is recipe generation (#41) on top of server release v19, build 5 lowers the minimum to iOS 17 for the second tester's phone,
build 6 is cover images and "Find another photo" (#44) on top of server
release v23. Test notes are set per build with
`node scripts/testflight-notes.mjs <build> Config/TestFlightNotes.txt`,
which waits for Apple's processing and writes the en-US "What to Test".

Deploy the server (`fly deploy` in `server/`) before any app build that
depends on a contract change, and confirm the machine is on the new
release before the upload. Build 2's first share failed for exactly this
reason: the app sent `{url, text}` to a server that did not know `text`.

- The archive authenticates with the App Store Connect API key named in
  `server/.env` (`ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_PATH`; the `.p8`
  lives in `~/.appstoreconnect/private_keys/`, owner-only). The key has
  the App Manager role. It can read and update everything but cannot
  create an app record (the API forbids it; the record was made on the
  site) and cannot use cloud-managed distribution certificates, so the
  export step authenticates with the Apple ID signed into Xcode instead.
- Signing needs the login keychain unlocked in the same login session as
  the build. Over ssh the keychain is locked, `codesign` fails with
  `errSecInternalComponent`, and an unlock in another terminal does not
  carry over. Run `security unlock-keychain ~/Library/Keychains/login.keychain-db`
  in the terminal, then `make ios-upload` in that same terminal, or start
  Claude Code from that terminal.
- The export pins `PATH` to the system directories because Apple's
  openrsync spawns `rsync` from `PATH` as its server and the Homebrew
  rsync rejects its options; the symptom is `exportArchive Copy failed`.
- Internal testing: one internal group named Internal with access to all
  builds, so new builds need no group step. Build 1 carries test notes and
  `ITSAppUsesNonExemptEncryption` is false, so no compliance prompt.
- Both testers are in: the owner and the second tester (2026-10-01, on
  iOS 17.6.1, hence build 5's iOS 17 minimum). Adding a tester takes two
  steps. First the lead invites them as an App Store Connect user with the
  Customer Support role limited to this app (Users and Access), and they
  accept from that email. That only makes them a team member; TestFlight
  shows nothing until the lead also adds them to the Internal group
  (`POST /v1/betaTesters` with the group, or the group's page on the site),
  which sends a second, TestFlight email. Open its link in Safari or Mail,
  since Chrome on iOS does not hand it to TestFlight. TestFlight follows the
  App Store Apple ID, not the iCloud one, so that account must match the
  invited email.

## After parity

Specced on 2026-09-30 after a grilling session; one GitHub issue per
feature, each labelled `ready-for-agent`: #39 share sheet capture, #40
Wegmans export, #41 recipe generation, #42 shopping widget and push. The
issues are the spec; the bullets below are the original wording.

- **Share sheet capture.** Built on 2026-09-30 (issue #39): the extension
  accepts a URL, text or up to ten images, posts to `/captures` itself with
  its own `APIClient`, and hands the draft to the app through `pendingLink`.
  A reel link plus its pasted caption goes up as `{url, text}` and the
  server extracts from the caption when the page cannot be read. Issue #43
  (same day) moved the page fetch onto the phone: `PageFetcher` in Kit
  renders the link in an offscreen WKWebView and the request carries the
  DOM as `html`; the server reduces it at ingest (`pageContent`) and only
  fetches itself when `html` is missing (ADR-041). Rows 71
  to 75 on the parity checklist are the owner's device checks; only a
  device proves the extension's Keychain read. Build 6's test notes
  describe the extension as it is.
- **Wegmans export.** Built on 2026-09-30 (issue #40): the Shopping
  toolbar share button sends the list as plain text through the system
  sheet. Research on the owner's phone the same day: the Wegmans app's AI
  assistant (powered by Cooklist) takes pasted text in any format and adds
  the items to the in-app shopping list, so copy, switch, paste into the
  assistant is the whole integration. No URL scheme or list import is
  needed; no second share action is planned.
- **Recipe generation.** Built on 2026-09-30 (issue #41, ADR-042): a
  `generate` job kind holds the description, yield and three candidates in
  one row; a pick records the index on that row and it reads as a draft
  from then on. The Add tab's "Describe what you want" screen starts it,
  browse shows one card ("Generating…", then "Choose a recipe"), and the
  draft screen shows a deck (`DeckView`, a page-style `TabView`) until the
  pick, when the same `EditorModel` moves to the form. Migration 002
  rebuilt the `job` table for the kind, so a dev server must be restarted
  after pulling it, and the runner's handler map only loads on restart too.
  `make ios-ui-test-unit9` proves the deck and the pick from a generation
  that `server/scripts/unit9-prep.mjs` forges (no Claude call); the prompt
  itself is unproven until the owner spends one call from the phone.
- **Cover images.** Built on 2026-10-01 (issue #44, ADR-043): a `cover`
  job follows every successful capture and every generation pick. It takes
  the page's own photo first (Recipe JSON-LD `image`, `og:image`,
  `twitter:image`, kept as `image_urls` on the capture at ingest), else runs
  a Brave image search on the title and lets one small Claude vision call
  pick the dish photo among up to four hits, else leaves the pot tile. The
  found image is a `photo` row with `source_url` set; the draft carries it
  as its last image and `cover_image_id`, the editor shows it with the same
  star and remove button, and a household photo added later takes the cover
  over from it (`EditorForm.addPhoto`). Migration 003 adds the column and
  rebuilds `job` for the kind, so a dev server restarts after pulling it.
  `POST /api/v1/covers/backfill` queues a cover job per coverless recipe.
  The search step needs `BRAVE_SEARCH_API_KEY` (Fly secret and `.env`);
  without it the step logs once and skips, so pasted-text and generated
  recipes stay coverless until the key is set. `server/scripts/cover-probe.mjs`
  shows what the job would accept for a URL or a title. Rows 77 to 81 are
  the owner's device checks. Server release v21 carries it. The first
  backfill ran on 2026-10-01 over the 12 coverless recipes and found
  nothing: the six with a source URL are blogs that answer the server's
  fetch with a block (the same wall as ADR-041, from home too), and the
  search step was off. Set the key, then
  `POST /api/v1/covers/backfill` again; recipes whose job found nothing
  are retried, ones whose cover the cook removed are not. "Find another
  photo" (`POST /api/v1/drafts/:id/cover` and `/recipes/:id/cover`) queues a
  replace-mode cover job that skips the source page and searches past every
  image already found, one at a time per draft or recipe. The new image takes
  over a found cover and the old one is soft-deleted; a household photo cover
  is never replaced.
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
