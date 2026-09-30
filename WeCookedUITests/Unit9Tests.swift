import XCTest

/// Recipe generation. Each test is run alone by `run-unit9.sh`, after
/// `server/scripts/unit9-prep.mjs choosing` seeds a done, unpicked generation
/// under a fixed id, so none depends on XCTest ordering. All are free: the
/// Generate button is never tapped, since that spends a Claude call.
@MainActor
final class Unit9Tests: PortUITest {
	override var unit: String { "unit9" }

	private let choosingId = "01UNIT9CHOOSING000000000000"
	private let request = "the chicken thighs and half a cabbage, under 40 minutes"

	private func wait(_ element: XCUIElement, until format: String, _ args: Any..., timeout: TimeInterval = 10) -> Bool {
		let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: format, argumentArray: args), object: element)
		return XCTWaiter().wait(for: [expectation], timeout: timeout) == .completed
	}

	/// The seeded candidates' titles, in deck order, read from the server so
	/// the test follows `server/fixtures/candidates.json` without a copy.
	private func candidateTitles() -> [String] {
		let candidates = phoneB().call("GET", "drafts/\(choosingId)")["candidates"] as? [[String: Any]] ?? []
		let titles = candidates.compactMap { $0["title"] as? String }
		XCTAssertEqual(titles.count, 3, "the prep seeded three candidates")
		return titles
	}

	private func openDeck() {
		launch()
		let card = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", request)).firstMatch
		XCTAssertTrue(card.waitForExistence(timeout: 10), "the generation card is on Browse")
		reveal(card).tap()
		XCTAssertTrue(el("deck.title.0").waitForExistence(timeout: 10), "the deck opens on the first card")
	}

	private func assertTitle(_ index: Int, is title: String, file: StaticString = #filePath, line: UInt = #line) {
		XCTAssertTrue(wait(el("deck.title.\(index)"), until: "exists == true"), "card \(index) is on screen", file: file, line: line)
		XCTAssertEqual(el("deck.title.\(index)").label, title, "card \(index) title", file: file, line: line)
	}

	func testRowDeckRendersThreeCards() {
		let titles = candidateTitles()
		openDeck()

		assertTitle(0, is: titles[0])
		el("deck.card.0").swipeLeft()
		assertTitle(1, is: titles[1])
		el("deck.card.1").swipeLeft()
		assertTitle(2, is: titles[2])
		el("deck.card.2").swipeRight()
		assertTitle(1, is: titles[1])
		snap("deck")
	}

	func testPickLandsOnTheReviewForm() {
		let titles = candidateTitles()
		openDeck()

		el("deck.card.0").swipeLeft()
		assertTitle(1, is: titles[1])
		el("deck.pick.1").tap()
		XCTAssertTrue(el("editor.title").waitForExistence(timeout: 15), "the review form opens")
		XCTAssertEqual(text("editor.title"), titles[1], "seeded from the picked candidate")
		snap("picked")
	}

	func testGenerateScreen() {
		launch()
		tab("Add")
		reveal(el("add.generate")).tap()
		XCTAssertTrue(el("generate.description").waitForExistence(timeout: 10), "the generate screen opens")
		XCTAssertEqual(el("generate.yield.count").value as? String, "4", "the default yield")
		el("generate.yield.plus").tap()
		XCTAssertEqual(el("generate.yield.count").value as? String, "5", "plus adds one")
		XCTAssertTrue(el("generate.start").exists, "Generate is there and stays untapped")
		snap("generate")
	}
}
