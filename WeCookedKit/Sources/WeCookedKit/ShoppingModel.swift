import Foundation
import Observation

// The shopping tab. Ticks are the one write that must work in a shop with bad
// signal and must agree between two phones, so this is the one place with an
// outbox. Everything else in the app is online-only (PRODUCT: no offline mode).

public struct ShoppingRow: Equatable, Sendable, Identifiable {
	public let id: ShoppingItemID
	public let primary: String
	/// "added by hand", or "about 21 oz canned chickpeas · Chickpea stew".
	public let secondary: String?
	public let ticked: Bool
}

public struct ShoppingSection: Equatable, Sendable, Identifiable {
	public let section: Section
	public var id: String { section.wire }
	public let rows: [ShoppingRow]
	/// Staples render collapsed as "Check you have (N)".
	public var isCollapsedByDefault: Bool { section == .staples }
}

public enum ShoppingLayout {
	/// Sections in the server's order (unknown sections after known ones), items
	/// generated-first then manual, each by `position`. `pending` is laid over
	/// the server's `ticked` at this boundary; nothing else in the app knows an
	/// outbox exists.
	public static func sections(
		items: [ShoppingItem], order: [Section], units: UnitSystem,
		pending: [ShoppingItemID: Bool]
	) -> [ShoppingSection] {
		let grouped = Dictionary(grouping: items, by: \.section)
		let known = order.filter { grouped[$0] != nil }
		let extra = grouped.keys.filter { !order.contains($0) }.sorted { $0.wire < $1.wire }
		return (known + extra).map { section in
			let rows = grouped[section]!
				.sorted { ($0.isManual ? 1 : 0, $0.position) < ($1.isManual ? 1 : 0, $1.position) }
				.map { item -> ShoppingRow in
					let alt = item.text(units.other)
					var parts: [String] = []
					if item.isManual { parts.append("added by hand") } else {
						if alt != item.text(units) { parts.append("about \(alt)") }
						parts.append(contentsOf: item.fromTitles)
					}
					return ShoppingRow(
						id: item.id, primary: item.text(units),
						secondary: parts.isEmpty ? nil : parts.joined(separator: " · "),
						ticked: pending[item.id] ?? item.ticked)
				}
			return ShoppingSection(section: section, rows: rows)
		}
	}

	/// "3 of 12 ticked".
	public static func progress(items: [ShoppingItem], pending: [ShoppingItemID: Bool]) -> (ticked: Int, total: Int) {
		(items.filter { pending[$0.id] ?? $0.ticked }.count, items.count)
	}

	/// Text for the once-per-build banner, or nil when nothing was lost.
	public static func rebuildNotice(_ r: BuildResult) -> String? {
		guard !r.reset.isEmpty else { return nil }
		let kept = r.kept == 1 ? "1 tick kept." : "\(r.kept) ticks kept."
		return "\(kept) \(r.reset.count) reset because the line changed: \(r.reset.joined(separator: ", "))."
	}
}

/// Two phones, one list, no lock:
///  - the server row holds the truth; `Resource<ShoppingResponse>` mirrors it,
///    polled every 5 s while the tab is visible;
///  - a tap writes the *target state* into `device.pendingTicks` (idempotent:
///    "item 7 is ticked", never "toggle item 7");
///  - the view reads `server ⊕ pendingTicks` (`ShoppingLayout.sections`);
///  - `flush()` sends each pending target, then `settleTick` drops it only if
///    it still matches what was sent, and `Resource.mutate` writes the
///    acknowledged value into the mirror so a slow poll cannot flip it back;
///  - the other phone's tick arrives on the next poll, last write wins per item.
/// A failed send leaves the entry in place; the next poll cycle or foreground
/// retries it, so a tick made in a dead spot lands when the signal returns.
@MainActor @Observable
public final class ShoppingModel {
	public var resource: Resource<ShoppingResponse> { env.store.resource(.shopping) }
	public private(set) var notice: String?
	@ObservationIgnored private let env: AppEnvironment

	public init(env: AppEnvironment) { fatalError("not implemented") }

	public var sections: [ShoppingSection] {
		fatalError("not implemented")
		// resource.value + vocabulary.sectionOrder + device.units + device.pendingTicks
		// -> ShoppingLayout.sections
	}

	/// While the tab is visible: flush the outbox, revalidate every 5 s, show
	/// the rebuild notice once per `build.jobId` (`device.seenBuild`). A pending
	/// `list.build` is waited on by the Store, which refetches the list when the
	/// merge ends.
	public func appear() async { fatalError("not implemented") }

	public func setTicked(_ id: ShoppingItemID, _ ticked: Bool) { fatalError("not implemented") }
	public func flush() async { fatalError("not implemented") }
	public func addManual(_ text: String) async { fatalError("not implemented") }
	public func startBuild(_ picks: [BuildPick]) async { fatalError("not implemented") }
	public func retryBuild() async { fatalError("not implemented") }
	public func doneShopping() async { fatalError("not implemented") }
}
