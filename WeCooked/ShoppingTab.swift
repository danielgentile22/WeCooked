import SwiftUI
import WeCookedKit

/// D11. List with sections, rows tick optimistically through
/// `ShoppingModel.setTicked`, "Add recipes" opens `PickRecipesSheet`, Done
/// shopping asks once with the web's confirmation text.
struct ShoppingTab: View {
	@Environment(AppEnvironment.self) private var env
	@State private var model: ShoppingModel?

	var body: some View {
		// .watching(model.resource, every: .seconds(5)) plus `.task { await model.appear() }`
		NotBuiltYet()
			.navigationTitle("Shopping")
	}
}

/// Pick mode over the same list rows as browse, whole-number yield stepper
/// (minimum 1) per picked recipe, "Build list from N recipes".
struct PickRecipesSheet: View { var body: some View { NotBuiltYet() } }
