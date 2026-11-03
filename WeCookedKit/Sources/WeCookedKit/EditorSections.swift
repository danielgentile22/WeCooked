import Foundation

/// The parts of the editor screen that re-render on their own. `EditorModel`
/// observes the form one section at a time, so a keystroke in an ingredient
/// wakes the ingredients and nothing else; a long recipe stays smooth to type
/// in (#78). A view reads its part with `model.form(section)`.
public enum EditorSection: CaseIterable, Hashable, Sendable {
	case title, photos, yield, times
	/// The unit toggle and the body's bookkeeping: which body is shown, the
	/// one that is not, and the baseline. Changes on a swap, never on typing.
	case units
	case ingredients, steps, tags, source, notes

	/// The fields this section shows, as one comparable value.
	func slice(of f: EditorForm) -> AnyHashable {
		switch self {
		case .title: f.title
		case .photos: [AnyHashable(f.images), AnyHashable(f.coverImageId)]
		case .yield: [AnyHashable(f.yieldCount), AnyHashable(f.yieldUnit)]
		case .times: [f.prepMinutes, f.cookMinutes]
		case .units: [AnyHashable(f.shownUnits), AnyHashable(f.sourceUnits), AnyHashable(f.other), AnyHashable(f.baseline)]
		case .ingredients: f.shown.ingredients
		case .steps: f.shown.steps
		case .tags:
			[AnyHashable(f.mealTypes), AnyHashable(f.cuisine), AnyHashable(f.protein), AnyHashable(f.effort), AnyHashable(f.damage)]
		case .source: [f.sourceText, f.sourceUrl]
		case .notes: f.notes
		}
	}

	/// The sections an edit from `old` to `new` touches. A change no section
	/// claims (a field added to the form but not here) wakes them all, so a
	/// missed field costs a render, never a stale screen.
	static func changed(from old: EditorForm, to new: EditorForm) -> [EditorSection] {
		guard old != new else { return [] }
		let touched = allCases.filter { $0.slice(of: old) != $0.slice(of: new) }
		return touched.isEmpty ? allCases : touched
	}
}
