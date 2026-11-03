import Foundation
import Observation
import Testing

@testable import WeCookedKit

/// The form is observed one section at a time, so a keystroke re-renders the
/// section it lands in and nothing else (#78). Each test reads one section the
/// way its view does and checks which edits wake it.
@MainActor
struct EditorSectionTests {
	static func model() throws -> EditorModel {
		let env = try EditorModelTests.env(FakeServer())
		return EditorModel(origin: .recipe(EditorModelTests.recipe, nil), env: env)
	}

	/// True if `edit` wakes a reader of `section`.
	static func wakes(_ model: EditorModel, _ section: EditorSection, _ edit: (EditorModel) -> Void) -> Bool {
		let woke = CallCounter()
		withObservationTracking { _ = model.form(section) } onChange: { _ = woke.next() }
		edit(model)
		return woke.count > 0
	}

	@Test func typingAnIngredientWakesOnlyTheIngredients() throws {
		let m = try Self.model()
		let type: (EditorModel) -> Void = { $0.form.shown.ingredients[0].items[0] += "x" }
		#expect(Self.wakes(m, .ingredients, type))
		for other in EditorSection.allCases where other != .ingredients {
			#expect(!Self.wakes(m, other, type), "\(other) re-rendered for an ingredient keystroke")
		}
	}

	/// The Photos section reads `canFindCover` in its body.
	@Test func typingDoesNotWakeTheFindCoverButton() throws {
		let m = try Self.model()
		let woke = CallCounter()
		withObservationTracking { _ = m.canFindCover } onChange: { _ = woke.next() }
		m.form.shown.ingredients[0].items[0] += "x"
		m.form.title += "x"
		#expect(woke.count == 0)
	}

	@Test func eachFieldWakesItsOwnSection() throws {
		let m = try Self.model()
		let edits: [(EditorSection, (EditorModel) -> Void)] = [
			(.title, { $0.form.title += "x" }),
			(.yield, { $0.form.yieldUnit += "x" }),
			(.times, { $0.form.prepMinutes = 99 }),
			(.steps, { $0.form.shown.steps.append("x") }),
			(.tags, { $0.form.toggleMeal(MealType(wire: "brunch")) }),
			(.source, { $0.form.sourceText = "x" }),
			(.notes, { $0.form.notes = "x" }),
			(.photos, { $0.form.coverImageId = nil }),
		]
		for (section, edit) in edits {
			#expect(Self.wakes(m, section, edit), "\(section)")
			#expect(!Self.wakes(m, .title == section ? .notes : .title, edit), "\(section) woke another section")
		}
	}

	@Test func swappingUnitsWakesTheBodyAndTheToggle() throws {
		let m = try Self.model()
		let other = m.form.shownUnits.other
		#expect(Self.wakes(m, .units, { $0.form.show(other) }))
		#expect(Self.wakes(m, .ingredients, { $0.form.show(other.other) }))
		#expect(!Self.wakes(m, .title, { $0.form.show(other) }))
	}

	@Test func theWholeFormStillReadsAsOneValue() throws {
		let m = try Self.model()
		let woke = CallCounter()
		withObservationTracking { _ = m.form } onChange: { _ = woke.next() }
		m.form.notes = "changed"
		#expect(woke.count == 1)
		#expect(m.form.notes == "changed")
		#expect(m.form(.title).notes == "changed", "every section hands back the whole form")
	}

	@Test func anEqualWriteWakesNothing() throws {
		let m = try Self.model()
		let same = m.form
		#expect(!Self.wakes(m, .ingredients, { $0.form = same }))
	}
}
