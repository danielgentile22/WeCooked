import Foundation
import Testing

@testable import WeCookedKit

struct SuggestionSnapshotTests {
	static let saved = Date(timeIntervalSince1970: 1_790_000_000)
	static let calendar: Calendar = {
		var c = Calendar(identifier: .gregorian)
		c.timeZone = TimeZone(identifier: "America/New_York")!
		return c
	}()

	/// Noon on the given day of November 2026; the 2nd is a Monday.
	static func day(_ d: Int, hour: Int = 12) -> Date {
		calendar.date(from: DateComponents(year: 2026, month: 11, day: d, hour: hour))!
	}

	static func pick(_ id: String, _ effort: Effort = .weeknight) -> SuggestionSnapshot.Pick {
		.init(id: RecipeID(id), title: "Recipe \(id)", effort: effort, damage: .tidy)
	}

	static func ids(_ s: SuggestionSnapshot, days: ClosedRange<Int>) -> [String] {
		days.map { s.pick(on: day($0), calendar: calendar)?.id.raw ?? "-" }
	}

	@Test func readsTheUnfilteredBrowseList() throws {
		let reply = try Wire.makeDecoder().decode(BrowseResponse.self, from: Fixtures.data("recipes-list"))
		let s = SuggestionSnapshot(rows: reply.recipes, now: Self.saved)
		#expect(s.recipes.count == reply.recipes.count)
		#expect(s.recipes.map(\.id.raw) == s.recipes.map(\.id.raw).sorted())
		let covered = try #require(reply.recipes.first { $0.coverUrl != nil })
		let pick = try #require(s.recipes.first { $0.id == covered.id })
		#expect(pick.cover == SuggestionFile.coverName(for: covered.coverUrl!))
	}

	@Test func anEmptyBookSuggestsNothing() {
		let s = SuggestionSnapshot(recipes: [], savedAt: Self.saved)
		#expect(s.pick(on: Self.day(2), calendar: Self.calendar) == nil)
	}

	@Test func onePickPerDaySteppingThroughTheBook() {
		let s = SuggestionSnapshot(recipes: [Self.pick("c"), Self.pick("a"), Self.pick("b")], savedAt: Self.saved)
		let week = Self.ids(s, days: 2...7)
		#expect(Set(week.prefix(3)) == ["a", "b", "c"], "every recipe before any repeats")
		#expect(week.prefix(3) == week.dropFirst(3).prefix(3))
		#expect(s.pick(on: Self.day(2, hour: 0), calendar: Self.calendar)
			== s.pick(on: Self.day(2, hour: 23), calendar: Self.calendar), "steady all day")
	}

	@Test func weeknightsSkipProjectsAndWeekendsDoNot() {
		let s = SuggestionSnapshot(
			recipes: [Self.pick("a"), Self.pick("p1", .project), Self.pick("p2", .project), Self.pick("p3", .project)],
			savedAt: Self.saved)
		#expect(Self.ids(s, days: 2...5) == ["a", "a", "a", "a"], "Monday to Thursday")
		#expect(Self.ids(s, days: 6...8).contains { $0.hasPrefix("p") }, "Friday to Sunday use the whole book")
	}

	@Test func aBookOfProjectsStillSuggestsOnWeeknights() {
		let s = SuggestionSnapshot(recipes: [Self.pick("p", .project)], savedAt: Self.saved)
		#expect(Self.ids(s, days: 2...5) == ["p", "p", "p", "p"])
	}

	@Test func daysStartAtMidnightForAWeek() {
		let s = SuggestionSnapshot(recipes: [Self.pick("a")], savedAt: Self.saved)
		let days = s.days(from: Self.day(2), calendar: Self.calendar)
		#expect(days.count == SuggestionSnapshot.daysAhead)
		#expect(days.first?.start == Self.day(2, hour: 0))
		#expect(days.last?.start == Self.day(8, hour: 0))
		#expect(days.allSatisfy { $0.pick?.id == "a" })
	}

	@Test func sameContentIgnoresWhenItWasSaved() {
		let a = SuggestionSnapshot(recipes: [Self.pick("a"), Self.pick("b")], savedAt: Self.saved)
		let b = SuggestionSnapshot(recipes: [Self.pick("b"), Self.pick("a")], savedAt: .now)
		#expect(a.sameContent(as: b))
		#expect(!a.sameContent(as: nil))
		#expect(!a.sameContent(as: SuggestionSnapshot(recipes: [Self.pick("a")], savedAt: Self.saved)))
	}

	@Test func roundTripsThroughTheWireCoders() throws {
		let s = SuggestionSnapshot(recipes: [Self.pick("a", .project)], savedAt: Self.saved)
		let data = try Wire.makeEncoder().encode(s)
		let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
		#expect(object["saved_at"] as? String == "2026-09-21T14:13:20.000Z")
		#expect((object["recipes"] as? [[String: Any]])?.first?["effort"] as? String == "project")
		#expect(try Wire.makeDecoder().decode(SuggestionSnapshot.self, from: data) == s)
	}
}

struct SuggestionFileTests {
	static func file() -> SuggestionFile {
		SuggestionFile(directory: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString))
	}

	@Test func writesAndReadsBack() {
		let file = Self.file()
		#expect(file.read() == nil)
		let s = SuggestionSnapshot(recipes: [SuggestionSnapshotTests.pick("a")], savedAt: SuggestionSnapshotTests.saved)
		file.write(s)
		#expect(file.read() == s)
		#expect(file.url.lastPathComponent == "suggestion-widget.json")
	}

	@Test func coversAreShrunkKeptAndRemoved() throws {
		let file = Self.file()
		let big = try JPEGTests.image(width: 2000, height: 1000, type: .png)
		file.writeCover(big, named: "a.jpg")
		file.writeCover(big, named: "b.jpg")
		let size = try #require(JPEG.size(of: try Data(contentsOf: file.cover(named: "a.jpg"))))
		#expect(size.width == SuggestionFile.coverEdge && size.height == 300)
		file.keepCovers(["b.jpg"])
		#expect(!file.hasCover(named: "a.jpg"))
		#expect(file.hasCover(named: "b.jpg"))
		file.write(SuggestionSnapshot(recipes: [], savedAt: .now))
		file.remove()
		#expect(!file.hasCover(named: "b.jpg"))
		#expect(file.read() == nil)
	}

	@Test func coverNamesIgnoreTheDailySignature() throws {
		let today = try #require(URL(string: "https://r2.example/bucket/images/01X/display.jpg?X-Amz-Signature=aaa"))
		let tomorrow = try #require(URL(string: "https://r2.example/bucket/images/01X/display.jpg?X-Amz-Signature=bbb"))
		let other = try #require(URL(string: "https://r2.example/bucket/images/01Y/display.jpg?X-Amz-Signature=aaa"))
		#expect(SuggestionFile.coverName(for: today) == SuggestionFile.coverName(for: tomorrow))
		#expect(SuggestionFile.coverName(for: today) != SuggestionFile.coverName(for: other))
		let name = SuggestionFile.coverName(for: today)
		#expect(name.allSatisfy { $0.isLetter || $0.isNumber || $0 == "." }, "nothing path() would decode")
		let file = SuggestionFileTests.file()
		file.writeCover(try JPEGTests.image(width: 10, height: 10, type: .png), named: name)
		#expect(file.hasCover(named: name))
	}
}

@MainActor
struct SuggestionFeedTests {
	@Test func aChangeTheWidgetDoesNotShowWritesNothingAndReloadsOnlyItsKind() async throws {
		let env = ShoppingModelTests.env(FakeServer())
		var kinds: [String] = []
		env.onSnapshotWritten = { kinds.append($0) }
		var reply = try Wire.makeDecoder().decode(BrowseResponse.self, from: Fixtures.data("recipes-list"))
		for i in reply.recipes.indices { reply.recipes[i].coverUrl = nil }  // no cover downloads
		let list = env.store.resource(.recipes())
		list.replace(reply)
		await ShoppingModelTests.until { env.suggestionFile.read() != nil }
		for _ in 0..<50 { await Task.yield() }
		#expect(Set(kinds) == [SuggestionFile.widgetKind])
		let count = kinds.count
		let first = try #require(env.suggestionFile.read())

		list.mutate { $0.drafts = [] }  // drafts are not in the widget
		for _ in 0..<50 { await Task.yield() }
		#expect(kinds.count == count)
		#expect(env.suggestionFile.read()?.savedAt == first.savedAt)

		list.mutate { $0.recipes[0].title = "Renamed" }
		await ShoppingModelTests.until { kinds.count > count }
		#expect(env.suggestionFile.read()?.recipes.contains { $0.title == "Renamed" } == true)
		#expect(Set(kinds) == [SuggestionFile.widgetKind])
	}
}
