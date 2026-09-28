import Foundation
import Synchronization
import Testing

@testable import WeCookedKit

/// The instant-reopen contract, tested without a network: `Key.load` is a
/// closure, so a scripted fetch stands in for the server.
@MainActor
struct StoreTests {
	struct Note: Codable, Sendable, Equatable { var text: String }

	static func api() -> APIClient {
		APIClient(baseURL: URL(string: "http://localhost/api/v1/")!, tokens: InMemoryTokenStore("t"))
	}
	static func tempCache() -> DiskCache {
		DiskCache(directory: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString))
	}
	/// A poller that never finishes; these tests are about values, not jobs.
	static func idlePoller() -> JobPoller {
		JobPoller(
			fetch: { _ in JobPoll(status: .running, errorCode: nil, errorText: nil, resultRef: nil) },
			sleep: { try await Task.sleep(for: $0) }, now: { .now })
	}
	static func store(_ cache: DiskCache = tempCache()) -> Store {
		Store(api: api(), cache: cache, poller: idlePoller())
	}
	static func key(_ name: String = "n", _ load: @escaping @Sendable () async throws -> Note) -> Key<Note> {
		Key(name: name, family: .trash) { _ in try await load() }
	}

	@Test func aFreshResourceHasNoValueAndShowsTheSkeleton() {
		let r = Self.store().resource(Self.key { Note(text: "x") })
		#expect(r.value == nil)
		#expect(r.isFirstLoad)
	}

	@Test func aRevalidatedValueIsThereSynchronouslyOnNextOpen() async throws {
		let cache = Self.tempCache()
		let first = Self.store(cache).resource(Self.key { Note(text: "seen") })
		await first.revalidate()
		await cache.drain()
		let second = Self.store(cache).resource(Self.key { Note(text: "never called") })
		#expect(second.value == Note(text: "seen"), "value present at init, before any await")
		#expect(!second.isFirstLoad)
	}

	@Test func oneKeyIsOneObject() {
		let store = Self.store()
		#expect(store.resource(Self.key { Note(text: "a") }) === store.resource(Self.key { Note(text: "b") }))
	}

	@Test func aReplyThatRacedALocalEditIsDroppedAndRefetched() async {
		let store = Self.store()
		let calls = CallCounter()
		let r = store.resource(Self.key {
			let n = calls.next()
			if n == 1 { try await Task.sleep(for: .milliseconds(80)); return Note(text: "old server") }
			return Note(text: "server after edit")
		})
		r.replace(Note(text: "start"))
		async let refresh: Void = r.revalidate()
		try? await Task.sleep(for: .milliseconds(20))
		r.mutate { $0.text = "local edit" }
		await refresh
		#expect(calls.count == 2)
		#expect(r.value == Note(text: "server after edit"))
	}

	@Test func aFailedRefreshKeepsTheValueAndReportsThePhase() async {
		let r = Self.store().resource(Self.key { throw APIError.transport(.timedOut) })
		r.replace(Note(text: "kept"))
		await r.revalidate()
		#expect(r.value == Note(text: "kept"))
		#expect(r.phase == .failed(.transport(.timedOut)))
	}

	@Test func recipeSavedPatchesTheListRowAndTheOpenRecipe() throws {
		let store = Self.store()
		let list = store.resource(Key<BrowseResponse>.recipes())
		list.replace(try Wire.makeDecoder().decode(BrowseResponse.self, from: Fixtures.data("recipes-list")))
		let response = try Wire.makeDecoder().decode(RecipeResponse.self, from: Fixtures.data("recipe-get"))
		let detail = store.resource(Key<RecipeResponse>.recipe(response.recipe.id, variation: nil))
		detail.replace(response)
		var form = EditorForm(recipe: response.recipe, units: .metric)
		form.title = "Chickpea stew, spicy"
		guard case .ready(let input) = form.payload() else { Issue.record("not ready"); return }
		store.recipeSaved(response.recipe.id, input: input)
		#expect(list.value?.recipes.first { $0.id == response.recipe.id }?.title == "Chickpea stew, spicy")
		#expect(detail.value?.recipe.title == "Chickpea stew, spicy")
	}

	@Test func writesToOneKeyLandInOrder() async throws {
		let cache = Self.tempCache()
		let r = Self.store(cache).resource(Self.key { Note(text: "unused") })
		for i in 1...50 { r.replace(Note(text: "v\(i)")) }
		await cache.drain()
		#expect(Self.store(cache).resource(Self.key { Note(text: "unused") }).value == Note(text: "v50"))
	}

	@Test func theOriginalVariationSharesOneEntryWithTheDefaultKey() async throws {
		let store = Self.store()
		let response = try Wire.makeDecoder().decode(RecipeResponse.self, from: Fixtures.data("recipe-get"))
		let id = response.recipe.id
		let byDefault = store.resource(Key<RecipeResponse>.recipe(id, variation: nil))
		#expect(store.resource(Key<RecipeResponse>.recipe(id, variation: response.recipe.variationId)) !== byDefault,
			"before any reply the two keys are strangers")
		byDefault.replace(response)
		#expect(store.resource(Key<RecipeResponse>.recipe(id, variation: response.recipe.variationId)) === byDefault)
		let scaled = try Wire.makeDecoder().decode(RecipeResponse.self, from: Fixtures.data("recipe-get-variation"))
		let other = store.resource(Key<RecipeResponse>.recipe(id, variation: scaled.recipe.variationId))
		other.replace(scaled)
		#expect(other !== byDefault, "a scaled variation is not aliased")
	}
}

/// The Store owns every job wait: one per job listed by any loaded reply, none
/// for a job no reply lists any more, and the owner refetched when it ends.
@MainActor
struct StoreWatcherTests {
	final class Gate: Sendable {
		let open = Mutex(false)
		let polls = CallCounter()
	}

	/// `recipe-get-busy` with only its pending calculation (the fixture also
	/// carries a pending reconvert; one job keeps the counts plain).
	static func busy() throws -> RecipeResponse {
		var r = try Wire.makeDecoder().decode(RecipeResponse.self, from: Fixtures.data("recipe-get-busy"))
		r.recipe.reconvert = nil
		r.refresh = nil
		return r
	}

	/// A poller that reports `running` until `gate` opens, sleeping for real but
	/// briefly, so the test observes the wait while it is alive.
	static func poller(_ gate: Gate) -> JobPoller {
		JobPoller(
			fetch: { _ in
				_ = gate.polls.next()
				let done = gate.open.withLock { $0 }
				return JobPoll(status: done ? .done : .running, errorCode: nil, errorText: nil, resultRef: nil)
			},
			sleep: { _ in try await Task.sleep(for: .milliseconds(5)) },
			now: { .now })
	}

	static func settle(until condition: @MainActor () -> Bool) async {
		for _ in 0..<200 where !condition() { try? await Task.sleep(for: .milliseconds(5)) }
	}

	@Test func aPendingCalcJobStartsExactlyOneWaitAndTheEndRefetchesTheOwner() async throws {
		let gate = Gate()
		let store = Store(api: StoreTests.api(), cache: StoreTests.tempCache(), poller: Self.poller(gate))
		let busy = try Self.busy()
		let job = try #require(busy.calcJob?.jobId)
		let finished: RecipeResponse = { var f = busy; f.calcJob = nil; return f }()
		let loads = CallCounter()
		let key = Key<RecipeResponse>(name: "r", family: .recipe(busy.recipe.id)) { _ in
			_ = loads.next()
			return finished
		}
		let r = store.resource(key)
		#expect(store.activeJobs.isEmpty)
		r.replace(busy)
		#expect(store.activeJobs == [job])
		#expect(store.waitStarts == 1)
		store.reconcileWatchers()
		store.reconcileWatchers()
		#expect(store.waitStarts == 1, "reconcile is idempotent")
		#expect(store.owners(of: job).count == 1)
		gate.open.withLock { $0 = true }
		await Self.settle { loads.count == 1 && store.activeJobs.isEmpty }
		#expect(loads.count == 1, "the owner was revalidated once when the job ended")
		#expect(r.value?.calcJob == nil)
		#expect(store.activeJobs.isEmpty)
		#expect(store.timedOutJobs.isEmpty)
	}

	@Test func aReplyThatStopsListingTheJobCancelsItsWait() async throws {
		let gate = Gate()
		let store = Store(api: StoreTests.api(), cache: StoreTests.tempCache(), poller: Self.poller(gate))
		let busy = try Self.busy()
		let r = store.resource(Key<RecipeResponse>(name: "r", family: .recipe(busy.recipe.id)) { _ in busy })
		r.replace(busy)
		#expect(store.activeJobs.count == 1)
		r.mutate { $0.calcJob = nil }
		#expect(store.activeJobs.isEmpty)
		let before = gate.polls.count
		try await Task.sleep(for: .milliseconds(40))
		#expect(gate.polls.count <= before + 1, "a cancelled wait stops polling")
	}

	@Test func aCachedReplyWithAPendingJobResumesTheWaitOnRelaunch() async throws {
		let gate = Gate()
		let cache = StoreTests.tempCache()
		let busy = try Self.busy()
		let key = Key<RecipeResponse>(name: "r", family: .recipe(busy.recipe.id)) { _ in busy }
		Store(api: StoreTests.api(), cache: cache, poller: Self.poller(gate)).resource(key).replace(busy)
		await cache.drain()
		let relaunched = Store(api: StoreTests.api(), cache: cache, poller: Self.poller(gate))
		_ = relaunched.resource(key)
		let job = try #require(busy.calcJob?.jobId)
		#expect(relaunched.activeJobs == [job])
	}
}

final class CallCounter: Sendable {
	private let n = Mutex(0)
	var count: Int { n.withLock { $0 } }
	func next() -> Int { n.withLock { $0 += 1; return $0 } }
}
