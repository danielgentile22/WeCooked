import Foundation
import Testing

@testable import WeCookedKit

struct YieldStepperTests {
	static let chips: [VariationChip] = [
		.init(id: "orig", yieldCount: 4, isOriginal: true, stale: false),
		.init(id: "v8", yieldCount: 8, isOriginal: false, stale: false),
	]

	@Test func existingYieldShowsWithoutARequest() {
		var s = YieldStepper(viewed: 4)
		s.text = "8"
		#expect(s.action(chips: Self.chips) == .show("v8"))
	}
	@Test func newYieldCalculates() {
		var s = YieldStepper(viewed: 4)
		s.step(+1)
		#expect(s.action(chips: Self.chips) == .calculate(5))
	}
	@Test func viewedYieldIsUnchanged() {
		#expect(YieldStepper(viewed: 4).action(chips: Self.chips) == .unchanged)
	}
	@Test func garbageAndZeroAreInvalidAndStepNeverReachesZero() {
		var s = YieldStepper(viewed: 1)
		s.text = "abc"
		#expect(s.action(chips: Self.chips) == .invalid)
		s.text = "0"
		#expect(s.action(chips: Self.chips) == .invalid)
		s.reset(viewed: 1)
		s.step(-1)
		#expect(s.count == 0.1)
	}
	@Test func decimalsRoundToOnePlace() {
		var s = YieldStepper(viewed: 4)
		s.text = "2.55"
		#expect(s.count == 2.6 || s.count == 2.5)
		#expect(s.action(chips: Self.chips) != .invalid)
	}
}

@MainActor
struct DeviceStateTests {
	final class Memory: KeyValueStore {
		private let m = MutexBox()
		func data(forKey key: String) -> Data? { m.get(key) }
		func set(_ data: Data?, forKey key: String) { m.put(key, data) }
	}

	@Test func strikesSurviveRelaunchButNotAnEditOrTwelveIdleHours() {
		let mem = Memory()
		let d = DeviceState(store: mem, now: { Date(timeIntervalSince1970: 1_000) })
		d.toggleStrike(.step(0), variation: "v", contentVersion: 1)
		d.toggleStrike(.ingredient(group: 0, item: 1), variation: "v", contentVersion: 1)
		let relaunched = DeviceState(store: mem, now: { Date(timeIntervalSince1970: 1_000 + 3600) })
		#expect(relaunched.strikes(for: "v", contentVersion: 1).count == 2)
		#expect(relaunched.strikes(for: "v", contentVersion: 2).isEmpty, "edited recipe: positions are stale")
		let next = DeviceState(store: mem, now: { Date(timeIntervalSince1970: 1_000 + 13 * 3600) })
		#expect(next.strikes(for: "v", contentVersion: 1).isEmpty)
	}

	@Test func tappingAStruckLineUnstrikesIt() {
		let d = DeviceState(store: Memory())
		d.toggleStrike(.step(2), variation: "v", contentVersion: 1)
		d.toggleStrike(.step(2), variation: "v", contentVersion: 1)
		#expect(d.strikes(for: "v", contentVersion: 1).isEmpty)
	}

	@Test func aSecondTapDuringASendIsNotSettledAway() {
		let d = DeviceState(store: Memory())
		d.queueTick("i", true)
		d.queueTick("i", false)
		d.settleTick("i", sent: true)
		#expect(d.pendingTicks["i"] == false)
		d.settleTick("i", sent: false)
		#expect(d.pendingTicks.isEmpty)
	}

	@Test func unitsDefaultToMetricAndPersist() {
		let mem = Memory()
		let d = DeviceState(store: mem)
		#expect(d.units == .metric)
		d.units = .us
		#expect(DeviceState(store: mem).units == .us)
	}
}

import Synchronization
final class MutexBox: Sendable {
	private let m = Mutex<[String: Data]>([:])
	func get(_ k: String) -> Data? { m.withLock { $0[k] } }
	func put(_ k: String, _ v: Data?) { m.withLock { $0[k] = v } }
}

struct ShoppingLayoutTests {
	static func response() throws -> ShoppingResponse {
		try Wire.makeDecoder().decode(ShoppingResponse.self, from: Fixtures.data("shopping-get"))
	}
	static let order: [Section] = [.produce, .meatFish, .dairy, .dryGoods, .spices, .frozen, .other, .staples]

	@Test func sectionsFollowServerOrderAndStaplesCollapse() throws {
		let s = ShoppingLayout.sections(items: try Self.response().list.items, order: Self.order, units: .metric, pending: [:])
		#expect(s.map(\.section) == [.produce, .dryGoods, .other, .staples])
		#expect(s.last?.isCollapsedByDefault == true)
	}

	@Test func secondaryLineShowsOtherUnitsAndSources() throws {
		let s = ShoppingLayout.sections(items: try Self.response().list.items, order: Self.order, units: .metric, pending: [:])
		let chickpeas = try #require(s.flatMap(\.rows).first { $0.primary.contains("chickpeas") })
		#expect(chickpeas.secondary == "about 21 oz canned chickpeas · Chickpea stew")
		let manual = try #require(s.flatMap(\.rows).first { $0.primary == "bin bags" })
		#expect(manual.secondary == "added by hand")
	}

	@Test func pendingTicksOverlayTheServer() throws {
		let items = try Self.response().list.items
		let id = try #require(items.first { !$0.ticked }?.id)
		let s = ShoppingLayout.sections(items: items, order: Self.order, units: .metric, pending: [id: true])
		#expect(s.flatMap(\.rows).first { $0.id == id }?.ticked == true)
		#expect(ShoppingLayout.progress(items: items, pending: [id: true]).ticked == 2)
	}
}

struct RecipeDisplayTests {
	static func response(_ name: String) throws -> RecipeResponse {
		try Wire.makeDecoder().decode(RecipeResponse.self, from: Fixtures.data(name))
	}

	@Test func reconvertBannerOnlyOnTheConvertedSide() throws {
		let r = try Self.response("recipe-get-busy")
		#expect(RecipeDisplay.make(r, units: .metric, struck: []).banners.contains(.reconvertPending) == false)
		#expect(RecipeDisplay.make(r, units: .us, struck: []).banners.contains(.reconvertPending))
	}

	@Test func resumesACalculationFromTheServerReply() throws {
		let d = RecipeDisplay.make(try Self.response("recipe-get-busy"), units: .metric, struck: [])
		#expect(d.banners.contains(.calculating(toCount: 8)))
	}

	@Test func asWrittenOnlyForOriginalsOrHandEditedWhicheverUnitsShow() throws {
		let orig = try Self.response("recipe-get")
		#expect(RecipeDisplay.make(orig, units: .metric, struck: []).sourceIsAsWritten)
		#expect(RecipeDisplay.make(orig, units: .us, struck: []).sourceIsAsWritten)
		let scaled = try Self.response("recipe-get-variation")
		#expect(!RecipeDisplay.make(scaled, units: .metric, struck: []).sourceIsAsWritten)
	}

	@Test func missingCounterpartFallsBackToTheSourceBody() throws {
		var r = try Self.response("recipe-get")
		r.recipe.bodies.us = nil
		let d = RecipeDisplay.make(r, units: .us, struck: [])
		#expect(d.isFallback)
		#expect(d.body == r.recipe.bodies.metric)
	}
}

struct DeepLinkTests {
	@Test func parsesTheWebRoutesUnderBothSchemes() {
		#expect(DeepLink(url: URL(string: "wecooked://drafts/01ABC")!) == .draft("01ABC"))
		#expect(DeepLink(url: URL(string: "https://wecooked.kitchen/drafts/01ABC")!) == .draft("01ABC"))
		#expect(DeepLink(url: URL(string: "wecooked://recipes/r1?v=v9")!) == .recipe("r1", variation: "v9"))
		#expect(DeepLink(url: URL(string: "https://wecooked.kitchen/recipes/r1")!) == .recipe("r1", variation: nil))
		#expect(DeepLink(url: URL(string: "wecooked://shopping")!) == .shopping)
		#expect(DeepLink(url: URL(string: "https://wecooked.kitchen/")!) == .recipes)
		#expect(DeepLink(url: URL(string: "wecooked://add")!) == .add)
		#expect(DeepLink(url: URL(string: "https://wecooked.kitchen/trash")!) == .trash)
		#expect(DeepLink(url: URL(string: "https://wecooked.kitchen/login")!) == nil)
		#expect(DeepLink(url: URL(string: "mailto:x@y")!) == nil)
	}
	@Test func pathAndUrlRoundTrip() {
		#expect(DeepLink(path: "/drafts/01ABC") == .draft("01ABC"))
		let link = DeepLink.recipe("r1", variation: "v9")
		#expect(DeepLink(url: link.url) == link)
		#expect(DeepLink(url: DeepLink.draft("d").url) == .draft("d"))
	}
	@Test func pushPayloadUsesTheSameParser() {
		#expect(DeepLink(pushPayload: ["link": "wecooked://drafts/01ABC"]) == .draft("01ABC"))
	}
}

struct RecipeDisplayTimeoutTests {
	@Test func aTimedOutCalculationSaysSo() throws {
		let r = try RecipeDisplayTests.response("recipe-get-busy")
		let job = try #require(r.calcJob?.jobId)
		let d = RecipeDisplay.make(r, units: .metric, struck: [], timedOut: [job])
		#expect(d.banners.contains(.calculationTimedOut(toCount: 8)))
		#expect(!d.banners.contains(.calculating(toCount: 8)))
	}
}
