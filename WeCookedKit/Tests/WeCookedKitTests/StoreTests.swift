import Foundation
import os
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
			fetch: { _, _ in JobPoll(status: .running, errorCode: nil, errorText: nil, resultRef: nil) },
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

	@Test func anEqualReplyIsNotAssignedOrWritten() async throws {
		let cache = Self.tempCache()
		let r = Self.store(cache).resource(Self.key { Note(text: "same") })
		await r.revalidate()
		await cache.drain()
		let file = try #require(
			try FileManager.default.contentsOfDirectory(
				at: cache.directory, includingPropertiesForKeys: nil
			).first)
		try FileManager.default.removeItem(at: file)
		let changes = CallCounter()
		withObservationTracking { _ = r.value } onChange: { _ = changes.next() }
		await r.revalidate()
		await cache.drain()
		#expect(changes.count == 0, "an equal reply leaves the value alone, so nothing re-renders")
		#expect(!FileManager.default.fileExists(atPath: file.path()), "and writes nothing to disk")
	}

	@Test func aDifferentReplyIsAssignedAndWritten() async throws {
		let cache = Self.tempCache()
		let calls = CallCounter()
		let r = Self.store(cache).resource(Self.key { Note(text: "v\(calls.next())") })
		await r.revalidate()
		await r.revalidate()
		await cache.drain()
		#expect(r.value == Note(text: "v2"))
		#expect(Self.store(cache).resource(Self.key { Note(text: "unused") }).value == Note(text: "v2"))
	}

	@Test func aSearchIsNotPersistedButTagFiltersAndTheBookAre() {
		var search = BrowseFilters()
		search.q = "chick"
		var tagged = BrowseFilters()
		tagged.efforts = [.weeknight]
		#expect(!Key<BrowseResponse>.recipes(search).persisted)
		#expect(Key<BrowseResponse>.recipes(tagged).persisted)
		#expect(Key<BrowseResponse>.recipes().persisted)
		#expect(Key<BrowseResponse>.recipes(search).evictedWhenUnwatched)
		#expect(Key<BrowseResponse>.recipes(tagged).evictedWhenUnwatched)
		#expect(!Key<BrowseResponse>.recipes().evictedWhenUnwatched)
	}

	@Test func anUnpersistedKeyNeitherWritesNorReadsTheDisk() async {
		let cache = Self.tempCache()
		let key = Key<Note>(name: "q", family: .recipes, persisted: false) { _ in Note(text: "hit") }
		await Self.store(cache).resource(key).revalidate()
		await cache.drain()
		let files = (try? FileManager.default.contentsOfDirectory(atPath: cache.directory.path())) ?? []
		#expect(files.isEmpty)
		#expect(Self.store(cache).resource(key).value == nil)
	}

	@Test func aFilteredResourceIsKeptWhileWatchedAndEvictedAfter() async {
		let store = Self.store()
		let key = Key<Note>(name: "f", family: .recipes, evictedWhenUnwatched: true) { _ in Note(text: "hit") }
		let r = store.resource(key)
		let watching = Task { await r.watch() }
		await ShoppingModelTests.until { r.value != nil }
		for _ in 0..<20 { await Task.yield() }
		#expect(store.resource(key) === r, "a visible list stays after its fetch")
		watching.cancel()
		await watching.value
		#expect(!store.holds("f"), "nobody watches it, so the Store let it go")

		let plain = store.resource(Self.key { Note(text: "kept") })
		let plainWatch = Task { await plain.watch() }
		plainWatch.cancel()
		await plainWatch.value
		#expect(store.holds("n"), "an ordinary key stays")

		let again = Task { await r.watch() }
		await ShoppingModelTests.until { r.watchers > 0 }
		#expect(store.resource(key) === r, "a view still holding it watches again: the Store takes it back")
		again.cancel()
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
		let open = OSAllocatedUnfairLock(initialState: false)
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
			fetch: { _, _ in
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
		await Self.settle { loads.count == 1 && store.activeJobs.isEmpty && r.value?.calcJob == nil }
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

	/// Two screens that list one job (a list and its recipe, say) refetch side
	/// by side when it ends, so the result lands on both in one step. Each load
	/// holds until it sees the other start; one after the other, the first
	/// would give up waiting and report it ran alone.
	@Test func theOwnersOfAFinishedJobRefetchConcurrently() async throws {
		let gate = Gate()
		let store = Store(api: StoreTests.api(), cache: StoreTests.tempCache(), poller: Self.poller(gate))
		let busy = try Self.busy()
		let job = try #require(busy.calcJob?.jobId)
		let finished: RecipeResponse = { var f = busy; f.calcJob = nil; return f }()
		let started = CallCounter()
		let alone = CallCounter()
		let load: @Sendable (APIClient) async throws -> RecipeResponse = { _ in
			_ = started.next()
			for _ in 0..<100 where started.count < 2 { try? await Task.sleep(for: .milliseconds(5)) }
			if started.count < 2 { _ = alone.next() }
			return finished
		}
		let a = store.resource(Key<RecipeResponse>(name: "a", family: .recipe(busy.recipe.id), load: load))
		let b = store.resource(Key<RecipeResponse>(name: "b", family: .recipe(busy.recipe.id), load: load))
		a.replace(busy)
		b.replace(busy)
		#expect(store.owners(of: job).count == 2)
		gate.open.withLock { $0 = true }
		await Self.settle { a.value?.calcJob == nil && b.value?.calcJob == nil }
		#expect(started.count == 2)
		#expect(alone.count == 0, "both refetches were in flight at once")
	}
}

final class CallCounter: Sendable {
	private let n = OSAllocatedUnfairLock(initialState: 0)
	var count: Int { n.withLock { $0 } }
	func next() -> Int { n.withLock { $0 += 1; return $0 } }
}
