import Foundation

// The shopping widget's whole world. The widget never calls the server and
// never reads the Keychain: the app writes this value into the app-group
// container whenever the list, a tick or the unit system changes, and the
// widget renders `display` from whatever file it finds.

/// The unticked list as the Shopping tab would show it, in both unit systems
/// so the widget can follow the toggle without the app. Encoded with the
/// `Wire` coders: `{"items": [{"text_us", "text_metric"}], "staples", "units",
/// "saved_at"}`.
public struct ShoppingSnapshot: Codable, Hashable, Sendable {
	public struct Line: Codable, Hashable, Sendable {
		public let textUs: String
		public let textMetric: String
		public init(textUs: String, textMetric: String) {
			self.textUs = textUs
			self.textMetric = textMetric
		}
		public func text(_ units: UnitSystem) -> String { units == .us ? textUs : textMetric }
	}

	/// Unticked non-staple lines, in the tab's order.
	public var items: [Line]
	/// Unticked staples, shown only as a count, as the tab collapses them.
	public var staples: Int
	public var units: UnitSystem
	public var savedAt: Date

	public static let emptyText = "List is empty"
	/// Past this age the widget says when the list is from.
	static let staleAfter: TimeInterval = 24 * 3600

	public init(items: [Line], staples: Int, units: UnitSystem, savedAt: Date) {
		self.items = items
		self.staples = staples
		self.units = units
		self.savedAt = savedAt
	}

	/// The tab's order and the outbox laid over the server's ticks, through the
	/// same `ShoppingLayout.ordered` the tab uses, so the two never disagree.
	public init(
		items: [ShoppingItem], order: [Section], units: UnitSystem,
		pending: [ShoppingItemID: Bool], now: Date
	) {
		let unticked = ShoppingLayout.ordered(items, by: order)
			.flatMap(\.1)
			.filter { !(pending[$0.id] ?? $0.ticked) }
		self.init(
			items: unticked.filter { $0.section != .staples }.map { Line(textUs: $0.textUs, textMetric: $0.textMetric) },
			staples: unticked.count { $0.section == .staples },
			units: units, savedAt: now)
	}

	public enum Display: Hashable, Sendable {
		/// The view shows `emptyText`.
		case empty
		/// At most `maxLines` lines; `footer` is set only for a stale snapshot.
		case list(lines: [String], footer: String?)
	}

	/// What a widget with room for `maxLines` lines shows. Hidden items and
	/// unticked staples share one closing line, so the count is never cut off:
	/// `and 3 more`, `and 2 to check`, `and 3 more, 2 to check`.
	public func display(maxLines: Int, now: Date) -> Display {
		if items.isEmpty && staples == 0 { return .empty }
		let maxLines = max(maxLines, 1)
		let all = items.map { $0.text(units) }
		let fits = all.count <= maxLines - (staples > 0 ? 1 : 0)
		let shown = fits ? all : Array(all.prefix(maxLines - 1))
		let hidden = all.count - shown.count
		let tail = [hidden > 0 ? "\(hidden) more" : nil, staples > 0 ? "\(staples) to check" : nil]
			.compactMap { $0 }.joined(separator: ", ")
		let closing = tail.isEmpty ? [] : [shown.isEmpty ? tail : "and \(tail)"]
		return .list(lines: shown + closing, footer: footer(now: now))
	}

	private func footer(now: Date) -> String? {
		guard now.timeIntervalSince(savedAt) > Self.staleAfter else { return nil }
		let f = RelativeDateTimeFormatter()
		f.dateTimeStyle = .named
		f.locale = Locale(identifier: "en_US")
		return "as of \(f.localizedString(for: savedAt, relativeTo: now))"
	}
}

/// `shopping-widget.json` at the root of the app-group container. The app is
/// the only writer and writes whole files atomically, so the widget reads
/// either the old snapshot or the new one. A missing or unreadable file reads
/// as nil, which the widget treats like a list it has not seen yet.
public struct SnapshotFile: Sendable {
	public static let fileName = "shopping-widget.json"
	let url: URL

	/// Nil (tests, previews) puts the file in a fresh temporary directory, so
	/// two environments never share one.
	public init(appGroup: String?) {
		let container = appGroup.flatMap {
			FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: $0)
		}
		self.init(directory: container ?? FileManager.default.temporaryDirectory.appending(path: UUID().uuidString))
	}

	init(directory: URL) { url = directory.appending(path: Self.fileName) }

	public func read() -> ShoppingSnapshot? {
		guard let data = try? Data(contentsOf: url) else { return nil }
		return try? Wire.makeDecoder().decode(ShoppingSnapshot.self, from: data)
	}

	public func write(_ snapshot: ShoppingSnapshot) {
		guard let data = try? Wire.makeEncoder().encode(snapshot) else { return }
		try? FileManager.default.createDirectory(
			at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
		try? data.write(to: url, options: .atomic)
	}

	public func remove() { try? FileManager.default.removeItem(at: url) }
}
