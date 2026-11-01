import XCTest

/// The suggestion widget on the real home screen: Cook opens the suggested
/// recipe, a tap anywhere else opens the app where it was. Needs the dev
/// server with seeded recipes, like the other UI tests.
@MainActor
final class SuggestionWidgetTests: PortUITest {
	override var unit: String { "widget" }
	let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

	var widget: XCUIElement { springboard.icons.matching(NSPredicate(format: "value == 'Widget' AND label == 'We Cooked'")).firstMatch }

	/// Adds the Tonight widget through the widget gallery, unless an earlier
	/// run left one on the first page.
	func addWidget() {
		XCUIDevice.shared.press(.home)
		guard !widget.waitForExistence(timeout: 2) || !widget.buttons["Cook"].exists else { return }
		springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.6)).press(forDuration: 1.5)
		springboard.buttons["Edit"].tap()
		springboard.buttons["Add Widget"].tap()
		let search = springboard.searchFields["Search Widgets"]
		XCTAssertTrue(search.waitForExistence(timeout: 5))
		search.tap()
		search.typeText("We Cooked")
		springboard.cells["We Cooked"].firstMatch.tap()
		// The gallery pages are Shopping medium, Shopping large, Tonight; a drag
		// does not turn them in the simulator, a tap on the page dots does.
		let tonight = springboard.staticTexts["Tonight"]
		for dot in [0.547, 0.5, 0.547] where !tonight.waitForExistence(timeout: 1) {
			springboard.coordinate(withNormalizedOffset: CGVector(dx: dot, dy: 0.85)).tap()
		}
		springboard.buttons.matching(NSPredicate(format: "label CONTAINS 'Add Widget'")).firstMatch.tap()
		springboard.buttons["Done"].tap()
		XCTAssertTrue(widget.buttons["Cook"].waitForExistence(timeout: 10), "Tonight is on the home screen")
	}

	func testCookOpensTheRecipeAndAnywhereElseOpensTheApp() throws {
		launch()  // signs in, which writes the book for the widget
		addWidget()
		let title = try XCTUnwrap(
			widget.staticTexts.allElementsBoundByIndex.map(\.label).first { $0 != "Tonight" }, "a suggestion")

		widget.buttons["Cook"].tap()
		XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
		XCTAssertTrue(app.staticTexts[title].waitForExistence(timeout: 10), "Cook opened \(title)")
		snap("cook")

		// The list shows the title too, so the recipe screen is told apart by its Edit button.
		let recipeScreen = app.buttons["Edit"]
		XCTAssertTrue(recipeScreen.exists)
		app.navigationBars.buttons.element(boundBy: 0).tap()
		XCTAssertTrue(recipeScreen.waitForNonExistence(timeout: 5), "back on the list")
		XCUIDevice.shared.press(.home)
		widget.staticTexts["Tonight"].tap()
		XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
		XCTAssertTrue(app.tabBars.buttons["Recipes"].waitForExistence(timeout: 5))
		XCTAssertFalse(recipeScreen.waitForExistence(timeout: 3), "the app, not the recipe")
		snap("elsewhere")

		// From cold: the intent runs as the app launches. A Debug simulator build
		// keeps the token in memory (`TokenStore.automatic`), so it comes back
		// signed out; the recipe must still be waiting behind the sign-in.
		app.terminate()
		widget.buttons["Cook"].tap()
		XCTAssertTrue(app.wait(for: .runningForeground, timeout: 15))
		let password = app.secureTextFields["Password"]
		if password.waitForExistence(timeout: 5) {
			password.tap()
			password.typeText("wecooked\n")
		}
		XCTAssertTrue(recipeScreen.waitForExistence(timeout: 15), "Cook from cold opened \(title)")
		XCTAssertTrue(app.staticTexts[title].exists)
		snap("cook-cold")
	}
}
