import Foundation
import Observation

// The cooking screen's logic, minus pixels. SwiftUI reads `display` and calls
// the methods; everything decidable without a view is a value below and tested
// on its own.

/// The stepper beside the chips: a typed count, +/- by one, and the single
/// decision "what would the button do".
public struct YieldStepper: Equatable, Sendable {
	public var text: String
	/// Yield of the variation on screen.
	public private(set) var viewed: Double

	public init(viewed: Double) {
		self.viewed = viewed
		self.text = Self.format(viewed)
	}

	/// Typed count rounded to one decimal; nil unless finite and above zero.
	public var count: Double? {
		guard let n = Double(text.trimmingCharacters(in: .whitespaces)), n.isFinite else { return nil }
		let r = (n * 10).rounded() / 10
		return r > 0 ? r : nil
	}

	/// +/- steps by one from the typed count (or the viewed yield when the text
	/// is invalid) and never reaches zero.
	public mutating func step(_ delta: Double) {
		let next = ((count ?? viewed) + delta)
		text = Self.format(max(0.1, (next * 10).rounded() / 10))
	}

	/// The viewed variation changed: back to its yield.
	public mutating func reset(viewed: Double) {
		self.viewed = viewed
		text = Self.format(viewed)
	}

	public enum Action: Equatable, Sendable {
		case invalid
		case unchanged
		/// An existing variation has this yield: switching costs no request.
		case show(VariationID)
		case calculate(Double)
	}

	public func action(chips: [VariationChip]) -> Action {
		guard let n = count else { return .invalid }
		if let chip = chips.first(where: { abs($0.yieldCount - n) < 0.05 }) {
			return abs(chip.yieldCount - viewed) < 0.05 ? .unchanged : .show(chip.id)
		}
		return .calculate(n)
	}

	static func format(_ d: Double) -> String {
		d == d.rounded() ? String(Int(d)) : String(format: "%.1f", d)
	}
}

/// Everything the cooking screen renders, derived from one server reply plus
/// this phone's units and strikes. The view holds no other logic.
public struct RecipeDisplay: Equatable, Sendable {
	public enum Banner: Equatable, Sendable {
		/// Counterpart body is being generated and the person is looking at it.
		case reconvertPending
		case reconvertFailed
		/// This variation is behind the original and is being refreshed.
		case refreshing
		case refreshFailed
		case calculating(toCount: Double)
		case calculationFailed(String)
		/// The client stopped polling after five minutes; the job may still finish.
		case calculationTimedOut(toCount: Double)
		case updated
		/// A recalculate, keep, delete or retry request failed.
		case actionFailed(String)
	}

	public let detail: RecipeDetail
	public let units: UnitSystem
	public let body: BodyText
	/// The requested units have no body yet, so the source body is shown.
	public let isFallback: Bool
	/// The source units carry the text as a person wrote it: the original, or a
	/// variation with hand edits. The units toggle marks that side "as written"
	/// whichever side is showing.
	public let sourceIsAsWritten: Bool
	public let struck: Set<LineKey>
	public let banners: [Banner]

	/// `timedOut` is `Store.timedOutJobs`: the only job fact the server does not
	/// hold, so the only one that is not in `response`.
	public static func make(
		_ response: RecipeResponse, units: UnitSystem, struck: Set<LineKey>,
		timedOut: Set<JobID> = []
	) -> RecipeDisplay {
		let r = response.recipe
		let chosen = r.bodies[units]
		let source = BodyText(ingredients: r.ingredients, steps: r.steps)
		let body = chosen ?? r.bodies[r.sourceUnits] ?? source
		var banners: [Banner] = []
		// Only when looking at the converted side; the source side is always ready.
		if units != r.sourceUnits, let rc = r.reconvert {
			banners.append(rc.status == .failed || rc.jobId == nil ? .reconvertFailed : .reconvertPending)
		}
		if let f = response.refresh {
			banners.append(f.status == .failed ? .refreshFailed : .refreshing)
		}
		if let c = response.calcJob {
			banners.append(
				c.status == .failed ? .calculationFailed(c.errorText ?? "Could not calculate.")
					: timedOut.contains(c.jobId) ? .calculationTimedOut(toCount: c.toCount)
					: .calculating(toCount: c.toCount))
		}
		return RecipeDisplay(
			detail: r, units: units, body: body, isFallback: chosen == nil,
			sourceIsAsWritten: r.isOriginal || r.handEdited,
			struck: struck, banners: banners)
	}
}

/// One open cooking screen. Owns the stepper and the few local facts the
/// server does not know. It owns no job: the calculate, refresh and reconvert
/// jobs are in the reply, and the Store waits on whatever the reply lists
/// (`Store.reconcileWatchers`), so a relaunch resumes them without this model
/// doing anything. What the server never states is how two consecutive replies
/// differ, so the model keeps the last one it acted on (`seen`) and reads two
/// transitions from it: a calculate that ended switches to the new chip, and a
/// refresh that ended shows "Updated to match the original."
@MainActor @Observable
public final class RecipeModel {
	public let recipeID: RecipeID
	/// nil means "the server's default", the original.
	public private(set) var variationID: VariationID?
	public var stepper: YieldStepper
	public private(set) var localBanner: RecipeDisplay.Banner?

	@ObservationIgnored private let env: AppEnvironment
	@ObservationIgnored private var seen: RecipeResponse?

	public init(recipe: RecipeID, variation: VariationID?, env: AppEnvironment) {
		self.recipeID = recipe
		self.variationID = variation
		self.env = env
		let cached = env.store.resource(.recipe(recipe, variation: variation)).value
		stepper = YieldStepper(viewed: cached?.recipe.yieldCount ?? 4)
	}

	/// The same object the list's row opened; `value` is non-nil the first time
	/// SwiftUI asks if this recipe was ever seen on this phone.
	public var resource: Resource<RecipeResponse> {
		env.store.resource(.recipe(recipeID, variation: variationID))
	}

	/// Pure projection of the resource, this phone's units, its strikes, and
	/// the Store's timed-out set.
	public var display: RecipeDisplay? {
		guard let response = resource.value else { return nil }
		let struck = env.device.strikes(
			for: response.recipe.variationId, contentVersion: response.recipe.contentVersion)
		return RecipeDisplay.make(
			response, units: env.device.units, struck: struck, timedOut: env.store.timedOutJobs)
	}

	/// Run while the screen is visible (`.watching` already revalidates).
	/// Prefetches the other variations at low priority so chip taps are
	/// instant, then reads every reply of the variation on screen for the two
	/// transitions (`noticed`) until the task is cancelled. Waiting on the jobs
	/// themselves is the Store's.
	public func appear() async {
		if resource.value == nil {
			await resource.revalidate()
			// init guessed a yield; the first reply says the real one.
			if let y = resource.value?.recipe.yieldCount { stepper.reset(viewed: y) }
		}
		if let r = resource.value?.recipe {
			let missing = r.variations
				.filter { $0.id != r.variationId }
				.map { env.store.resource(.recipe(recipeID, variation: $0.id)) }
				.filter { $0.value == nil }
			await withTaskGroup(of: Void.self) { group in
				for other in missing { group.addTask(priority: .utility) { await other.revalidate() } }
			}
		}
		for await reply in changes(of: { self.resource.value }) {
			if let reply { noticed(reply) }
		}
	}

	/// `reply` follows `seen`. A reply for another variation is a chip tap, not
	/// a transition. A failed calculate or refresh changes nothing here: the
	/// reply's own banner reports it. The chip at the requested yield is the
	/// proof a calculate ended, not the reply's `calcJob`: the server files a
	/// finished job under its variation, so an older failure can be the
	/// recipe's latest calcJob again while the new chip is already there.
	func noticed(_ reply: RecipeResponse) {
		defer { seen = reply }
		guard let seen, seen.recipe.variationId == reply.recipe.variationId else { return }
		if let job = seen.calcJob, job.status == .pending, reply.calcJob?.jobId != job.jobId,
			let chip = reply.recipe.variations.first(where: { abs($0.yieldCount - job.toCount) < 0.05 }),
			chip.id != reply.recipe.variationId
		{
			// The screen leaves this variation, so its refresh outcome is moot.
			show(chip.id)
			return
		}
		if seen.refresh?.status == .pending, reply.refresh == nil { localBanner = .updated }
	}

	public func toggleUnits() { env.device.units = env.device.units.other }

	public func strike(_ line: LineKey) {
		guard let r = resource.value?.recipe else { return }
		env.device.toggleStrike(line, variation: r.variationId, contentVersion: r.contentVersion)
	}

	/// Chip tap or "Show N": swap `variationID`; the new key's resource is
	/// usually cached already. Resets the stepper and clears local banners.
	public func show(_ variation: VariationID) {
		let chip = resource.value?.recipe.variations.first { $0.id == variation }
		variationID = variation
		localBanner = nil
		if let y = resource.value?.recipe.yieldCount ?? chip?.yieldCount { stepper.reset(viewed: y) }
	}

	/// The stepper's button. `.show` switches locally; `.calculate` POSTs and
	/// either switches (`existing`) or calls `store.calculationStarted`, which
	/// writes `calcJob` into the cached reply so the Store's wait begins; when
	/// it ends the refetched reply carries the new chip (or the failure text).
	public func commitStepper() async {
		guard let chips = resource.value?.recipe.variations else { return }
		switch stepper.action(chips: chips) {
		case .invalid, .unchanged: return
		case .show(let v): show(v)
		case .calculate(let n): await calculate(n)
		}
	}

	/// A failed calculate is retried by asking for the same yield again; the
	/// server starts a fresh job since only pending ones are reused.
	public func retryCalculation() async {
		guard let c = resource.value?.calcJob else { return }
		await calculate(c.toCount)
	}

	/// The server trashes this variation and queues a calculate for the same
	/// yield, so the job is a `calcJob` on the recipe, not this variation's
	/// `refresh`. Back to the original, whose reply now lists it.
	public func recalculate() async {
		guard let r = resource.value?.recipe, !r.isOriginal else { return }
		await run(RecipeDisplay.Banner.actionFailed) {
			let job = try await env.api.recalculate(r.variationId)
			// Show first so the original's resource is loaded and gets the patch.
			showOriginal(of: r)
			env.store.calculationStarted(recipeID, job: job, toCount: r.yieldCount)
			env.store.variationChanged(recipe: recipeID)
		}
	}

	/// A stale refresh that failed is never retried by the server on its own.
	/// These three refetch this screen's own reply rather than invalidating
	/// the family: `Store.invalidate` refetches only watched resources, and
	/// the outcome is what the screen shows next.
	public func retryRefresh() async {
		guard let vid = resource.value?.recipe.variationId else { return }
		await run(RecipeDisplay.Banner.actionFailed) {
			_ = try await env.api.retryScale(vid)
			await resource.revalidate()
		}
	}

	public func keepMine() async {
		guard let vid = resource.value?.recipe.variationId else { return }
		await run(RecipeDisplay.Banner.actionFailed) {
			try await env.api.keepMine(vid)
			await resource.revalidate()
		}
	}

	public func deleteVariation() async {
		guard let r = resource.value?.recipe, !r.isOriginal else { return }
		await run(RecipeDisplay.Banner.actionFailed) {
			try await env.api.deleteVariation(r.variationId)
			showOriginal(of: r)
			env.store.variationChanged(recipe: recipeID)
		}
	}

	public func deleteRecipe() async {
		await run(RecipeDisplay.Banner.actionFailed) {
			try await env.api.deleteRecipe(recipeID)
			env.store.recipeDeleted(recipeID)
		}
	}

	public func retryReconvert() async {
		guard let r = resource.value?.recipe else { return }
		await run(RecipeDisplay.Banner.actionFailed) {
			try await env.api.retryReconvert(recipeID, variation: r.isOriginal ? nil : r.variationId)
			await resource.revalidate()
		}
	}

	private func calculate(_ n: Double) async {
		await run(RecipeDisplay.Banner.calculationFailed) {
			switch try await env.api.calculate(recipeID, toCount: n) {
			case .existing(let v): show(v)
			case .job(let id): env.store.calculationStarted(recipeID, job: id, toCount: n)
			}
		}
	}

	private func showOriginal(of r: RecipeDetail) {
		if let original = r.variations.first(where: \.isOriginal) { show(original.id) }
	}

	private func run(
		_ banner: (String) -> RecipeDisplay.Banner, _ work: () async throws -> Void
	) async {
		localBanner = nil
		do { try await work() } catch { localBanner = banner(APIError.wrapping(error).message) }
	}
}
