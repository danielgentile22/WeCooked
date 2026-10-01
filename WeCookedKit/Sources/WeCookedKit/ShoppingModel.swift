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
						if !item.fromTitles.isEmpty { parts.append(item.fromTitles.joined(separator: ", ")) }
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

	/// The list as plain text for the share sheet, to paste into a shop's app,
	/// Notes, or a message: unticked items one per line, then unticked staples
	/// under "Check you have". Nil when nothing is left to buy.
	public static func shareText(_ sections: [ShoppingSection]) -> String? {
		let untickedLines = { (section: ShoppingSection) in section.rows.filter { !$0.ticked }.map(\.primary) }
		let items = sections.filter { !$0.isCollapsedByDefault }.flatMap(untickedLines)
		let staples = sections.filter(\.isCollapsedByDefault).flatMap(untickedLines)
		let blocks = [items, staples.isEmpty ? [] : ["Check you have"] + staples].filter { !$0.isEmpty }
		return blocks.isEmpty ? nil : blocks.map { $0.joined(separator: "\n") }.joined(separator: "\n\n")
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
///    polled every 5 s by the view while the tab is visible;
///  - a tap writes the *target state* into `device.pendingTicks` (idempotent:
///    "item 7 is ticked", never "toggle item 7");
///  - the view reads `server ⊕ pendingTicks` (`ShoppingLayout.sections`);
///  - `flush()` sends each pending target, then `settleTick` drops it only if
///    it still matches what was sent, and `Resource.mutate` writes the
///    acknowledged value into the mirror so a slow poll cannot flip it back;
///  - the other phone's tick arrives on the next poll, last write wins per item.
/// A failed send leaves the entry in place; the next poll's reply retries it,
/// so a tick made in a dead spot lands when the signal returns.
@MainActor @Observable
public final class ShoppingModel {
	public enum Phase: Equatable, Sendable { case building, empty, list }

	public var resource: Resource<ShoppingResponse> { env.store.resource(.shopping) }
	/// The rebuild notice, shown once per build job.
	public private(set) var notice: String?
	/// The last failed action's message; cleared when the next action starts.
	public private(set) var banner: String?

	@ObservationIgnored private let env: AppEnvironment
	/// The send in progress. Internal so tests can tell a send has started.
	@ObservationIgnored private(set) var flushing: Task<Void, Never>?

	public init(env: AppEnvironment) { self.env = env }

	private var items: [ShoppingItem] { resource.value?.list.items ?? [] }

	/// The web's branches: a pending build hides everything else; otherwise
	/// the empty state or the list, under `buildError` and `notice`.
	public var phase: Phase {
		if resource.value?.list.build?.status == .pending { return .building }
		return items.isEmpty ? .empty : .list
	}

	public var buildError: String? {
		guard let b = resource.value?.list.build, b.status == .failed else { return nil }
		return b.errorText ?? "The build failed."
	}

	public var sections: [ShoppingSection] {
		let order = env.store.resource(.vocabulary).value?.sectionOrder ?? Section.known
		return ShoppingLayout.sections(
			items: items, order: order, units: units, pending: env.device.pendingTicks)
	}

	public var progress: (ticked: Int, total: Int) {
		ShoppingLayout.progress(items: items, pending: env.device.pendingTicks)
	}

	public var shareText: String? {
		phase == .building ? nil : ShoppingLayout.shareText(sections)
	}

	public var units: UnitSystem { env.device.units }
	public var pickable: [PickableRecipe] { resource.value?.recipes ?? [] }
	public var picks: [ShoppingPick] { resource.value?.list.picks ?? [] }
	public var hasList: Bool { !items.isEmpty }

	/// Run while the tab is visible; the view's `.watching` owns the poll.
	/// Every reply (the first is the cached one) may carry a finished build to
	/// announce, and is a moment to retry ticks a dead spot left behind.
	public func appear() async {
		for await reply in changes(of: { self.resource.value }) {
			if let reply { noticed(reply) }
			if !env.device.pendingTicks.isEmpty { await flush() }
		}
	}

	/// Marks a done build seen even when nothing was reset, as the web does,
	/// so a later reply for the same job never raises the notice. A build in
	/// progress ends the old notice: the pick sheet starts builds on a model of
	/// its own, so the tab's model only learns of them from the reply.
	func noticed(_ reply: ShoppingResponse) {
		guard let b = reply.list.build else { return }
		if b.status == .pending { notice = nil; return }
		guard b.status == .done, let result = b.result, env.device.seenBuild != b.jobId else { return }
		env.device.seenBuild = b.jobId
		notice = ShoppingLayout.rebuildNotice(result)
	}

	public func setTicked(_ id: ShoppingItemID, _ ticked: Bool) {
		env.device.queueTick(id, ticked)
		mirror(id, ticked)
		Task { await flush() }
	}

	/// One send at a time. A call during a send waits for it, then sends
	/// whatever is still pending, so a second tap is neither lost nor raced.
	public func flush() async {
		while let running = flushing { await running.value }
		let batch = env.device.pendingTicks
		guard !batch.isEmpty else { return }
		let task = Task {
			await send(batch)
			flushing = nil
		}
		flushing = task
		await task.value
	}

	/// Stops at the first failure without a banner: the entry stays queued
	/// and the next reply retries it.
	private func send(_ batch: [ShoppingItemID: Bool]) async {
		for (id, ticked) in batch {
			do { try await env.api.setTicked(id, ticked) } catch { return }
			env.device.settleTick(id, sent: ticked)
			mirror(id, ticked)
		}
	}

	private func mirror(_ id: ShoppingItemID, _ ticked: Bool) {
		resource.mutate { r in
			if let i = r.list.items.firstIndex(where: { $0.id == id }) { r.list.items[i].ticked = ticked }
		}
	}

	public func addManual(_ text: String) async {
		await run { try await env.api.addManualLine(text) }
	}

	/// The reply lists the pending job under `list.build`; the Store waits on
	/// it and refetches when the merge ends.
	public func startBuild(_ picks: [BuildPick]) async {
		notice = nil
		await run { _ = try await env.api.buildShopping(picks) }
	}

	public func retryBuild() async {
		notice = nil
		await run { _ = try await env.api.retryShopping() }
	}

	public func doneShopping() async {
		notice = nil
		await run {
			try await env.api.doneShopping()
			env.device.clearTicks()
		}
	}

	public func toggleUnits() { env.device.units = env.device.units.other }
	public func dismissNotice() { notice = nil }

	/// Refetches this reply rather than invalidating the family:
	/// `Store.invalidate` refetches only watched resources, and the outcome is
	/// what the screen shows next.
	private func run(_ work: () async throws -> Void) async {
		banner = nil
		do {
			try await work()
			await resource.revalidate()
		} catch {
			banner = APIError.wrapping(error).message
		}
	}
}
