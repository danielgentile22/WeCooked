import CryptoKit
import Foundation

// The suggestion widget's whole world, fed like the shopping widget's: the
// app writes the book's titles and a few small covers into the app-group
// container, and the widget picks a recipe for the day from whatever it finds.
// The pick is a pure function of the file and the date, so the widget can lay
// out a week of days without the app running.

/// Every recipe in the book, as the unfiltered Recipes tab lists it. Encoded
/// with the `Wire` coders: `{"recipes": [{"id", "title", "effort", "damage",
/// "cover"}], "saved_at"}`.
public struct SuggestionSnapshot: Codable, Hashable, Sendable {
	public struct Pick: Codable, Hashable, Sendable {
		public let id: RecipeID
		public let title: String
		public let effort: Effort
		public let damage: Damage
		/// File name under `suggestion-covers`, from the cover's path, so a new
		/// photo is a new file. Nil for a recipe without a cover.
		public let cover: String?
		public init(id: RecipeID, title: String, effort: Effort, damage: Damage, cover: String? = nil) {
			self.id = id
			self.title = title
			self.effort = effort
			self.damage = damage
			self.cover = cover
		}
	}

	/// Sorted by id, so the rotation does not move when a title is edited.
	public var recipes: [Pick]
	public var savedAt: Date

	/// How many days ahead the app keeps covers for, and the widget lays out.
	public static let daysAhead = 7

	public init(recipes: [Pick], savedAt: Date) {
		self.recipes = recipes.sorted { $0.id.raw < $1.id.raw }
		self.savedAt = savedAt
	}

	public init(rows: [BrowseRow], now: Date) {
		self.init(
			recipes: rows.map {
				Pick(
					id: $0.id, title: $0.title, effort: $0.effort, damage: $0.damage,
					cover: $0.coverUrl.map(SuggestionFile.coverName(for:)))
			},
			savedAt: now)
	}

	/// The recipe for the day `date` falls on. Each day moves one step through
	/// the book, so every recipe comes up before any repeats. Monday to
	/// Thursday skip `project` recipes, unless the whole book is projects.
	public func pick(on date: Date, calendar: Calendar = .current) -> Pick? {
		let weekday = calendar.component(.weekday, from: date)
		let weeknight = (2...5).contains(weekday)  // Gregorian: 1 is Sunday
		let easy = recipes.filter { $0.effort != .project }
		let pool = weeknight && !easy.isEmpty ? easy : recipes
		guard !pool.isEmpty else { return nil }
		let epoch = calendar.startOfDay(for: Date(timeIntervalSinceReferenceDate: 0))
		let day = calendar.dateComponents([.day], from: epoch, to: calendar.startOfDay(for: date)).day ?? 0
		return pool[((day % pool.count) + pool.count) % pool.count]
	}

	/// The start of today and of each following day, `daysAhead` in all, with
	/// that day's pick. The widget's timeline and the app's cover list.
	public func days(from now: Date, calendar: Calendar = .current) -> [(start: Date, pick: Pick?)] {
		let today = calendar.startOfDay(for: now)
		return (0..<Self.daysAhead).compactMap { offset in
			calendar.date(byAdding: .day, value: offset, to: today).map { ($0, pick(on: $0, calendar: calendar)) }
		}
	}
}

/// `suggestion-widget.json` and `suggestion-covers/<cover name>` at the root
/// of the app-group container. The app is the only writer and writes whole
/// files atomically. A missing or unreadable file reads as nil, which the
/// widget treats like a book it has not seen yet; a missing cover is drawn
/// without a photo.
public struct SuggestionFile: Sendable {
	public static let fileName = "suggestion-widget.json"
	public static let coversName = "suggestion-covers"
	/// The widget's kind, which the app names when it asks WidgetKit to reload.
	public static let widgetKind = "SuggestionWidget"
	/// Long edge of a stored cover: a 2x2 widget is under 180 points at 3x.
	public static let coverEdge = 600
	let url: URL
	let covers: URL

	/// Nil (tests, previews) puts the files in a fresh temporary directory.
	public init(appGroup: String?) {
		let container = appGroup.flatMap {
			FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: $0)
		}
		self.init(directory: container ?? FileManager.default.temporaryDirectory.appending(path: UUID().uuidString))
	}

	init(directory: URL) {
		url = directory.appending(path: Self.fileName)
		covers = directory.appending(path: Self.coversName)
	}

	public func read() -> SuggestionSnapshot? {
		guard let data = try? Data(contentsOf: url) else { return nil }
		return try? Wire.makeDecoder().decode(SuggestionSnapshot.self, from: data)
	}

	public func write(_ snapshot: SuggestionSnapshot) {
		guard let data = try? Wire.makeEncoder().encode(snapshot) else { return }
		try? FileManager.default.createDirectory(
			at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
		try? data.write(to: url, options: .atomic)
	}

	/// A digest of the cover's host and path. The query string is a signature
	/// that changes daily, so it is left out, as in `ImageStore`. Hex, because
	/// a percent-encoded name would be decoded back into slashes by `path()`.
	public static func coverName(for url: URL) -> String {
		SHA256.hash(data: Data(ImageStore.key(for: url).utf8)).map { String(format: "%02x", $0) }.joined() + ".jpg"
	}

	public func cover(named name: String) -> URL { covers.appending(path: name) }

	public func hasCover(named name: String) -> Bool {
		FileManager.default.fileExists(atPath: cover(named: name).path())
	}

	/// Stores `image` (any format ImageIO reads) shrunk to `coverEdge`.
	public func writeCover(_ image: Data, named name: String) {
		guard let jpeg = try? JPEG.thumbnail(image, maxEdge: Self.coverEdge) else { return }
		try? FileManager.default.createDirectory(at: covers, withIntermediateDirectories: true)
		try? jpeg.write(to: cover(named: name), options: .atomic)
	}

	/// Deletes every cover not named in `names`.
	public func keepCovers(_ names: Set<String>) {
		let found = (try? FileManager.default.contentsOfDirectory(atPath: covers.path())) ?? []
		for name in found where !names.contains(name) {
			try? FileManager.default.removeItem(at: cover(named: name))
		}
	}

	public func remove() {
		try? FileManager.default.removeItem(at: url)
		try? FileManager.default.removeItem(at: covers)
	}
}
