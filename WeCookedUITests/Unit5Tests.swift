import XCTest

/// Variations. Each test is run alone by `run-unit5.sh`, after
/// `server/scripts/unit5-prep.mjs` forges the server state it starts from, so
/// none depends on XCTest ordering. Five of the seven spend one Claude call each.
@MainActor
final class Unit5Tests: PortUITest {
	override var unit: String { "unit5" }

	private let calcError = "Claude is unavailable right now. Try again in a minute."
	private let jobTimeout: TimeInterval = 240

	override func setUpWithError() throws {
		try XCTSkipUnless(ProcessInfo.processInfo.environment["WC_CLAUDE"] == "1", "set TEST_RUNNER_WC_CLAUDE=1 to spend Claude calls")
	}

	private func wait(_ element: XCUIElement, until format: String, timeout: TimeInterval) -> Bool {
		let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: format), object: element)
		return XCTWaiter().wait(for: [expectation], timeout: timeout) == .completed
	}

	private func selected(_ element: XCUIElement, timeout: TimeInterval) -> Bool {
		wait(element, until: "exists == true AND isSelected == true", timeout: timeout)
	}

	private func chip(_ count: Int) -> XCUIElement { app.buttons["\(count)"] }

	private var originalChip: XCUIElement {
		app.buttons.matching(NSPredicate(format: "label ENDSWITH %@", " · original")).firstMatch
	}

	/// A confirmation dialog's button shares its label with the button that
	/// opened it, which carries no identifier; the opener's frame tells them apart.
	private func confirm(_ label: String, openedBy opener: XCUIElement, title: String, snapshot: String) {
		let openerFrame = opener.frame
		opener.tap()
		XCTAssertTrue(app.staticTexts[title].waitForExistence(timeout: 5), "asks: \(title)")
		snap(snapshot)
		let button = app.buttons.matching(NSPredicate(format: "label == %@", label)).allElementsBoundByIndex
			.first { $0.frame != openerFrame }
		guard let button else { return XCTFail("the dialog's \(label) button") }
		button.tap()
	}

	/// The job is forged as running and never finishes, so the relaunch cannot
	/// race it and nothing is spent.
	func testRow20PendingCalculationResumes() {
		launch()
		openRecipe("Shakshuka")
		XCTAssertTrue(app.staticTexts["Calculating for 6…"].waitForExistence(timeout: 10))
		snap("calc-pending")

		app.terminate()
		launch()
		openRecipe("Shakshuka")
		XCTAssertTrue(app.staticTexts["Calculating for 6…"].waitForExistence(timeout: 10), "resumed after relaunch")
		snap("calc-resumed")
	}

	func testRow21FailedCalculationRetried() {
		launch()
		openRecipe("Shakshuka")
		XCTAssertTrue(app.staticTexts[calcError].waitForExistence(timeout: 10), "failed calculation shows its error")
		XCTAssertTrue(app.buttons["Try again"].exists, "with a retry")
		snap("calc-failed")

		app.buttons["Try again"].tap()
		XCTAssertTrue(app.staticTexts["Calculating for 6…"].waitForExistence(timeout: 15))
		snap("calculating")

		XCTAssertTrue(selected(chip(6), timeout: jobTimeout), "switched to the new variation")
		XCTAssertEqual(app.textFields["Yield count"].value as? String, "6")
		snap("calc-done")
	}

	func testRows19And16CalculateThenDeleteVariation() {
		launch()
		openRecipe("Buttermilk pancakes")
		let more = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'More '")).firstMatch
		XCTAssertTrue(more.waitForExistence(timeout: 5))
		let unit = String(more.label.dropFirst("More ".count))
		var count = Int(app.textFields["Yield count"].value as? String ?? "") ?? 0
		repeat {
			more.tap()
			count += 1
		} while chip(count).exists && count < 100
		let calculate = app.buttons["Calculate for \(count)"]
		XCTAssertTrue(calculate.exists, "a count with no chip offers Calculate")
		calculate.tap()
		XCTAssertTrue(app.staticTexts["Calculating for \(count)…"].waitForExistence(timeout: 15))
		snap("calculate-banner")

		XCTAssertTrue(selected(chip(count), timeout: jobTimeout), "switched to the new variation")
		snap("calculate-switched")

		chip(count).tap()
		let delete = app.buttons["Delete this variation"]
		XCTAssertTrue(delete.waitForExistence(timeout: 5), "the selected chip reveals delete")
		snap("variation-detail")
		confirm(
			"Delete this variation", openedBy: delete, title: "Delete the \(count)-\(unit) version? It goes to Trash.",
			snapshot: "variation-delete-confirm")
		XCTAssertTrue(selected(originalChip, timeout: 10), "back on the original")
		XCTAssertTrue(chip(count).waitForNonExistence(timeout: 10), "the chip is gone")
		snap("variation-deleted")
	}

	func testRow22StaleUntouchedRefresh() {
		launch()
		openRecipe("Shakshuka")
		chip(6).tap()
		let updating = app.staticTexts["The original changed, updating this version…"]
		XCTAssertTrue(updating.waitForExistence(timeout: 15), "a stale untouched variation refreshes")
		snap("refreshing")
		XCTAssertTrue(app.staticTexts["Updated to match the original."].waitForExistence(timeout: jobTimeout))
		snap("refreshed")
		XCTAssertFalse(updating.exists, "the updating banner is gone")
	}

	func testRow23KeepMine() {
		launch()
		openRecipe("Shakshuka")
		chip(6).tap()
		let stale = app.staticTexts["The original changed after you edited this version."]
		XCTAssertTrue(stale.waitForExistence(timeout: 15))
		XCTAssertTrue(app.buttons["Recalculate"].exists)
		XCTAssertTrue(app.buttons["Keep mine"].exists)
		snap("stale-hand-edited")
		app.buttons["Keep mine"].tap()
		XCTAssertTrue(stale.waitForNonExistence(timeout: 10), "Keep mine dismisses it")
		snap("kept-mine")
	}

	func testRow23Recalculate() {
		launch()
		openRecipe("Shakshuka")
		chip(6).tap()
		let recalculate = app.buttons["Recalculate"]
		XCTAssertTrue(recalculate.waitForExistence(timeout: 15))
		confirm(
			"Recalculate", openedBy: recalculate,
			title: "Recalculate this version? Your edits will be lost (the edited version goes to Trash).",
			snapshot: "recalculate-confirm")
		XCTAssertTrue(selected(originalChip, timeout: 10), "back on the original")
		XCTAssertTrue(app.staticTexts["Calculating for 6…"].waitForExistence(timeout: 10))
		snap("recalculating")
		XCTAssertTrue(selected(chip(6), timeout: jobTimeout), "the recalculated 6 is back")
		snap("recalculated")
	}

	func testRow25ReconvertBannersAndEditorBanner() {
		launch()
		openRecipe("Sunday ragù")
		let picker = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Units'")).firstMatch
		if !picker.label.hasSuffix("US") {
			picker.tap()
			app.buttons["US"].tap()
		}
		XCTAssertTrue(picker.label.hasSuffix("US"), picker.label)
		let failed = app.staticTexts["Couldn't update from your edit."]
		let pending = app.staticTexts["Not yet updated from your edit. Updating…"]
		XCTAssertTrue(failed.waitForExistence(timeout: 10), "failed reconvert on the converted side")
		XCTAssertTrue(app.buttons["Tap to retry"].exists)
		snap("reconvert-failed")

		app.buttons["Edit"].tap()
		XCTAssertTrue(el("editor.title").waitForExistence(timeout: 5))
		reveal(el("editor.units"))
		app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'US'")).firstMatch.tap()
		XCTAssertTrue(failed.waitForExistence(timeout: 5), "the editor shows it too")
		reveal(app.buttons["Tap to retry"])
		snap("editor-reconvert-failed")
		app.buttons["Tap to retry"].tap()
		XCTAssertTrue(pending.waitForExistence(timeout: 15), "retry requeues the job")
		snap("editor-reconvert-pending")

		app.navigationBars.buttons.element(boundBy: 0).tap()
		XCTAssertTrue(picker.waitForExistence(timeout: 5), "back on the recipe")
		XCTAssertTrue(picker.label.hasSuffix("US"), picker.label)
		XCTAssertFalse(failed.exists, "pending, or already done")
		XCTAssertTrue(pending.waitForNonExistence(timeout: jobTimeout), "reconvert finished")
		XCTAssertFalse(failed.exists)
		snap("reconvert-done")
	}
}
