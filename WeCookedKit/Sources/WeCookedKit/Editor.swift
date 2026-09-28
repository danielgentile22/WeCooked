import Foundation

// The recipe editor's state and its save rule, as values. No view, no store, no
// network: SwiftUI binds to an `EditorForm` and calls `payload()`. Ported from
// `RecipeForm.svelte` (payload(), fromInitial(), swapBodies(), withDevicePref())
// and `cleanBody` from `tags.ts`; the test cases in `EditorPayloadTests` mirror
// its branches one for one.

extension BodyText {
	/// Trim every line, drop empty lines and empty groups, turn a blank heading
	/// into nil. The comparison form: two bodies are "the same" iff their
	/// cleaned values are equal. Never sent to the server (it cleans again).
	public var cleaned: BodyText {
		let groups = ingredients.compactMap { g -> IngredientGroup? in
			let items = g.items.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
				.filter { !$0.isEmpty }
			guard !items.isEmpty else { return nil }
			let heading = g.heading?.trimmingCharacters(in: .whitespacesAndNewlines)
			return IngredientGroup(heading: (heading?.isEmpty ?? true) ? nil : heading, items: items)
		}
		let steps = steps.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
			.filter { !$0.isEmpty }
		return BodyText(ingredients: groups, steps: steps)
	}
}

/// Why a save is not possible yet. The copy is the server's own so the two
/// front doors read the same.
public enum EditorIssue: Hashable, Sendable, Error {
	case titleRequired, yieldInvalid, ingredientRequired, effortRequired, damageRequired

	public var message: String {
		switch self {
		case .titleRequired: "Title is required."
		case .yieldInvalid: "Yield must be a positive number."
		case .ingredientRequired: "At least one ingredient line is required."
		case .effortRequired: "Effort is required."
		case .damageRequired: "Damage is required."
		}
	}
}

/// What the form holds, and only what it holds. `baseline` exists exactly when
/// the form was seeded from something the server already has (a saved recipe
/// or an extracted draft); a form for a hand-typed recipe has none, so "compare
/// to what was loaded" cannot be asked of it.
public struct EditorForm: Codable, Hashable, Sendable {
	/// The server's bodies at load time, cleaned. `Codable` so a persisted
	/// editor draft keeps its baseline across a relaunch.
	public struct Baseline: Codable, Hashable, Sendable {
		public var sourceUnits: UnitSystem
		public var source: BodyText
		public var other: BodyText?
	}

	public var title = ""
	public var yieldCount: Double = 4
	public var yieldUnit = "servings"
	public var prepMinutes: Int?
	public var cookMinutes: Int?
	public var sourceText: String?
	public var sourceUrl: String?
	public var notes: String?
	/// Units the body was authored in. For a hand-typed recipe the toggle sets
	/// this directly; for a loaded one only `payload()` changes it.
	public var sourceUnits: UnitSystem = .metric
	public var mealTypes: [MealType] = []
	public var cuisine: Cuisine?
	public var protein: Protein?
	public var effort: Effort?
	public var damage: Damage?
	public var images: [DraftImage] = []
	public var coverImageId: ImageID?
	/// The body currently in the inputs, and the units it is in.
	public var shownUnits: UnitSystem = .metric
	public var shown = BodyText(ingredients: [.init(heading: nil, items: [""])], steps: [""])
	/// The body not on screen; typed work in it is kept. Nil until it exists.
	public var other: BodyText?
	/// The server's bodies when editing began. Persisted with the autosave so a
	/// restored form still knows what it was started from.
	public private(set) var baseline: Baseline?

	/// A hand-typed recipe in the device's units (default metric, D15).
	public static func blank(units: UnitSystem) -> EditorForm {
		var f = EditorForm(baseline: nil)
		f.sourceUnits = units
		f.shownUnits = units
		return f
	}

	private init(baseline: Baseline?) { self.baseline = baseline }

	/// Seed from a saved recipe (edit) or an extracted draft (review). Opens in
	/// `units` when that body exists, without touching the baseline.
	public init(recipe: RecipeDetail, units: UnitSystem) {
		let source = BodyText(ingredients: recipe.ingredients, steps: recipe.steps)
		let counterpart = recipe.bodies[recipe.sourceUnits.other]
		baseline = Baseline(
			sourceUnits: recipe.sourceUnits, source: source.cleaned, other: counterpart?.cleaned)
		title = recipe.title
		yieldCount = recipe.yieldCount
		yieldUnit = recipe.yieldUnit
		prepMinutes = recipe.prepMinutes
		cookMinutes = recipe.cookMinutes
		sourceText = recipe.sourceText
		sourceUrl = recipe.sourceUrl
		notes = recipe.notes
		sourceUnits = recipe.sourceUnits
		mealTypes = recipe.mealTypes
		cuisine = recipe.cuisine
		protein = recipe.protein
		effort = recipe.effort
		damage = recipe.damage
		images = recipe.images.map { DraftImage(id: $0.id, url: $0.url) }
		coverImageId = recipe.coverImageId
		shownUnits = recipe.sourceUnits
		shown = source
		other = counterpart
		applyDevicePreference(units)
	}

	/// Review form for an extracted draft. A failed capture has no bodies, so
	/// its form is blank plus the link and photos; a done one carries the
	/// counterpart, which makes it a "loaded" form (`editing=true` on the web).
	public init(seed: DraftSeed, sourceText: String?, units: UnitSystem) {
		if let ingredients = seed.ingredients, let steps = seed.steps {
			let src = seed.sourceUnits ?? .metric
			let body = BodyText(ingredients: ingredients, steps: steps)
			baseline = Baseline(
				sourceUnits: src, source: body.cleaned, other: seed.counterpart?.cleaned)
			shown = body
			other = seed.counterpart
			sourceUnits = src
			shownUnits = src
		} else {
			baseline = nil
			sourceUnits = units
			shownUnits = units
		}
		title = seed.title ?? ""
		yieldCount = seed.yieldCount ?? 4
		yieldUnit = seed.yieldUnit ?? "servings"
		prepMinutes = seed.prepMinutes
		cookMinutes = seed.cookMinutes
		self.sourceText = seed.sourceText ?? sourceText
		sourceUrl = seed.sourceUrl
		notes = seed.notes
		mealTypes = seed.mealTypes ?? []
		cuisine = seed.cuisine
		protein = seed.protein
		effort = seed.effort
		damage = seed.damage
		images = seed.images
		coverImageId = seed.images.first?.id
		applyDevicePreference(units)
	}

	/// D15: open in the device's system when the counterpart exists.
	mutating func applyDevicePreference(_ units: UnitSystem) {
		if baseline != nil, other != nil, units != shownUnits { swapBodies(to: units) }
	}

	private mutating func swapBodies(to units: UnitSystem) {
		let current = shown
		shown = other ?? current
		other = current
		shownUnits = units
	}

	/// The editor's unit toggle. New recipe: names the system being typed in.
	/// Loaded recipe: swaps which body is in the inputs. No-op while the
	/// counterpart has not been generated.
	public mutating func show(_ units: UnitSystem) {
		guard units != shownUnits else { return }
		if baseline == nil {
			sourceUnits = units
			shownUnits = units
		} else if other != nil {
			swapBodies(to: units)
		}
	}

	/// True when `fresh` (the recipe as the server holds it now) no longer
	/// matches the bodies this form was started from: the other phone edited it
	/// meanwhile. The screen shows "This recipe changed since you started
	/// editing" and offers Start over.
	public func baselineDiffers(from fresh: EditorForm) -> Bool {
		baseline != fresh.baseline
	}

	/// This form's typed work, measured against `fresh`'s bodies. The payload
	/// rule always diffs against what the server holds now, as on the web, so a
	/// restored form cannot mark an edit made elsewhere as "unchanged".
	public func rebased(onto fresh: EditorForm) -> EditorForm {
		var f = self
		f.baseline = fresh.baseline
		return f
	}

	/// Which body is submitted, in which units, and whether the other rides
	/// along as a known-good counterpart. Split out so the rule is testable
	/// without the validation around it.
	public struct BodySelection: Hashable, Sendable {
		public var sourceUnits: UnitSystem
		public var body: BodyText
		public var counterpart: BodyText?
	}

	/// ADR-028. The submitted body is the one the human edited and
	/// `sourceUnits` names it. The counterpart rides along only while nothing
	/// changed (it is known-good); otherwise it is nil and the server queues a
	/// reconvert. If both bodies were edited the visible one wins as "last
	/// authored". The server re-diffs, so a false positive cannot move
	/// `is_source`. Bodies are sent as typed (uncleaned), like the web form.
	public func bodySelection() -> BodySelection {
		guard let baseline else {
			return .init(sourceUnits: sourceUnits, body: shown, counterpart: nil)
		}
		let bodyFor: (UnitSystem) -> BodyText? = { $0 == shownUnits ? shown : other }
		let src = bodyFor(baseline.sourceUnits)!
		let oth = bodyFor(baseline.sourceUnits.other)
		let srcChanged = src.cleaned != baseline.source
		let othChanged = if let oth, let base = baseline.other { oth.cleaned != base } else { false }
		if srcChanged && othChanged {
			return .init(sourceUnits: shownUnits, body: shown, counterpart: nil)
		} else if othChanged, let oth {
			return .init(sourceUnits: baseline.sourceUnits.other, body: oth, counterpart: nil)
		} else {
			return .init(
				sourceUnits: baseline.sourceUnits, body: src, counterpart: srcChanged ? nil : oth)
		}
	}

	public enum Submission: Hashable, Sendable {
		case ready(RecipeInput)
		case incomplete([EditorIssue])
	}

	/// The one place a `RecipeInput` is made from the form. Pure.
	public func payload() -> Submission {
		let sel = bodySelection()
		var issues: [EditorIssue] = []
		if title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { issues.append(.titleRequired) }
		let rounded = (yieldCount * 10).rounded() / 10
		if !rounded.isFinite || rounded <= 0 { issues.append(.yieldInvalid) }
		if sel.body.cleaned.ingredients.isEmpty { issues.append(.ingredientRequired) }
		if effort == nil { issues.append(.effortRequired) }
		if damage == nil { issues.append(.damageRequired) }
		guard issues.isEmpty, let effort, let damage else { return .incomplete(issues) }
		return .ready(
			RecipeInput(
				title: title, yieldCount: yieldCount, yieldUnit: yieldUnit,
				prepMinutes: prepMinutes, cookMinutes: cookMinutes, sourceText: sourceText,
				sourceUrl: sourceUrl, notes: notes, sourceUnits: sel.sourceUnits,
				mealTypes: mealTypes, cuisine: cuisine, protein: protein, effort: effort,
				damage: damage, ingredients: sel.body.ingredients, steps: sel.body.steps,
				counterpart: sel.counterpart, imageIds: images.map(\.id),
				coverImageId: coverImageId))
	}

	public mutating func moveIngredient(group: Int, from: Int, by delta: Int) { fatalError("not implemented") }
	public mutating func moveStep(from: Int, by delta: Int) { fatalError("not implemented") }
	public mutating func addPhoto(_ image: DraftImage) {
		// first photo becomes the cover
		fatalError("not implemented")
	}
	public mutating func removePhoto(_ id: ImageID) {
		// removing the cover moves it to the first remaining photo
		fatalError("not implemented")
	}
	/// Single-select groups: tapping the selected value clears it.
	public mutating func toggleCuisine(_ c: Cuisine) { cuisine = (cuisine == c) ? nil : c }
	public mutating func toggleProtein(_ p: Protein) { protein = (protein == p) ? nil : p }
	public mutating func toggleMeal(_ m: MealType) {
		if let i = mealTypes.firstIndex(of: m) { mealTypes.remove(at: i) } else { mealTypes.append(m) }
	}
}
