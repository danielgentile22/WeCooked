import SwiftUI
import WeCookedKit

/// The cooking screen: 95 percent of use, so it gets the layout that reads at
/// arm's length with wet hands. Type scale 19 to 20 pt via Dynamic Type
/// (`.title3` body, not fixed points), tap a line to strike it, wake lock,
/// sticky ingredients while steps scroll.
///
/// Data path (three files): this view -> `RecipeModel.display` (WeCookedKit/
/// RecipeModel.swift) -> `Resource<RecipeResponse>` (WeCookedKit/Store.swift).
struct RecipeScreen: View {
	@State var model: RecipeModel

	var body: some View {
		Group {
			if let display = model.display {
				CookingBody(display: display, model: model)
			} else if model.resource.isFirstLoad {
				ProgressView()  // reached only for a recipe never seen on this phone
			} else if case .failed(let e) = model.resource.phase {
				Banner(kind: .error, text: e.message, actionTitle: "Try again") {
					Task { await model.resource.revalidate() }
				}
				.padding()
			}
		}
		.watching(model.resource)
		// .task { await model.appear() } once `RecipeModel.appear` exists; it traps today.
		.keepsScreenAwake()
	}
}

struct CookingBody: View {
	let display: RecipeDisplay
	let model: RecipeModel
	var body: some View {
		// ScrollView { photo strip; title; meta line (prep, cook, tags as words);
		//   chips row + YieldStepper + "Show N" / "Calculate for N";
		//   banners from display.banners (+ model.localBanner);
		//   ingredients grouped, each line a Button that calls model.strike(_:);
		//   steps likewise; notes; source }
		// Toolbar: units toggle (device-wide), Edit -> Route.edit, delete in a menu (D10).
		NotBuiltYet()
	}
}
