import Foundation
import Testing

@testable import WeCookedKit

/// Issue #67: a capture opens with its as-written body only, and the
/// counterpart fills in from the draft's conversion job.
@MainActor
struct DraftCounterpartTests {
	static let draft: JobID = "01TEST00000000000000000022"
	static let conversion: JobID = "01TEST0000000000000000CONV"

	static func view(_ fixture: String) throws -> DraftView {
		guard case .draft(let d) = try EditorModelTests.lookup(fixture) else {
			throw CancellationError()
		}
		return d
	}

	@Test func theCounterpartStatesDecodeFromTheServerFixtures() throws {
		let converting = try Self.view("draft-get-converting")
		#expect(converting.counterpartState == CounterpartState(status: .converting, jobId: Self.conversion))
		#expect(converting.initial?.counterpart == nil)
		let failed = try Self.view("draft-get-conversion-failed")
		#expect(failed.counterpartState == CounterpartState(status: .failed, jobId: Self.conversion))
		#expect(failed.initial?.counterpart == nil)
		let ready = try Self.view("draft-get-ready")
		#expect(ready.counterpartState == CounterpartState(status: .ready, jobId: nil))
		#expect(ready.initial?.counterpart?.ingredients.first?.items == ["1 cup sugar", "2 lemons"])
		#expect(try Self.view("draft-get-failed").counterpartState == nil)
	}

	@Test func theStoreWaitsOnTheConversionOnlyWhileItRuns() throws {
		#expect(try EditorModelTests.lookup("draft-get-converting").watchedJobs == [Self.conversion])
		#expect(try EditorModelTests.lookup("draft-get-conversion-failed").watchedJobs.isEmpty)
		#expect(try EditorModelTests.lookup("draft-get-ready").watchedJobs.isEmpty)
	}

	@Test func aCounterpartThatArrivesJoinsAnEditedFormAndRidesAlongUntilTheBodyIsEdited() throws {
		let converting = EditorForm(seed: try #require(Self.view("draft-get-converting").initial), units: .metric)
		let ready = EditorForm(seed: try #require(Self.view("draft-get-ready").initial), units: .metric)
		#expect(converting.other == nil)

		var titled = converting
		titled.title = "Lemon cake"
		let joined = titled.rebased(onto: ready)
		#expect(joined.other == ready.other)
		guard case .ready(let input) = joined.payload() else { Issue.record("not ready"); return }
		#expect(input.counterpart?.ingredients.first?.items == ["1 cup sugar", "2 lemons"])

		var edited = converting
		edited.shown.ingredients[0].items[0] = "250 g sugar"
		guard case .ready(let changed) = edited.rebased(onto: ready).payload() else {
			Issue.record("not ready")
			return
		}
		#expect(changed.counterpart == nil, "an edited as-written body is reconverted on save")
	}

	@Test func retryingAFailedConversionPostsAndRereadsTheDraft() async throws {
		let path = "/api/v1/drafts/\(Self.draft)"
		let server = FakeServer([
			"POST \(path)/retry-conversion": FakeServer.json(#"{"ok":true}"#),
			"GET \(path)": FakeServer.json(String(decoding: try Fixtures.data("draft-get-converting"), as: UTF8.self)),
		])
		let env = try EditorModelTests.env(server)
		env.store.resource(.draft(Self.draft)).replace(try EditorModelTests.lookup("draft-get-conversion-failed"))
		let model = EditorModel(origin: .draft(Self.draft), env: env)
		#expect(model.conversion == CounterpartState(status: .failed, jobId: Self.conversion))
		await model.retryConversion()
		#expect(server.requests.filter { !$0.contains("/jobs/") } == ["POST \(path)/retry-conversion", "GET \(path)"])
		#expect(model.conversion?.status == .converting)
	}

	@Test func aCounterpartArrivingOnAnEditedFormIsNotAnEditElsewhere() async throws {
		let path = "/api/v1/drafts/\(Self.draft)"
		let server = FakeServer([
			"GET \(path)": FakeServer.json(String(decoding: try Fixtures.data("draft-get-ready"), as: UTF8.self))
		])
		let env = try EditorModelTests.env(server)
		env.store.resource(.draft(Self.draft)).replace(try EditorModelTests.lookup("draft-get-converting"))
		let model = EditorModel(origin: .draft(Self.draft), env: env)
		model.form.title = "Edited while it converted"
		// The reread when the conversion ends brings the ready draft.
		let task = Task { await model.appear() }
		defer { task.cancel() }

		for _ in 0..<200 where model.form.other == nil { try await Task.sleep(for: .milliseconds(10)) }
		#expect(model.form.other?.ingredients.first?.items == ["1 cup sugar", "2 lemons"])
		#expect(model.form.title == "Edited while it converted")
		#expect(!model.recipeChanged, "the conversion finishing is not the recipe changing")
	}
}
