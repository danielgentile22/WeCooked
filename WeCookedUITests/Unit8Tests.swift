import XCTest

/// The shell: three tabs, light and dark, words not colour. Free, and needs no
/// prep: every test leaves the server as it found it. The dark test runs only
/// when `make ios-ui-test-unit8` has switched the simulator to dark and says so
/// in `WC_APPEARANCE`: iOS ignores `-AppleInterfaceStyle`, so the phone's own
/// setting is the only honest lever.
@MainActor
final class Unit8Tests: PortUITest {
	override var unit: String { "unit8" }

	private func wait(_ element: XCUIElement, until format: String, timeout: TimeInterval = 10) -> Bool {
		let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: format), object: element)
		return XCTWaiter().wait(for: [expectation], timeout: timeout) == .completed
	}

	/// The status bar strip is the app's own background, so its first pixel
	/// says which appearance the app drew in.
	private func drewDark() -> Bool {
		guard let image = app.screenshot().image.cgImage,
			let corner = image.cropping(to: CGRect(x: 2, y: 2, width: 1, height: 1))
		else { return false }
		var pixel = [UInt8](repeating: 0, count: 4)
		let context = CGContext(
			data: &pixel, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
			space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
		context?.draw(corner, in: CGRect(x: 0, y: 0, width: 1, height: 1))
		return (Int(pixel[0]) + Int(pixel[1]) + Int(pixel[2])) / 3 < 128
	}

	private var simulatorIsDark: Bool { ProcessInfo.processInfo.environment["WC_APPEARANCE"] == "dark" }

	private func back(from title: String) {
		app.navigationBars[title].buttons.element(boundBy: 0).tap()
	}

	func testRow68ThreeTabs() {
		launch()
		let labels = app.tabBars.buttons.allElementsBoundByIndex.map(\.label)
		XCTAssertEqual(labels, ["Recipes", "Add", "Shopping"])
		snap("tabs")
	}

	/// Every screen in one appearance. Each step asserts its screen before the
	/// snap, so a screen that fails to open fails here, not in the screenshot.
	private func walk(_ look: String) {
		XCTAssertTrue(app.navigationBars["Recipes"].waitForExistence(timeout: 10), "Browse")
		XCTAssertTrue(rows("Shakshuka").firstMatch.waitForExistence(timeout: 10), "Browse has rows")
		XCTAssertEqual(drewDark(), look == "dark", "the app follows the phone into \(look)")
		snap("\(look)-browse")

		openRecipe("Shakshuka")
		XCTAssertTrue(app.buttons["Edit"].waitForExistence(timeout: 10), "recipe toolbar")
		snap("\(look)-recipe")

		app.buttons["Edit"].tap()
		XCTAssertTrue(app.navigationBars["Edit recipe"].waitForExistence(timeout: 10), "editor")
		XCTAssertTrue(el("editor.title").waitForExistence(timeout: 10), "editor fields")
		snap("\(look)-editor")
		back(from: "Edit recipe")
		XCTAssertTrue(app.buttons["Edit"].waitForExistence(timeout: 5), "back on the recipe")
		app.navigationBars.firstMatch.buttons.element(boundBy: 0).tap()
		XCTAssertTrue(app.navigationBars["Recipes"].waitForExistence(timeout: 5), "back on Browse")

		tab("Add")
		XCTAssertTrue(app.navigationBars["Add a recipe"].waitForExistence(timeout: 10), "Add tab")
		snap("\(look)-add")

		tab("Shopping")
		XCTAssertTrue(app.navigationBars["Shopping"].waitForExistence(timeout: 10), "Shopping tab")
		XCTAssertTrue(app.staticTexts["Pick recipes to build a list."].waitForExistence(timeout: 10) || el("shopping-header").exists, "Shopping loaded")
		snap("\(look)-shopping")

		tab("Recipes")
		reveal(app.buttons["Trash"]).tap()
		XCTAssertTrue(app.navigationBars["Trash"].waitForExistence(timeout: 10), "Trash")
		XCTAssertTrue(app.collectionViews.staticTexts["Variations"].waitForExistence(timeout: 10), "Trash loaded")
		snap("\(look)-trash")
		back(from: "Trash")
		XCTAssertTrue(app.navigationBars["Recipes"].waitForExistence(timeout: 5), "back on Browse")

		app.buttons["Filters"].tap()
		XCTAssertTrue(app.navigationBars["Filters"].waitForExistence(timeout: 10), "filter sheet")
		let quick = app.buttons["Quick"]
		XCTAssertTrue(quick.waitForExistence(timeout: 10), "vocabulary loaded")
		quick.tap()
		XCTAssertTrue(wait(quick, until: "isSelected == true"), "Quick selected")
		snap("\(look)-filters")
	}

	func testRow69Light() throws {
		try XCTSkipIf(simulatorIsDark, "the simulator is dark")
		launch()
		walk("light")
	}

	func testRow69Dark() throws {
		try XCTSkipUnless(simulatorIsDark, "needs the simulator in dark: make ios-ui-test-unit8")
		launch()
		walk("dark")
	}

	func testRow70ChipsAndTicksCarryWords() {
		launch()
		app.buttons["Filters"].tap()
		let chip = app.buttons["Tidy"]
		XCTAssertTrue(chip.waitForExistence(timeout: 10), "vocabulary loaded")
		XCTAssertFalse(chip.isSelected, "starts unselected")
		chip.tap()
		XCTAssertTrue(wait(chip, until: "isSelected == true"), "the selected trait, not just a fill")
		XCTAssertEqual(chip.label, "Tidy", "the chip still carries its word")
		reveal(chip)
		snap("chip-selected")
		app.buttons["Done"].tap()

		tab("Shopping")
		let empty = app.staticTexts["Pick recipes to build a list."]
		let unticked = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'item-' AND value == 'unticked'"))
		let header = el("shopping-header")
		let deadline = Date().addingTimeInterval(10)
		while !empty.exists && !header.exists && Date() < deadline { _ = header.waitForExistence(timeout: 0.5) }
		let loaded = empty.exists || header.exists
		XCTAssertTrue(loaded, "Shopping loaded")
		guard unticked.count > 0 else {
			XCTAssertTrue(empty.exists, "no unticked item, so the list is empty and says so")
			snap("shopping-empty")
			return
		}
		let row = el(unticked.firstMatch.identifier)
		reveal(row).tap()
		XCTAssertTrue(wait(row, until: "value == 'ticked'", timeout: 3), "ticked reads as a word")
		snap("tick")
		row.tap()
		XCTAssertTrue(wait(row, until: "value == 'unticked'", timeout: 3), "ticked back as found")
	}
}
