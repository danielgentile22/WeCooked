# We Cooked iOS: shape of the app (candidate 1)

## Problem

Unit 2 of `docs/port/PLAN.md` lays the skeleton every later unit fills: an XcodeGen project, a `WeCookedKit` package whose models decode the server's recorded fixtures, an API client, a Keychain token, and the app's state model. The shape is not obvious for four reasons found while grounding.

- The web app has no client state model to port. Every page reloads through SvelteKit, so "what is on screen after a mutation" is answered by `invalidate()`. A native app has to decide where data lives, and PRODUCT principle 3 ("nothing waits on a spinner in the kitchen") means cached, not refetched.
- Five flows poll jobs (calculate, stale refresh, reconvert, capture, shopping build), each wired separately on the web, each resumed after a reload from a field in the page load (`calcJob`, `refresh`, `reconvert`, extracting drafts, `build`).
- Shopping ticks are written by two phones and a poller at once. The web handles it by pausing polling while a tick is in flight.
- The editor payload rule (`RecipeForm.payload()`) decides which body becomes "as written". A mismatch silently moves `is_source`. There are no TypeScript tests for it to mirror.

One finding changes the models. `validateInput` checks `raw.cuisine !== null`, so a JSON body that omits `cuisine` (which Swift's synthesized `Encodable` does for nil) fails with "Unknown cuisine.". `RecipeInput` must encode explicit nulls.

## Usage (caller's view)

Build and test from a clean checkout:

```sh
xcodegen generate
xcodebuild -project WeCooked.xcodeproj -scheme WeCooked \
  -destination 'platform=iOS Simulator,name=iPhone 17' test   # package tests, fixtures included
cd WeCookedKit && swift test                                    # same tests on the Mac, no simulator (CI)
```

The sketch already compiles. `swift build --build-tests` on the package and an `xcodebuild` simulator build of the generated project (app plus the scheme's test bundle) both succeed under Swift 6 with strict concurrency. Bodies are `fatalError` stubs, so only `PollScheduleTests` runs green today.

A screen asks the Store for a resource and renders whatever it has. This is the whole data-loading story for every screen:

```swift
struct RecipeScreen: View {
    @Environment(Store.self) private var store
    @State private var selected: VariationID?

    var body: some View {
        if let page = store.page(recipe, selected) { content(page) }       // memory or disk: instant
        else { RecipePlaceholder(row: store.browse[.all]?.recipes.first { $0.id == recipe }) }
    }
    // .task(id: selected) { await store.keepFresh(.recipe(recipe, selected)) }
}
```

Three API call sites. Routes are values from one catalog, sent by one client, with typed errors:

```swift
// Login (Session)
try await api.logIn(password: password)                    // stores the token; 400 -> .rejected("Wrong password.")

// Photo upload (editor): raw JPEG body, role in the query
let image = try await store.api.send(V1.uploadImage(jpeg: data, role: .photo))
form.add(EditorImage(id: image.id, url: image.url))

// Calculate (Store.calculate, called by the recipe screen)
switch try await api.send(V1.calculate(recipe, toCount: 8)) {
case .existing(let v): selected = v                          // no job, instant
case .started(let job): /* store writes calcJob = .pending(job, 8); a watcher starts itself */
}
```

Mutations go through the Store, which knows what each one invalidates:

```swift
let input = try RecipeInput.make(form: form, baseline: seed.baseline).get()   // pure, tested
let dest = try await store.save(input, to: seed.target)                       // new, draft or edit
router.show(dest)

store.setTicked(item.id, true)        // optimistic, retried until it lands, never undone by a poll
```

## Shape

Files (WeCookedKit, nine; app target, eight):

| Kit file | Owns |
|---|---|
| `Models.swift` | Branded ids, vocabulary words, every reply and request type, sum types for statuses |
| `API.swift` | `Endpoint<Reply>`, the `V1` catalog (one function per README row), `API` client, `APIError` |
| `TokenStore.swift` | Keychain token in a shared access group; in-memory store for tests |
| `Jobs.swift` | `PollSchedule` (pure cadence) and `awaitJob`, the one poller |
| `Store.swift` | The read model: typed slots, disk reply cache, job watchers, tick overlay, mutations |
| `Editor.swift` | `EditorForm`, `EditorSeed`, `EditorTarget`, `submittedBody` (the payload rule), `RecipeInput.make` |
| `DeviceState.swift` | `Preferences` (units, seen build), `Strikes`, `FormAutosave` |
| `Presentation.swift` | Pure view derivations: body choice, banners, stepper, shopping layout, deep links |
| `ImageStore.swift` | Image bytes keyed by URL path, because the presigned query rotates daily |

The app target is `WeCookedApp.swift` (composition root, Session, Router, tab shell, push delegate), one file per tab area (`RecipesScreen`, `RecipeScreen`, `EditorScreen`, `AddScreen`, `ShoppingScreen`), `LoginScreen`, and `Components` (Banner, Chip, CachedImage, wake lock). No per-screen view model classes: screen state is `@State` for view-only values, the Store for server values, `Presentation.swift` for every rule. Tracing any screen is three files.

**Data structures first.**

- Ids are `ID<Entity>`, so a `RecipeID` cannot be passed as a `VariationID`. A draft is addressed by its `JobID`, matching the server, where a draft is its job row. (type-system-discipline)
- `BodyPair { sourceUnits, source, counterpart? }` replaces the wire's `ingredients`, `steps` and `bodies`, which say the source body twice. The source always exists and the counterpart may not, which is exactly the domain. The same type is the recipe's bodies, the draft seed's bodies, and the editor's baseline. (model-the-domain)
- Statuses are sum types with their payloads: `CalcJob.pending(job, toCount)`, `ReconvertState.failed(JobID?)`, `DraftView.Phase.ready(DraftSeed)`, `CalculateReply.existing | .started`, `DraftReply.saved | .draft`. No optional-field bags.
- `EditorForm.bodies` is keyed by unit system with a `shown` pointer, not a visible/hidden pair that swaps. The toggle becomes a pointer change and the payload rule becomes a lookup.

**Unknown enum values.** The rule depends on what the app does with the value. Values the app only *shows* are open: `Word<Kind>` wraps any string, the choice lists come from `GET /tags`, and a new cuisine renders as its own words and round-trips through the editor. That covers tags, shopping sections and job error codes. Values the app *branches on* are closed enums that decode strictly: job, draft, build, refresh, reconvert and calc statuses, and `UnitSystem`. An unknown lifecycle state has semantics the app cannot guess, and guessing "done" loses work. A strict failure shows as `APIError.badReply` over the cached value, and the fixture tests catch it before it ships. `Vocabulary.bundled` is compiled in so nothing waits on `/tags`; a test asserts it equals `tags.json`.

**Stale-while-revalidate, including across launches.** Every GET reply's raw bytes are written to Caches under `Endpoint.cacheKey`. On a cold launch the Store replays the bytes through the same decoder, then refreshes. Bytes rather than re-encoded models keep reply types `Decodable`-only, and an app update that changes a model simply fails to decode an old file, which is deleted. The only spinner is for a resource this phone has never seen, and even then the recipe screen shows the browse row's title and cover.

**Jobs are derived from resources.** This is the load-bearing decision. Each cached reply exposes `watchedJobs` (calc, refresh and reconvert on a recipe page, extracting drafts on browse and draft replies, a pending build on shopping). After every change the Store reconciles one watcher per waited-on job, and when a job ends it refetches the resources that were waiting on it. The server's reply stays the only source of job state: the failure text, the new chip, the cleared banner. Screens render resources and never see poll results, only `timedOutJobs`. All five flows share one mechanism with no per-flow wiring, and resume-after-relaunch is free, because a cached page that says "pending" restarts its own watcher. Reconciliation is idempotent, so running it twice or after a crash converges. (make-operations-idempotent, single source of truth)

**Two writers, no shared write target.** For shopping, the poller writes `shoppingSnapshot` and the user writes `tickIntents`, and `store.shopping` merges them at read time. An intent is dropped only when a snapshot *fetched after the PATCH succeeded* arrives, so a stale poll cannot untick. PATCH carries the absolute value, so it is idempotent and retried with backoff until it lands, which matters in a shop with one bar of signal. The web app's "pause polling while ticks are in flight" disappears. For every other resource, a reply is applied only if its fetch started after the last local write to that resource. (separate-before-serializing-shared-state)

**Boundaries.** JSON is parsed once, in `API.exchange`, off the main actor (`@concurrent`). Status codes map to `APIError` cases that already say what the screen does: `rejected` shows the server's copy, `notFound` removes the value, `unauthorized` has already cleared the token and signalled `API.signedOut`. `X-Session-Token` is stored before the status switch. Inside the app nothing re-validates. (boundary-discipline)

**Per-device state has one owner per fact.** Units and the seen-build marker go in app-group `UserDefaults`, so the share extension can read units. Strikes go in a file keyed by variation and expire 12 hours after last touch. The web keeps them in sessionStorage, which iOS evicts with the tab. On a phone the right "session" is the cooking session, and a trip to the timer app should not lose them. Form autosave is one file per `EditorTarget` and records the baseline it started from, so reopening after the other phone edited the recipe says so instead of silently diffing against stale data.

**Traces.**

- *Open recipe list.* `RecipesScreen` runs `keepFresh(.browse(.all))`. Memory is empty on a cold launch, so disk bytes are decoded and drawn, then the network refreshes. Extracting draft cards start watchers.
- *Tap recipe.* A push to `.recipe(id, nil)`. `store.page(id, nil)` resolves through `RecipeCache.original`. On a hit it draws instantly. On a miss it shows the placeholder from the browse row. When a page arrives, sibling variation pages are prefetched so chips switch without a wait.
- *Toggle units.* `prefs.units` changes, and `displayBody(recipe, preferring:)` picks the other body, falling back to the source when the counterpart is missing. No network. Strikes are positional (`LineKey`), so they stay.
- *Strike a line.* `strikes.toggle(.ingredient(group:item:), in: variationID)` writes the file off the main actor. It is never synced.
- *Calculate and poll.* `store.calculate` returns `.existing(v)`, which selects v, or `.started(job)`, which writes `calcJob = .pending(job, n)` into every cached page of the recipe. Reconciliation starts `awaitJob` (1.5 s for 30 s, then 5 s, 5 minute limit). When it ends, the pages are refetched. The new chip appears, and the screen, which set `awaitingYield = n` from `calcJob`, selects it. On failure, `calcJob` comes back `.failed` with the server's copy. Locking the phone cancels the watcher, and resume re-derives it.
- *Tick from two phones.* Phone A records an intent and the row flips at once, with a haptic. The PATCH is retried until it lands. A's 5 s poll cannot revert the row until a post-PATCH snapshot confirms it. Phone B sees the tick on its next 5 s poll. Opposite ticks at once end last-writer-wins at the server, and both phones converge within one poll.
- *Edit a recipe and return to the list.* The editor sheet calls `store.save(.edit)`, and the PUT follows. The Store awaits a refetch of that page, so the recipe under the sheet is already new when it dismisses. It drops sibling pages, since an edit to the original makes them stale, and patches title, effort and damage into every cached browse row. Popping to the list shows the new title immediately, and a background refresh brings the cover.

**Navigation.** Three tabs, and a `NavigationStack` path of `Router.Route` in Recipes (`recipe`, `draft`, `trash`). The editor is a sheet for new recipes and edits, since those are modal tasks with Save and Cancel. Draft review is pushed, because it is a place with its own states (extracting, failed, ready) that embeds the same editor view. `DeepLink` parses the web's own route grammar, so `https://wecooked.kitchen/drafts/ID`, `wecooked://drafts/ID` and a push payload `path` all land through `Router.open`. The share extension reads the shared Keychain token, posts `/captures` itself, and relies on the later push to deep-link to the draft.

## Synthesis decision

To be filled in by arena.

## Tradeoffs accepted

- We accept one `Store` file with roughly twenty mutation methods in exchange for one place that knows which cached values each server write invalidates. A per-screen view model would scatter that knowledge.
- We accept the `V1.recipe(id)` spelling (a namespace, not methods on the client) in exchange for routes being values. The same value is sent, used as the disk cache key, and replayed at launch.
- We accept a disk cache of reply bytes that can be up to a session old, in exchange for never showing a spinner for anything seen. It is always refreshed on appear, and it is wiped on sign-out.
- We accept refetching whole resources when a job ends, rather than applying `result_ref`, in exchange for the server staying the only source of job state. It costs one small GET per job.
- We accept strikes outliving the process (12 hours) in exchange for surviving iOS evicting the app mid-cook. This is a deliberate change from the web's sessionStorage.
- We accept open string types for tags, which give up exhaustive `switch` on cuisine, in exchange for a server vocabulary change never breaking a shipped build. Nothing branches on a tag value.
- We accept compiling in `Vocabulary.bundled` in exchange for editors and filters that never wait. A test keeps it equal to `tags.json`.

## Alternatives considered

- **Per-screen `@Observable` view models, each calling the API.** This is the common SwiftUI shape. It lost because each view model would own a copy of server state. Editing a recipe would then need cross-view-model invalidation, and each of the five polling flows would be wired again per screen.
- **A generic query cache (type-erased `[String: Any]` keyed by URL, like SWR or React Query).** It lost on type safety (casts at every read) and because the dominant access patterns need normalization a URL key cannot express. Examples: the recipe page for "the original" versus by variation id, and a calc job that belongs to every page of a recipe.
- **SwiftData as the cache.** It lost because it would need a second model layer parallel to the wire types, plus a migration story, for two users and low hundreds of recipes. Reply bytes on disk give the same instant launch with no schema.
- **Screens own their job polling (a direct port of the web).** It lost because resume-after-relaunch then has to be re-implemented per flow, and a watcher outlives or dies with the wrong screen.

## Open questions and risks

- Should strikes really outlive the process for 12 hours? Or does the owner want the web's semantics (gone when the app is gone)? It is one constant.
- Should unsynced ticks persist to disk, so a tick made offline survives the app being killed in the shop? The design retries in memory only.
- `GET /recipes` rows carry `cover_url` but no image id, so the image cache keys on the URL path, which is stable today. Is it worth adding `cover_image_id` to the browse reply in unit 1 to make that contract explicit?
- The payload tests here are the first executable spec of `RecipeForm.payload()`. Should unit 4 port the same table to vitest, so both sides run one list?
- Does a new lifecycle status from the server count as a breaking change that needs an app release first? The strict decode assumes yes.
- Is it acceptable that Session sign-out on 401 wipes the reply cache? It holds the household's recipes, so that seems right, but it means a server secret rotation costs one cold load.

## Next implementation step

Fill `Models.swift` decoders and make `DecodingTests` green against the fixtures under `swift test`. Every later unit reads these types, and the `everyFixtureHasAProducer` test locks the catalog to the server from day one.
