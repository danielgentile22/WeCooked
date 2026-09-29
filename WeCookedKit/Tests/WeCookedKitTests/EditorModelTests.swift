import Foundation
import Testing

@testable import WeCookedKit

@MainActor
struct CaptureModelTests {
	static let uploadCapture = "POST /api/v1/images?role=capture"
	static let captures = "POST /api/v1/captures"

	@Test func anEmptyPasteShowsTheWebCopyAndSendsNothing() async {
		let server = FakeServer()
		let model = CaptureModel(env: RecipeModelTests.env(server))
		model.text = "  \n "
		#expect(await model.extract() == nil)
		#expect(model.error == "Paste some recipe text first.")
		#expect(server.requests.isEmpty)
	}

	@Test func pastedTextCreatesACaptureAndClearsTheBox() async {
		let server = FakeServer([Self.captures: FakeServer.fixture("captures")])
		let model = CaptureModel(env: RecipeModelTests.env(server))
		model.text = "https://www.example.com/soup"
		#expect(await model.extract() == "01TEST00000000000000000019")
		#expect(server.requests == [Self.captures])
		#expect(model.text.isEmpty)
		#expect(model.error == nil)
		#expect(!model.isSubmitting)
	}

	@Test func photosUploadOnPickCanBeRemovedAndAreSentInsteadOfText() async {
		let server = FakeServer([
			Self.uploadCapture: FakeServer.fixture("image-upload"),
			Self.captures: FakeServer.fixture("captures"),
		])
		let model = CaptureModel(env: RecipeModelTests.env(server))
		await model.add(jpeg: Data([1]))
		await model.add(jpeg: Data([2]))
		#expect(model.photos.count == 2)
		guard case .uploaded = model.photos[0].state else { Issue.record("not uploaded"); return }
		model.remove(model.photos[1].id)
		#expect(model.photos.count == 1)
		model.text = "ignored while photos are on the strip"
		#expect(await model.extract() != nil)
		#expect(server.requests == [Self.uploadCapture, Self.uploadCapture, Self.captures])
		#expect(model.photos.isEmpty)
	}

	@Test func aNinthPhotoIsRefusedWithoutAnUpload() async {
		let server = FakeServer([Self.uploadCapture: FakeServer.fixture("image-upload")])
		let model = CaptureModel(env: RecipeModelTests.env(server))
		for i in 0..<8 { await model.add(jpeg: Data([UInt8(i)])) }
		await model.add(jpeg: Data([9]))
		#expect(model.photos.count == 8)
		#expect(model.error == "At most 8 pages per recipe.")
		#expect(server.requests.count == 8)
	}

	@Test func aFailedUploadShowsTheWebCopyAndCannotBeExtracted() async {
		let server = FakeServer()
		let model = CaptureModel(env: RecipeModelTests.env(server))
		await model.add(jpeg: Data([1]))
		guard case .failed(let text) = model.photos.first?.state else { Issue.record("not failed"); return }
		#expect(text == "Could not upload a photo. Check the connection and try again.")
		#expect(await model.extract() == nil)
		#expect(model.error == "Add at least one photo first.")
		#expect(server.requests == [Self.uploadCapture])
	}
}

@MainActor
struct EditorModelTests {
	static let recipe: RecipeID = "01TEST00000000000000000003"
	static let original: VariationID = "01TEST00000000000000000004"
	static let ready: JobID = "01TEST00000000000000000021"
	static let failed: JobID = "01TEST00000000000000000018"
	static let savedRecipe: RecipeID = "01TEST00000000000000000022"
	static let recipePath = "/api/v1/recipes/01TEST00000000000000000003"

	static func lookup(_ name: String) throws -> DraftLookup {
		try Wire.makeDecoder().decode(DraftLookup.self, from: Fixtures.data(name))
	}

	static func browse() throws -> BrowseResponse {
		try Wire.makeDecoder().decode(BrowseResponse.self, from: Fixtures.data("recipes-list"))
	}

	static func env(_ server: FakeServer, cachingRecipe: Bool = true) throws -> AppEnvironment {
		let env = RecipeModelTests.env(server)
		if cachingRecipe { env.store.resource(.recipe(recipe, variation: nil)).replace(try RecipeModelTests.reply("recipe-get")) }
		env.store.resource(.recipes()).replace(try browse())
		return env
	}

	/// Runs `appear()` (which follows a draft until cancelled) until `done`
	/// holds, then cancels it and waits for it to end.
	static func appear(_ model: EditorModel, until done: () -> Bool) async {
		let task = Task { await model.appear() }
		for _ in 0..<200 where !done() { try? await Task.sleep(for: .milliseconds(10)) }
		task.cancel()
		await task.value
	}

	static func complete(_ form: inout EditorForm) {
		form.title = "Toast"
		form.effort = .allCases.first
		form.damage = .allCases.first
		form.shown.ingredients[0].items = ["1 slice bread"]
	}

	// MARK: Appear

	@Test func manualOpensBlankInTheDeviceUnitsWithTheWebDefaults() throws {
		let env = try Self.env(FakeServer())
		env.device.units = .us
		let model = EditorModel(origin: .manual, env: env)
		#expect(model.phase == .editing)
		#expect(model.form == .blank(units: .us))
		#expect(model.form.yieldCount == 4)
		#expect(model.form.yieldUnit == "servings")
		#expect(model.form.effort == nil)
		#expect(model.form.damage == nil)
	}

	@Test func manualWorkIsAutosavedAndRestoredSilently() async throws {
		let env = try Self.env(FakeServer())
		let first = EditorModel(origin: .manual, env: env)
		first.form.title = "Half typed"
		await first.autosaveSettled()
		let again = EditorModel(origin: .manual, env: env)
		#expect(again.form.title == "Half typed")
		#expect(!again.recipeChanged)
	}

	@Test func anUntouchedEditorLeavesNoAutosave() async throws {
		let env = try Self.env(FakeServer())
		let model = EditorModel(origin: .manual, env: env)
		model.form.title = "x"
		model.form.title = ""
		await model.autosaveSettled()
		#expect(env.device.editorDraft(.manual) == nil)
	}

	@Test func aRecipeSeedsFromTheCacheInItsFirstFrame() throws {
		let server = FakeServer()
		let model = EditorModel(origin: .recipe(Self.recipe, nil), env: try Self.env(server))
		#expect(model.phase == .editing)
		#expect(model.form == (try EditorPayloadTests.loadedForm()))
		#expect(server.requests.isEmpty)
	}

	@Test func anUncachedRecipeIsFetchedOnAppear() async throws {
		let server = FakeServer(["GET \(Self.recipePath)": FakeServer.fixture("recipe-get")])
		let model = EditorModel(origin: .recipe(Self.recipe, nil), env: try Self.env(server, cachingRecipe: false))
		await model.appear()
		#expect(model.form.title == (try EditorPayloadTests.loadedForm()).title)
		#expect(model.issues.isEmpty)
	}

	@Test func aRestoredAutosaveOnAnUnchangedRecipeHasNoBanner() throws {
		let env = try Self.env(FakeServer())
		var saved = try EditorPayloadTests.loadedForm()
		saved.title = "Renamed while away"
		env.device.saveEditorDraft(saved, for: .recipe(Self.original))
		let model = EditorModel(origin: .recipe(Self.recipe, nil), env: env)
		#expect(model.form.title == "Renamed while away")
		#expect(!model.recipeChanged)
	}

	@Test func aRestoredAutosaveOnAChangedRecipeShowsTheBannerAndStartOverReseeds() async throws {
		let env = try Self.env(FakeServer())
		var saved = try EditorPayloadTests.loadedForm()
		saved.title = "Renamed while away"
		env.device.saveEditorDraft(saved, for: .recipe(Self.original))
		env.store.resource(.recipe(Self.recipe, variation: nil)).mutate {
			$0.recipe.ingredients[0].items[0] = "2 onions, finely diced"
			$0.recipe.bodies.metric = BodyText(ingredients: $0.recipe.ingredients, steps: $0.recipe.steps)
		}
		let model = EditorModel(origin: .recipe(Self.recipe, nil), env: env)
		#expect(model.recipeChanged)
		#expect(model.form.title == "Renamed while away")
		guard case .ready(let input) = model.form.payload() else { Issue.record("not ready"); return }
		#expect(input.counterpart == nil, "measured against the fresh recipe")
		model.startOver()
		await model.autosaveSettled()
		#expect(!model.recipeChanged)
		#expect(model.form.title != "Renamed while away")
		#expect(model.form.shown.ingredients[0].items[0] == "2 onions, finely diced")
		#expect(env.device.editorDraft(.recipe(Self.original)) == nil)
	}

	@Test func aReadyDraftSeedsTheFormWithItsWarningsAndPhotos() async throws {
		let server = FakeServer(["GET /api/v1/drafts/\(Self.ready)": FakeServer.fixture("draft-get-ready")])
		let model = EditorModel(origin: .draft(Self.ready), env: try Self.env(server))
		#expect(model.phase == .extracting)
		await Self.appear(model) { model.phase != .extracting }
		#expect(model.phase == .editing)
		#expect(model.form.title == "Lemon drizzle cake")
		#expect(model.form.coverImageId == "01TEST00000000000000000020")
		#expect(model.warnings == ["Step 3 was cut off in the photo."])
		#expect(model.damageReasoning == "One bowl and a tin.")
	}

	@Test func anExtractingDraftMovesToEditingWhenTheReplyChanges() async throws {
		let env = try Self.env(FakeServer())
		var queued = try Self.lookup("draft-get-ready")
		if case .draft(var d) = queued { d.status = .queued; queued = .draft(d) }
		let resource = env.store.resource(.draft(Self.ready))
		resource.replace(queued)
		let model = EditorModel(origin: .draft(Self.ready), env: env)
		let task = Task { await model.appear() }
		try await Task.sleep(for: .milliseconds(50))
		#expect(model.phase == .extracting)
		resource.replace(try Self.lookup("draft-get-ready"))
		for _ in 0..<200 where model.phase == .extracting { try await Task.sleep(for: .milliseconds(10)) }
		#expect(model.phase == .editing)
		#expect(model.form.title == "Lemon drizzle cake")
		task.cancel()
		await task.value
	}

	@Test func aFailedDraftShowsTheErrorAndKeepsTheLink() async throws {
		let server = FakeServer(["GET /api/v1/drafts/\(Self.failed)": FakeServer.fixture("draft-get-failed")])
		let model = EditorModel(origin: .draft(Self.failed), env: try Self.env(server))
		await Self.appear(model) { model.phase != .extracting }
		#expect(model.phase == .extractionFailed("This site blocks automated readers."))
		#expect(model.form.sourceUrl == "https://www.example.com/soup")
		#expect(model.form.title.isEmpty)
	}

	@Test func retryingAFailedDraftRequeuesItAndDropsTheAutosave() async throws {
		let server = FakeServer([
			"GET /api/v1/drafts/\(Self.failed)": FakeServer.fixture("draft-get-failed"),
			"POST /api/v1/drafts/\(Self.failed)/retry": FakeServer.json(#"{"ok":true}"#),
		])
		let env = try Self.env(server)
		let model = EditorModel(origin: .draft(Self.failed), env: env)
		await Self.appear(model) { model.phase != .extracting }
		model.form.title = "Typed before retry"
		await model.autosaveSettled()
		#expect(env.device.editorDraft(.draft(Self.failed)) != nil)
		await model.retryExtraction()
		#expect(server.requests.contains("POST /api/v1/drafts/\(Self.failed)/retry"))
		#expect(env.device.editorDraft(.draft(Self.failed)) == nil)
	}

	@Test func aSavedDraftGoesStraightToItsRecipe() throws {
		let env = try Self.env(FakeServer())
		env.store.resource(.draft(Self.ready)).replace(try Self.lookup("draft-get-saved"))
		let model = EditorModel(origin: .draft(Self.ready), env: env)
		#expect(model.phase == .saved(Self.savedRecipe))
	}

	// MARK: Save

	@Test func savingADraftCreatesTheRecipeAndDropsTheCard() async throws {
		let server = FakeServer([
			"GET /api/v1/drafts/\(Self.ready)": FakeServer.fixture("draft-get-ready"),
			"POST /api/v1/drafts/\(Self.ready)/save": FakeServer.fixture("draft-save"),
		])
		let env = try Self.env(server)
		let model = EditorModel(origin: .draft(Self.ready), env: env)
		await Self.appear(model) { model.phase != .extracting }
		model.form.title = "Lemon cake"
		await model.save()
		#expect(model.phase == .saved(Self.savedRecipe))
		#expect(env.store.resource(.recipes()).value?.drafts.contains { $0.id == Self.ready } == false)
		#expect(env.device.editorDraft(.draft(Self.ready)) == nil)
	}

	@Test func savingARecipeUpdatesItAndPatchesTheCache() async throws {
		let server = FakeServer(["PUT \(Self.recipePath)": FakeServer.fixture("recipe-update")])
		let env = try Self.env(server)
		let model = EditorModel(origin: .recipe(Self.recipe, nil), env: env)
		model.form.title = "Chickpea stew, again"
		await model.save()
		#expect(model.phase == .saved(Self.recipe))
		#expect(server.requests.filter { !$0.contains("/jobs/") } == ["PUT \(Self.recipePath)"])
		#expect(env.store.resource(.recipe(Self.recipe, variation: nil)).value?.recipe.title == "Chickpea stew, again")
		#expect(env.store.resource(.recipes()).value?.recipes.first { $0.id == Self.recipe }?.title == "Chickpea stew, again")
		#expect(env.device.editorDraft(.recipe(Self.original)) == nil)
	}

	@Test func savingAManualRecipeCreatesIt() async throws {
		let server = FakeServer(["POST /api/v1/recipes": FakeServer.fixture("recipe-create")])
		let env = try Self.env(server)
		let model = EditorModel(origin: .manual, env: env)
		Self.complete(&model.form)
		await model.autosaveSettled()
		await model.save()
		#expect(model.phase == .saved(Self.recipe))
		#expect(env.device.editorDraft(.manual) == nil)
	}

	@Test func anIncompleteFormListsItsIssuesWithoutARequest() async throws {
		let server = FakeServer()
		let model = EditorModel(origin: .manual, env: try Self.env(server))
		await model.save()
		#expect(model.issues == [.titleRequired, .ingredientRequired, .effortRequired, .damageRequired])
		#expect(model.phase == .editing)
		#expect(server.requests.isEmpty)
	}

	@Test func aServerRefusalBecomesAnIssueAndTheFormStaysOpen() async throws {
		let server = FakeServer([
			"POST /api/v1/recipes": (400, Data(#"{"error":"A variation at that yield already exists. Delete it first."}"#.utf8))
		])
		let env = try Self.env(server)
		let model = EditorModel(origin: .manual, env: env)
		Self.complete(&model.form)
		await model.autosaveSettled()
		await model.save()
		#expect(model.issues == [.server("A variation at that yield already exists. Delete it first.")])
		#expect(model.issues.first?.message == "A variation at that yield already exists. Delete it first.")
		#expect(model.phase == .editing)
		#expect(env.device.editorDraft(.manual)?.title == "Toast", "a failed save keeps the autosave")
	}

	// MARK: Reconvert

	@Test func reconvertReadsTheRecipeReplyAndIsNilWithoutARecipe() throws {
		let env = try Self.env(FakeServer())
		let failed = PendingWork(jobId: nil, status: .failed)
		env.store.resource(.recipe(Self.recipe, variation: nil)).mutate { $0.recipe.reconvert = failed }
		#expect(EditorModel(origin: .recipe(Self.recipe, nil), env: env).reconvert == failed)
		#expect(EditorModel(origin: .manual, env: env).reconvert == nil)
	}

	@Test func retryingAReconvertPostsTheRetry() async throws {
		let retry = "POST \(Self.recipePath)/retry-reconvert"
		let server = FakeServer([retry: FakeServer.json(#"{"ok":true}"#), "GET \(Self.recipePath)": FakeServer.fixture("recipe-get")])
		let model = EditorModel(origin: .recipe(Self.recipe, nil), env: try Self.env(server))
		await model.retryReconvert()
		#expect(server.requests.filter { !$0.contains("/jobs/") } == [retry, "GET \(Self.recipePath)"], "the retry, then the recipe itself refetched")
		#expect(model.issues.isEmpty)
	}

	@Test func aRefusedReconvertRetryBecomesAnIssue() async throws {
		let server = FakeServer([
			"POST \(Self.recipePath)/retry-reconvert": (400, Data(#"{"error":"Nothing to retry."}"#.utf8))
		])
		let model = EditorModel(origin: .recipe(Self.recipe, nil), env: try Self.env(server))
		await model.retryReconvert()
		#expect(model.issues == [.server("Nothing to retry.")])
	}

	// MARK: Discard and delete

	@Test func discardingADraftRemovesItsCard() async throws {
		let server = FakeServer(["POST /api/v1/drafts/\(Self.ready)/discard": FakeServer.json(#"{"ok":true}"#)])
		let env = try Self.env(server)
		env.store.resource(.draft(Self.ready)).replace(try Self.lookup("draft-get-ready"))
		let model = EditorModel(origin: .draft(Self.ready), env: env)
		await model.discardDraft()
		#expect(model.phase == .removed)
		#expect(env.store.resource(.recipes()).value?.drafts.contains { $0.id == Self.ready } == false)
	}

	@Test func discardingAnExtractingDraftShowsTheServerText() async throws {
		let server = FakeServer([
			"POST /api/v1/drafts/\(Self.ready)/discard": (400, Data(#"{"error":"Still extracting; wait for it to finish."}"#.utf8))
		])
		let model = EditorModel(origin: .draft(Self.ready), env: try Self.env(server))
		await model.discardDraft()
		#expect(model.issues == [.server("Still extracting; wait for it to finish.")])
		#expect(model.phase == .extracting)
	}

	@Test func deletingARecipeRemovesItsRow() async throws {
		let server = FakeServer(["DELETE \(Self.recipePath)": FakeServer.json(#"{"ok":true}"#)])
		let env = try Self.env(server)
		let model = EditorModel(origin: .recipe(Self.recipe, nil), env: env)
		await model.deleteRecipe()
		#expect(model.phase == .removed)
		#expect(env.store.resource(.recipes()).value?.recipes.contains { $0.id == Self.recipe } == false)
	}

	// MARK: Photos

	@Test func anEditorPhotoUploadsAndBecomesTheCoverWhenFirst() async throws {
		let server = FakeServer(["POST /api/v1/images?role=photo": FakeServer.fixture("image-upload")])
		let model = EditorModel(origin: .manual, env: try Self.env(server))
		await model.upload(photo: Data([1]))
		#expect(model.form.images.map(\.id) == ["01TEST00000000000000000002"])
		#expect(model.form.coverImageId == "01TEST00000000000000000002")
		#expect(model.uploads.isEmpty)
	}

	@Test func aFailedEditorUploadShowsTheWebCopy() async throws {
		let model = EditorModel(origin: .manual, env: try Self.env(FakeServer()))
		await model.upload(photo: Data([1]))
		#expect(model.issues.map(\.message) == ["Could not upload a photo. Check the connection and try again."])
		#expect(model.form.images.isEmpty)
		#expect(model.uploads.isEmpty)
	}

	@Test func coverRules() {
		let url = URL(string: "https://example.com/i.jpg")!
		var f = EditorForm.blank(units: .metric)
		f.addPhoto(DraftImage(id: "a", url: url))
		f.addPhoto(DraftImage(id: "b", url: url))
		f.addPhoto(DraftImage(id: "c", url: url))
		#expect(f.coverImageId == "a", "first is cover")
		f.coverImageId = "c"
		f.removePhoto("b")
		#expect(f.coverImageId == "c", "removing another photo keeps the cover")
		f.removePhoto("c")
		#expect(f.coverImageId == "a", "removing the cover moves it to the next")
		f.removePhoto("a")
		#expect(f.coverImageId == nil)
	}

	@Test func linesMoveWithinBounds() {
		var f = EditorForm.blank(units: .metric)
		f.shown = BodyText(ingredients: [.init(heading: nil, items: ["a", "b"])], steps: ["1", "2"])
		f.moveIngredient(group: 0, from: 0, by: 1)
		f.moveStep(from: 1, by: -1)
		#expect(f.shown.ingredients[0].items == ["b", "a"])
		#expect(f.shown.steps == ["2", "1"])
		f.moveStep(from: 0, by: -1)
		f.moveIngredient(group: 0, from: 1, by: 1)
		#expect(f.shown.steps == ["2", "1"])
		#expect(f.shown.ingredients[0].items == ["b", "a"])
	}
}
