import Foundation
import Testing

@testable import WeCookedKit

/// A recipe opened from the list before it was ever fetched on this phone
/// shows the row's title and cover while the reply loads (issue #78).
@MainActor
struct RecipePreviewTests {
	static let stew: RecipeID = "01TEST00000000000000000003"

	@Test func anUncachedRecipeShowsItsBrowseRowWhileLoading() throws {
		let env = RecipeModelTests.env(FakeServer())
		env.store.resource(.recipes()).replace(try EditorModelTests.browse())
		let model = RecipeModel(recipe: Self.stew, variation: nil, env: env)
		#expect(model.display == nil)
		let preview = try #require(model.preview)
		#expect(preview.title == "Chickpea stew")
		#expect(preview.coverUrl?.path().hasSuffix("/display.jpg") == true)
	}

	@Test func aFilteredListAlsoSuppliesThePreview() throws {
		let env = RecipeModelTests.env(FakeServer())
		var filters = BrowseFilters()
		filters.efforts = [.weeknight]
		env.store.resource(.recipes(filters)).replace(try EditorModelTests.browse())
		#expect(RecipeModel(recipe: Self.stew, variation: nil, env: env).preview?.title == "Chickpea stew")
	}

	@Test func theReplyReplacesThePreview() throws {
		let env = RecipeModelTests.env(FakeServer())
		env.store.resource(.recipes()).replace(try EditorModelTests.browse())
		let model = RecipeModel(recipe: Self.stew, variation: nil, env: env)
		model.resource.replace(try RecipeModelTests.reply("recipe-get"))
		#expect(model.display != nil)
		#expect(model.preview == nil)
	}

	@Test func aRecipeNoListShowsHasNoPreview() {
		let env = RecipeModelTests.env(FakeServer())
		#expect(RecipeModel(recipe: Self.stew, variation: nil, env: env).preview == nil)
	}
}
