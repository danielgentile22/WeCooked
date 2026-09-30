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

	/// A tap during the tab bar's launch animation can be lost, so the tap
	/// repeats until the tab reports itself selected.
	func tab(_ name: String) {
		let button = app.tabBars.buttons[name]
		for _ in 0..<3 where !button.isSelected {
			button.tap()
			_ = button.wait(for: \.isSelected, toEqual: true, timeout: 3)
		}
		XCTAssertTrue(button.isSelected, "on the \(name) tab")
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

	/// The other phone: this test process talking to the server directly.
	func phoneB() -> Phone {
		var phone = Phone(base: URL(string: "http://localhost:5173/api/v1")!)
		phone.token = phone.call("POST", "login", ["password": "wecooked"])["token"] as? String ?? ""
		XCTAssertFalse(phone.token.isEmpty, "login token")
		return phone
	}
}

@MainActor
struct Phone {
	let base: URL
	var token = ""

	func call(_ method: String, _ path: String, _ body: [String: Any]? = nil) -> [String: Any] {
		var request = URLRequest(url: base.appendingPathComponent(path))
		request.httpMethod = method
		if !token.isEmpty { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
		if let body {
			request.setValue("application/json", forHTTPHeaderField: "Content-Type")
			request.httpBody = try? JSONSerialization.data(withJSONObject: body)
		}
		let reply = Reply()
		let done = XCTestExpectation(description: "\(method) \(path)")
		URLSession.shared.dataTask(with: request) { data, response, _ in
			reply.status = (response as? HTTPURLResponse)?.statusCode ?? 0
			reply.json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
			done.fulfill()
		}.resume()
		XCTAssertEqual(XCTWaiter().wait(for: [done], timeout: 10), .completed, "\(method) \(path) answered")
		XCTAssertEqual(reply.status, 200, "\(method) \(path)")
		return reply.json
	}
}

private final class Reply: @unchecked Sendable {
	var status = 0
	var json: [String: Any] = [:]
}
