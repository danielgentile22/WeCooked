import Foundation
import Observation

// Everything that belongs to this phone and is never sent to the server. One
// owner (this class), one persistence rule (a small JSON blob per concern in a
// `KeyValueStore`), no sharing with `Store`: server truth and device truth
// meet only inside a view, where they are read side by side.
//
//   web (localStorage / sessionStorage)        native (here)
//   units                                      `units`
//   strikes:{variation_id}                     `strikes(...)`, survives app kill,
//                                              expires after 12 idle hours and on
//                                              any content change
//   wc-draft:job|recipe|manual                 `editorDraft(...)`
//   shoppingBuildSeen                          `seenBuild`
//   (none: ticks were online-only)             `pendingTicks`, the outbox

public protocol KeyValueStore: Sendable {
	func data(forKey key: String) -> Data?
	func set(_ data: Data?, forKey key: String)
}

/// `UserDefaults`, optionally the app-group suite so the share extension and a
/// future widget read the same units and pending ticks.
public struct DefaultsStore: KeyValueStore {
	/// `UserDefaults` is not `Sendable`, so the value holds the suite name and
	/// opens the (process-wide, thread-safe) defaults per call.
	private let suiteName: String?
	public init(suiteName: String? = nil) { self.suiteName = suiteName }
	private var defaults: UserDefaults {
		suiteName.flatMap(UserDefaults.init(suiteName:)) ?? .standard
	}
	public func data(forKey key: String) -> Data? { defaults.data(forKey: key) }
	public func set(_ data: Data?, forKey key: String) {
		if let data { defaults.set(data, forKey: key) } else { defaults.removeObject(forKey: key) }
	}
}

/// A struck line, keyed by position, as on the web (`i0.1` ingredient, `s2`
/// step). Positional keys are why strikes survive a units toggle: line 3 is
/// line 3 in both bodies.
public struct LineKey: Hashable, Codable, Sendable {
	public let raw: String
	public static func ingredient(group: Int, item: Int) -> LineKey { .init(raw: "i\(group).\(item)") }
	public static func step(_ index: Int) -> LineKey { .init(raw: "s\(index)") }
}

/// Which editor a saved form belongs to.
public enum EditorKey: Hashable, Codable, Sendable {
	case draft(JobID)
	case recipe(VariationID)
	case manual
	var storageName: String {
		switch self {
		case .draft(let j): "job.\(j)"
		case .recipe(let v): "recipe.\(v)"
		case .manual: "manual"
		}
	}
}

@MainActor @Observable
public final class DeviceState {
	struct StrikeRecord: Codable {
		var contentVersion: Int
		var lines: Set<LineKey>
		var touched: Date
	}
	struct Stamped<T: Codable>: Codable { var value: T; var savedAt: Date }

	/// Default metric (D15). Read by the recipe screen, shopping and the editor.
	public var units: UnitSystem { didSet { save(units, "units") } }
	/// The last shopping build whose rebuild banner was shown.
	public var seenBuild: JobID? { didSet { save(seenBuild, "seenBuild") } }
	/// Ticks the server has not acknowledged yet, as target states. Idempotent
	/// to replay; see `ShoppingModel`.
	public private(set) var pendingTicks: [ShoppingItemID: Bool] {
		didSet { save(pendingTicks, "pendingTicks") }
	}
	private var strikeBook: [VariationID: StrikeRecord] {
		didSet { save(strikeBook, "strikes") }
	}

	@ObservationIgnored private let store: any KeyValueStore
	@ObservationIgnored private let now: @Sendable () -> Date
	static let strikeLifetime: TimeInterval = 12 * 3600
	static let editorDraftLifetime: TimeInterval = 7 * 24 * 3600

	public init(store: any KeyValueStore, now: @escaping @Sendable () -> Date = { .now }) {
		self.store = store
		self.now = now
		func load<T: Decodable>(_ k: String, _ d: T) -> T {
			store.data(forKey: k).flatMap { try? JSONDecoder().decode(T.self, from: $0) } ?? d
		}
		units = load("units", UnitSystem.metric)
		seenBuild = load("seenBuild", JobID?.none)
		pendingTicks = load("pendingTicks", [:])
		strikeBook = load("strikes", [:])
	}

	private func save<T: Encodable>(_ value: T, _ key: String) {
		store.set(try? JSONEncoder().encode(value), forKey: key)
	}

	/// Lines struck on `variation`, or empty if the record is older than 12 idle
	/// hours or belongs to another content version (an edit reorders lines, so
	/// old positions would strike the wrong ones).
	public func strikes(for variation: VariationID, contentVersion: Int) -> Set<LineKey> {
		guard let r = strikeBook[variation], r.contentVersion == contentVersion,
			now().timeIntervalSince(r.touched) < Self.strikeLifetime
		else { return [] }
		return r.lines
	}

	public func toggleStrike(_ line: LineKey, variation: VariationID, contentVersion: Int) {
		var r = strikeBook[variation].flatMap {
			$0.contentVersion == contentVersion ? $0 : nil
		} ?? StrikeRecord(contentVersion: contentVersion, lines: [], touched: now())
		if !r.lines.insert(line).inserted { r.lines.remove(line) }
		r.touched = now()
		strikeBook[variation] = r
		pruneStrikes()
	}

	private func pruneStrikes() {
		let cutoff = now().addingTimeInterval(-Self.strikeLifetime)
		strikeBook = strikeBook.filter { $0.value.touched > cutoff && !$0.value.lines.isEmpty }
	}

	public func editorDraft(_ key: EditorKey) -> EditorForm? {
		guard let data = store.data(forKey: "editor.\(key.storageName)"),
			let s = try? JSONDecoder().decode(Stamped<EditorForm>.self, from: data),
			now().timeIntervalSince(s.savedAt) < Self.editorDraftLifetime
		else { return nil }
		return s.value
	}
	public func saveEditorDraft(_ form: EditorForm, for key: EditorKey) {
		save(Stamped(value: form, savedAt: now()), "editor.\(key.storageName)")
	}
	public func discardEditorDraft(_ key: EditorKey) {
		store.set(nil, forKey: "editor.\(key.storageName)")
	}

	public func queueTick(_ id: ShoppingItemID, _ ticked: Bool) { pendingTicks[id] = ticked }
	/// Remove only if the queued target is still the one that was sent, so a
	/// second tap made while the first request was in flight is not lost.
	public func settleTick(_ id: ShoppingItemID, sent: Bool) {
		if pendingTicks[id] == sent { pendingTicks[id] = nil }
	}
	public func clearTicks() { pendingTicks = [:] }

	/// Sign-out.
	public func wipe() {
		strikeBook = [:]
		pendingTicks = [:]
		seenBuild = nil
	}
}
