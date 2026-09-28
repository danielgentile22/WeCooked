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
	}

	public let detail: RecipeDetail
	public let units: UnitSystem
	public let body: BodyText
	/// The requested units have no body yet, so the source body is shown.
	public let isFallback: Bool
	/// "as written": the original, or one carrying hand edits, viewed in the
	/// units it was authored in.
	public let showsAsWritten: Bool
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
			showsAsWritten: (r.isOriginal || r.handEdited) && units == r.sourceUnits,
			struck: struck, banners: banners)
	}
}

/// One open cooking screen. Owns the stepper and the few local facts the
/// server does not know (`justUpdated`). It owns no job: the calculate, refresh
/// and reconvert jobs are in the reply, and the Store waits on whatever the
/// reply lists (`Store.reconcileWatchers`), so a relaunch resumes them without
/// this model doing anything.
@MainActor @Observable
public final class RecipeModel {
	public let recipeID: RecipeID
	/// nil means "the server's default", the original.
	public private(set) var variationID: VariationID?
	public var stepper: YieldStepper
	public private(set) var localBanner: RecipeDisplay.Banner?

	@ObservationIgnored private let env: AppEnvironment

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
	/// instant. Jobs need nothing here: the reply lists them and the Store waits.
	public func appear() async { fatalError("not implemented") }

	public func toggleUnits() { env.device.units = env.device.units.other }

	public func strike(_ line: LineKey) {
		guard let r = resource.value?.recipe else { return }
		env.device.toggleStrike(line, variation: r.variationId, contentVersion: r.contentVersion)
	}

	/// Chip tap or "Show N": swap `variationID`; the new key's resource is
	/// usually cached already. Resets the stepper and clears local banners.
	public func show(_ variation: VariationID) { fatalError("not implemented") }

	/// The stepper's button. `.show` switches locally; `.calculate` POSTs and
	/// either switches (`existing`) or calls `store.calculationStarted`, which
	/// writes `calcJob` into the cached reply so the Store's wait begins; when
	/// it ends the refetched reply carries the new chip (or the failure text).
	public func commitStepper() async { fatalError("not implemented") }

	public func retryCalculation() async { fatalError("not implemented") }
	public func recalculate() async { fatalError("not implemented") }
	public func keepMine() async { fatalError("not implemented") }
	public func deleteVariation() async { fatalError("not implemented") }
	public func deleteRecipe() async { fatalError("not implemented") }
	public func retryReconvert() async { fatalError("not implemented") }
}
