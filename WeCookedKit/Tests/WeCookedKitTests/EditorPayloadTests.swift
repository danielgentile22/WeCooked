import Foundation
import Testing

@testable import WeCookedKit

/// One test per branch of `RecipeForm.payload()`. Every case starts from the
/// `recipe-get` fixture (metric source, US counterpart) so the setup is the
/// server's real shape.
struct EditorPayloadTests {
	static func loadedForm(units: UnitSystem = .metric) throws -> EditorForm {
		let r = try Wire.makeDecoder().decode(RecipeResponse.self, from: Fixtures.data("recipe-get"))
		return EditorForm(recipe: r.recipe, units: units)
	}

	static func edited(_ body: BodyText) -> BodyText {
		var b = body
		b.ingredients[0].items[0] += " (edited)"
		return b
	}

	func input(_ f: EditorForm) throws -> RecipeInput {
		guard case .ready(let i) = f.payload() else { throw Failure() }
		return i
	}
	struct Failure: Error {}

	@Test func neitherChangedSendsSourceAndKnownGoodCounterpart() throws {
		let f = try Self.loadedForm()
		let i = try input(f)
		#expect(i.sourceUnits == .metric)
		#expect(i.ingredients == f.shown.ingredients)
		#expect(i.counterpart == f.other)
	}

	@Test func onlySourceChangedNullsCounterpartSoServerReconverts() throws {
		var f = try Self.loadedForm()
		f.shown = Self.edited(f.shown)
		let i = try input(f)
		#expect(i.sourceUnits == .metric)
		#expect(i.counterpart == nil)
		#expect(i.ingredients[0].items[0].hasSuffix("(edited)"))
	}

	@Test func onlyOtherChangedSubmitsOtherAsSourceInItsUnits() throws {
		var f = try Self.loadedForm()
		f.other = Self.edited(f.other!)
		let i = try input(f)
		#expect(i.sourceUnits == .us)
		#expect(i.counterpart == nil)
		#expect(i.ingredients == f.other!.ingredients)
	}

	@Test func bothChangedSubmitsTheVisibleBodyWithItsUnits() throws {
		var f = try Self.loadedForm()
		f.shown = Self.edited(f.shown)
		f.other = Self.edited(f.other!)
		#expect(try input(f).sourceUnits == .metric)
		f.show(.us)
		let i = try input(f)
		#expect(i.sourceUnits == .us)
		#expect(i.ingredients == f.shown.ingredients)
		#expect(i.counterpart == nil)
	}

	@Test func togglingUnitsWithoutTypingChangesNothing() throws {
		var f = try Self.loadedForm()
		let before = try input(f)
		f.show(.us)
		f.show(.metric)
		#expect(try input(f) == before)
		f.show(.us)
		let viewedInUS = try input(f)
		#expect(viewedInUS.sourceUnits == .metric, "viewing US must not make US the source")
		#expect(viewedInUS.counterpart != nil)
	}

	@Test func deviceUnitPreferenceOpensOtherBodyButNotAsBaseline() throws {
		let f = try Self.loadedForm(units: .us)
		#expect(f.shownUnits == .us)
		let i = try input(f)
		#expect(i.sourceUnits == .metric)
		#expect(i.counterpart != nil)
	}

	@Test func whitespaceOnlyEditsAreNotEdits() throws {
		var f = try Self.loadedForm()
		f.shown.ingredients[0].items[0] += "   "
		f.shown.steps.append("  ")
		let i = try input(f)
		#expect(i.counterpart != nil)
	}

	@Test func newRecipeSendsShownBodyNoCounterpartAndFollowsToggle() throws {
		var f = EditorForm.blank(units: .metric)
		f.title = "Toast"
		f.shown.ingredients[0].items = ["2 slices bread"]
		f.effort = .quick
		f.damage = .tidy
		f.show(.us)
		let i = try input(f)
		#expect(i.sourceUnits == .us)
		#expect(i.counterpart == nil)
	}

	@Test func incompleteFormsListTheServersOwnMessages() {
		var f = EditorForm.blank(units: .metric)
		guard case .incomplete(let issues) = f.payload() else { Issue.record("expected incomplete"); return }
		#expect(issues.map(\.message) == [
			"Title is required.", "At least one ingredient line is required.",
			"Effort is required.", "Damage is required.",
		])
		f.yieldCount = 0
		guard case .incomplete(let again) = f.payload() else { return }
		#expect(again.contains(.yieldInvalid))
	}

	@Test func imagesAndCoverRideInThePayload() throws {
		var f = try Self.loadedForm()
		f.coverImageId = f.images.first?.id
		let i = try input(f)
		#expect(i.imageIds == f.images.map(\.id))
		#expect(i.coverImageId == f.coverImageId)
	}
}
