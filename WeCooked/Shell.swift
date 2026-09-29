import SwiftUI
import WeCookedKit

// Navigation: three tabs, each its own NavigationStack over one shared `Route`
// enum, driven by one `Router`. Anything outside the app that wants to open a
// screen (URL scheme, share extension, push, widget) becomes a `DeepLink`,
// and `Router.open` is the only place that turns it into tab + path.

enum AppTab: Hashable { case recipes, add, shopping }

/// Every pushed screen. Hashable and Codable-able (IDs are strings) so the
/// paths can be saved in `@SceneStorage` for state restoration.
enum Route: Hashable {
	case recipe(RecipeID, VariationID?)
	case edit(RecipeID, VariationID?)
	case draft(JobID)
	case newRecipe
	case trash
}

/// Presented over a tab, not pushed.
enum Sheet: Identifiable, Hashable {
	case pickRecipes
	var id: Self { self }
}

@MainActor @Observable
final class Router {
	var tab: AppTab = .recipes
	var recipesPath: [Route] = []
	var addPath: [Route] = []
	var shoppingPath: [Route] = []
	var sheet: Sheet?

	/// Draft and trash links land on the Recipes tab with the screen pushed, so
	/// Back returns to the list, not to an empty Add tab.
	func open(_ link: DeepLink) {
		sheet = nil
		switch link {
		case .recipes: tab = .recipes; recipesPath = []
		case .recipe(let id, let v): tab = .recipes; recipesPath = [.recipe(id, v)]
		case .draft(let job): tab = .recipes; recipesPath = [.draft(job)]
		case .add: tab = .add; addPath = []
		case .shopping: tab = .shopping; shoppingPath = []
		case .trash: tab = .recipes; recipesPath = [.trash]
		}
	}

	/// A saved editor gives way to its recipe on the Recipes tab. Editing from
	/// the recipe screen pops back to it rather than stacking a second copy.
	func leaveEditor(showing saved: Route) {
		switch tab {
		case .recipes: recipesPath.removeLast()
		case .add: addPath.removeLast()
		case .shopping: shoppingPath.removeLast()
		}
		tab = .recipes
		if recipesPath.last != saved { recipesPath.append(saved) }
	}

	static let pendingLinkKey = "pendingLink"

	/// Extension hand-off: the extension writes `pendingLink` (a URL string) in
	/// the app-group defaults; consumed once.
	func consumePendingLink(from env: AppEnvironment) {
		guard let group = env.config.appGroup, let defaults = UserDefaults(suiteName: group),
			let raw = defaults.string(forKey: Self.pendingLinkKey)
		else { return }
		defaults.removeObject(forKey: Self.pendingLinkKey)
		if let url = URL(string: raw), let link = DeepLink(url: url) { open(link) }
	}
}

struct RootView: View {
	@Environment(AppEnvironment.self) private var env

	var body: some View {
		if env.isSignedIn { Tabs() } else { LoginScreen() }
	}
}

struct Tabs: View {
	@Environment(Router.self) private var router
	@Environment(AppEnvironment.self) private var env

	var body: some View {
		@Bindable var router = router
		TabView(selection: $router.tab) {
			Tab("Recipes", systemImage: "book.closed", value: AppTab.recipes) {
				NavigationStack(path: $router.recipesPath) {
					RecipesTab().navigationDestination(for: Route.self) { destination($0) }
				}
			}
			Tab("Add", systemImage: "plus.circle", value: AppTab.add) {
				NavigationStack(path: $router.addPath) {
					AddTab(model: CaptureModel(env: env)).navigationDestination(for: Route.self) { destination($0) }
				}
			}
			Tab("Shopping", systemImage: "cart", value: AppTab.shopping) {
				NavigationStack(path: $router.shoppingPath) {
					ShoppingTab().navigationDestination(for: Route.self) { destination($0) }
				}
			}
		}
		.sheet(item: $router.sheet) { SheetContent(sheet: $0) }
	}

	@ViewBuilder
	private func destination(_ route: Route) -> some View {
		switch route {
		case .recipe(let id, let v):
			RecipeScreen(model: RecipeModel(recipe: id, variation: v, env: env))
		case .edit(let id, let v):
			EditorScreen(model: EditorModel(origin: .recipe(id, v), env: env))
		case .draft(let job):
			EditorScreen(model: EditorModel(origin: .draft(job), env: env))
		case .newRecipe:
			EditorScreen(model: EditorModel(origin: .manual, env: env))
		case .trash:
			TrashScreen()
		}
	}
}

struct SheetContent: View {
	let sheet: Sheet
	var body: some View {
		switch sheet {
		case .pickRecipes: PickRecipesSheet()
		}
	}
}
