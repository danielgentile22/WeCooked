import XCTest

/// Shared driver for the per-unit UI tests. Each unit subclasses it and names
/// its screenshots with `unit`.
@MainActor
class PortUITest: XCTestCase {
	let app = XCUIApplication()
	var unit: String { "unit" }

	func launch(_ extra: [String] = []) {
		continueAfterFailure = false
		app.launchArguments = ["-wc-password", "wecooked", "-wc-autologin", "YES"] + extra
		app.launch()
		XCTAssertTrue(app.tabBars.buttons["Recipes"].waitForExistence(timeout: 15), "signed in")
	}

	func snap(_ name: String) {
		let png = app.screenshot().pngRepresentation
		let attachment = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
		attachment.name = "\(unit)-\(name)"
		attachment.lifetime = .keepAlways
		add(attachment)
		guard let dir = ProcessInfo.processInfo.environment["WC_SCREENSHOT_DIR"] else { return }
		XCTAssertNoThrow(try png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(unit)-\(name).png")))
	}

	func el(_ id: String) -> XCUIElement {
		app.descendants(matching: .any).matching(identifier: id).firstMatch
	}

	/// An empty field reports its placeholder as its value.
	func text(_ id: String) -> String {
		let field = el(id)
		let value = field.value as? String ?? ""
		return value == field.placeholderValue ? "" : value
	}

	func tab(_ name: String) {
		app.tabBars.buttons[name].tap()
	}

	func rows(_ title: String) -> XCUIElementQuery {
		app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", title))
	}

	func openRecipe(_ title: String) {
		rows(title).firstMatch.tap()
		XCTAssertTrue(app.staticTexts[title].waitForExistence(timeout: 10), "\(title) opened")
	}

	/// The editor is a lazy Form: rows off screen do not exist until scrolled
	/// to. Swipes go in the upper half so they miss the keyboard.
	@discardableResult
	func reveal(_ element: XCUIElement, down: Bool = true, file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
		let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: down ? 0.45 : 0.2))
		let to = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: down ? 0.2 : 0.45))
		for _ in 0..<25 where !(element.exists && element.isHittable) {
			from.press(forDuration: 0.05, thenDragTo: to)
		}
		XCTAssertTrue(element.isHittable, "revealed \(element)", file: file, line: line)
		return element
	}

	/// The system photo picker runs out of process; its grid cells carry this
	/// identifier. The simulator's library ships with six photos.
	func pickPhotos(_ count: Int) {
		let grid = app.images.matching(identifier: "PXGGridLayout-Info")
		XCTAssertTrue(grid.firstMatch.waitForExistence(timeout: 10), "photo picker open")
		for i in 0..<count { grid.element(boundBy: i).tap() }
		app.buttons["Done"].tap()
	}

	func type(_ text: String, into element: XCUIElement) {
		reveal(element).tap()
		element.typeText(text)
	}
}
