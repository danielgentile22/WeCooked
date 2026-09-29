import XCTest

/// Trash. Each test is run alone by `run-unit7.sh`, after
/// `server/scripts/unit7-prep.mjs` forges the Trash it starts from, so none
/// depends on XCTest ordering. All are free.
///
/// The other restore error, "Variation not found in Trash.", needs an id the
/// server no longer knows, which a UI test cannot produce; TrashModelTests in
/// the package proves it.
@MainActor
final class Unit7Tests: PortUITest {
	override var unit: String { "unit7" }

	private let lemony = "Lemony White Beans on Toast"
	private let shakshukaSix = "Shakshuka · 6 servings"
	private let clashId = "01UNIT7CLASH00000000000000"

	private func wait(_ element: XCUIElement, until format: String, _ args: Any..., timeout: TimeInterval = 10) -> Bool {
		let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: format, argumentArray: args), object: element)
		return XCTWaiter().wait(for: [expectation], timeout: timeout) == .completed
	}

	/// Snaps whatever the wait ended on, then asserts, so a failure keeps its screenshot.
	private func expect(_ ok: Bool, _ message: String, snapshot: String, file: StaticString = #filePath, line: UInt = #line) {
		snap(snapshot)
		XCTAssertTrue(ok, message, file: file, line: line)
	}

	private func header(_ text: String) -> XCUIElement { app.collectionViews.staticTexts[text] }
	private func row(_ id: String) -> XCUIElement { el("trash-row-\(id)") }
	private func restore(_ id: String) -> XCUIElement { el("trash-restore-\(id)") }

	private func openTrash() {
		launch()
		reveal(app.buttons["Trash"]).tap()
		expect(app.navigationBars["Trash"].waitForExistence(timeout: 10), "Trash opens", snapshot: "opened")
	}

	private func backToBrowse() {
		app.navigationBars["Trash"].buttons.element(boundBy: 0).tap()
		XCTAssertTrue(app.navigationBars["Recipes"].waitForExistence(timeout: 5), "back on Browse")
	}

	private func assertRow(_ id: String, startsWith title: String, file: StaticString = #filePath, line: UInt = #line) {
		let label = reveal(row(id), file: file, line: line).label
		XCTAssertTrue(label.hasPrefix(title), "row \(id) reads \(label)", file: file, line: line)
		XCTAssertTrue(label.contains(", deleted "), "row \(id) has its date: \(label)", file: file, line: line)
	}

	private func trash(_ phone: Phone) -> (recipes: [[String: Any]], variations: [[String: Any]]) {
		let trash = phone.call("GET", "trash")["trash"] as? [String: Any] ?? [:]
		return (trash["recipes"] as? [[String: Any]] ?? [], trash["variations"] as? [[String: Any]] ?? [])
	}

	private func ids(_ rows: [[String: Any]], title: String, yield count: Double? = nil) -> [String] {
		rows.filter { $0["title"] as? String == title && (count == nil || $0["yield_count"] as? Double == count) }
			.compactMap { $0["id"] as? String }
	}

	func testRow65TwoGroupsAndRows() {
		let (recipes, variations) = trash(phoneB())
		let lemonyIds = ids(recipes, title: lemony)
		let sixes = ids(variations, title: "Shakshuka", yield: 6)
		let thirteens = ids(variations, title: "Buttermilk pancakes", yield: 13)
		XCTAssertEqual(lemonyIds.count, 1, "the prep trashed \(lemony)")
		XCTAssertEqual(sixes.count, 3, "the prep trashed three Shakshuka 6s")
		XCTAssertEqual(thirteens.count, 1, "the prep trashed one pancakes 13")
		openTrash()

		XCTAssertTrue(header("Recipes").exists, "Recipes header")
		for id in lemonyIds { assertRow(id, startsWith: lemony) }
		reveal(header("Variations"))
		for id in sixes { assertRow(id, startsWith: shakshukaSix) }
		for id in thirteens { assertRow(id, startsWith: "Buttermilk pancakes · 13 pancakes") }
		snap("rows")

		for id in (recipes + variations).compactMap({ $0["id"] as? String }).reversed() {
			reveal(row(id), down: false)
			XCTAssertEqual(restore(id).label, "Restore", "row \(id) has a Restore button")
		}
	}

	func testRow66RestoreRecipeShowsRestored() {
		let id = ids(trash(phoneB()).recipes, title: lemony).first ?? ""
		openTrash()

		reveal(restore(id)).tap()
		expect(wait(el("trash-notice"), until: "label == %@", "Restored."), "the notice reads Restored.", snapshot: "restored")
		XCTAssertTrue(wait(row(id), until: "exists == false"), "the row leaves Trash")

		backToBrowse()
		let browsed = rows(lemony).firstMatch
		XCTAssertTrue(browsed.waitForExistence(timeout: 10), "\(lemony) is back in Browse")
		reveal(browsed, down: false)
		snap("browse-after-restore")
	}

	func testRow66RestoreVariationDisplaces() {
		let phone = phoneB()
		let restored = ids(trash(phone).variations, title: "Shakshuka", yield: 6).first ?? ""
		openTrash()

		reveal(restore(restored)).tap()
		let displacedText = "Restored your version; the variation that held the same yield is in Trash."
		expect(wait(el("trash-notice"), until: "label == %@", displacedText), "the notice says what was displaced", snapshot: "displaced")
		XCTAssertTrue(wait(row(restored), until: "exists == false"), "the restored row leaves Trash")

		let sixes = ids(trash(phone).variations, title: "Shakshuka", yield: 6)
		XCTAssertEqual(sixes.count, 3, "the displaced 6 took the restored one's place")
		reveal(header("Variations"), down: false)
		for id in sixes { assertRow(id, startsWith: shakshukaSix) }

		backToBrowse()
		openRecipe("Shakshuka")
		XCTAssertTrue(app.buttons["6"].waitForExistence(timeout: 10), "the 6 chip shows")
		XCTAssertEqual(app.buttons.matching(NSPredicate(format: "label == '6'")).count, 1, "exactly one live 6")
	}

	func testRow67RestoreErrorShown() {
		openTrash()
		assertRow(clashId, startsWith: "Shakshuka · 2 servings")

		reveal(restore(clashId)).tap()
		let message = "The original now uses this yield and cannot be displaced."
		expect(wait(el("trash-error"), until: "label == %@", message), "the server's error shows", snapshot: "restore-error")
		XCTAssertTrue(row(clashId).exists, "the row stays in Trash")
	}
}
