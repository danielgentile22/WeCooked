import Foundation
import Testing

@testable import WeCookedKit

/// Every fixture the server records must be claimed here by a real model type.
/// Three checks per fixture:
///  1. it decodes with the same decoder the API client uses;
///  2. re-encoding loses nothing (every key, at every depth, survives), so a
///     field the server added and the model forgot fails here, not in the app;
///  3. a fixture with no entry in `table` fails, so a new endpoint cannot ship
///     without a model.
struct FixtureDecodingTests {
	/// fixture name -> the type that must decode it.
	static let table: [String: any (Codable & Sendable).Type] = [
		"captures": JobReply.self,
		"captures-url": JobReply.self,
		"covers-backfill": CoverBackfillReply.self,
		"devices-register": OK.self,
		"draft-get-failed": DraftLookup.self,
		"draft-cover-refresh": JobReply.self,
		"draft-get-cover": DraftLookup.self,
		"draft-get-ready": DraftLookup.self,
		"draft-get-saved": DraftLookup.self,
		"draft-get-choosing": DraftLookup.self,
		"draft-get-generating": DraftLookup.self,
		"draft-get-picked": DraftLookup.self,
		"draft-save": SavedDraft.self,
		"error": ErrorBody.self,
		"generations": JobReply.self,
		"image-upload": UploadedImage.self,
		"job-get-queued": JobPoll.self,
		"job-get": JobPoll.self,
		"login": TokenReply.self,
		"recipe-calculate-existing": ReplyWithVariation.self,
		"recipe-calculate-job": JobReply.self,
		"recipe-create": CreatedRecipe.self,
		"recipe-cover-refresh": JobReply.self,
		"recipe-get-busy": RecipeResponse.self,
		"recipe-get-cover": RecipeResponse.self,
		"recipe-get-variation": RecipeResponse.self,
		"recipe-get": RecipeResponse.self,
		"recipe-update": UpdatedRecipe.self,
		"recipes-list": BrowseResponse.self,
		"recipes-list-generation": BrowseResponse.self,
		"session": OK.self,
		"shopping-build": JobReply.self,
		"shopping-get-empty": ShoppingResponse.self,
		"shopping-get": ShoppingResponse.self,
		"tags": Vocabulary.self,
		"trash-get": TrashResponse.self,
		"trash-restore-recipe": RestoreReply.self,
		"trash-restore-variation": RestoreReply.self,
	]

	@Test func everyFixtureHasAModel() {
		#expect(Set(Fixtures.names) == Set(Self.table.keys))
	}

	@Test(arguments: Fixtures.names)
	func decodesAndLosesNothing(name: String) throws {
		let type = try #require(Self.table[name])
		let original = try Fixtures.data(name)
		let decoded = try Wire.makeDecoder().decode(type, from: original)
		let reencoded = try Wire.makeEncoder().encode(decoded)
		let a = try JSONSerialization.jsonObject(with: original)
		let b = try JSONSerialization.jsonObject(with: reencoded)
		#expect(Self.normalize(a) as? NSObject == Self.normalize(b) as? NSObject, "\(name)")
	}

	/// null and absent are the same thing on read; NSNumber 8 and 8.0 compare
	/// equal already. Keys compare without case or underscores because the
	/// server's one camelCase key, `calcJob` in the recipe reply, re-encodes as
	/// `calc_job` under `convertToSnakeCase` (decoding is unaffected).
	static func normalize(_ v: Any) -> Any {
		if let d = v as? [String: Any] {
			var out: [String: Any] = [:]
			for (k, x) in d where !(x is NSNull) {
				out[k.replacingOccurrences(of: "_", with: "").lowercased()] = normalize(x)
			}
			return out as NSDictionary
		}
		if let a = v as? [Any] { return a.map(normalize) as NSArray }
		return v
	}

	@Test func calculateReplyDecodesBothShapes() throws {
		let d = Wire.makeDecoder()
		let existing = try d.decode(CalculateReply.self, from: Fixtures.data("recipe-calculate-existing"))
		let job = try d.decode(CalculateReply.self, from: Fixtures.data("recipe-calculate-job"))
		#expect(existing == .existing("01TEST00000000000000000013"))
		#expect(job == .job("01TEST00000000000000000012"))
	}

	@Test func draftLookupTellsSavedFromDraft() throws {
		let d = Wire.makeDecoder()
		let saved = try d.decode(DraftLookup.self, from: Fixtures.data("draft-get-saved"))
		guard case .saved(let id) = saved else { Issue.record("expected .saved"); return }
		#expect(id == "01TEST00000000000000000022")
		let failed = try d.decode(DraftLookup.self, from: Fixtures.data("draft-get-failed"))
		guard case .draft(let view) = failed else { Issue.record("expected .draft"); return }
		#expect(view.status == .failed)
		#expect(view.initial?.ingredients == nil)
	}

	@Test func draftLookupTellsChoosing() throws {
		let d = Wire.makeDecoder()
		let choosing = try d.decode(DraftLookup.self, from: Fixtures.data("draft-get-choosing"))
		guard case .choosing(let g) = choosing else { Issue.record("expected .choosing"); return }
		#expect(g.id == "01TEST00000000000000000039")
		#expect(g.yieldCount == 2)
		#expect(g.candidates.map(\.title) == [
			"Chicken and cabbage stir-fry with ginger",
			"Roast chicken thighs with caraway cabbage wedges",
			"Chicken katsu with shredded cabbage",
		])
		#expect(g.candidates.map(\.damage) == [.tidy, .messy, .carnage])
		let generating = try d.decode(DraftLookup.self, from: Fixtures.data("draft-get-generating"))
		guard case .draft(let running) = generating else { Issue.record("expected .draft"); return }
		#expect(running.status == .running)
		#expect(running.initial == nil)
		let picked = try d.decode(DraftLookup.self, from: Fixtures.data("draft-get-picked"))
		guard case .draft(let done) = picked else { Issue.record("expected .draft"); return }
		#expect(done.status == .done)
		#expect(done.initial?.title == "Roast chicken thighs with caraway cabbage wedges")
		#expect(done.initial?.sourceUrl == nil)
		let list = try d.decode(BrowseResponse.self, from: Fixtures.data("recipes-list-generation"))
		#expect(list.drafts.map(\.status).prefix(2) == [.choosing, .generating])
		#expect(list.watchedJobs.contains(list.drafts[1].id))
		#expect(!list.watchedJobs.contains(list.drafts[0].id))
	}

	@Test func unknownEnumValuesSurviveDecodingAndReencoding() throws {
		var json = try #require(
			JSONSerialization.jsonObject(with: Fixtures.data("recipe-get")) as? [String: Any])
		var recipe = try #require(json["recipe"] as? [String: Any])
		recipe["effort"] = "epic"
		recipe["damage"] = "apocalypse"
		recipe["cuisine"] = "martian"
		recipe["source_units"] = "imperial"
		recipe["reconvert"] = ["job_id": "j", "status": "paused"]
		json["recipe"] = recipe
		let data = try JSONSerialization.data(withJSONObject: json)
		let r = try Wire.makeDecoder().decode(RecipeResponse.self, from: data).recipe
		#expect(r.effort == .unknown("epic"))
		#expect(r.damage == .unknown("apocalypse"))
		#expect(r.cuisine?.wire == "martian")
		#expect(r.cuisine?.title == "Martian")
		#expect(r.sourceUnits == .metric)
		#expect(r.reconvert?.status == .unknown("paused"))
		let out = try Wire.makeEncoder().encode(r)
		#expect(String(decoding: out, as: UTF8.self).contains("\"epic\""))
	}

	@Test func recipeInputEncodesEveryKeyTheServerReads() throws {
		let input = RecipeInput(
			title: "T", yieldCount: 4, yieldUnit: "servings", prepMinutes: nil, cookMinutes: nil,
			sourceText: nil, sourceUrl: nil, notes: nil, sourceUnits: .metric, mealTypes: [],
			cuisine: nil, protein: nil, effort: .quick, damage: .tidy,
			ingredients: [.init(heading: nil, items: ["1 egg"])], steps: [],
			counterpart: nil, imageIds: [], coverImageId: nil)
		let object = try #require(
			JSONSerialization.jsonObject(with: Wire.makeEncoder().encode(input)) as? [String: Any])
		let expected: Set<String> = [
			"title", "yield_count", "yield_unit", "prep_minutes", "cook_minutes", "source_text",
			"source_url", "notes", "source_units", "meal_types", "cuisine", "protein", "effort",
			"damage", "ingredients", "steps", "counterpart", "image_ids", "cover_image_id",
		]
		#expect(Set(object.keys) == expected)
		#expect(object["cuisine"] is NSNull)
		#expect(object["counterpart"] is NSNull)
		#expect(object["cover_image_id"] is NSNull)
	}
}

/// `recipe-calculate-existing.json` is `{variation_id}`; `CalculateReply` is
/// decode-only, so the round-trip check uses this plain twin.
struct ReplyWithVariation: Codable, Sendable { let variationId: VariationID }
