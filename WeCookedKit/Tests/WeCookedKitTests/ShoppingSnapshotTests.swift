import Foundation
import Testing

@testable import WeCookedKit

struct ShoppingSnapshotTests {
	static let chickpeas: ShoppingItemID = "01TEST00000000000000000029"
	static let oliveOil: ShoppingItemID = "01TEST00000000000000000030"
	static let binBags: ShoppingItemID = "01TEST00000000000000000031"
	static let saved = Date(timeIntervalSince1970: 1_790_000_000)

	static func snapshot(
		_ fixture: String = "shopping-get", units: UnitSystem = .metric, pending: [ShoppingItemID: Bool] = [:]
	) throws -> ShoppingSnapshot {
		let reply = try Wire.makeDecoder().decode(ShoppingResponse.self, from: Fixtures.data(fixture))
		return ShoppingSnapshot(
			items: reply.list.items, order: Section.known, units: units, pending: pending, now: saved)
	}

	static func made(items: Int, staples: Int) -> ShoppingSnapshot {
		ShoppingSnapshot(
			items: (1...items).map { .init(textUs: "\($0) cup", textMetric: "\($0) ml") },
			staples: staples, units: .metric, savedAt: saved)
	}

	@Test func untickedLinesInTabOrderWithStaplesCounted() throws {
		let s = try Self.snapshot()
		#expect(s.items.map(\.textMetric) == ["600 g tinned chickpeas", "bin bags"])
		#expect(s.staples == 1)
		#expect(s.savedAt == Self.saved)
	}

	@Test func anEmptyListIsEmpty() throws {
		#expect(try Self.snapshot("shopping-get-empty").display(maxLines: 4, now: Self.saved) == .empty)
		#expect(ShoppingSnapshot.emptyText == "List is empty")
	}

	@Test func anAllTickedListIsEmpty() throws {
		let all = [Self.chickpeas: true, Self.oliveOil: true, Self.binBags: true]
		#expect(try Self.snapshot(pending: all).display(maxLines: 4, now: Self.saved) == .empty)
	}

	@Test func staplesAloneAreOneLine() throws {
		let s = try Self.snapshot(pending: [Self.chickpeas: true, Self.binBags: true])
		#expect(s.display(maxLines: 4, now: Self.saved) == .list(lines: ["1 to check"], footer: nil))
	}

	@Test func linesFollowTheSnapshotsUnitSystem() throws {
		var s = try Self.snapshot()
		#expect(s.display(maxLines: 4, now: Self.saved)
			== .list(lines: ["600 g tinned chickpeas", "bin bags", "and 1 to check"], footer: nil))
		s.units = .us
		#expect(s.display(maxLines: 4, now: Self.saved)
			== .list(lines: ["21 oz canned chickpeas", "bin bags", "and 1 to check"], footer: nil))
	}

	@Test func aPendingTickRemovesTheLine() throws {
		let s = try Self.snapshot(pending: [Self.chickpeas: true])
		#expect(s.items.map(\.textMetric) == ["bin bags"])
	}

	@Test func aPendingUntickBringsTheLineBack() throws {
		let s = try Self.snapshot(pending: [Self.chickpeas: true, "01TEST00000000000000000028": false])
		#expect(s.items.map(\.textMetric) == ["2 onions", "bin bags"])
	}

	@Test func exactlyMaxLinesShowsThemAll() {
		#expect(Self.made(items: 4, staples: 0).display(maxLines: 4, now: Self.saved)
			== .list(lines: ["1 ml", "2 ml", "3 ml", "4 ml"], footer: nil))
	}

	@Test func overflowTurnsTheLastLineIntoACount() {
		#expect(Self.made(items: 6, staples: 0).display(maxLines: 4, now: Self.saved)
			== .list(lines: ["1 ml", "2 ml", "3 ml", "and 3 more"], footer: nil))
	}

	@Test func overflowAndStaplesShareTheLastLine() {
		#expect(Self.made(items: 6, staples: 2).display(maxLines: 4, now: Self.saved)
			== .list(lines: ["1 ml", "2 ml", "3 ml", "and 3 more, 2 to check"], footer: nil))
		#expect(Self.made(items: 4, staples: 2).display(maxLines: 4, now: Self.saved)
			== .list(lines: ["1 ml", "2 ml", "3 ml", "and 1 more, 2 to check"], footer: nil))
	}

	@Test func aStaleSnapshotSaysWhen() {
		let s = Self.made(items: 1, staples: 0)
		let hour: TimeInterval = 3600
		#expect(s.display(maxLines: 4, now: Self.saved + 23 * hour) == .list(lines: ["1 ml"], footer: nil))
		#expect(s.display(maxLines: 4, now: Self.saved + 25 * hour) == .list(lines: ["1 ml"], footer: "as of yesterday"))
		#expect(s.display(maxLines: 4, now: Self.saved + 72 * hour) == .list(lines: ["1 ml"], footer: "as of 3 days ago"))
	}

	@Test func jsonUsesTheContractsKeysAndRoundTrips() throws {
		let s = try Self.snapshot()
		let data = try Wire.makeEncoder().encode(s)
		let object = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
		#expect(Set(object.keys) == ["items", "staples", "units", "saved_at"])
		let first = try #require((object["items"] as? [[String: Any]])?.first)
		#expect(Set(first.keys) == ["text_us", "text_metric"])
		#expect(object["units"] as? String == "metric")
		#expect(object["saved_at"] as? String == "2026-09-21T14:13:20.000Z")
		#expect(try Wire.makeDecoder().decode(ShoppingSnapshot.self, from: data) == s)
	}
}

struct SnapshotFileTests {
	static func file() -> SnapshotFile {
		SnapshotFile(directory: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString))
	}

	@Test func writesAndReadsBack() throws {
		let file = Self.file()
		#expect(file.read() == nil)
		let s = ShoppingSnapshotTests.made(items: 2, staples: 1)
		file.write(s)
		#expect(file.read() == s)
		file.remove()
		#expect(file.read() == nil)
	}

	@Test func aCorruptFileReadsAsNothing() throws {
		let file = Self.file()
		file.write(ShoppingSnapshotTests.made(items: 1, staples: 0))
		try Data("{not json".utf8).write(to: file.url)
		#expect(file.read() == nil)
	}

	@Test func theFileSitsAtTheContractsName() {
		#expect(Self.file().url.lastPathComponent == "shopping-widget.json")
	}
}

@MainActor
struct DeviceIdentityTests {
	@Test func anEmptyStoreGetsAFreshLowercaseUUIDThatSticks() throws {
		let mem = DeviceStateTests.Memory()
		let id = DeviceIdentity.id(in: mem)
		#expect(UUID(uuidString: id) != nil)
		#expect(id == id.lowercased())
		#expect(DeviceIdentity.id(in: mem) == id)
		let stored = try #require(mem.data(forKey: DeviceIdentity.key))
		#expect(String(decoding: stored, as: UTF8.self) == id)
	}

	@Test func twoInstallsGetTwoIDs() {
		#expect(DeviceIdentity.id(in: DeviceStateTests.Memory()) != DeviceIdentity.id(in: DeviceStateTests.Memory()))
	}

	@Test func signOutKeepsTheDeviceID() {
		let mem = DeviceStateTests.Memory()
		let id = DeviceIdentity.id(in: mem)
		DeviceState(store: mem).wipe()
		#expect(DeviceIdentity.id(in: mem) == id)
	}
}

@MainActor
struct DeviceRegistrationTests {
	@Test func everyRequestCarriesTheDeviceID() async throws {
		let server = FakeServer(["GET /api/v1/shopping": FakeServer.fixture("shopping-get")])
		let env = ShoppingModelTests.env(server)
		await env.store.resource(.shopping).revalidate()
		#expect(server.lastHeaders["X-Device-Id"] == env.deviceID)
		#expect(UUID(uuidString: env.deviceID) != nil)
	}

	@Test func aClientWithoutAnIDSendsNoHeader() async throws {
		let server = FakeServer(["GET /api/v1/session": FakeServer.json(#"{"ok":true}"#)])
		let config = URLSessionConfiguration.ephemeral
		config.protocolClasses = [StubProtocol.self]
		let api = APIClient(
			baseURL: URL(string: "http://\(server.host)/api/v1/")!, tokens: InMemoryTokenStore("t"),
			session: URLSession(configuration: config))
		try await api.session()
		#expect(server.lastHeaders["X-Device-Id"] == nil)
	}

	@Test func registerDevicePostsTheIDTokenAndEnvironment() async throws {
		let server = FakeServer(["POST /api/v1/devices": FakeServer.json(#"{"ok":true}"#)])
		let env = ShoppingModelTests.env(server)
		try await env.api.registerDevice(token: "ab12", environment: .sandbox)
		#expect(server.requests == ["POST /api/v1/devices"])
		let body = try #require(try JSONSerialization.jsonObject(with: server.lastBody) as? [String: String])
		#expect(body == ["device_id": env.deviceID, "push_token": "ab12", "environment": "sandbox"])
	}
}

@MainActor
struct WidgetFeedTests {
	static func lines(_ env: AppEnvironment) -> [String]? {
		env.widgetSnapshot.read().map { s in s.items.map { $0.text(s.units) } }
	}

	@Test func theFileFollowsTheListTicksUnitsAndSignOut() async throws {
		let server = FakeServer([
			"GET /api/v1/shopping": FakeServer.fixture("shopping-get"),
			ShoppingModelTests.patch: ShoppingModelTests.ok,
		])
		let env = ShoppingModelTests.env(server)
		var writes = 0
		env.onSnapshotWritten = { writes += 1 }
		#expect(env.widgetSnapshot.read() == nil)

		await env.store.resource(.shopping).revalidate()
		await ShoppingModelTests.until { Self.lines(env) == ["600 g tinned chickpeas", "bin bags"] }
		#expect(Self.lines(env) == ["600 g tinned chickpeas", "bin bags"])
		#expect(env.widgetSnapshot.read()?.staples == 1)
		#expect(writes > 0)

		ShoppingModel(env: env).setTicked(ShoppingModelTests.chickpeas, true)
		await ShoppingModelTests.until { Self.lines(env) == ["bin bags"] }
		#expect(Self.lines(env) == ["bin bags"])

		ShoppingModel(env: env).toggleUnits()
		await ShoppingModelTests.until { env.widgetSnapshot.read()?.units == .us }
		#expect(env.widgetSnapshot.read()?.units == .us)

		env.signOut()
		#expect(env.widgetSnapshot.read() == nil)
		for _ in 0..<50 { await Task.yield() }
		#expect(env.widgetSnapshot.read() == nil, "nothing rewrites it after sign-out")
	}
}
