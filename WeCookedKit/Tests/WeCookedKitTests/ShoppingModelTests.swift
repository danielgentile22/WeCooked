import Foundation
import Testing

@testable import WeCookedKit

@MainActor
struct ShoppingModelTests {
	static let base = "/api/v1/shopping"
	/// Unticked on the server in `shopping-get`.
	static let chickpeas: ShoppingItemID = "01TEST00000000000000000029"
	static let patch = "PATCH \(base)/items/\(chickpeas)"
	static let ok = FakeServer.json(#"{"ok":true}"#)

	static func env(_ server: FakeServer, defaults: any KeyValueStore = DeviceStateTests.Memory()) -> AppEnvironment {
		let config = URLSessionConfiguration.ephemeral
		config.protocolClasses = [StubProtocol.self]
		return AppEnvironment(
			config: AppConfig(baseURL: URL(string: "http://\(server.host)/api/v1/")!),
			tokens: InMemoryTokenStore("t"), defaults: defaults,
			cachesDirectory: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString),
			session: URLSession(configuration: config))
	}

	static func reply(_ name: String = "shopping-get") throws -> ShoppingResponse {
		try Wire.makeDecoder().decode(ShoppingResponse.self, from: Fixtures.data(name))
	}

	static func model(_ env: AppEnvironment, _ reply: ShoppingResponse? = nil) throws -> ShoppingModel {
		env.store.resource(.shopping).replace(try reply ?? Self.reply())
		return ShoppingModel(env: env)
	}

	static func withBuild(_ build: ShoppingBuild?) throws -> ShoppingResponse {
		var r = try reply()
		r.list.build = build
		return r
	}

	static func until(_ condition: () -> Bool) async {
		let deadline = ContinuousClock.now + .seconds(5)
		while !condition(), ContinuousClock.now < deadline { await Task.yield() }
	}

	func mirrored(_ model: ShoppingModel) -> Bool? {
		model.resource.value?.list.items.first { $0.id == Self.chickpeas }?.ticked
	}

	func shown(_ model: ShoppingModel) -> Bool? {
		model.sections.flatMap(\.rows).first { $0.id == Self.chickpeas }?.ticked
	}

	@Test func aTickShowsAtOnceAndAFlushSettlesIt() async throws {
		let server = FakeServer([Self.patch: Self.ok])
		let env = Self.env(server)
		let model = try Self.model(env)
		model.setTicked(Self.chickpeas, true)
		#expect(env.device.pendingTicks == [Self.chickpeas: true])
		#expect(mirrored(model) == true)
		#expect(shown(model) == true)
		#expect(model.progress.ticked == 2)
		#expect(model.progress.total == 4)
		await model.flush()
		#expect(env.device.pendingTicks.isEmpty)
		#expect(mirrored(model) == true)
		#expect(server.requests == [Self.patch])
		#expect(model.banner == nil)
	}

	@Test func aFailedSendStaysQueuedAndLandsWhenTheSignalReturns() async throws {
		let defaults = DeviceStateTests.Memory()
		let dead = Self.env(FakeServer([Self.patch: (500, try Fixtures.data("error"))]), defaults: defaults)
		let offline = try Self.model(dead)
		offline.setTicked(Self.chickpeas, true)
		await offline.flush()
		#expect(dead.device.pendingTicks == [Self.chickpeas: true])
		#expect(shown(offline) == true)
		#expect(offline.banner == nil, "a dead spot is silent")

		let server = FakeServer([Self.patch: Self.ok])
		let live = Self.env(server, defaults: defaults)
		#expect(live.device.pendingTicks == [Self.chickpeas: true], "the outbox survives a relaunch")
		let model = try Self.model(live)
		let visible = Task { await model.appear() }
		await Self.until { live.device.pendingTicks.isEmpty }
		visible.cancel()
		#expect(live.device.pendingTicks.isEmpty)
		#expect(server.requests == [Self.patch])
		#expect(mirrored(model) == true)
	}

	@Test func aSecondTapDuringASendIsSentAfterIt() async throws {
		let server = FakeServer([Self.patch: Self.ok])
		let env = Self.env(server)
		let model = try Self.model(env)
		model.setTicked(Self.chickpeas, true)
		await Self.until { model.flushing != nil }
		model.setTicked(Self.chickpeas, false)
		await model.flush()
		#expect(server.requests == [Self.patch, Self.patch])
		#expect(env.device.pendingTicks.isEmpty)
		#expect(mirrored(model) == false, "the later target wins")
	}

	@Test func aPollThatStartedBeforeATickDoesNotFlipItBack() async throws {
		let server = FakeServer(["GET \(Self.base)": FakeServer.fixture("shopping-get")])
		let env = Self.env(server)
		let model = try Self.model(env)
		let poll = Task { await model.resource.revalidate() }
		await Self.until { model.resource.phase == .refreshing }
		model.setTicked(Self.chickpeas, true)
		await poll.value
		#expect(server.requests.filter { $0.hasPrefix("GET") }.count == 2, "the raced reply is dropped and refetched")
		#expect(shown(model) == true)
		#expect(env.device.pendingTicks == [Self.chickpeas: true], "the send failed, so the tick waits")
	}

	@Test func theRebuildNoticeShowsOncePerBuild() throws {
		let env = Self.env(FakeServer())
		let model = try Self.model(env)
		let lost = ShoppingBuild(
			jobId: "01TEST00000000000000000040", status: .done, errorText: nil,
			result: BuildResult(kept: 1, reset: ["2 onions", "olive oil"]))
		model.noticed(try Self.withBuild(lost))
		#expect(model.notice == "1 tick kept. 2 reset because the line changed: 2 onions, olive oil.")
		#expect(env.device.seenBuild == lost.jobId)
		model.dismissNotice()
		model.noticed(try Self.withBuild(lost))
		#expect(model.notice == nil)

		let clean = ShoppingBuild(
			jobId: "01TEST00000000000000000041", status: .done, errorText: nil,
			result: BuildResult(kept: 3, reset: []))
		model.noticed(try Self.withBuild(clean))
		#expect(model.notice == nil)
		#expect(env.device.seenBuild == clean.jobId)
	}

	@Test func aBuildStartedElsewhereEndsTheNotice() throws {
		let env = Self.env(FakeServer())
		let model = try Self.model(env)
		model.noticed(try Self.withBuild(ShoppingBuild(
			jobId: "01TEST00000000000000000042", status: .done, errorText: nil,
			result: BuildResult(kept: 0, reset: ["olive oil"]))))
		#expect(model.notice != nil)
		model.noticed(try Self.withBuild(ShoppingBuild(
			jobId: "01TEST00000000000000000043", status: .pending, errorText: nil, result: nil)))
		#expect(model.notice == nil)
	}

	@Test func phaseFollowsTheReply() throws {
		let env = Self.env(FakeServer())
		let model = try Self.model(env)
		#expect(model.phase == .list)
		#expect(model.hasList)
		#expect(model.buildError == nil)
		#expect(model.picks.count == 1)
		#expect(model.pickable.count == 3)

		model.resource.replace(try Self.reply("shopping-get-empty"))
		#expect(model.phase == .empty)
		#expect(!model.hasList)

		let job: JobID = "01TEST00000000000000000042"
		model.resource.replace(try Self.withBuild(ShoppingBuild(jobId: job, status: .pending, errorText: nil, result: nil)))
		#expect(model.phase == .building)

		model.resource.replace(try Self.withBuild(ShoppingBuild(jobId: job, status: .failed, errorText: "Could not reach the model.", result: nil)))
		#expect(model.phase == .list)
		#expect(model.buildError == "Could not reach the model.")
		model.resource.replace(try Self.withBuild(ShoppingBuild(jobId: job, status: .failed, errorText: nil, result: nil)))
		#expect(model.buildError == "The build failed.")
	}

	@Test func addManualPostsAndRefetches() async throws {
		let server = FakeServer([
			"POST \(Self.base)/manual": Self.ok, "GET \(Self.base)": FakeServer.fixture("shopping-get"),
		])
		let model = try Self.model(Self.env(server))
		await model.addManual("bin bags")
		#expect(server.requests == ["POST \(Self.base)/manual", "GET \(Self.base)"])
		#expect(model.banner == nil)
	}

	@Test func aRejectedManualLineShowsTheServersMessage() async throws {
		let server = FakeServer(["POST \(Self.base)/manual": (400, Data(#"{"error":"Nothing to add."}"#.utf8))])
		let model = try Self.model(Self.env(server))
		await model.addManual(" ")
		#expect(model.banner == "Nothing to add.")
		#expect(server.requests == ["POST \(Self.base)/manual"])
	}

	@Test func doneShoppingClearsTheOutboxAndShowsTheEmptyList() async throws {
		let server = FakeServer([
			"POST \(Self.base)/done": Self.ok, "GET \(Self.base)": FakeServer.fixture("shopping-get-empty"),
		])
		let env = Self.env(server)
		let model = try Self.model(env)
		env.device.queueTick(Self.chickpeas, true)
		model.noticed(try Self.withBuild(ShoppingBuild(
			jobId: "01TEST00000000000000000043", status: .done, errorText: nil,
			result: BuildResult(kept: 0, reset: ["olive oil"]))))
		#expect(model.notice != nil)
		await model.doneShopping()
		#expect(server.requests == ["POST \(Self.base)/done", "GET \(Self.base)"])
		#expect(env.device.pendingTicks.isEmpty)
		#expect(model.notice == nil)
		#expect(model.phase == .empty)
	}

	@Test func startBuildPostsThePicksAndShowsTheBuild() async throws {
		let server = FakeServer([
			"POST \(Self.base)/build": FakeServer.fixture("shopping-build"),
			"GET \(Self.base)": FakeServer.fixture("shopping-get"),
		])
		let model = try Self.model(Self.env(server))
		await model.startBuild([BuildPick(recipeId: "01TEST00000000000000000003", yieldCount: 6)])
		#expect(server.requests == ["POST \(Self.base)/build", "GET \(Self.base)"])
		#expect(model.banner == nil)
	}

	@Test func toggleUnitsFlipsThePhonesSetting() throws {
		let env = Self.env(FakeServer())
		let model = try Self.model(env)
		model.toggleUnits()
		#expect(env.device.units == .us)
		#expect(model.sections.flatMap(\.rows).first { $0.id == Self.chickpeas }?.primary == "21 oz canned chickpeas")
	}
}
