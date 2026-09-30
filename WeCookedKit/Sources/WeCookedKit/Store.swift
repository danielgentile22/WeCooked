import Foundation
import Observation

// The read side of the app. A screen never calls the API to render; it asks the
// Store for the `Resource` behind a typed `Key` and reads `resource.value`.
//
//   tap recipe -> store.resource(.recipe(id, nil))
//              -> Resource already in memory? its value is on screen this frame
//              -> else init reads Caches/<key>.json synchronously (a few KB)
//              -> value non-nil: no spinner; nil only for a never-seen recipe
//              -> .watching(resource) calls revalidate(): same object, same
//                 `value` property, updated in place when the reply lands.
//
// The disk cache is disposable server truth, never a source of edits: wrong or
// missing files are misses, so model changes need no migration.
//
// Jobs are a projection of these values. Every value change runs
// `reconcileWatchers()`, which keeps exactly one wait per job any loaded reply
// lists (`WatchesJobs`) and refetches the owning replies when a wait ends.

// MARK: - Keys

/// Groups of keys that one mutation can invalidate together.
public enum Family: Hashable, Sendable {
	case vocabulary, recipes, shopping, trash
	case recipe(RecipeID)
	case draft(JobID)
}

/// A typed address for one server read: its cache name, its family, and how to
/// fetch it. Adding a readable thing to the app is adding one static below.
public struct Key<Value: Codable & Sendable>: Sendable {
	public let name: String
	public let family: Family
	let load: @Sendable (APIClient) async throws -> Value
}

extension Key where Value == Vocabulary {
	public static var vocabulary: Self { .init(name: "tags", family: .vocabulary) { try await $0.tags() } }
}
extension Key where Value == BrowseResponse {
	public static func recipes(_ f: BrowseFilters = BrowseFilters()) -> Self {
		let q = f.queryItems.map { "\($0.name)=\($0.value ?? "")" }.joined(separator: "&")
		return .init(name: "recipes?\(q)", family: .recipes) { try await $0.recipes(f) }
	}
}
extension Key where Value == RecipeResponse {
	/// `variation == nil` asks for the server's default (the original). Once a
	/// reply reveals which variation that is, the Store aliases this key and
	/// `.recipe(id, original)` to one object (`Store.learnOriginal`).
	public static func recipe(_ id: RecipeID, variation: VariationID?) -> Self {
		.init(name: Self.recipeName(id, variation), family: .recipe(id)) {
			try await $0.recipe(id, variation: variation)
		}
	}
	static func recipeName(_ id: RecipeID, _ variation: VariationID?) -> String {
		"recipe/\(id)/\(variation?.raw ?? "-")"
	}
}
extension Key where Value == DraftLookup {
	public static func draft(_ id: JobID) -> Self {
		.init(name: "draft/\(id)", family: .draft(id)) { try await $0.draft(id) }
	}
}
extension Key where Value == ShoppingResponse {
	public static var shopping: Self { .init(name: "shopping", family: .shopping) { try await $0.shopping() } }
}
extension Key where Value == TrashResponse {
	public static var trash: Self { .init(name: "trash", family: .trash) { try await $0.trash() } }
}

// MARK: - Disk

/// One JSON file per key under `directory` (Caches, so the system may purge it).
/// Reads are synchronous on the caller: the files are small, and a synchronous
/// read is what lets a screen have a value in its first frame. Writes to one
/// name are chained, so two quick edits land on disk in the order they were
/// made; the chain is built on the main actor, which is what makes the order
/// certain.
@MainActor
public final class DiskCache {
	private let directory: URL
	private var chains: [String: Task<Void, Never>] = [:]

	/// `directory` should include a schema version (`.../cache/v1`); bump it
	/// and the old files are simply ignored.
	public init(directory: URL) { self.directory = directory }

	private func url(_ name: String) -> URL {
		let safe = name.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? name
		return directory.appending(path: safe + ".json")
	}

	func read<V: Decodable>(_ name: String, as: V.Type) -> V? {
		guard let data = try? Data(contentsOf: url(name)) else { return nil }
		return try? JSONDecoder().decode(V.self, from: data)
	}

	func write<V: Encodable>(_ value: V, name: String) {
		guard let data = try? JSONEncoder().encode(value) else { return }
		let target = url(name)
		let previous = chains[name]
		chains[name] = Task.detached {
			await previous?.value
			try? FileManager.default.createDirectory(
				at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
			try? data.write(to: target, options: .atomic)
		}
	}

	/// Waits for every queued write, then removes the directory.
	func wipe() {
		let pending = Array(chains.values)
		chains = [:]
		let dir = directory
		Task.detached {
			for t in pending { await t.value }
			try? FileManager.default.removeItem(at: dir)
		}
	}

	/// Test seam: every queued write has landed.
	func drain() async {
		for t in chains.values { await t.value }
	}
}

// MARK: - Resource

@MainActor
protocol AnyResource: AnyObject {
	var family: Family { get }
	var watchers: Int { get }
	var watchedJobs: [JobID] { get }
	func revalidate() async
}

/// The one observable value behind a screen's data. `value` is the last thing
/// the server said (or the cache said before it), `phase` is what the refresh
/// is doing. Local optimistic edits go through `mutate`.
@MainActor @Observable
public final class Resource<Value: Codable & Sendable>: AnyResource {
	public enum Phase: Equatable, Sendable {
		case idle
		case refreshing
		case failed(APIError)
	}

	public private(set) var value: Value? { didSet { didChange() } }
	public private(set) var phase: Phase = .idle
	public let key: Key<Value>
	var family: Family { key.family }
	private(set) var watchers = 0

	@ObservationIgnored private let api: APIClient
	@ObservationIgnored private let cache: DiskCache
	/// Disk names this value is written under: the key's own, plus an alias
	/// once the Store learns two keys mean the same reply.
	@ObservationIgnored var cacheNames: [String]
	/// The Store's hook: reconcile job watchers and learn aliases.
	@ObservationIgnored var didChange: @MainActor () -> Void = {}
	@ObservationIgnored private var inflight: Task<Void, Never>?
	/// Bumped by every local write. A reply that started before the latest
	/// bump may not know about it, so it is dropped and the fetch repeated.
	@ObservationIgnored private var epoch = 0
	@ObservationIgnored private var raced = false

	init(key: Key<Value>, api: APIClient, cache: DiskCache) {
		self.key = key
		self.api = api
		self.cache = cache
		self.cacheNames = [key.name]
		self.value = cache.read(key.name, as: Value.self)
	}

	var watchedJobs: [JobID] { (value as? any WatchesJobs)?.watchedJobs ?? [] }

	/// No value yet and nothing failed: the only state that shows a skeleton.
	public var isFirstLoad: Bool {
		if value != nil { return false }
		if case .failed = phase { return false }
		return true
	}

	/// Fetch now, or join the fetch already running. Never cancels a fetch
	/// because its caller went away: the reply still fills the cache.
	public func revalidate() async {
		if let inflight { await inflight.value; return }
		phase = .refreshing
		raced = false
		let started = epoch
		let task = Task {
			do {
				let fresh = try await key.load(api)
				if started == epoch {
					value = fresh
					phase = .idle
					persist(fresh)
				} else {
					raced = true
				}
			} catch {
				phase = .failed(APIError.wrapping(error))
			}
		}
		inflight = task
		await task.value
		inflight = nil
		if raced { await revalidate() }
	}

	/// Optimistic local edit: applied at once, persisted, and the next reply
	/// that raced it is discarded (see `epoch`). No-op until a value exists.
	public func mutate(_ change: (inout Value) -> Void) {
		guard var v = value else { return }
		change(&v)
		epoch += 1
		value = v
		persist(v)
	}

	/// A server-confirmed value from a mutation reply.
	public func replace(_ new: Value) {
		epoch += 1
		value = new
		phase = .idle
		persist(new)
	}

	private func persist(_ v: Value) {
		for name in cacheNames { cache.write(v, name: name) }
	}

	/// Keep this resource fresh while a screen is visible: fetch on entry, then
	/// every `interval` if given. Cancelling the calling task ends the loop.
	/// `Store.invalidate` refetches immediately only for resources being watched.
	public func watch(every interval: Duration? = nil) async {
		watchers += 1
		defer { watchers -= 1 }
		await revalidate()
		guard let interval else { return }
		while !Task.isCancelled {
			try? await Task.sleep(for: interval)
			if Task.isCancelled { break }
			await revalidate()
		}
	}
}

// MARK: - Store

/// Owns every `Resource`, so one key is one object app-wide and every screen
/// that shows it sees the same edits. Owns every job wait for the same reason.
@MainActor @Observable
public final class Store {
	@ObservationIgnored public let api: APIClient
	@ObservationIgnored let cache: DiskCache
	@ObservationIgnored private let poller: JobPoller
	@ObservationIgnored private var resources: [String: any AnyResource] = [:]
	@ObservationIgnored private var jobWaits: [JobID: Task<Void, Never>] = [:]
	/// Jobs the client gave up on after five minutes. A reply that still lists
	/// one is not re-watched until `resume()` clears the set. Screens read this
	/// to turn a pending banner into "Still working after 5 minutes".
	public private(set) var timedOutJobs: Set<JobID> = []
	/// Jobs whose wait ended (done or failed). A reply fetched after that
	/// should no longer list them as pending; if one still does, waiting again
	/// would end at once and refetch again, a hot loop. Cleared on `resume()`.
	@ObservationIgnored private var endedJobs: Set<JobID> = []
	/// Test seam: how many waits have ever been started.
	@ObservationIgnored private(set) var waitStarts = 0

	public init(api: APIClient, cache: DiskCache, poller: JobPoller) {
		self.api = api
		self.cache = cache
		self.poller = poller
	}

	public func resource<V>(_ key: Key<V>) -> Resource<V> {
		if let r = resources[key.name] as? Resource<V> { return r }
		let r = Resource(key: key, api: api, cache: cache)
		resources[key.name] = r
		r.didChange = { [weak self, weak r] in
			guard let self, let r else { return }
			self.learnOriginal(from: r)
			self.reconcileWatchers()
		}
		r.didChange()
		return r
	}

	/// `.recipe(id, nil)` and `.recipe(id, original)` are one reply. The first
	/// reply that says `isOriginal` ties the two names to one object, so a chip
	/// tap on the original and a relaunch's cached "default" hit the same value.
	private func learnOriginal<V>(from r: Resource<V>) {
		guard let response = r.value as? RecipeResponse, response.recipe.isOriginal else { return }
		let id = response.recipe.id
		for name in [Key<RecipeResponse>.recipeName(id, nil), Key<RecipeResponse>.recipeName(id, response.recipe.variationId)]
		where resources[name] !== r {
			resources[name] = r
			if !r.cacheNames.contains(name) { r.cacheNames.append(name) }
		}
	}

	/// Something changed on the server that these resources show. Watched ones
	/// refetch now; the rest will on their next `watch`.
	public func invalidate(_ families: Family...) {
		for r in distinctResources where families.contains(r.family) && r.watchers > 0 {
			Task { await r.revalidate() }
		}
	}

	/// Every distinct resource (aliases collapse to one).
	private var distinctResources: [any AnyResource] {
		var seen: Set<ObjectIdentifier> = []
		return resources.values.filter { seen.insert(ObjectIdentifier($0)).inserted }
	}

	/// Apply `change` to every loaded resource of type `V` in `family`.
	func patch<V: Codable & Sendable>(
		_ type: V.Type, in family: Family, _ change: (inout V) -> Void
	) {
		for case let r as Resource<V> in distinctResources where r.family == family {
			r.mutate(change)
		}
	}

	/// Sign-out: forget everything, memory and disk, and stop every wait.
	public func wipe() {
		for t in jobWaits.values { t.cancel() }
		jobWaits = [:]
		timedOutJobs = []
		endedJobs = []
		resources.removeAll()
		cache.wipe()
	}

	// MARK: Job watchers

	/// Jobs currently being waited on.
	public var activeJobs: Set<JobID> { Set(jobWaits.keys) }

	/// Idempotent: the wanted set is every job a loaded reply lists, minus the
	/// ones that timed out. Start a wait for each wanted job without one,
	/// cancel each wait no longer wanted. Runs after every value change, so it
	/// converges whatever a crash or relaunch left behind.
	func reconcileWatchers() {
		var wanted: Set<JobID> = []
		for r in distinctResources { wanted.formUnion(r.watchedJobs) }
		wanted.subtract(timedOutJobs)
		wanted.subtract(endedJobs)
		for (id, task) in jobWaits where !wanted.contains(id) {
			task.cancel()
			jobWaits[id] = nil
		}
		for id in wanted where jobWaits[id] == nil {
			waitStarts += 1
			jobWaits[id] = Task { [poller] in
				let outcome: JobOutcome
				do { outcome = try await poller.wait(for: id) } catch is CancellationError {
					return
				} catch {
					// 401 or a dead connection: the reply, when it can be fetched
					// again, still lists the job and a fresh wait starts then.
					outcome = .timedOut
				}
				self.finished(id, outcome)
			}
		}
	}

	private func finished(_ id: JobID, _ outcome: JobOutcome) {
		guard jobWaits[id] != nil else { return }
		jobWaits[id] = nil
		if outcome == .timedOut { timedOutJobs.insert(id) } else { endedJobs.insert(id) }
		let owners = owners(of: id)
		Task {
			for r in owners { await r.revalidate() }
		}
	}

	/// Resources whose value lists `job`.
	func owners(of job: JobID) -> [any AnyResource] {
		distinctResources.filter { $0.watchedJobs.contains(job) }
	}

	/// Scene went to the background: stop every wait. Nothing polls in the
	/// background; the waits are re-derived on resume.
	public func suspend() {
		for t in jobWaits.values { t.cancel() }
		jobWaits = [:]
	}

	/// Scene is active again: give timed-out jobs another five minutes and
	/// start the waits the cached replies still ask for. Watched resources
	/// refetch on their own (`.watching` restarts on active), and their replies
	/// re-derive the set.
	public func resume() {
		timedOutJobs = []
		endedJobs = []
		reconcileWatchers()
	}
}

// MARK: - Effects of mutations

/// What each write does to what is already on screen. The rule: patch what the
/// client can compute exactly, invalidate what only the server knows. Every
/// mutation in the app funnels through one of these, so "edit a recipe and
/// return to the list" has one implementation, not one per screen.
extension Store {
	/// A recipe (or variation) was saved from the editor.
	public func recipeSaved(_ id: RecipeID, input: RecipeInput) {
		patch(BrowseResponse.self, in: .recipes) { list in
			guard let i = list.recipes.firstIndex(where: { $0.id == id }) else { return }
			list.recipes[i].title = input.title
			list.recipes[i].effort = input.effort
			list.recipes[i].damage = input.damage
		}
		patch(RecipeResponse.self, in: .recipe(id)) { $0.recipe.apply(input) }
		invalidate(.recipes, .recipe(id))
	}

	public func recipeDeleted(_ id: RecipeID) {
		patch(BrowseResponse.self, in: .recipes) { $0.recipes.removeAll { $0.id == id } }
		invalidate(.recipes, .trash)
	}

	public func draftSaved(_ job: JobID, recipe: RecipeID) {
		patch(BrowseResponse.self, in: .recipes) { $0.drafts.removeAll { $0.id == job } }
		invalidate(.recipes, .draft(job))
	}

	public func draftDiscarded(_ job: JobID) {
		patch(BrowseResponse.self, in: .recipes) { $0.drafts.removeAll { $0.id == job } }
		invalidate(.recipes)
	}

	/// `POST /recipes/:id/calculate` answered with a job: write it into every
	/// cached page of the recipe so the wait starts now, before any refetch.
	public func calculationStarted(_ id: RecipeID, job: JobID, toCount: Double) {
		patch(RecipeResponse.self, in: .recipe(id)) {
			$0.calcJob = CalcJob(jobId: job, status: .pending, errorText: nil, toCount: toCount)
		}
	}

	/// `POST /generations` answered with a job: put its card on every cached
	/// browse page so it shows in the first frame and the wait starts now, as
	/// `calculationStarted` does for a scale.
	public func generationStarted(_ job: JobID, description: String) {
		patch(BrowseResponse.self, in: .recipes) { list in
			guard !list.drafts.contains(where: { $0.id == job }) else { return }
			list.drafts.insert(DraftCard(id: job, status: .generating, title: description), at: 0)
		}
		invalidate(.recipes)
	}

	public func variationChanged(recipe: RecipeID) { invalidate(.recipe(recipe), .trash) }
	public func restored() { invalidate(.trash, .recipes) }
}

extension RecipeDetail {
	/// What a saved payload does to this variation, as far as the client can
	/// know: the fields it carries, the authored body in its units, and the
	/// counterpart (a nil counterpart means a reconvert is now pending). The
	/// refetch that follows replaces all of it; this only covers the gap so the
	/// screen never flashes the old text.
	mutating func apply(_ input: RecipeInput) {
		title = input.title
		yieldUnit = input.yieldUnit
		prepMinutes = input.prepMinutes
		cookMinutes = input.cookMinutes
		notes = input.notes
		mealTypes = input.mealTypes
		cuisine = input.cuisine
		protein = input.protein
		effort = input.effort
		damage = input.damage
		sourceUnits = input.sourceUnits
		ingredients = input.ingredients
		steps = input.steps
		let authored = BodyText(ingredients: input.ingredients, steps: input.steps)
		if input.sourceUnits == .us { bodies.us = authored; bodies.metric = input.counterpart ?? bodies.metric }
		else { bodies.metric = authored; bodies.us = input.counterpart ?? bodies.us }
		handEdited = true
	}
}
