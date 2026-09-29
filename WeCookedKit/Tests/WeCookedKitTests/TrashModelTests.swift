import Foundation
import Testing

@testable import WeCookedKit

@MainActor
struct TrashModelTests {
	static let omelette: RecipeID = "01TEST00000000000000000007"
	static let stew: VariationID = "01TEST00000000000000000013"
	static let getTrash = "GET /api/v1/trash"
	static let restoreOmelette = "POST /api/v1/trash/recipes/\(omelette)/restore"
	static let restoreStew = "POST /api/v1/trash/variations/\(stew)/restore"

	static func model(_ server: FakeServer) throws -> TrashModel {
		let env = ShoppingModelTests.env(server)
		let reply = try Wire.makeDecoder().decode(TrashResponse.self, from: Fixtures.data("trash-get"))
		env.store.resource(.trash).replace(reply)
		return TrashModel(env: env)
	}

	@Test func restoringARecipeSaysRestoredAndRefetchesTrash() async throws {
		let server = FakeServer([
			Self.restoreOmelette: FakeServer.fixture("trash-restore-recipe"),
			Self.getTrash: FakeServer.fixture("trash-get"),
		])
		let model = try Self.model(server)
		await model.restore(recipe: Self.omelette)
		#expect(model.notice == .restored)
		#expect(server.requests == [Self.restoreOmelette, Self.getTrash])
	}

	@Test func restoringAVariationThatDisplacedOneSaysDisplaced() async throws {
		let server = FakeServer([
			Self.restoreStew: FakeServer.json(#"{"restored":true,"displaced":true}"#),
			Self.getTrash: FakeServer.fixture("trash-get"),
		])
		let model = try Self.model(server)
		await model.restore(variation: Self.stew)
		#expect(model.notice == .displaced)
	}

	@Test func aRejectedRestoreShowsTheServersMessageAndDoesNotRefetch() async throws {
		let server = FakeServer([
			Self.restoreStew: (400, Data(#"{"error":"Variation not found in Trash."}"#.utf8)),
		])
		let model = try Self.model(server)
		await model.restore(variation: Self.stew)
		#expect(model.notice == .failed("Variation not found in Trash."))
		#expect(server.requests == [Self.restoreStew])
	}

	@Test func aRestoreReplacesThePreviousNotice() async throws {
		let server = FakeServer([
			Self.restoreOmelette: FakeServer.fixture("trash-restore-recipe"),
			Self.getTrash: FakeServer.fixture("trash-get"),
		])
		let model = try Self.model(server)
		await model.restore(recipe: "01TEST00000000000000000099")
		guard case .failed = model.notice else {
			Issue.record("expected a failure first, got \(String(describing: model.notice))")
			return
		}
		await model.restore(recipe: Self.omelette)
		#expect(model.notice == .restored)
	}
}
