import XCTest

@MainActor
final class Unit4Tests: PortUITest {
	override var unit: String { "unit4" }

	private func openBlankEditor() {
		tab("Add")
		el("add.typeIt").tap()
		XCTAssertTrue(el("editor.title").waitForExistence(timeout: 5), "blank editor opened")
		startOver()
	}

	/// The manual editor restores its autosave across launches by design, so a
	/// test that wants a blank form clears any leftover from an earlier run.
	private func startOver() {
		reveal(el("editor.startOver")).tap()
		el("editor.startOver").tap()
		reveal(el("editor.title"), down: false)
		XCTAssertEqual(text("editor.title"), "", "start over cleared the form")
	}

	private func save() {
		el("editor.save").tap()
	}

	func testRow31EmptyPaste() {
		launch()
		tab("Add")
		el("add.extract").tap()
		XCTAssertTrue(app.staticTexts["Paste some recipe text first."].waitForExistence(timeout: 5))
		snap("empty-paste")
	}

	func testRows34And43To48And53TypeItIn() {
		launch()
		openBlankEditor()
		XCTAssertEqual(el("editor.yield.count").value as? String, "4", "yield defaults to 4")
		XCTAssertEqual(el("editor.yield.unit").value as? String, "servings")
		XCTAssertTrue(app.buttons["Metric"].isSelected, "metric by default")
		snap("blank")

		save()
		XCTAssertTrue(app.staticTexts["Title is required."].waitForExistence(timeout: 5), "title issue")
		snap("issues")

		let title = "UI test red lentil soup"
		type(title, into: el("editor.title"))
		type("200 g red lentils", into: el("editor.ingredient.0.0"))
		reveal(el("editor.ingredient.add.0")).tap()
		el("editor.ingredient.0.1").typeText("1 onion")
		reveal(el("editor.ingredient.0.1.up")).tap()
		XCTAssertEqual(text("editor.ingredient.0.0"), "1 onion", "line moved up")
		type("Simmer until soft.", into: el("editor.step.0"))
		reveal(el("editor.step.add")).tap()
		el("editor.step.1").typeText("Blend.")
		reveal(el("editor.step.1.remove")).tap()
		XCTAssertFalse(el("editor.step.1").exists, "step removed")
		reveal(el("editor.tag.effort.Quick")).tap()
		reveal(el("editor.tag.damage.Tidy")).tap()
		XCTAssertTrue(el("editor.tag.effort.Quick").isSelected, "chip selected")
		snap("filled")

		save()
		XCTAssertTrue(app.staticTexts[title].waitForExistence(timeout: 10), "saved recipe opened")
		XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS '1 onion'")).firstMatch.exists, "lines saved")
		snap("saved")

		app.buttons["Edit"].tap()
		reveal(el("editor.delete")).tap()
		let confirm = app.buttons.matching(NSPredicate(format: "label == 'Delete recipe' AND identifier != 'editor.delete'")).firstMatch
		XCTAssertTrue(confirm.waitForExistence(timeout: 5), "asks before deleting")
		XCTAssertTrue(app.staticTexts["Delete “\(title)”? You can restore it from Trash."].exists)
		snap("delete-confirm")
		confirm.tap()
		XCTAssertTrue(app.buttons["Trash"].waitForExistence(timeout: 10), "back on the list")
		XCTAssertTrue(rows(title).firstMatch.waitForNonExistence(timeout: 5), "deleted recipe left the list")
	}

	func testRows46And47GroupsAndSteps() {
		launch()
		openBlankEditor()
		type("pasta", into: el("editor.ingredient.0.0"))
		reveal(el("editor.group.add")).tap()
		el("editor.ingredient.1.0").typeText("tomatoes")
		type("Sauce", into: el("editor.group.1.heading"))
		reveal(el("editor.group.1.up")).tap()
		XCTAssertEqual(text("editor.group.0.heading"), "Sauce", "group moved up")
		XCTAssertEqual(text("editor.ingredient.0.0"), "tomatoes")
		snap("groups")
		reveal(el("editor.group.1.remove")).tap()
		XCTAssertFalse(el("editor.ingredient.1.0").exists, "group removed")

		type("Boil.", into: el("editor.step.0"))
		reveal(el("editor.step.add")).tap()
		el("editor.step.1").typeText("Salt the water.")
		reveal(el("editor.step.1.up")).tap()
		XCTAssertEqual(text("editor.step.0"), "Salt the water.", "step moved up")
		snap("steps")
		startOver()
	}

	func testEditedTitleShowsInTheList() {
		launch()
		openRecipe("Buttermilk pancakes")
		app.buttons["Edit"].tap()
		let suffix = " fluffy"
		let field = el("editor.title")
		XCTAssertTrue(field.waitForExistence(timeout: 5))
		field.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.5)).tap()
		field.typeText(suffix)
		save()
		XCTAssertTrue(app.staticTexts["Buttermilk pancakes\(suffix)"].waitForExistence(timeout: 10), "recipe shows the new title")
		app.navigationBars.buttons.element(boundBy: 0).tap()
		XCTAssertTrue(rows("Buttermilk pancakes\(suffix)").firstMatch.waitForExistence(timeout: 1), "list row updated at once")
		snap("list-edited")

		openRecipe("Buttermilk pancakes\(suffix)")
		app.buttons["Edit"].tap()
		XCTAssertTrue(field.waitForExistence(timeout: 5))
		field.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.5)).tap()
		field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: suffix.count))
		save()
		XCTAssertTrue(app.staticTexts["Buttermilk pancakes"].waitForExistence(timeout: 10), "title restored")
	}

	/// The editor opens in the device's units, which an earlier test may have
	/// left on either side, so this finds the tomatoes line and flips to the
	/// other system.
	func testRows44And45Units() {
		launch()
		openRecipe("Shakshuka")
		app.buttons["Edit"].tap()
		XCTAssertTrue(el("editor.title").waitForExistence(timeout: 5))
		let tomatoes = (0..<8).map { el("editor.ingredient.0.\($0)") }.first {
			reveal($0)
			let value = $0.value as? String ?? ""
			return value.contains("800 g") || value.contains("28 oz")
		}
		guard let line = tomatoes else { return XCTFail("the tomatoes line") }
		let before = line.value as? String ?? ""
		snap("units-before")
		reveal(el("editor.units"))
		let other = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", before.contains("800 g") ? "US" : "Metric")).firstMatch
		XCTAssertTrue(other.isEnabled, "the other system is enabled: a counterpart exists")
		other.tap()
		reveal(line)
		XCTAssertEqual(line.value as? String, before.contains("800 g") ? "28 oz canned whole tomatoes" : "800 g tinned whole tomatoes", "bodies swapped")
		snap("units-after")
		app.navigationBars.buttons.element(boundBy: 0).tap()
	}

	func testRow51AutosaveRestoresAcrossLaunch() {
		launch()
		openBlankEditor()
		type("Autosave check", into: el("editor.title"))
		sleep(1)
		app.terminate()
		launch()
		tab("Add")
		el("add.typeIt").tap()
		XCTAssertTrue(el("editor.title").waitForExistence(timeout: 5))
		XCTAssertEqual(text("editor.title"), "Autosave check", "restored silently")
		snap("autosave-restored")
		reveal(el("editor.startOver")).tap()
		XCTAssertTrue(app.buttons["Really start over? Tap again to discard your edits"].exists, "asks twice")
		el("editor.startOver").tap()
		reveal(el("editor.title"), down: false)
		XCTAssertEqual(text("editor.title"), "", "start over cleared it")
	}

	func testRow32AddPhotos() {
		launch()
		tab("Add")
		el("add.photos").tap()
		pickPhotos(2)
		let extract = el("add.extractPhotos")
		XCTAssertTrue(extract.waitForExistence(timeout: 15))
		XCTAssertTrue(el("add.photo.1").waitForExistence(timeout: 15), "two thumbnails")
		expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: extract)
		waitForExpectations(timeout: 30)
		XCTAssertEqual(extract.label, "Extract these 2 pages")
		snap("add-photos")
		el("add.photo.1.remove").tap()
		XCTAssertEqual(extract.label, "Extract this page")
		XCTAssertFalse(el("add.photo.1").exists, "removed")
	}

	/// Also proves the photo strip on the cooking screen (row 26) against the
	/// dev server's local image store.
	func testRow49EditorPhotos() {
		launch()
		openBlankEditor()
		reveal(el("editor.photos.add")).tap()
		pickPhotos(3)
		XCTAssertTrue(el("editor.photo.2").waitForExistence(timeout: 30), "three photos uploaded")
		XCTAssertEqual(el("editor.photo.0").label, "Cover photo", "first is the cover")
		el("editor.photo.1").tap()
		XCTAssertEqual(el("editor.photo.1").label, "Cover photo", "tap sets the cover")
		XCTAssertEqual(el("editor.photo.0").label, "Make cover photo")
		snap("editor-photos")
		el("editor.photo.1.remove").tap()
		XCTAssertFalse(el("editor.photo.2").exists, "removed")
		XCTAssertEqual(el("editor.photo.0").label, "Cover photo", "removing the cover moves it to the first")

		let title = "UI test photo salad"
		type(title, into: el("editor.title"))
		type("1 cucumber", into: el("editor.ingredient.0.0"))
		reveal(el("editor.tag.effort.Quick")).tap()
		reveal(el("editor.tag.damage.Tidy")).tap()
		save()
		XCTAssertTrue(app.staticTexts[title].waitForExistence(timeout: 10), "saved recipe opened")
		sleep(2)
		snap("recipe-photo-strip")

		app.buttons["Edit"].tap()
		reveal(el("editor.delete")).tap()
		let confirm = app.buttons.matching(NSPredicate(format: "label == 'Delete recipe' AND identifier != 'editor.delete'")).firstMatch
		XCTAssertTrue(confirm.waitForExistence(timeout: 5))
		confirm.tap()
		XCTAssertTrue(rows(title).firstMatch.waitForNonExistence(timeout: 10), "cleaned up")
	}
}
