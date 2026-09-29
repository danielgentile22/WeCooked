import XCTest

/// The shopping tab. Each test is run alone by `run-unit6.sh`, after
/// `server/scripts/unit6-prep.mjs` forges the list it starts from, so none
/// depends on XCTest ordering. The `Gated` tests spend Claude calls and skip
/// unless `WC_CLAUDE=1`; the rest are free.
@MainActor
final class Unit6Tests: PortUITest {
	override var unit: String { "unit6" }

	private let apiError = "Claude is unavailable right now. Try again in a minute."
	private let jobTimeout: TimeInterval = 240
	private let forgedHeader = "2 of 10 ticked · ticks sync to both phones"

	// MARK: Helpers

	private func wait(_ element: XCUIElement, until format: String, _ args: Any..., timeout: TimeInterval = 10) -> Bool {
		let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: format, argumentArray: args), object: element)
		return XCTWaiter().wait(for: [expectation], timeout: timeout) == .completed
	}

	/// Snaps whatever the wait ended on, then asserts, so a failure keeps its screenshot.
	private func expect(_ ok: Bool, _ message: String, snapshot: String, file: StaticString = #filePath, line: UInt = #line) {
		snap(snapshot)
		XCTAssertTrue(ok, message, file: file, line: line)
	}

	private var header: XCUIElement { el("shopping-header") }
	private func item(_ text: String) -> XCUIElement { el("item-\(text)") }
	private func ticked(_ element: XCUIElement, timeout: TimeInterval = 10) -> Bool {
		wait(element, until: "exists == true AND value == 'ticked'", timeout: timeout)
	}

	private func openShopping(header expected: String? = nil) {
		launch()
		tab("Shopping")
		guard let expected else { return }
		expect(wait(header, until: "label == %@", expected), "header reads \(expected)", snapshot: "opened")
	}

	private func confirm(_ label: String, openedBy opener: XCUIElement, title: String, snapshot: String) {
		opener.tap()
		let asked = app.staticTexts[title].waitForExistence(timeout: 5)
		expect(asked, "asks: \(title)", snapshot: snapshot)
		app.buttons[label].tap()
	}

	private func assertOrder(_ labels: [String], file: StaticString = #filePath, line: UInt = #line) {
		for (above, below) in zip(labels, labels.dropFirst()) {
			let a = app.staticTexts[above]
			let b = reveal(app.staticTexts[below], file: file, line: line)
			if a.exists {
				XCTAssertLessThan(a.frame.minY, b.frame.minY, "\(above) above \(below)", file: file, line: line)
			}
		}
	}

	// MARK: Free

	func testRows54To56ListSectionsAndHeader() {
		openShopping(header: forgedHeader)
		assertOrder(["Produce", "Meat and fish", "Dairy", "Dry goods", "Spices", "Other"])

		let harissa = reveal(item("1 jar harissa"))
		let kitchenRoll = reveal(item("kitchen roll"))
		XCTAssertLessThan(harissa.frame.minY, kitchenRoll.frame.minY, "generated before manual")
		XCTAssertTrue(harissa.label.contains("Shakshuka"), "source title: \(harissa.label)")
		XCTAssertTrue(kitchenRoll.label.contains("added by hand"), "manual line: \(kitchenRoll.label)")

		let staples = reveal(app.buttons["Check you have (2)"])
		XCTAssertFalse(item("olive oil").exists, "staples start collapsed")
		snap("staples-collapsed")
		staples.tap()
		expect(item("olive oil").waitForExistence(timeout: 5), "staples expand on tap", snapshot: "staples-expanded")
		reveal(item("salt"))

		let metric = reveal(el("shopping-units-metric"))
		metric.tap()
		let chickpeasMetric = reveal(item("600 g tinned chickpeas"), down: false)
		XCTAssertTrue(chickpeasMetric.label.contains("about 21 oz canned chickpeas"), "other units: \(chickpeasMetric.label)")
		XCTAssertTrue(chickpeasMetric.label.contains("Chickpea and spinach curry"), "source: \(chickpeasMetric.label)")
		snap("metric")

		reveal(el("shopping-units-us")).tap()
		let chickpeasUS = reveal(item("21 oz canned chickpeas"), down: false)
		XCTAssertTrue(chickpeasUS.label.contains("about 600 g tinned chickpeas"), "follows units: \(chickpeasUS.label)")
		snap("us")
		reveal(el("shopping-units-metric")).tap()
	}

	func testRow57TickSyncsBothWays() {
		let phone = phoneB()
		openShopping(header: forgedHeader)

		let cumin = phone.id(of: "2 tsp ground cumin")
		let row = reveal(item("2 tsp ground cumin"))
		XCTAssertEqual(row.value as? String, "unticked")
		row.tap()
		expect(ticked(row, timeout: 3), "the tap shows at once", snapshot: "tick-local")
		let deadline = Date().addingTimeInterval(10)
		var landed = phone.isTicked(cumin)
		while !landed && Date() < deadline {
			Thread.sleep(forTimeInterval: 0.5)
			landed = phone.isTicked(cumin)
		}
		XCTAssertTrue(landed, "phone B sees the tick within 10 s")
		reveal(header, down: false)
		XCTAssertTrue(wait(header, until: "label BEGINSWITH '3 of 10'", timeout: 2), "header counts it: \(header.label)")

		let harissa = phone.id(of: "1 jar harissa")
		_ = phone.call("PATCH", "shopping/items/\(harissa)", ["ticked": true])
		let other = reveal(item("1 jar harissa"))
		expect(ticked(other, timeout: 10), "phone B's tick shows within 10 s", snapshot: "tick-remote")
	}

	func testRow58PickMode() {
		let phone = phoneB()
		openShopping(header: forgedHeader)
		reveal(el("shopping-pick")).tap()

		let build = el("pick-build")
		expect(build.waitForExistence(timeout: 5), "the sheet opens", snapshot: "pick-open")
		XCTAssertEqual(el("pick-row-Shakshuka").value as? String, "picked")
		XCTAssertEqual(el("pick-row-Chickpea and spinach curry").value as? String, "picked")
		XCTAssertEqual(el("pick-row-Buttermilk pancakes").value as? String, "not picked")
		XCTAssertEqual(el("pick-yield-Shakshuka").label, "4 servings")
		XCTAssertEqual(el("pick-yield-Chickpea and spinach curry").label, "6 servings")
		XCTAssertEqual(build.label, "Build list from 2 recipes")
		XCTAssertEqual(el("pick-cancel").label, "Cancel, keep current list")

		for expected in ["3", "2", "1", "1"] {
			el("pick-minus-Shakshuka").tap()
			XCTAssertEqual(el("pick-yield-Shakshuka").label, "\(expected) servings")
		}
		el("pick-plus-Shakshuka").tap()
		XCTAssertEqual(el("pick-yield-Shakshuka").label, "2 servings", "whole steps up from 1")
		snap("pick-stepped")

		el("pick-row-Shakshuka").tap()
		XCTAssertFalse(el("pick-plus-Shakshuka").exists, "no stepper on an unpicked recipe")
		XCTAssertEqual(build.label, "Build list from 1 recipe")
		el("pick-row-Chickpea and spinach curry").tap()
		XCTAssertEqual(build.label, "Pick at least one recipe")
		XCTAssertFalse(build.isEnabled, "nothing picked, nothing to build")
		snap("pick-none")

		el("pick-cancel").tap()
		expect(wait(build, until: "exists == false", timeout: 5), "cancel closes the sheet", snapshot: "pick-cancelled")
		XCTAssertEqual(reveal(header, down: false).label, forgedHeader)
		let buildState = phone.list["build"] as? [String: Any]
		XCTAssertEqual(buildState?["status"] as? String, "done", "nothing was built")
	}

	func testRow59BuildingBannerAndSkeletons() {
		openShopping(header: "Building…")
		let banner = el("shopping-build-banner")
		expect(banner.waitForExistence(timeout: 10), "the building banner shows", snapshot: "building")
		XCTAssertTrue(app.staticTexts["Building your list. You can lock your phone; the build carries on."].exists)
		XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "shopping-skeleton").count, 5, "five skeleton rows")
	}

	func testRow60RebuildNoticeShownOnce() {
		let notice = app.staticTexts["2 ticks kept. 2 reset because the line changed: 2 onions, olive oil."]
		openShopping(header: forgedHeader)
		expect(notice.waitForExistence(timeout: 10), "the rebuild notice shows", snapshot: "notice")

		app.terminate()
		openShopping(header: forgedHeader)
		expect(!notice.exists, "the notice shows once per build", snapshot: "notice-gone")
	}

	func testRow61FailedBuildShowsRetry() {
		openShopping()
		let error = app.staticTexts[apiError]
		expect(error.waitForExistence(timeout: 10), "the failed build shows its error", snapshot: "build-failed")
		XCTAssertTrue(app.buttons["Tap to retry"].exists, "with a retry")
	}

	func testRow62AddManualLine() {
		openShopping(header: forgedHeader)
		type("bin bags", into: el("shopping-add-field"))
		el("shopping-add").tap()
		let added = item("bin bags")
		expect(added.waitForExistence(timeout: 10), "the manual line appears", snapshot: "manual-added")
		XCTAssertTrue(added.label.contains("added by hand"), added.label)
		XCTAssertEqual(text("shopping-add-field"), "", "the field clears")
		reveal(header, down: false)
		XCTAssertTrue(wait(header, until: "label BEGINSWITH '2 of 11 ticked'"), "count went up: \(header.label)")
		let other = reveal(app.staticTexts["Other"])
		let kitchenRoll = reveal(item("kitchen roll"))
		reveal(added)
		XCTAssertLessThan(other.frame.minY, added.frame.minY, "under Other")
		XCTAssertLessThan(kitchenRoll.frame.minY, added.frame.minY, "after the older manual line")
	}

	func testRow63DoneShoppingAsksThenClears() {
		openShopping(header: forgedHeader)
		confirm(
			"Clear list", openedBy: reveal(el("shopping-done")),
			title: "Clear 10 items and all ticks on both phones? The list cannot be brought back.",
			snapshot: "done-confirm")
		let empty = app.staticTexts["Pick recipes to build a list."]
		expect(empty.waitForExistence(timeout: 10), "the list is cleared", snapshot: "done-cleared")
		XCTAssertTrue(app.buttons["Add recipes"].exists)
	}

	func testRow64EmptyState() {
		openShopping()
		let empty = app.staticTexts["Pick recipes to build a list."]
		expect(empty.waitForExistence(timeout: 10), "the empty state shows", snapshot: "empty")
		XCTAssertTrue(app.buttons["Add recipes"].exists)
		XCTAssertFalse(header.exists, "no count without a list")
	}

	// MARK: Gated (each spends Claude calls)

	private func requireClaude() throws {
		try XCTSkipUnless(ProcessInfo.processInfo.environment["WC_CLAUDE"] == "1", "set TEST_RUNNER_WC_CLAUDE=1 to spend Claude calls")
	}

	private func buildFromSheet(_ step: (() -> Void)? = nil, snapshot: String) {
		let build = el("pick-build")
		XCTAssertTrue(build.waitForExistence(timeout: 5), "the sheet opens")
		step?()
		build.tap()
		let banner = el("shopping-build-banner")
		expect(banner.waitForExistence(timeout: 10), "the building banner shows", snapshot: snapshot)
		XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "shopping-skeleton").count, 5)
	}

	private func waitForList(snapshot: String) {
		let done = wait(header, until: "label ENDSWITH 'ticks sync to both phones'", timeout: jobTimeout)
		expect(done, "the list replaces the banner", snapshot: snapshot)
	}

	func testRow59BuildCompletes() throws {
		try requireClaude()
		openShopping()
		el("shopping-pick").tap()
		buildFromSheet({ self.el("pick-row-Shakshuka").tap() }, snapshot: "build-started")
		waitForList(snapshot: "build-done")
		XCTAssertGreaterThan(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'item-'")).count, 0)
	}

	func testRow60RebuildKeepsAndResets() throws {
		try requireClaude()
		openShopping()
		el("shopping-pick").tap()
		buildFromSheet({ self.el("pick-row-Shakshuka").tap() }, snapshot: "rebuild-first")
		waitForList(snapshot: "rebuild-first-done")

		let rows = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'item-'"))
		for i in 0..<2 {
			rows.element(boundBy: i).tap()
			XCTAssertTrue(ticked(rows.element(boundBy: i), timeout: 2))
		}
		XCTAssertTrue(wait(header, until: "label BEGINSWITH '2 of'"))

		reveal(el("shopping-pick")).tap()
		buildFromSheet({ self.el("pick-plus-Shakshuka").tap() }, snapshot: "rebuild-second")
		let notice = app.staticTexts.matching(
			NSPredicate(format: "label MATCHES %@", "\\d+ ticks? kept\\. \\d+ reset because the line changed: .+\\.")
		).firstMatch
		expect(notice.waitForExistence(timeout: jobTimeout), "the notice reports kept and reset", snapshot: "rebuild-notice")
	}

	func testRow61RetryAfterFailure() throws {
		try requireClaude()
		openShopping()
		let retry = app.buttons["Tap to retry"]
		XCTAssertTrue(retry.waitForExistence(timeout: 10))
		retry.tap()
		expect(el("shopping-build-banner").waitForExistence(timeout: 10), "retry shows the building banner", snapshot: "retry-building")
		waitForList(snapshot: "retry-done")
	}
}

private extension Phone {
	var list: [String: Any] { call("GET", "shopping")["list"] as? [String: Any] ?? [:] }
	var items: [[String: Any]] { list["items"] as? [[String: Any]] ?? [] }

	func id(of text: String) -> String {
		let id = items.first { $0["text_metric"] as? String == text }?["id"] as? String
		XCTAssertNotNil(id, "server has \(text)")
		return id ?? ""
	}

	func isTicked(_ id: String) -> Bool {
		items.first { $0["id"] as? String == id }?["ticked"] as? Bool ?? false
	}
}
