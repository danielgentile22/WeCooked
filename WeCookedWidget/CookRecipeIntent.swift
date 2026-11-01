import AppIntents
import WeCookedKit

/// The suggestion widget's Cook button. A 2x2 widget has one tap target unless
/// a control runs an intent, so the button carries this and the rest of the
/// widget carries no URL: Cook opens the recipe, anywhere else opens the app
/// as it was. Compiled into both targets; it always runs in the app, which
/// sets `open` at launch.
struct CookRecipeIntent: AppIntent {
	static let title: LocalizedStringResource = "Cook recipe"
	static let openAppWhenRun = true
	static let isDiscoverable = false

	/// Hands the link to the app's router. Unset (a no-op) in the widget.
	@MainActor static var open: (DeepLink) -> Void = { _ in }

	@Parameter(title: "Recipe ID") var recipeID: String

	init() {}
	init(recipe: RecipeID) { recipeID = recipe.raw }

	@MainActor
	func perform() async throws -> some IntentResult {
		Self.open(.recipe(RecipeID(recipeID), variation: nil))
		return .result()
	}
}
