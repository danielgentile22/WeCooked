import XCTest

/// Draft flows. The paste test spends one Claude call against the daily cap,
/// so these run only with `TEST_RUNNER_WC_CLAUDE=1`. The failure test spends
/// nothing (a private host is refused before any call) but shares the gate so
/// the suite stays one switch.
@MainActor
final class Unit4DraftTests: PortUITest {
	override var unit: String { "unit4" }

	override func setUpWithError() throws {
		try XCTSkipUnless(ProcessInfo.processInfo.environment["WC_CLAUDE"] == "1", "set TEST_RUNNER_WC_CLAUDE=1 to spend Claude calls")
	}

	private func extract(_ text: String) {
		tab("Add")
		el("add.paste").tap()
		el("add.paste").typeText(text)
		el("add.extract").tap()
	}

	private var draftRow: XCUIElement {
		app.buttons.matching(NSPredicate(format: "label CONTAINS 'Extracting…' OR label CONTAINS 'Ready to review' OR label CONTAINS 'Failed: tap to fix'")).firstMatch
	}

	func testRows30And35And8And9And38To40PasteToRecipe() {
		launch()
		extract("""
			Lemony white beans on toast. Serves 2.
			1 can cannellini beans, 1 lemon, 2 slices sourdough, 2 tbsp olive oil, 1 garlic clove.
			Warm the beans in the oil with the garlic. Add lemon zest and juice. Pile onto toast.
			""")
		XCTAssertTrue(el("editor.extracting").waitForExistence(timeout: 10), "draft screen shows progress")
		snap("draft-extracting")

		app.navigationBars.buttons.element(boundBy: 0).tap()
		XCTAssertTrue(draftRow.waitForExistence(timeout: 10), "a draft card on Browse")
		snap("draft-card")
		let ready = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Ready to review'")).firstMatch
		XCTAssertTrue(ready.waitForExistence(timeout: 180), "the card updates when extraction ends")
		snap("draft-card-ready")

		ready.tap()
		let title = el("editor.title")
		XCTAssertTrue(title.waitForExistence(timeout: 10))
		XCTAssertFalse(text("editor.title").isEmpty, "seeded from the draft")
		let saved = text("editor.title")
		snap("draft-review")
		XCTAssertTrue(reveal(el("editor.sourceText")).exists)
		snap("draft-review-source")

		el("editor.save").tap()
		if !app.staticTexts[saved].waitForExistence(timeout: 10) {
			snap("draft-save-issues")
			for tag in ["editor.tag.effort.Quick", "editor.tag.damage.Tidy"] where !el(tag).isSelected {
				reveal(el(tag)).tap()
			}
			el("editor.save").tap()
		}
		XCTAssertTrue(app.staticTexts[saved].waitForExistence(timeout: 10), "saved draft opens its recipe")
		snap("draft-saved")
		app.navigationBars.buttons.element(boundBy: 0).tap()
		XCTAssertTrue(draftRow.waitForNonExistence(timeout: 5), "the card left Browse")

		openRecipe(saved)
		app.buttons["Edit"].tap()
		reveal(el("editor.delete")).tap()
		let confirm = app.buttons.matching(NSPredicate(format: "label == 'Delete recipe' AND identifier != 'editor.delete'")).firstMatch
		XCTAssertTrue(confirm.waitForExistence(timeout: 5))
		confirm.tap()
		XCTAssertTrue(rows(saved).firstMatch.waitForNonExistence(timeout: 10), "cleaned up")
	}

	func testRows36And41FailedThenDiscarded() {
		launch()
		extract("http://localhost/no-recipe-here")
		let retry = app.buttons["Try again"]
		XCTAssertTrue(retry.waitForExistence(timeout: 60), "failed draft offers Try again")
		snap("draft-failed")

		reveal(el("editor.discard")).tap()
		XCTAssertEqual(el("editor.discard").label, "Really discard this draft? Tap again", "asks twice")
		el("editor.discard").tap()
		XCTAssertTrue(app.tabBars.buttons["Recipes"].waitForExistence(timeout: 10))
		XCTAssertTrue(draftRow.waitForNonExistence(timeout: 10), "discarded draft left Browse")
		snap("draft-discarded")
	}
}
