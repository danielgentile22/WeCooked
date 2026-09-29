import Foundation
import Synchronization
import Testing

@testable import WeCookedKit

/// Answers requests for one host from a table of "METHOD /path" routes and
/// logs every request it saw. Each test gets its own host, so tests running
/// in parallel never share routes.
final class FakeServer: Sendable {
	typealias Reply = (status: Int, body: Data)
	let host = UUID().uuidString.lowercased() + ".test"
	private let routes: [String: Reply]
	private let log = Mutex<[String]>([])

	init(_ routes: [String: Reply] = [:]) {
		self.routes = routes
		StubProtocol.servers.withLock { $0[host] = self }
	}

	var requests: [String] { log.withLock { $0 } }

	fileprivate func answer(_ request: URLRequest) -> Reply {
		let url = request.url!
		let key = "\(request.httpMethod ?? "GET") \(url.path())" + (url.query().map { "?\($0)" } ?? "")
		log.withLock { $0.append(key) }
		if url.path().contains("/jobs/") { return (200, try! Fixtures.data("job-get-queued")) }
		return routes[key] ?? (404, try! Fixtures.data("error"))
	}

	static func json(_ s: String) -> Reply { (200, Data(s.utf8)) }
	static func fixture(_ name: String) -> Reply { (200, try! Fixtures.data(name)) }
}

final class StubProtocol: URLProtocol, @unchecked Sendable {
	static let servers = Mutex<[String: FakeServer]>([:])

	override class func canInit(with request: URLRequest) -> Bool { true }
	override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
	override func stopLoading() {}
	override func startLoading() {
		let url = request.url!
		let server = Self.servers.withLock { $0[url.host() ?? ""] }
		let (status, body) = server?.answer(request) ?? (404, Data())
		let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!
		client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
		client?.urlProtocol(self, didLoad: body)
		client?.urlProtocolDidFinishLoading(self)
	}
}

@MainActor
struct RecipeModelTests {
	static let recipe: RecipeID = "01TEST00000000000000000003"
	static let original: VariationID = "01TEST00000000000000000004"
	static let eight: VariationID = "01TEST00000000000000000013"
	static let job: JobID = "01TEST00000000000000000012"
	static let base = "/api/v1/recipes/01TEST00000000000000000003"

	static func env(_ server: FakeServer) -> AppEnvironment {
		let config = URLSessionConfiguration.ephemeral
		config.protocolClasses = [StubProtocol.self]
		return AppEnvironment(
			config: AppConfig(baseURL: URL(string: "http://\(server.host)/api/v1/")!),
			tokens: InMemoryTokenStore("t"), defaults: DeviceStateTests.Memory(),
			cachesDirectory: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString),
			session: URLSession(configuration: config))
	}

	static func reply(_ name: String) throws -> RecipeResponse {
		try Wire.makeDecoder().decode(RecipeResponse.self, from: Fixtures.data(name))
	}

	/// The original (4) and an 8 cached, both listing both chips, as after a
	/// calculate for 8 finished.
	static func seed(_ env: AppEnvironment, withEight: Bool = true) throws {
		let eight = try reply("recipe-get-variation")
		var original = try reply("recipe-get")
		original.recipe.variations = eight.recipe.variations
		env.store.resource(.recipe(recipe, variation: nil)).replace(original)
		if withEight { env.store.resource(.recipe(recipe, variation: Self.eight)).replace(eight) }
	}

	@Test func anExistingYieldSwitchesWithoutARequest() async throws {
		let server = FakeServer()
		let env = Self.env(server)
		try Self.seed(env)
		let model = RecipeModel(recipe: Self.recipe, variation: nil, env: env)
		model.stepper.text = "8"
		await model.commitStepper()
		#expect(model.variationID == Self.eight)
		#expect(model.display?.detail.yieldCount == 8)
		#expect(server.requests.isEmpty)
	}

	@Test func aNewYieldPostsCalculateAndTheCachedReplyListsTheJob() async throws {
		let server = FakeServer(["POST \(Self.base)/calculate": FakeServer.fixture("recipe-calculate-job")])
		let env = Self.env(server)
		try Self.seed(env)
		let model = RecipeModel(recipe: Self.recipe, variation: nil, env: env)
		model.stepper.text = "6"
		await model.commitStepper()
		#expect(server.requests.first == "POST \(Self.base)/calculate")
		#expect(model.resource.value?.calcJob?.jobId == Self.job)
		#expect(env.store.activeJobs.contains(Self.job))
		#expect(model.display?.banners == [.calculating(toCount: 6)])
		#expect(model.variationID == nil)
	}

	@Test func aCalculateErrorSetsTheBanner() async throws {
		let server = FakeServer([
			"POST \(Self.base)/calculate": (400, Data(#"{"error":"Yield must be a positive number."}"#.utf8))
		])
		let env = Self.env(server)
		try Self.seed(env)
		let model = RecipeModel(recipe: Self.recipe, variation: nil, env: env)
		model.stepper.text = "6"
		await model.commitStepper()
		#expect(model.localBanner == .calculationFailed("Yield must be a positive number."))
		#expect(env.store.activeJobs.isEmpty)
	}

	@Test func showResetsTheStepperToTheNewYieldAndClearsTheBanner() async throws {
		let server = FakeServer()
		let env = Self.env(server)
		try Self.seed(env, withEight: false)
		let model = RecipeModel(recipe: Self.recipe, variation: nil, env: env)
		model.stepper.text = "6"
		await model.commitStepper()
		#expect(model.localBanner != nil)
		model.show(Self.eight)
		#expect(model.stepper.text == "8", "uncached: the chip's yield")
		#expect(model.stepper.viewed == 8)
		#expect(model.localBanner == nil)
	}

	@Test func deleteVariationReturnsToTheOriginal() async throws {
		let server = FakeServer(["DELETE /api/v1/variations/\(Self.eight)": FakeServer.json(#"{"ok":true}"#)])
		let env = Self.env(server)
		try Self.seed(env)
		let model = RecipeModel(recipe: Self.recipe, variation: Self.eight, env: env)
		#expect(model.stepper.viewed == 8)
		await model.deleteVariation()
		#expect(server.requests == ["DELETE /api/v1/variations/\(Self.eight)"])
		#expect(model.variationID == Self.original)
		#expect(model.display?.detail.isOriginal == true)
		#expect(model.stepper.viewed == 4)
		#expect(model.localBanner == nil)
	}

	@Test func recalculateReturnsToTheOriginalWithTheJobListed() async throws {
		let server = FakeServer([
			"POST /api/v1/variations/\(Self.eight)/recalculate": FakeServer.json(#"{"job_id":"01TEST00000000000000000012"}"#)
		])
		let env = Self.env(server)
		try Self.seed(env)
		let model = RecipeModel(recipe: Self.recipe, variation: Self.eight, env: env)
		await model.recalculate()
		#expect(model.variationID == Self.original)
		#expect(model.display?.banners == [.calculating(toCount: 8)])
		#expect(env.store.activeJobs.contains(Self.job))
	}

	/// Keep mine on the 8 refetches the 8 itself: nothing else may be watching
	/// it, and the stale banner clears only from its fresh reply.
	@Test func keepMineRefetchesTheViewedVariation() async throws {
		let server = FakeServer([
			"POST /api/v1/variations/\(Self.eight)/keep-mine": FakeServer.json(#"{"ok":true}"#),
			"GET \(Self.base)?v=\(Self.eight)": FakeServer.fixture("recipe-get-variation"),
		])
		let env = Self.env(server)
		try Self.seed(env)
		let model = RecipeModel(recipe: Self.recipe, variation: Self.eight, env: env)
		await model.keepMine()
		#expect(server.requests == ["POST /api/v1/variations/\(Self.eight)/keep-mine", "GET \(Self.base)?v=\(Self.eight)"])
		#expect(model.localBanner == nil)
	}

	@Test func aFailedActionSetsTheActionBanner() async throws {
		let env = Self.env(FakeServer())
		try Self.seed(env)
		let model = RecipeModel(recipe: Self.recipe, variation: Self.eight, env: env)
		await model.keepMine()
		#expect(model.localBanner == .actionFailed("Recipe not found"))
	}

	@Test func appearPrefetchesTheOtherVariations() async throws {
		let server = FakeServer(["GET \(Self.base)?v=\(Self.eight)": FakeServer.fixture("recipe-get-variation")])
		let env = Self.env(server)
		try Self.seed(env, withEight: false)
		let model = RecipeModel(recipe: Self.recipe, variation: nil, env: env)
		let eight = env.store.resource(.recipe(Self.recipe, variation: Self.eight))
		await Self.appear(model) { eight.value != nil }
		#expect(server.requests == ["GET \(Self.base)?v=\(Self.eight)"])
		#expect(eight.value?.recipe.yieldCount == 8)
	}

	// MARK: Transitions

	/// Runs `appear()` (which reads replies until cancelled), lets its loop
	/// record the current reply, applies `change`, and waits for `done`.
	static func appear(_ model: RecipeModel, change: () -> Void = {}, until done: () -> Bool) async {
		let task = Task { await model.appear() }
		try? await Task.sleep(for: .milliseconds(50))
		change()
		for _ in 0..<200 where !done() { try? await Task.sleep(for: .milliseconds(10)) }
		task.cancel()
		await task.value
	}

	static func calculating(_ reply: RecipeResponse, _ status: PendingStatus = .pending) -> RecipeResponse {
		var r = reply
		r.calcJob = CalcJob(jobId: job, status: status, errorText: nil, toCount: 8)
		return r
	}

	@Test func aCalculateThatEndedSwitchesToTheNewChip() async throws {
		let env = Self.env(FakeServer())
		try Self.seed(env)
		let original = env.store.resource(.recipe(Self.recipe, variation: nil))
		let finished = try #require(original.value)
		var busy = Self.calculating(finished)
		busy.recipe.variations = busy.recipe.variations.filter(\.isOriginal)
		original.replace(busy)
		let model = RecipeModel(recipe: Self.recipe, variation: nil, env: env)
		model.stepper.text = "8"
		await Self.appear(model, change: { original.replace(finished) }) { model.variationID != nil }
		#expect(model.variationID == Self.eight)
		#expect(model.stepper.viewed == 8)
		#expect(model.stepper.text == "8")
		#expect(model.display?.detail.yieldCount == 8)
	}

	@Test func aCalculateThatFailedStaysPut() throws {
		let env = Self.env(FakeServer())
		try Self.seed(env)
		let finished = try #require(env.store.resource(.recipe(Self.recipe, variation: nil)).value)
		let model = RecipeModel(recipe: Self.recipe, variation: nil, env: env)
		model.noticed(Self.calculating(finished))
		model.noticed(Self.calculating(finished, .failed))
		#expect(model.variationID == nil)
	}

	/// The failure forged for row 21 outlived the retry that succeeded: the
	/// server filed the finished job under its variation, so the older
	/// failure was the recipe's calcJob again beside the new chip.
	@Test func aCalculateThatEndedBesideAnOlderFailureStillSwitches() throws {
		let env = Self.env(FakeServer())
		try Self.seed(env)
		let finished = try #require(env.store.resource(.recipe(Self.recipe, variation: nil)).value)
		let model = RecipeModel(recipe: Self.recipe, variation: nil, env: env)
		model.noticed(Self.calculating(finished))
		var older = finished
		older.calcJob = CalcJob(
			jobId: "01TEST00000000000000000099", status: .failed,
			errorText: "Claude is unavailable right now. Try again in a minute.", toCount: 8)
		model.noticed(older)
		#expect(model.variationID == Self.eight)
	}

	@Test func aRefreshThatEndedShowsUpdatedUntilAChipTap() throws {
		let env = Self.env(FakeServer())
		try Self.seed(env)
		let current = try Self.reply("recipe-get-variation")
		var refreshing = current
		refreshing.refresh = PendingWork(jobId: Self.job, status: .pending)
		let model = RecipeModel(recipe: Self.recipe, variation: Self.eight, env: env)
		model.noticed(refreshing)
		model.noticed(current)
		#expect(model.localBanner == .updated)
		model.show(Self.original)
		#expect(model.localBanner == nil)
	}

	@Test func aReplyForAnotherVariationIsRecordedWithoutATransition() throws {
		let env = Self.env(FakeServer())
		try Self.seed(env)
		var busy = Self.calculating(try #require(env.store.resource(.recipe(Self.recipe, variation: nil)).value))
		busy.refresh = PendingWork(jobId: Self.job, status: .pending)
		let model = RecipeModel(recipe: Self.recipe, variation: nil, env: env)
		model.noticed(busy)
		model.show(Self.eight)
		model.noticed(try Self.reply("recipe-get-variation"))
		#expect(model.variationID == Self.eight)
		#expect(model.localBanner == nil)
	}
}
