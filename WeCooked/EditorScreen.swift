import SwiftUI
import WeCookedKit

/// One editor for three jobs (PRODUCT principle 4): review a draft, edit a
/// recipe, type a new one. It binds `model.form` and calls `model.save()`; the
/// rules live in `EditorForm`. Not routed to yet: `EditorModel.init` traps.
struct EditorScreen: View {
	@State var model: EditorModel
	@Environment(Router.self) private var router

	var body: some View {
		// Form {
		//   Banner rows: extraction running / failed (retry) / warnings / damage reasoning.
		//   Sections: photos strip (cover = tap), title, yield + unit, times, tags
		//   (Chip groups; cuisine/protein single-select, meal multi), units toggle
		//   (EditorForm.show), ingredients (groups, up/down arrows per D9), steps, notes,
		//   source. Destructive zone last (D10).
		// }
		// .task { await model.appear() }
		// .onChange(of: model.phase): .saved(id) replaces this screen with
		//   Route.recipe(id, nil) on the Recipes tab.
		NotBuiltYet()
	}
}
