# We Cooked iOS: candidate 2

## Problem

The web app is a working v1 whose every screen re-fetches from the server and shows a spinner meanwhile; the native app has to feel better than that on a propped-up phone with wet hands, against the same backend and the new `/api/v1`. The shape is non-obvious for three reasons. First, five different flows queue server jobs, and three of those jobs can also be discovered already running inside an ordinary GET reply, so polling has to be resumable from data as well as from a tap. Second, one screen (shopping) has two phones writing to one list, while everything else is one writer. Third, the editor's payload rule decides which body the server treats as human-authored, and a port that drifts from it silently loses edits. Constraints carried in: the fixtures under `WeCookedKit/Tests/Fixtures` are the contract and the Swift models must decode every one of them; `RecipeInput` must encode explicit nulls because the server diffs JSON; per-device state from inventory §6 stays per device; iOS 26, Swift 6 strict concurrency, `@Observable`, no dependencies.

## Usage (caller's view)

**Quickstart.** The app target builds four objects once and injects them through the environment. A screen reads a cached document, asks the store to refresh it, and mutates through the store. It never sees `URLSession`, JSON, or a job id.

```swift
let tokens = KeychainTokenStore(accessGroup: AppIdentity.keychainGroup)
let store = Store.make(baseURL: AppIdentity.baseURL, tokens: tokens, disk: DiskCache(directory: caches))
let device = DeviceState(directory: appSupport)
```

**Call site 1, the cooking screen.** Cached paints first, refresh lands in place; the calculate banner is derived state.

```swift
struct RecipeScreen: View {
    let ref: RecipeRef
    @Environment(Store.self) var store
    @Environment(DeviceState.self) var device

    var body: some View {
        let cached = store.recipe(ref)
        content(cached?.value.recipe)
            .task(id: ref) { await store.loadRecipe(ref) }
            .overlay { if cached == nil, store.activity[.recipe(ref)] == .loading { ProgressView() } }
    }

    func calculateTapped(_ count: Double) async {
        if let existing = try? await store.calculate(ref.recipe, toCount: count) { router.push(.recipe(existing)) }
    }
    // store.calculation(for: ref.recipe) is .running(8) while the job runs,
    // then .done(vid, jobId): push .recipe(RecipeRef(ref.recipe, variation: vid)),
    // then store.acknowledgeCalculation(jobId).
}
```

**Call site 2, a tick from either phone.**

```swift
ShoppingRow(item: item, units: device.units) {
    Task { await store.tick(item.id, !item.ticked) }
}
// The row reads store.shoppingItems: server list with this phone's pending
// ticks overlaid. A failed PATCH removes the overlay, so the row reverts.
```

**Call site 3, saving an edit.** The rule is a pure function with a typed error; the store does the rest.

```swift
do {
    let input = try EditorPayload.build(form, editing: loaded)
    let shown = try await store.updateRecipe(ref.recipe, input, variation: ref.variation)
    device.removeDraft(.recipe(vid))
    router.pop()
} catch let e as FormError { error = e.message }
  catch let e as APIError { error = e.userMessage }
```

**Call site 4, the tests read the same fixtures the server wrote.**

```swift
let reply = try Wire.decoder.decode(RecipeReply.self, from: fixture("recipe-get-busy"))
#expect(reply.calcJob?.status == .pending)
```

## Shape

**Module map.** `WeCookedKit` is nine files, each one boundary: `Models` (wire types and the ID brand), `API` (the client, `APIError`, `Transport`, `TokenStore`), `Keychain` (the token store and its in-memory test double), `Jobs` (`PollingSchedule`, `waitForJob`, `JobTracker`, `JobPurpose`), `Store` (the cache, loads, mutations, `DiskCache`), `DeviceState` (units, strikes, drafts, seen build), `Editor` (`FormState`, `cleanBody`, the payload rule, stepper math), `Images` (bytes by image id, JPEG normalisation over ImageIO), `Presentation` (display strings). The package is Foundation, Security and ImageIO only and declares macOS as a platform so `swift test` runs without a simulator. The app target is eight files: composition root, shell and router, and one file per screen family. Tracing any user action touches at most three files (screen, Store, API), per minimize-reader-load.

**Ids are branded.** `ID<Of>` with phantom tags gives `RecipeID`, `VariationID`, `JobID`, `ImageID`, `ShoppingItemID`. A job's `result_ref` is the one untyped id, and `JobPurpose` names its brand at the only place it is read (`Store.jobFinished`), per type-system-discipline.

**Two kinds of server enum.** A value the app branches on (`UnitSystem`, `JobStatus`, `DraftStatus`, `RefreshStatus`, `BuildStatus`) is a strict Swift enum; every case is proven by a fixture. A value the app only displays or compares (the five tag groups, `Section`, `ErrorCode`) is a string-backed `Vocabulary` struct with named constants. The server owns those lists and sends them in `/tags`, so a new cuisine renders on day one and nothing fails decode. The test `unknownVocabularyWordStillDecodes` pins this. Extra JSON keys (`content_version`, `based_on_content_version`) are ignored at the boundary, per boundary-discipline.

**Union replies are enums with custom decoders.** `DraftReply` (`.saved(RecipeID)` or `.draft(DraftView)`), `CalculateReply` (`.existing` or `.queued`), and `DraftSeed.extracted` (present only when `title` is). The three shapes the web app handles with `if ('recipe_id' in data)` are exhaustive switches here.

**The store is a document cache keyed by GET endpoint.** `CacheKey` enumerates every cached document; `activity[key]` and `DiskCache` share the key. Recipes are stored under their `variation_id`, plus an `originals` map from recipe id, so `RecipeRef(recipe)` and `RecipeRef(recipe, variation: original)` are one entry (single source of truth; derived, not synced). Every store method is stale-while-revalidate: the value is returned synchronously from memory, `load*` refreshes, and a spinner is only ever drawn when the value is nil. `restore()` reads every document off disk at launch, which is what makes a recipe seen last week paint on the first frame after a cold start. Access patterns traced: open list, `browse[.all]` from disk then refresh; tap recipe, `originals[id]` then `recipes[vid]`, refresh in place; toggle units, `device.units` only, the body is `recipe.body(for:)` with the fallback rule from §7; strike a line, `device.strikes[vid]` keyed by position; calculate and poll, below; tick from two phones, below; edit and return, `updateRecipe` drops every variation of that recipe from the cache and reloads the edited one, browse reloads on appear so the old row shows until the new title lands.

**Jobs enter one tracker from two directions.** A mutation that gets `{job_id}` calls `jobs.track(id, purpose)`. A GET reply that carries a pending job (`calcJob`, `refresh`, `reconvert`, an extracting draft card, a pending build) is adopted by the store's three private `store(_:)` methods with the same call. `track` is idempotent by id, so a reply seen after a phone lock resumes exactly what the web app would restart, and a second reply changes nothing, per make-operations-idempotent. `JobPurpose` is the only switch: `jobFinished` reloads the right document and the screen derives its banner from `jobs` (`Store.calculation(for:)` returns `.running(8)`, `.done(vid)`, `.failed(text)`). The cadence is a value (`PollingSchedule.server`) with a pure `nextDelay(elapsed:)`, so the tests run the real loop with `.immediate` and check the 1.5 s, 5 s, 5 minute rule as arithmetic.

**Two phones, one list.** The other phone's ticks arrive by poll, this phone's ticks go out by PATCH, and they are never written to the same object. `pendingTicks` holds this phone's unconfirmed writes; `shoppingItems` is the server list overlaid with them; a confirmed tick is written into the cached list and removed from pending; a failed one is just removed, which is the revert. The poll skips while anything is pending. That is per-actor state merged at the read boundary, per separate-before-serializing-shared-state, and it deletes the `ticksInFlight` counter the web app needs.

**Per-device state is three durability tiers, chosen on purpose.** Units and the seen build live in UserDefaults. Strikes live in a stamped file that expires 12 hours after the last change: the web app loses them when the tab closes, and iOS kills backgrounded apps far more often than Safari drops a tab, so a mid-cook relaunch losing strikes would be a regression. Editor drafts live in Application Support until save or start-over, per ADR-038.

**The payload rule is a pure function with a typed error.** `EditorPayload.build(form, editing:) throws(FormError) -> RecipeInput` is the Svelte `payload()` line for line, over `cleanBody` ported from `tags.ts`. `LoadedSnapshot` freezes the cleaned bodies at open time, and `openedIn(device.units)` is applied to the form only, never the snapshot. `FormError` fails the two tags the server would reject with the server's copy, so the screen never sends a payload it knows is bad. Ten test cases cover every branch in §7 including the device-preference swap and whitespace-only edits.

**Boundaries.** `APIClient.send` is the one place headers, 401, `X-Session-Token`, `{error}` mapping and decoding happen; every endpoint is one method on top of it. `Transport` wraps URLSession so the API tests run real request building against scripted replies. `KeychainTokenStore` uses an access group and after-first-unlock accessibility so the future share extension reads the same token in the background. The store's 401 hook and the tracker's finish hook both point back at the store; `Store.make` wires the cycle.

**Navigation.** One `Route` enum, one `Router` with a path per tab, one `DeepLink` (`wecooked://drafts/{id}`, `wecooked://recipes/{id}`). A push notification, the URL scheme and the share extension's app-group handoff (`PendingDraft`) all end in `router.open(link)`, which selects Recipes and resets its stack. Confirmations are `confirmationDialog`s per D10.

## Synthesis decision

*Filled in by arena.*

## Tradeoffs accepted

- We accept persisting every server document to disk with no eviction in exchange for zero spinners on anything seen. Low hundreds of recipes, kilobytes each; sign-out wipes it.
- We accept that the unfiltered browse page and each filtered query are separate cache entries in exchange for a cache keyed by exactly what was requested. Only `.all` is worth restoring from disk; filtered queries are cheap to refetch.
- We accept string-backed tag types, losing exhaustive switching on cuisines, in exchange for never failing decode when the server adds a word. The app never branches on a tag value.
- We accept 12-hour strike persistence as a deliberate deviation from the web app's per-tab semantics in exchange for surviving iOS background kills mid-cook.
- We accept `RecipeInput` having a hand-written decoder in exchange for using one type for the editor's output and the draft seed, instead of a second near-identical type.
- We accept an in-memory `JobTracker` that forgets running jobs on relaunch in exchange for no persisted job list: every job the app cares about is re-discovered from the next GET reply, so persistence would only duplicate the server.
- We accept macOS in the package platforms, which costs nothing in code, in exchange for `swift test` in CI without a simulator.

## Alternatives considered

- **Per-screen view models with their own fetch and cache.** Lost because every stale-while-revalidate rule and every job-resume rule would be written five times, and "seen once, instant forever" needs one cache across screens.
- **A generic `Resource<T>` with fetch closures and a registry** instead of typed properties on `Store`. Lost to laziness-protocol: six documents do not justify a mini-framework, and typed properties make the access patterns readable in the type.
- **Persisting the recipe cache in SwiftData or SQLite.** Lost because the documents are read whole and written whole; a JSON file per key is the entire requirement and needs no schema migration when the server changes a reply.
- **Strict enums with an `.unknown(String)` case for tags.** Lost because every switch would need a branch nobody can act on; the string struct gives the same safety with less code and the fixture test still proves the known words decode.
- **Polling inside each screen with `.task`.** Lost because a calculation must keep polling when the phone locks or the user pops back to the list, and the browse page and the draft page both need the same capture job's result.

## Open questions and risks

- Do you want strikes to survive a relaunch at all, or is per-process (matching the web tab) the behaviour you expect? The 12-hour window is my call and is one constant.
- Should sign-out exist in the app? The web app has none; I added `Store.signOut` because 401 handling needs it, but a visible button is a product choice.
- XcodeGen's `scheme.testTargets` entry for a package test target (`package: WeCookedKit/WeCookedKitTests`) is the documented form for recent XcodeGen; the exact spelling should be verified against the installed version on the first `xcodegen generate`.
- `RecipeInput` encoding must write explicit nulls; `JSONEncoder` skips nil by default. The custom encoder in `Wire` has to handle this, and `recipeInputRoundTripsWithExplicitNulls` is the test that proves it. Is there a server-side check that would catch an absent key instead of null, or is silent divergence possible?
- Image bytes are fetched directly from R2 with presigned URLs; if a cached reply is more than 7 days old its URLs are dead. `ImageStore` caches by id so the bytes still show; a reply refresh brings new URLs. Is a 7-day-old cached recipe with a never-fetched image acceptable as a pot tile until the refresh lands?
- The share extension will need the resolved keychain access group string at runtime (`AppIdentity.keychainGroup`); reading it from the entitlements is the only way to avoid hardcoding the team prefix. Worth confirming on the first device build.

## Next implementation step

Fill in `Wire`, `Models.swift`'s three custom decoders and `RecipeInput`'s coder, then make `FixtureDecodingTests` green with `swift test --package-path WeCookedKit`, since every other file depends on those types decoding the recorded replies.
