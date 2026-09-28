# Cross-judge report

Written by a read-only judge on a different model from the orchestrator, 2026-09-28. Scores are against rubric.md.

I recommend candidate 3 as the base. It is the only candidate whose logic has actually run: it builds, its package tests pass (46 of 46), and every fixture decodes. Candidate 1 is the best design on paper; candidate 2 has three bugs that would break at runtime.

**How I checked.** I didn't modify any candidate or repo file. I copied each `WeCookedKit` into `scratchpad/judge/` with the repo fixtures and ran `swift build --build-tests` on all three, using the Swift 6.4 toolchain. I also ran `swift test` on candidate 3, and `xcodegen generate` plus an `xcodebuild` simulator build on a copy of each full candidate:

| | Candidate 1 | Candidate 2 | Candidate 3 |
|---|---|---|---|
| Package and tests compile, Swift 6, no warnings | yes | yes | yes |
| Tests passing | 1 (only `PollScheduleTests`; the rest are stubbed) | not run (bodies stubbed) | 46 of 46 |
| `xcodegen generate` from a clean checkout | yes | fails: "Invalid config file Local.xcconfig" | yes |
| App builds for the simulator | yes | fails | yes, with the share extension embedded |

Candidate 2's app build fails at `Shell.swift:62`: its own `enum Tab` hides SwiftUI's `Tab`.

## Scores

| Criterion | C1 | C2 | C3 |
|---|---|---|---|
| 1. Instant reopen | 3 | 3 | 3 |
| 2. One job poller | 3 | 3 | 2 |
| 3. Fixture-driven models | 2 | 1 | 3 |
| 4. Editor payload rule | 3 | 2 | 3 |
| 5. Shared state separated | 3 | 1 | 3 |
| 6. Reader load and project.yml | 2 | 1 | 3 |
| **Total** | **16** | **11** | **17** |

**Candidate 1**
1. `Store.page(_:_:)` reads `RecipeCache.page(_:)` from memory right away; `refresh(_:)` updates the same slot. On a cold launch the disk read (`ReplyCache.read`) is asynchronous, so the first frame shows `RecipePlaceholder` instead of the recipe.
2. `Store.reconcileWatchers()` starts one `awaitJob` per job listed in any cached reply's `watchedJobs`. That covers all five flows plus drafts on the browse list, survives leaving the screen, and resumes after relaunch.
3. The `producers` table in `DecodingTests.swift` routes every fixture through its real `Endpoint`. Explicit nulls in `RecipeInput` are tested. But every `init(from:)` is stubbed, and `DraftCard.Status` is a strict enum, so one new draft status would fail the whole browse list.
4. `submittedBody(form:baseline:)` in `Editor.swift` is pure, and `PayloadTests.swift` lists 13 cases covering all five the rubric asks for.
5. Each piece of per-device state has one owner: units and seen build in `Preferences` (app-group settings), `Strikes`, `FormAutosave`. The shopping list merges the server snapshot with local ticks at read time (`Store.shopping`), and a sequence number stops a stale poll from undoing a tick. No `@unchecked Sendable`.
6. The data path is three files (`RecipeScreen` → `Store` → `API`), and the app builds. The `WeCookedShare` target in `project.yml` is only commented out.

**Candidate 2**
1. `Store.recipe(_:)` reads memory synchronously, and `restore()` loads every cached reply from disk before auth resolves.
2. `JobTracker.track(_:_:)` with `JobPurpose` is adopted from replies in `Store.store(_:)`. Weakness: `waitForJob` throws on the first network error.
3. `RecipeInput` relies on the compiler-generated encoder, which leaves out nil keys. I confirmed this in a snippet. The server then rejects the save. `Tags.errorCopy` keys get mangled, and the explicit-null test is stubbed. Details under Flags.
4. `EditorPayload.build` has typed errors and matches the web rule. But it treats a draft review as `loaded == nil`, so a ready draft's extracted counterpart is thrown away and the server reconverts. The web passes it through.
5. `MemoryTokenStore: @unchecked Sendable`, plus `ScriptedTransport` and `Counter` in the tests. `DeviceState` uses `UserDefaults.standard`, so the share extension can't read units. The poll simply skips while ticks are pending, like the web's pause.
6. xcodegen fails without `Local.xcconfig`, the app doesn't compile, and the share extension is commented out.

**Candidate 3**
1. `Resource.init` reads `DiskCache` synchronously, so a seen recipe is on screen in frame one. The test `aRevalidatedValueIsThereSynchronouslyOnNextOpen` passes.
2. `JobPoller.wait(for:)` is implemented and its cadence is tested exactly (20 fast polls, then 54 slow). But `JobWatcher` belongs to a screen and dies with it, and `RecipesTab` polls the whole list every 5 s while a draft is extracting instead of using the poller.
3. `decodesAndLosesNothing` passes on 26 of 26 fixtures. Unknown values land in `.unknown(String)` cases instead of failing. `recipeInputEncodesEveryKeyTheServerReads` checks the exact key set and the nulls.
4. `EditorForm.bodySelection()` and `payload()` are implemented, with 10 passing cases in `EditorPayloadTests`. There is no explicit case for a missing counterpart.
5. `DeviceState` owns everything, including a `pendingTicks` queue persisted to disk. `settleTick` only clears a tick if it still matches what was sent. `Resource.epoch` drops replies that raced a local edit (tested). Nothing uses `@unchecked Sendable`.
6. The data path is three files (`RecipeScreen` → `RecipeModel` → `Store`). `project.yml` builds the app, the package tests and an embedded `WeCookedShare` with the app group and Keychain group.

## Recommendation

Use candidate 3 as the base. It is the only one whose claims I could verify end to end: every fixture decodes and re-encodes without losing a key, the payload rule and the poll cadence are implemented and tested, and it has the only share extension target that actually builds. Its `Key`/`Resource` store gives the strongest "no spinner for anything seen" guarantee: the disk read happens in the resource's initializer, so there is no async gap on a cold launch, which candidate 1 has.

Its weak spot is job ownership. Watchers live on screen models, so a calculation stops being polled when you leave the screen, and the browse list has its own second polling loop. Candidate 1 has the better answer: jobs are read off the cached replies and watched by the store. Grafting that in fixes criterion 2 without disturbing anything that already passes. Candidate 1 is the close second; take its three best ideas rather than switching base, because its models and store are all stubs.

## Graft list

**From candidate 1:**
1. `RecipePage.watchedJobs`, `BrowsePage.watchedJobs`, `ShoppingPage.watchedJobs`, `Store.reconcileWatchers()` and `owners(of:)` (`Store.swift`). Replace candidate 3's per-screen `JobWatcher` and the 5 s list poll in `RecipesTab`, keeping candidate 3's `JobPoller.wait` as the loop.
2. `RecipeCache.original` (`Store.swift`). Right now `.recipe(id, nil)` and `.recipe(id, originalVariation)` are two separate cache entries in candidate 3.
3. `FormAutosave.Saved.baseline` and the "recipe changed since you started editing" notice (`DeviceState.swift`). Candidate 3 saves the baseline inside the `EditorForm` draft and diffs against it after a relaunch. The web always diffs against the freshly loaded recipe, and candidate 1 does too.

Optional: `ImageStore.key(for:)` (`ImageStore.swift`), which caches by URL path. Browse rows carry only `cover_url` and no image id, so candidate 3's id-keyed `ImageStore` can't cache list covers.

**From candidate 2:**
1. `JPEG.normalise` (`Images.swift`). It does orientation, the 3000 px long edge and JPEG 0.9 with ImageIO inside the package, so the share extension can reuse it. Candidate 3 leaves this to the app target.

**Reject:**
- From candidate 1:
  - Strict enums for lifecycle statuses (`DraftCard.Status`, `JobPoll`), because one unknown value throws away the whole reply.
  - The asynchronous disk replay, which is worse than candidate 3's synchronous read.
  - The compiled-in `Vocabulary.bundled`, because a hand-kept copy of `/tags` can drift.
  - The commented-out share extension.
- From candidate 2:
  - Everything in the Flags section.
  - Pushing a new route when a calculation finishes (it stacks recipe screens).
  - `configFiles: Local.xcconfig` as a required file; candidate 3's optional `#include?` is right.

## Flags

**Would break under Swift 6 strict concurrency:** none. All three packages compile under Swift 6 with no warnings, and the candidate 1 and 3 apps build.
- Candidate 2 uses `@unchecked Sendable` as an escape hatch (`MemoryTokenStore` in `Keychain.swift`, plus test doubles). Its app build fails for an unrelated reason, the `Tab` name clash.
- Candidate 3's `DiskCache.write` comment claims writes "land in the order they were issued". Unstructured `Task`s don't guarantee that, so two quick writes to one key could leave the older one on disk. This is a correctness nit, not a compile problem.

**Models that would fail on a fixture:**
- Candidate 2:
  - `DraftSeed.extracted` decodes as a `RecipeInput`. `draft-get-ready.json`'s `initial` has no `notes` key, and the decoder's TODO only makes `counterpart`, `image_ids` and `cover_image_id` optional, so it would throw.
  - `Tags.errorCopy: [ErrorCode: String]` combined with the snake-case key conversion turns `fetch_blocked` into `fetchBlocked` (confirmed in a snippet). So error copy lookups miss for every code with an underscore. The test only checks `.interrupted`, which has none.
  - Cached `DraftView`s re-encode `extracted` as a nested key, so a ready draft loses its seed after a disk round trip.
- Candidate 1: all decoders are stubbed, so nothing is proven yet. By design, a new `DraftCard` status fails the whole browse list.
- Candidate 3: none (26 of 26 pass).

**Mismatches with the API README and web behaviour:**
- Candidate 2: `RecipeInput` leaves out nil keys. `validateInput` checks `raw.cuisine !== null` (`server/src/lib/server/recipes.ts:35`), so a missing key fails with "Unknown cuisine." That breaks `POST /recipes`, `PUT /recipes/:id` and `POST /drafts/:id/save` for any recipe with no cuisine or protein.
- Candidate 2: `waitForJob` gives up on the first transient network error.
- Candidate 3: the 5-minute timeout adds up sleep time, not wall-clock time, so request time isn't counted. Its `wecooked://draft/<id>` doesn't follow the web's `/drafts/:id` path; candidate 1's `DeepLink` does.
- Candidate 1: nothing found.