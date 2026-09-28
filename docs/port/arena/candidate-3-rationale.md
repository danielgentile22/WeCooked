# Candidate 3: keyed resources, one job poller, values for every rule

## Problem

Unit 2 of the port plan builds the skeleton every later unit fills: an XcodeGen project, a `WeCookedKit` package, models that decode the server's recorded replies, an API client, a Keychain token store, and the state model the screens sit on. The constraints that shaped this design: the cooking screen is 95 percent of use, so a recipe already seen must appear in its first frame (PRODUCT principle 3); two phones tick one shopping list, sometimes from a shop with bad signal; the server mixes shapes (`calculate` answers `{variation_id}` or `{job_id}`, `GET /drafts/:id` answers a draft or `{recipe_id}`, one key is camelCase `calcJob`); the editor's payload rule silently loses data if ported wrong; and a share extension will later need the token, the client and the app group without dragging in the app.

Verified, not just sketched: `swift test` and `xcodebuild test -scheme WeCooked` (iOS 27 simulator) run 46 tests green; `xcodegen generate && xcodebuild build` builds the app, the embedded share extension and the package under Swift 6 with `SWIFT_STRICT_CONCURRENCY=complete`. The decoding, editor rule, job poller, store, device state, stepper, shopping layout and recipe display code are real; screens and network-facing model methods are `fatalError("not implemented")` with pseudocode.

## Usage (caller's view)

Written first; the types below are derived from it.

**Opening a recipe (the cooking screen).** The view never asks "is it loaded?", it reads a value.

```swift
struct RecipeScreen: View {
    @State var model: RecipeModel        // RecipeModel(recipe: id, variation: nil, env: env)
    var body: some View {
        if let display = model.display {           // non-nil in frame one if ever seen
            CookingBody(display: display, model: model)
        } else if model.resource.isFirstLoad { ProgressView() }
    }                                              // .watching(model.resource) refreshes in place
}
```

**Three API call sites.** One method per endpoint on a value type.

```swift
let api = APIClient(baseURL: base, tokens: KeychainTokenStore(accessGroup: group))
try await api.login(password: pw)                                   // stores the token
let reply = try await api.calculate(recipe, toCount: 8)             // .existing(vid) | .job(jid)
try await api.setTicked(item, true)                                 // sets state, never toggles
```

**One job poller, five flows.** Every flow gets a `JobID` from a server reply and hands it to a `JobWatcher`.

```swift
calc.follow(jobID) { outcome in                    // calculate
    if case .done(let vid?) = outcome { self.show(VariationID(vid)) }
}
extraction.follow(draftID) { _ in Task { await draftResource.revalidate() } }   // capture
build.follow(list.build!.jobId) { _ in Task { await shopping.revalidate() } }   // shopping build
```

**Saving from the editor.** The rule is a value, not a view method.

```swift
switch form.payload() {
case .incomplete(let issues): self.issues = issues           // "Effort is required." etc.
case .ready(let input):
    let id = try await api.createRecipe(input)               // or updateRecipe / saveDraft
    store.recipeSaved(id, input: input)                      // patch list row + open recipe, refetch rest
}
```

**Per-device state.** `env.device.units`, `env.device.toggleStrike(line, variation:, contentVersion:)`, `env.device.saveEditorDraft(form, for: .draft(job))`, `env.device.seenBuild`. One owner, no view touches `UserDefaults`.

**Deep link.** `router.open(DeepLink(url: url)!)` from `onOpenURL`, a push payload, or the share extension's hand-off. `wecooked://draft/<id>` selects Recipes and pushes the draft screen.

## Shape

Files, by layer. Three files is the longest trace from a screen to the network (view, model, `Store.swift`).

| File | Holds | Why here |
|---|---|---|
| `Wire.swift` | ids, open enums, every request and reply type, coders | One vocabulary; changes only when the server does. |
| `Editor.swift` | `EditorForm`, `payload()`, `BodyText.cleaned`, `EditorIssue` | Pure; ported from `RecipeForm.svelte`; the riskiest logic in the app. |
| `APIClient.swift` | `APIClient`, `APIError`, 30 endpoint methods | The only HTTP. |
| `TokenStore.swift` | protocol, Keychain, in-memory | Shared with the extension by access group. |
| `Jobs.swift` | `PollSchedule`, `JobPoller`, `JobWatcher` | The one poller. |
| `Store.swift` | `Key`, `Resource`, `DiskCache`, `Store`, mutation effects | The read side and its cache. |
| `DeviceState.swift` | units, strikes, editor drafts, seen build, tick outbox | Everything that is this phone's. |
| `AppEnvironment.swift` | composition root, `AppConfig`, `DeepLink` | Wiring and outside-in addressing. |
| `RecipeModel`, `ShoppingModel`, `EditorModel.swift` | screen logic as `@Observable` classes over pure projections | Testable without SwiftUI; views stay dumb. |
| `ImageStore.swift` | image bytes cached by image id | Presigned URLs rotate daily; ids do not. |

**Keyed resources are the read path (per model-the-domain, foundational-thinking).** `Key<Value>` names one server read and carries its own fetch closure: `.recipe(id, variation:)`, `.recipes(filters)`, `.shopping`, `.draft(id)`, `.trash`, `.vocabulary`. `Store.resource(key)` returns the one `Resource<Value>` for that key app-wide. Its `init` reads `Caches/v1/<key>.json` synchronously, so `value` is already set when SwiftUI first reads it. `revalidate()` updates the same object in place. There is no "add a cache later" step because the cache is the data path: a screen has no other way to get data.

**Access patterns, traced.**

1. *Open recipe list.* `RecipesTab` reads `resource(.recipes(filters))`; cached rows render at once; `.watching` revalidates, polling every 5 s only while a draft card is extracting.
2. *Tap a recipe.* `Route.recipe(id, nil)` builds `RecipeModel`; `model.resource` is `resource(.recipe(id, nil))`. Seen before: memory hit or one sync file read, `display` non-nil, zero spinners. Never seen: skeleton, then the reply fills the same property. `appear()` also prefetches the other variations so chip taps are instant.
3. *Toggle units.* `env.device.units` flips; `RecipeDisplay.make` (pure) picks `bodies[units]`, falling back to the source body while the counterpart is missing. No request. Strikes are positional and survive the flip.
4. *Strike a line.* `device.toggleStrike(line, variation:, contentVersion:)`. Records persist across app kill, expire after 12 idle hours, and are discarded when `contentVersion` changes (the web silently strikes the wrong line after an edit; this cannot).
5. *Calculate a new yield.* `YieldStepper.action(chips:)` returns `.show(vid)` (local switch), `.calculate(n)` or `.invalid`. `.calculate` POSTs; `.job(id)` goes to the `calc` `JobWatcher`; on `.done(ref)` the model shows `ref` and invalidates `.recipe(id)`. After a relaunch the same job is found in `calcJob` in the recipe reply and followed again, so nothing about jobs is stored on the phone.
6. *Tick a shopping item from two phones.* Tap writes the target state into `device.pendingTicks` (idempotent: "ticked", never "toggle"). `ShoppingLayout.sections` reads `server ⊕ pendingTicks`. `flush()` sends each target, settles an entry only if it still equals what was sent, and writes the acknowledged value into the mirror with `Resource.mutate`. A poll that started before that local write is dropped and repeated (`epoch`). Phone B's tick arrives on A's next 5 s poll; last write wins per item. No lock, no shared writer, and a tick made with no signal lands when the signal returns.
7. *Edit a recipe and return to the list.* `store.recipeSaved(id, input:)` patches the list row title and tags and applies the payload to the cached recipe (`RecipeDetail.apply`), then invalidates `.recipes` and `.recipe(id)`; watched resources refetch. Popping back shows the new title in the first frame, not a flash of the old one.

**Optimistic edits and races (separate-before-serializing-shared-state).** Server truth and local edits meet at one point: `Resource.epoch`. Every local write bumps it; a fetch that started earlier is discarded and re-run. Two actors (the poll loop and the user) never write the same value concurrently because both run on the main actor and the epoch decides whose write survives. Tested in `StoreTests.aReplyThatRacedALocalEditIsDroppedAndRefetched`.

**One poller (make-operations-idempotent).** `PollSchedule.delay(afterElapsed:)` is a pure function: 1.5 s until 30 s of accumulated sleep, then 5 s, `nil` at 300 s. `JobPoller.wait(for:)` loops on it and returns `.done(resultRef) | .failed(code, text) | .timedOut`. It tolerates three consecutive dropped connections, ends on 401 and other errors, treats unknown statuses as "still going", and throws `CancellationError` when the screen leaves (the job runs on regardless). `JobWatcher` wraps it for a screen, dedups `follow` on the same id, and cancels with its owner. Elapsed time is summed sleeps, so tests inject `sleep` and run 300 seconds of schedule in microseconds.

**Models and unknown enums (type-system-discipline).** `ID<Entity>` brands every identifier (a draft is its capture job, so `JobID`). `WireEnum` gives each server enum an `unknown(String)` or `other` case that round-trips: `Effort`, `Damage`, `Section`, `JobStatus`, `ErrorCode`, `PendingStatus`, `DraftCardStatus`. Meal type, cuisine and protein are `Tag<Group>` string wrappers because no code branches on them, and pickers render `Vocabulary` from `/tags`. `UnitSystem` falls back to metric. `RecipeInput` hand-writes `encode(to:)` so every optional is an explicit JSON null, because the server tests `cuisine !== null` and an absent key is "Unknown cuisine." `effort` and `damage` are non-optional in `RecipeInput`, so an incomplete form cannot become one; the form yields `Submission.ready | .incomplete([EditorIssue])` with the server's own messages.

**Fixtures as the contract (build-the-lever).** `FixtureDecodingTests` keeps a table from fixture name to model type and fails if a fixture has no entry or a model drops a key: each fixture is decoded, re-encoded, and compared key for key with the original. Adding a server endpoint makes this test fail until a model exists. It already caught one server quirk (`calcJob` is camelCase in a snake_case API).

**Editor rule (encode-lessons-in-structure).** `EditorForm.baseline` is optional and exists only for forms seeded from something the server holds, so "did the body change" cannot be asked of a hand-typed recipe. `bodySelection()` is the RecipeForm branch table as a function; `EditorPayloadTests` covers: neither changed (counterpart rides along), only source changed (counterpart null so the server reconverts), only other changed (other becomes source, units flip), both changed (visible body wins with its units), toggling units without typing (no change, viewing US never makes US the source), device preference opening the other body (baseline untouched), whitespace-only edits (not edits), new recipe (shown body, toggle sets source units, no counterpart), and incomplete forms (server messages, in order).

**Per-device state has one owner (`DeviceState`).** Web `localStorage`/`sessionStorage` keys map to: `units`, `strikes`, `editorDraft(for:)`, `seenBuild`, plus the new `pendingTicks`. Persistence is one JSON blob per concern in a `KeyValueStore`, backed by the app-group `UserDefaults` suite so the extension and a widget see units.

**Navigation.** One `Router` (`@Observable`) holds the selected tab, three paths over a single `Route` enum, and the sheet. `DeepLink` is the only outside-in address type; `Router.open` maps it to tab and path. A share extension writes `pendingLink` to app-group defaults and the app consumes it on foreground; a push carries `{"link": "wecooked://draft/<id>"}`. Both land on the draft screen, which waits on the extraction job if it is still running.

**Project.** `project.yml` defines `WeCooked` (iOS 26, Swift 6 complete checking, `kitchen.wecooked.ios`), the local `WeCookedKit` package, `WeCookedShare` (embedded, compiles, shares app group and Keychain group, `APPLICATION_EXTENSION_API_ONLY`, so the package stays UIKit-free), and a `WeCooked` scheme whose test action runs the package's own test target (`package: WeCookedKit/WeCookedKitTests`). `Package.swift` lists `.macOS(.v26)` so `swift test` gives a seconds-long loop; the app is iOS only. Debug points at `http://localhost:5173/api/v1/`, Release at production, both via one build setting read from Info.plist. `Config/Base.xcconfig` includes an untracked `Local.xcconfig` for the signing team.

## Synthesis decision

Left for the orchestrator.

## Tradeoffs accepted

- We accept a synchronous disk read on the main actor at `Resource.init` in exchange for a value in the first frame. The files are a few KB per recipe and tens of KB for the list; the cache is disposable, so a corrupt or old file is a miss.
- We accept last-write-wins per shopping item in exchange for no locks and no server versions. Two people ticking the same item in the same second is the only loser, and the result is still a sensible list.
- We accept an outbox for ticks only, in exchange for correct behaviour in a shop with no signal. Every other write stays online-only, matching PRODUCT ("no offline mode"); a failed save keeps the editor draft on the phone instead.
- We accept `convertFromSnakeCase` naming rules (`coverUrl`, never `coverURL`) in exchange for models with no hand-written `CodingKeys`. The round-trip test enforces the rule.
- We accept that `RecipeDetail.apply(_:)` predicts what the server will store, in exchange for no flash of stale text after an edit. The refetch overwrites it, so a wrong prediction lasts about 200 ms.
- We accept a dropped poll after a local edit (epoch) in exchange for never showing a tick flip back. A user editing continuously could delay a refresh; polls are 5 s apart and taps are rare.
- We accept `Tag<Group>` strings for meal, cuisine and protein, so `switch` is not exhaustive on them. No code needs to branch on them, and the server can add a cuisine without an app release.
- The polling schedule counts sleeps, not wall time, so an app suspended for an hour does not time out a job. On resume the next poll simply reads the job's real state.
- `Store` holds strong references to every `Resource` it has made. Low hundreds of recipes, so there is no eviction; `wipe()` on sign-out clears them.

## Alternatives considered

- **SwiftData as the model store, with `@Query` in views.** Real persistence and free observation, but it turns server replies into a second schema to migrate, makes the two-phone reconcile a merge problem, shares badly with an extension, and its Swift 6 sendability story is still awkward. Server-truth mirrors (keyed JSON) need no migration and match a two-user app that is always mostly online.
- **View models that call the API directly, with a URL cache for "instant".** Fewer types, but instant reopen then depends on HTTP cache headers the server does not send, and mutations cannot update other screens. The keyed store makes every screen's data path the same.
- **A normalized entity graph (recipes by id, list rows as views).** Best coherence, most code. With two users and a few hundred recipes, patching list rows in `Store` effects gets the same visible result with far less machinery.
- **Duplicating fixture decode tests in an app-hosted test target.** Rejected: the scheme runs the package's test target directly, so there is one copy.

## Open questions and risks

- Should the 12-hour strike expiry and the 7-day editor draft expiry be different, or should a strike live until the recipe is next opened on another day? The web used the browser session; native has no equivalent.
- Does the server's `PATCH /shopping/items/:id` always ack with the final state, or could a stale `ticked` in a later poll overwrite a phone-A tick made after phone-B's? The epoch handles local ordering only.
- The `keychain-access-groups` entitlement needs a real team id; on the simulator without signing, Keychain calls return -34018. Which team id should go in `Local.xcconfig`, and do we want `KeychainTokenStore(accessGroup: nil)` in Debug to avoid this on the simulator?
- `refresh` and `reconvert` job ids are read from replies. Are the job ids stable across two `GET /recipes/:id` calls while a job runs? `JobWatcher` dedups on id, so a fresh id restarts the wait.
- The share extension's hand-off (`pendingLink` in app-group defaults) has a race if the app is already foreground. Is an App Intents based hand-off worth it, or should the extension only queue the capture and rely on the push?
- Server `deleted_at` decodes as ISO 8601 with milliseconds; if the format loses fractional seconds the decoder throws. Should the server's Trash fixture cover a second-precision value?

## Next implementation step

Fill `Resource`-backed `RecipeModel.appear()` and the login flow, then run the app against `npm run dev` in `server/` with a seeded database to see cached reopen on the Recipes tab.
