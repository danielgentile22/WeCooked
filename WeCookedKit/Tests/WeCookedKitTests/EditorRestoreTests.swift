import Foundation
import Testing

@testable import WeCookedKit

/// An autosaved form restored after the recipe changed on the other phone.
struct EditorRestoreTests {
	@Test func aRestoredFormIsMeasuredAgainstTheFreshRecipe() throws {
		var saved = try EditorPayloadTests.loadedForm()
		saved.title = "Renamed while away"
		var freshRecipe = try Wire.makeDecoder().decode(RecipeResponse.self, from: Fixtures.data("recipe-get")).recipe
		freshRecipe.ingredients[0].items[0] = "2 onions, finely diced"
		freshRecipe.bodies.metric = BodyText(ingredients: freshRecipe.ingredients, steps: freshRecipe.steps)
		let fresh = EditorForm(recipe: freshRecipe, units: .metric)
		#expect(saved.baselineDiffers(from: fresh))
		#expect(!saved.baselineDiffers(from: saved))
		let rebased = saved.rebased(onto: fresh)
		#expect(rebased.title == "Renamed while away", "typed work is kept")
		guard case .ready(let input) = rebased.payload() else { Issue.record("not ready"); return }
		#expect(input.counterpart == nil, "the body differs from the fresh recipe, so the server reconverts")
		guard case .ready(let stale) = saved.payload() else { Issue.record("not ready"); return }
		#expect(stale.counterpart != nil, "against the stale baseline the same body looked unchanged")
	}

	@Test func theBaselineSurvivesTheAutosaveRoundTrip() throws {
		let form = try EditorPayloadTests.loadedForm()
		let data = try JSONEncoder().encode(form)
		let back = try JSONDecoder().decode(EditorForm.self, from: data)
		#expect(back.baseline == form.baseline)
		#expect(!back.baselineDiffers(from: form))
	}
}
