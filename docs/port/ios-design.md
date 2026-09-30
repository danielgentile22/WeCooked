# iOS design: keyed resources, Store-owned job waits, values for every rule

Written 2026-09-28 from the design arena's chosen candidate (3) plus the grafts
listed under "Synthesis decision". This is the shape unit 2 implemented and the
later units fill in.

## Problem

Unit 2 of the port plan builds the skeleton every later unit fills: an XcodeGen
project, a `WeCookedKit` package, models that decode the server's recorded
replies, an API client, a Keychain token store, and the state model the
screens sit on. The constraints that shaped this design: the cooking screen is
95 percent of use, so a recipe already seen must appear in its first frame
(PRODUCT principle 3); two phones tick one shopping list, sometimes from a shop
with bad signal; the server mixes shapes (`calculate` answers `{variation_id}`
or `{job_id}`, `GET /drafts/:id` answers a draft or `{recipe_id}`, one key is
camelCase `calcJob`); the editor's payload rule silently loses data if ported
wrong; and a share extension will later need the token, the client and the app
group without dragging in the app.

## Usage (caller's view)

**Opening a recipe (the cooking screen).** The view never asks "is it
loaded?", it reads a value.

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
let api = APIClient(baseURL: base, tokens: KeychainTokenStore.automatic(accessGroup: group))
try await api.login(password: pw)                                   // stores the token
let reply = try await api.calculate(recipe, toCount: 8)             // .existing(vid) | .job(jid)
try await api.setTicked(item, true)                                 // sets state, never toggles
```

**Jobs: nobody follows one.** A screen writes what the server told it into the
cached reply and the Store does the rest.

```swift
case .job(let id): env.store.calculationStarted(recipe, job: id, toCount: n)
// the reply now lists the job -> Store starts one wait -> when it ends the
// reply is refetched -> the new chip (or the failure text) is on screen
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

**Per-device state.** `env.device.units`, `env.device.toggleStrike(line,
variation:, contentVersion:)`, `env.device.saveEditorDraft(form, for:
.draft(job))`, `env.device.seenBuild`. One owner, no view touches
`UserDefaults`.

**Deep link.** `router.open(DeepLink(url: url)!)` from `onOpenURL`, a push
payload, or the share extension's hand-off. The grammar is the web app's:
`https://wecooked.kitchen/drafts/<id>` and `wecooked://drafts/<id>` are the
same link, likewise `/recipes/<id>?v=`, `/add`, `/shopping`, `/trash` and `/`.

## Shape

Files, by layer. Three files is the longest trace from a screen to the network
(view, model, `Store.swift`).

| File | Holds | Why here |
|---|---|---|
| `Wire.swift` | ids, open enums, every request and reply type, coders | One vocabulary; changes only when the server does. |
| `Editor.swift` | `EditorForm`, `payload()`, `BodyText.cleaned`, `EditorIssue`, `rebased(onto:)` | Pure; ported from `RecipeForm.svelte`; the riskiest logic in the app. |
| `APIClient.swift` | `APIClient`, `APIError`, 30 endpoint methods | The only HTTP. |
| `TokenStore.swift` | protocol, Keychain, in-memory, `automatic(accessGroup:)` | Shared with the extension by access group. |
| `Jobs.swift` | `PollSchedule`, `JobPoller`, `WatchesJobs` | The one poll loop and what each reply is waiting on. |
| `Store.swift` | `Key`, `Resource`, `DiskCache`, `Store` (resources, aliases, job waits), mutation effects | The read side, its cache, and every job wait. |
| `DeviceState.swift` | units, strikes, editor drafts, seen build, tick outbox | Everything that is this phone's. |
| `AppEnvironment.swift` | composition root, `AppConfig`, `DeepLink` | Wiring and outside-in addressing. |
| `RecipeModel`, `ShoppingModel`, `EditorModel.swift` | screen logic as `@Observable` classes over pure projections | Testable without SwiftUI; views stay dumb. |
| `ImageStore.swift` | image bytes cached by URL path; `JPEG.normalise` | Presigned queries rotate daily; paths do not. Upload normalisation is shared with the extension. |

**Keyed resources are the read path (model-the-domain, foundational-thinking).**
`Key<Value>` names one server read and carries its own fetch closure:
`.recipe(id, variation:)`, `.recipes(filters)`, `.shopping`, `.draft(id)`,
`.trash`, `.vocabulary`. `Store.resource(key)` returns the one
`Resource<Value>` for that key app-wide. Its `init` reads
`Caches/v1/<key>.json` synchronously, so `value` is already set when SwiftUI
first reads it. `revalidate()` updates the same object in place. There is no
"add a cache later" step because the cache is the data path: a screen has no
other way to get data.

**The original variation has two names and one object.** `.recipe(id, nil)`
asks for the server's default; the reply says which variation that is
(`isOriginal`). The Store then registers both names to the one `Resource` and
writes its file under both, so a chip tap on the original, a `?v=` deep link
and a relaunch's cached default all hit the same value. Tested in
`StoreTests.theOriginalVariationSharesOneEntryWithTheDefaultKey`.

**Jobs are a projection of cached replies (make-operations-idempotent).** Each
reply type says which jobs it is waiting on (`WatchesJobs`): a recipe reply's
pending `calcJob`, `refresh` and `reconvert`; a browse reply's extracting
drafts; a draft reply while queued or running; the shopping reply's pending
`build`. After every value change the Store runs `reconcileWatchers()`: the
wanted set is the union of those lists minus jobs that timed out or already
ended; one wait is started per wanted job that has none, and waits for jobs no
reply lists any more are cancelled. When a wait ends the Store refetches the
owning resources (`owners(of:)`), and the fresh reply carries the outcome (the
new chip, the failure text, the draft's status). Nothing about a job is stored
on the phone: a relaunch reads the cached reply, the pending job is still in
it, and the wait resumes. A screen that starts a job writes the server's reply
into the cache (`Store.calculationStarted`) and that is all it does. Only one
job fact is client-side, the five minute timeout, kept in
`Store.timedOutJobs`; `RecipeDisplay.make` turns a pending `calcJob` in that
set into the "Still working after 5 minutes" banner. Tested in
`StoreWatcherTests`: a pending `calcJob` starts exactly one wait, a second
reconcile starts none, the wait ending refetches the owner, a reply that stops
listing the job cancels the wait, and a relaunch from disk resumes it.

**Access patterns, traced.**

1. *Open recipe list.* `RecipesTab` reads `resource(.recipes(filters))`; cached
   rows render at once; `.watching` revalidates on appear and on foreground.
   An extracting draft card is a listed job, so the Store polls it and
   refetches the list when it ends; the tab itself never polls.
2. *Tap a recipe.* `Route.recipe(id, nil)` builds `RecipeModel`; `model.resource`
   is `resource(.recipe(id, nil))`. Seen before: memory hit or one sync file
   read, `display` non-nil, zero spinners. Never seen: skeleton, then the reply
   fills the same property. `appear()` also prefetches the other variations so
   chip taps are instant.
3. *Toggle units.* `env.device.units` flips; `RecipeDisplay.make` (pure) picks
   `bodies[units]`, falling back to the source body while the counterpart is
   missing. No request. Strikes are positional and survive the flip.
4. *Strike a line.* `device.toggleStrike(line, variation:, contentVersion:)`.
   Records persist across app kill, expire after 12 idle hours, and are
   discarded when `contentVersion` changes.
5. *Calculate a new yield.* `YieldStepper.action(chips:)` returns `.show(vid)`
   (local switch), `.calculate(n)` or `.invalid`. `.calculate` POSTs; `.job(id)`
   goes into the cached reply via `calculationStarted`; the Store waits and
   refetches; the new chip appears from the reply.
6. *Tick a shopping item from two phones.* Tap writes the target state into
   `device.pendingTicks` (idempotent: "ticked", never "toggle").
   `ShoppingLayout.sections` reads `server ⊕ pendingTicks`. `flush()` sends
   each target, settles an entry only if it still equals what was sent, and
   writes the acknowledged value into the mirror with `Resource.mutate`. A
   poll that started before that local write is dropped and repeated
   (`epoch`). Phone B's tick arrives on A's next 5 s poll; last write wins per
   item.
7. *Edit a recipe and return to the list.* `store.recipeSaved(id, input:)`
   patches the list row title and tags and applies the payload to the cached
   recipe (`RecipeDetail.apply`), then invalidates `.recipes` and
   `.recipe(id)`; watched resources refetch. Popping back shows the new title
   in the first frame.
8. *Reopen an abandoned edit after the other phone changed the recipe.* The
   autosave (`DeviceState.editorDraft`) is the whole `EditorForm`, baseline
   included. The editor loads the fresh recipe, and if
   `saved.baselineDiffers(from: fresh)` it shows "This recipe changed since you
   started editing" with Start over, and works on `saved.rebased(onto: fresh)`
   so the payload rule diffs against what the server holds now. Tested in
   `EditorRestoreTests`.

**Optimistic edits and races (separate-before-serializing-shared-state).**
Server truth and local edits meet at one point: `Resource.epoch`. Every local
write bumps it; a fetch that started earlier is discarded and re-run. Two
actors (the poll loop and the user) never write the same value concurrently
because both run on the main actor and the epoch decides whose write survives.
Disk writes to one key are chained on the main actor (`DiskCache.chains`), so
fifty quick edits land in order; tested in
`StoreTests.writesToOneKeyLandInOrder`.

**One poll loop.** `PollSchedule.delay(afterElapsed:)` is a pure function: 1.5 s
until 30 s, then 5 s, `nil` at 300 s. `JobPoller.wait(for:)` loops on it and
returns `.done(resultRef) | .failed(code, text) | .timedOut`. Elapsed is wall
clock (an injected `now`, so tests drive 300 s in microseconds), which means a
phone that slept an hour times the job out on its first poll back; the Store
cancels every wait on background and `resume()` clears the timed-out set and
restarts waits from the cached replies with a fresh budget. The loop tolerates
three consecutive dropped connections, ends on 401 and other errors, and
treats unknown statuses as "still going".

**Models and unknown enums (type-system-discipline).** `ID<Entity>` brands
every identifier (a draft is its capture job, so `JobID`). `WireEnum` gives
each server enum an `unknown(String)` case that round-trips: `Effort`,
`Damage`, `Section`, `JobStatus`, `ErrorCode`, `PendingStatus`,
`DraftCardStatus`. Meal type, cuisine and protein are `Tag<Group>` string
wrappers because no code branches on them, and pickers render `Vocabulary`
from `/tags`. `UnitSystem` falls back to metric. `RecipeInput` hand-writes
`encode(to:)` so every optional is an explicit JSON null, because the server
tests `cuisine !== null` and an absent key is "Unknown cuisine." `effort` and
`damage` are non-optional in `RecipeInput`, so an incomplete form cannot become
one; the form yields `Submission.ready | .incomplete([EditorIssue])` with the
server's own messages.

**Fixtures as the contract (build-the-lever).** `FixtureDecodingTests` keeps a
table from fixture name to model type and fails if a fixture has no entry or a
model drops a key: each fixture is decoded, re-encoded, and compared key for
key with the original. Adding a server endpoint makes this test fail until a
model exists.

**Images.** `ImageStore` keys on host plus path, so a browse row's `cover_url`
(no image id beside it) and a recipe photo both hit the cache after the
presigned query rotates. Memory (60 most recent), then disk, then a bare
`URLSession` (the presigned URL carries its own credentials; never the bearer
header). `JPEG.normalise` applies the EXIF orientation, caps the long edge at
3000 px and encodes at quality 0.9 through ImageIO, so the app and the share
extension upload the same bytes; tested in `JPEGTests`.

**Per-device state has one owner (`DeviceState`).** Web
`localStorage`/`sessionStorage` keys map to: `units`, `strikes`,
`editorDraft(for:)`, `seenBuild`, plus the new `pendingTicks`. Persistence is
one JSON blob per concern in a `KeyValueStore`, backed by the app-group
`UserDefaults` suite so the extension and a widget see units.

**Navigation.** One `Router` (`@Observable`) holds the selected tab, three paths
over a single `Route` enum, and the sheet. `DeepLink` is the only outside-in
address type, and its grammar is the web's routes under both `https` and the
`wecooked` scheme; `Router.open` is the only place that turns one into tab and
path. A share extension writes `pendingLink` to app-group defaults and the app
consumes it on foreground; a push carries `{"link": ".../drafts/<id>"}`.

**Token store.** `KeychainTokenStore` with the shared access group on device.
`KeychainTokenStore.automatic(accessGroup:)` returns an in-memory store in
Debug on the simulator, where the access group has no signed entitlement and
every Keychain call fails; the Debug-only `-wc-password` launch argument fills
the login field so a simulator run needs no typing.

**Project.** `project.yml` defines `WeCooked` (iOS 26, Swift 6 complete
checking, `kitchen.wecooked.ios`), the local `WeCookedKit` package,
`WeCookedShare` (embedded, compiles, shares app group and Keychain group,
`APPLICATION_EXTENSION_API_ONLY`, so the package stays UIKit-free), and a
`WeCooked` scheme whose test action runs the package's own test target.
`Package.swift` lists `.macOS(.v26)` so `swift test` gives a seconds-long loop;
the app is iOS only. Debug points at `http://localhost:5173/api/v1/`, Release
at production, both via one build setting read from Info.plist.
`Config/Base.xcconfig` optionally includes an untracked `Local.xcconfig` for
the signing team. The root `Makefile` has `ios-generate`, `ios-build`,
`ios-test`, `kit-test` and `server-test`.

## Synthesis decision

**Base: candidate 3.** The only candidate whose package built, whose 46 tests
passed, whose fixtures all decoded, and whose project built the app plus an
embedded share extension.

**Grafts, by source.**

- Candidate 1: jobs owned by the Store and derived from cached replies
  (`WatchesJobs`, `reconcileWatchers`, `owners(of:)`, `timedOutJobs`),
  replacing candidate 3's per-screen `JobWatcher` and the browse tab's 5 s
  poll.
- Candidate 1: the original-variation alias, so `.recipe(id, nil)` and
  `.recipe(id, original)` are one cache entry.
- Candidate 1: the editor autosave keeps its baseline; a restore against a
  changed recipe shows the notice and diffs against the fresh recipe
  (`EditorForm.baselineDiffers(from:)`, `rebased(onto:)`).
- Candidate 1: the image cache keys on the URL path, so browse covers cache.
- Candidate 2: `JPEG.normalise` inside the package for the share extension.
- Judge's nits: `DiskCache` writes are chained per key on the main actor; the
  poll timeout counts wall clock; the deep link grammar is the web's paths
  under both schemes.

**Rejected.**

- Candidate 1's strict lifecycle enums: one unknown status value would fail a
  whole reply; open enums with an `unknown` case keep the recipe on screen.
- Candidate 1's async disk replay: a value that arrives after the first frame
  is a spinner in the kitchen; the synchronous read is a few KB.
- Candidate 1's compiled-in vocabulary: a copy of `/tags` drifts from the
  server; the cached reply is filled on first login before any picker opens.
- Candidate 2's nil-dropping `RecipeInput` encoder: the server rejects an
  absent `cuisine` key ("Unknown cuisine.").
- Candidate 2's `@unchecked Sendable` test doubles: `Mutex` makes them honest.
- Candidate 2's required `Local.xcconfig`: a clean checkout must build; the
  include is optional.

## Tradeoffs accepted

- A synchronous disk read on the main actor at `Resource.init` in exchange for
  a value in the first frame. The files are a few KB per recipe and tens of KB
  for the list; the cache is disposable, so a corrupt or old file is a miss.
- Last-write-wins per shopping item in exchange for no locks and no server
  versions.
- An outbox for ticks only. Every other write stays online-only, matching
  PRODUCT ("no offline mode"); a failed save keeps the editor draft on the
  phone instead.
- `convertFromSnakeCase` naming rules (`coverUrl`, never `coverURL`) in
  exchange for models with no hand-written `CodingKeys`.
- `RecipeDetail.apply(_:)` predicts what the server will store, in exchange
  for no flash of stale text after an edit. The refetch overwrites it.
- A dropped poll after a local edit (epoch) in exchange for never showing a
  tick flip back.
- A wall-clock timeout means a job that ran while the phone slept reads as
  timed out for one poll; `resume()` restarts the wait, and the refetch that
  `.watching` makes on foreground usually shows the finished result before
  anyone notices.
- A job the Store has seen end (`endedJobs`) is not re-watched until
  `resume()`, even if a stale reply still lists it, so a server that lags a
  job's completion cannot make the client spin.
- `Store` holds strong references to every `Resource` it has made. Low hundreds
  of recipes, so there is no eviction; `wipe()` on sign-out clears them.
- On the simulator in Debug the token lives in memory, so every launch signs in
  again. The device path (Keychain, shared group) is exercised in unit 8.

## Alternatives considered

- **SwiftData as the model store, with `@Query` in views.** Real persistence
  and free observation, but it turns server replies into a second schema to
  migrate, makes the two-phone reconcile a merge problem, shares badly with an
  extension, and its Swift 6 sendability story is still awkward.
- **View models that call the API directly, with a URL cache for "instant".**
  Fewer types, but instant reopen then depends on HTTP cache headers the
  server does not send, and mutations cannot update other screens.
- **A normalized entity graph.** Best coherence, most code. With two users and
  a few hundred recipes, patching list rows in `Store` effects gets the same
  visible result with far less machinery.
- **Per-screen job watchers (candidate 3's original).** Simpler per screen,
  but every screen re-implements resume-after-relaunch, and two screens
  showing one job poll it twice. The Store already knows every reply, so it
  is the one place that knows every job.

## Open questions and risks

- Should the 12-hour strike expiry and the 7-day editor draft expiry be
  different, or should a strike live until the recipe is next opened on
  another day?
- Does the server's `PATCH /shopping/items/:id` always ack with the final
  state, or could a stale `ticked` in a later poll overwrite a phone-A tick
  made after phone-B's? The epoch handles local ordering only.
- `refresh` and `reconvert` job ids are read from replies. A fresh id for the
  same work restarts the wait, which is correct but means two polls in flight
  for one job for one cycle.
- The share extension's hand-off (`pendingLink` in app-group defaults) was
  flagged as racing if the app is already foreground. Resolved 2026-09-30:
  on a phone, sharing from another app backgrounds We Cooked, so the key is
  always read on the next foreground. No code needed.
- Server `deleted_at` decodes as ISO 8601 with milliseconds; if the format
  loses fractional seconds the decoder throws.
