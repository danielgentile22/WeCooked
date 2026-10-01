import XCTest

@MainActor
final class Unit3Tests: PortUITest {
	override var unit: String { "unit3" }
	private let titles = [
		"Chickpea and spinach curry",
		"Slow-roasted salmon",
		"Buttermilk pancakes",
		"Sunday ragù",
		"Shakshuka",
		"Weeknight chicken thighs",
	]

	private func assertListShows(_ shown: [String]) {
		for title in titles {
			let row = rows(title).firstMatch
			if shown.contains(title) {
				XCTAssertTrue(row.waitForExistence(timeout: 10), "\(title) listed")
			} else {
				XCTAssertTrue(row.waitForNonExistence(timeout: 10), "\(title) filtered out")
			}
		}
	}

	private var searchField: XCUIElement {
		let field = app.searchFields.firstMatch
		if !field.exists { app.swipeDown() }
		XCTAssertTrue(field.waitForExistence(timeout: 5), "search field")
		return field
	}

	func testRow05List() {
		launch()
		assertListShows(titles)
		XCTAssertTrue(rows("Sunday ragù").firstMatch.label.contains("Project"))
		XCTAssertTrue(rows("Sunday ragù").firstMatch.label.contains("Carnage"))
		XCTAssertTrue(rows("Shakshuka").firstMatch.label.contains("Quick"))
		XCTAssertTrue(rows("Shakshuka").firstMatch.label.contains("Tidy"))
		snap("list")
	}

	func testRow06Search() {
		launch()
		let field = searchField
		field.tap()
		field.typeText("shak")
		assertListShows(["Shakshuka"])
		snap("search")
		field.buttons["Clear text"].tap()
		assertListShows(titles)
	}

	func testRow07Filters() {
		launch()
		app.buttons["Filters"].tap()
		app.buttons["Quick"].tap()
		snap("filters-sheet")
		app.buttons["Done"].tap()
		assertListShows(["Buttermilk pancakes", "Shakshuka"])
		snap("filters")
		app.buttons["Filters, 1 active"].tap()
		app.buttons["Tidy"].tap()
		app.buttons["Done"].tap()
		assertListShows(["Shakshuka"])
		snap("filters-and")
		app.buttons["Filters, 2 active"].tap()
		app.buttons["Clear"].tap()
		app.buttons["Done"].tap()
		assertListShows(titles)
	}

	func testRow10Empty() {
		launch()
		let field = searchField
		field.tap()
		field.typeText("zzzz")
		XCTAssertTrue(app.staticTexts["No recipes match."].waitForExistence(timeout: 10))
		snap("empty")
	}

	func testRow12To14And26Recipe() {
		launch()
		openRecipe("Sunday ragù")
		XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'prep'")).firstMatch.exists)
		for tag in ["Dinner", "Italian", "Beef", "Project", "Carnage"] {
			XCTAssertTrue(app.descendants(matching: .any)[tag].exists, "tag \(tag)")
		}
		XCTAssertTrue(app.staticTexts["Soffritto"].exists)
		XCTAssertTrue(app.buttons["Ingredients"].exists)
		snap("recipe")
		let steps = app.staticTexts["Steps"]
		for _ in 0..<5 where !steps.exists { app.swipeUp() }
		XCTAssertTrue(steps.exists, "Steps heading")
		XCTAssertTrue(app.staticTexts["Sauce"].exists)
		for _ in 0..<3 { app.swipeUp() }
		XCTAssertFalse(app.staticTexts["Sunday ragù"].isHittable, "scrolled past the header")
		XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label CONTAINS 'Shred the beef'")).firstMatch.isHittable, "last step rendered")
		XCTAssertFalse(app.buttons["Ingredients"].isHittable, "ingredients bar scrolled off with the list")
		snap("pinned")
	}

	/// Row 26, the pinned bar's extent. The bar pins only while the
	/// ingredient list is on screen, so by the last step it has scrolled off.
	/// Expanding from the bar still brings the list into view.
	func testRow26IngredientsBarExtent() {
		launch()
		openRecipe("Sunday ragù")
		let bar = app.buttons["Ingredients"]
		let lastStep = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Shred the beef'")).firstMatch
		for _ in 0..<8 where !lastStep.isHittable { app.swipeUp() }
		XCTAssertTrue(lastStep.isHittable, "last step rendered")
		XCTAssertFalse(bar.isHittable, "ingredients bar scrolled off with the list")
		snap("bar-gone")
		for _ in 0..<8 where !bar.isHittable { app.swipeDown() }
		XCTAssertTrue(bar.isHittable, "ingredients bar back")
		bar.tap()
		XCTAssertEqual(bar.value as? String, "collapsed")
		XCTAssertFalse(app.buttons["2 onions, finely diced"].exists, "list collapsed")
		bar.tap()
		XCTAssertEqual(bar.value as? String, "expanded")
		XCTAssertTrue(app.buttons["2 onions, finely diced"].waitForExistence(timeout: 3), "list back after expanding")
		XCTAssertTrue(app.buttons["2 onions, finely diced"].isHittable, "expanding scrolled the list into view")
	}

	func testRow27Strike() {
		launch()
		openRecipe("Sunday ragù")
		let line = app.buttons["2 onions, finely diced"]
		if line.value as? String == "struck" { line.tap() }
		XCTAssertNotEqual(line.value as? String, "struck")
		line.tap()
		XCTAssertEqual(line.value as? String, "struck")
		snap("struck")
		app.navigationBars.buttons.element(boundBy: 0).tap()
		openRecipe("Sunday ragù")
		XCTAssertEqual(app.buttons["2 onions, finely diced"].value as? String, "struck", "strike kept after reopening")
		app.buttons["2 onions, finely diced"].tap()
	}

	func testRow24Units() {
		launch()
		openRecipe("Sunday ragù")
		let picker = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Units'")).firstMatch
		if !picker.label.contains("Metric") {
			picker.tap()
			app.buttons["Metric · as written"].tap()
		}
		XCTAssertTrue(picker.label.contains("Metric · as written"), picker.label)
		XCTAssertTrue(app.buttons["60 ml olive oil"].exists)
		picker.tap()
		app.buttons["US"].tap()
		XCTAssertTrue(app.buttons["1/4 cup olive oil"].waitForExistence(timeout: 5))
		XCTAssertFalse(app.buttons["60 ml olive oil"].exists)
		XCTAssertTrue(picker.label.hasSuffix("US"), picker.label)
		snap("units")
		picker.tap()
		XCTAssertTrue(app.buttons["Metric · as written"].waitForExistence(timeout: 5), "marker stays on the source units")
		app.buttons["Metric · as written"].tap()
		XCTAssertTrue(app.buttons["60 ml olive oil"].waitForExistence(timeout: 5))
	}

	func testRow17Stepper() {
		launch()
		openRecipe("Sunday ragù")
		let field = app.textFields["Yield count"]
		XCTAssertEqual(field.value as? String, "8")
		app.buttons["More servings"].tap()
		XCTAssertEqual(field.value as? String, "9")
		XCTAssertTrue(app.buttons["Calculate for 9"].exists)
		app.buttons["Fewer servings"].tap()
		app.buttons["Fewer servings"].tap()
		XCTAssertEqual(field.value as? String, "7")
		XCTAssertTrue(app.buttons["Calculate for 7"].exists)
		field.tap()
		field.doubleTap()
		field.typeText("0")
		XCTAssertEqual(field.value as? String, "0")
		XCTAssertFalse(app.buttons["Calculate"].isEnabled)
		snap("stepper")
	}

	func testRow15Chips() {
		launch()
		openRecipe("Sunday ragù")
		XCTAssertTrue(app.buttons["8 · original"].isSelected)
		snap("chips")
	}

	// Row 28, the screen staying awake, has no XCUITest surface: `keepsScreenAwake`
	// in Components.swift sets `isIdleTimerDisabled`, which the runner cannot read.

	func testRow29Edit() {
		launch()
		openRecipe("Sunday ragù")
		app.buttons["Edit"].tap()
		let title = app.textFields["editor.title"]
		XCTAssertTrue(title.waitForExistence(timeout: 5), "editor opened")
		XCTAssertEqual(title.value as? String, "Sunday ragù")
		snap("edit")
		app.navigationBars.buttons.element(boundBy: 0).tap()
		XCTAssertTrue(app.staticTexts["Sunday ragù"].waitForExistence(timeout: 5))
	}
}
