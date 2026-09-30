import Foundation
import Testing

@testable import WeCookedKit

/// The generation shapes from the issue #41 contract as inline JSON, so the
/// model tests share one job id across the choosing, generating and picked
/// states of the same row. The recorded fixtures cover the server's own shapes.
enum GenerationJSON {
	static let job: JobID = "01TEST00000000000000000030"
	static let description = "the chicken thighs and half a cabbage, under 40 minutes"

	static let choosing = """
		{
		  "id": "01TEST00000000000000000030",
		  "status": "done",
		  "description": "the chicken thighs and half a cabbage, under 40 minutes",
		  "yield_count": 2,
		  "candidates": [
		    {
		      "title": "Chicken and cabbage stir-fry",
		      "prep_minutes": 10,
		      "cook_minutes": 20,
		      "effort": "quick",
		      "damage": "tidy",
		      "cuisine": "chinese",
		      "protein": "chicken",
		      "ingredients": ["2 chicken thighs, sliced", "half a cabbage, shredded"]
		    },
		    {
		      "title": "Braised chicken with cabbage and mustard",
		      "prep_minutes": 10,
		      "cook_minutes": 30,
		      "effort": "weeknight",
		      "damage": "messy",
		      "cuisine": null,
		      "protein": null,
		      "ingredients": ["2 chicken thighs", "half a cabbage", "1 tbsp mustard"]
		    },
		    {
		      "title": "Chicken and cabbage okonomiyaki",
		      "prep_minutes": null,
		      "cook_minutes": 15,
		      "effort": "quick",
		      "damage": "messy",
		      "cuisine": "japanese",
		      "protein": "chicken",
		      "ingredients": ["2 chicken thighs, diced", "half a cabbage, shredded", "2 eggs"]
		    }
		  ]
		}
		"""

	static let generating = """
		{
		  "id": "01TEST00000000000000000030",
		  "status": "running",
		  "error_text": null,
		  "source_text": "the chicken thighs and half a cabbage, under 40 minutes",
		  "initial": null,
		  "warnings": [],
		  "damage_reasoning": null
		}
		"""

	/// The row after picking index 1: an ordinary draft seeded from that candidate.
	static let picked = """
		{
		  "id": "01TEST00000000000000000030",
		  "status": "done",
		  "error_text": null,
		  "source_text": "the chicken thighs and half a cabbage, under 40 minutes",
		  "initial": {
		    "source_url": null,
		    "images": [],
		    "title": "Braised chicken with cabbage and mustard",
		    "yield_count": 2,
		    "yield_unit": "servings",
		    "prep_minutes": 10,
		    "cook_minutes": 30,
		    "source_text": "the chicken thighs and half a cabbage, under 40 minutes",
		    "notes": null,
		    "source_units": "metric",
		    "meal_types": ["dinner"],
		    "cuisine": null,
		    "protein": "chicken",
		    "effort": "weeknight",
		    "damage": "messy",
		    "ingredients": [{"heading": null, "items": ["2 chicken thighs", "half a cabbage", "1 tbsp mustard"]}],
		    "steps": ["Brown the thighs.", "Add the cabbage and braise."],
		    "counterpart": null
		  },
		  "warnings": [],
		  "damage_reasoning": "A pan and a lid."
		}
		"""

	static func data(_ json: String) -> Data { Data(json.utf8) }
}

struct GenerationWireTests {
	private func roundTrips<T: Codable>(_ type: T.Type, _ json: String) throws {
		let original = GenerationJSON.data(json)
		let decoded = try Wire.makeDecoder().decode(type, from: original)
		let reencoded = try Wire.makeEncoder().encode(decoded)
		let a = FixtureDecodingTests.normalize(try JSONSerialization.jsonObject(with: original))
		let b = FixtureDecodingTests.normalize(try JSONSerialization.jsonObject(with: reencoded))
		#expect(a as? NSObject == b as? NSObject)
	}

	@Test func generationViewRoundTripsTheContractJSON() throws {
		try roundTrips(GenerationView.self, GenerationJSON.choosing)
		try roundTrips(DraftLookup.self, GenerationJSON.choosing)
		try roundTrips(DraftLookup.self, GenerationJSON.generating)
		try roundTrips(DraftLookup.self, GenerationJSON.picked)
	}

	@Test func candidateFieldsDecode() throws {
		let g = try Wire.makeDecoder().decode(GenerationView.self, from: GenerationJSON.data(GenerationJSON.choosing))
		#expect(g.id == GenerationJSON.job)
		#expect(g.status == .done)
		#expect(g.description == GenerationJSON.description)
		#expect(g.yieldCount == 2)
		#expect(g.candidates.count == 3)
		let first = g.candidates[0]
		#expect(first.title == "Chicken and cabbage stir-fry")
		#expect(first.prepMinutes == 10)
		#expect(first.cookMinutes == 20)
		#expect(first.effort == .quick)
		#expect(first.damage == .tidy)
		#expect(first.cuisine?.wire == "chinese")
		#expect(first.protein?.title == "Chicken")
		#expect(first.ingredients.count == 2)
		#expect(g.candidates[1].cuisine == nil)
		#expect(g.candidates[1].protein == nil)
		#expect(g.candidates[2].prepMinutes == nil)
	}

	@Test func draftLookupTellsChoosingFromDraftAndSaved() throws {
		let d = Wire.makeDecoder()
		guard case .choosing(let g) = try d.decode(DraftLookup.self, from: GenerationJSON.data(GenerationJSON.choosing))
		else { Issue.record("expected .choosing"); return }
		#expect(g.candidates.count == 3)
		guard case .draft(let running) = try d.decode(DraftLookup.self, from: GenerationJSON.data(GenerationJSON.generating))
		else { Issue.record("expected .draft"); return }
		#expect(running.status == .running)
		#expect(running.initial == nil)
		#expect(running.sourceText == GenerationJSON.description)
		guard case .draft(let picked) = try d.decode(DraftLookup.self, from: GenerationJSON.data(GenerationJSON.picked))
		else { Issue.record("expected .draft"); return }
		#expect(picked.initial?.title == "Braised chicken with cabbage and mustard")
		let savedAndCandidates = #"{"recipe_id":"01TEST00000000000000000022","candidates":[]}"#
		guard case .saved(let id) = try d.decode(DraftLookup.self, from: Data(savedAndCandidates.utf8))
		else { Issue.record("expected .saved to win"); return }
		#expect(id == "01TEST00000000000000000022")
	}

	@Test func draftCardStatusKnowsTheGenerationStatuses() throws {
		#expect(DraftCardStatus(wire: "generating") == .generating)
		#expect(DraftCardStatus(wire: "choosing") == .choosing)
		#expect(DraftCardStatus.generating.wire == "generating")
		#expect(DraftCardStatus.choosing.wire == "choosing")
	}

	@Test func browseWatchesGeneratingCardsAndNotChoosingOnes() {
		let list = BrowseResponse(
			drafts: [
				DraftCard(id: "g", status: .generating, title: "soup"),
				DraftCard(id: "c", status: .choosing, title: "stew"),
				DraftCard(id: "e", status: .extracting, title: "pie"),
				DraftCard(id: "r", status: .ready, title: "cake"),
			], recipes: [])
		#expect(list.watchedJobs == ["g", "e"])
	}

	@Test func aChoosingLookupWatchesNothing() throws {
		let lookup = try Wire.makeDecoder().decode(DraftLookup.self, from: GenerationJSON.data(GenerationJSON.choosing))
		#expect(lookup.watchedJobs.isEmpty)
		let running = try Wire.makeDecoder().decode(DraftLookup.self, from: GenerationJSON.data(GenerationJSON.generating))
		#expect(running.watchedJobs == [GenerationJSON.job])
	}
}

struct GenerateRequestTests {
	@Test func encodesDescriptionAndSnakeCaseYield() throws {
		let data = try Wire.makeEncoder().encode(GenerateRequest(description: "x", yieldCount: 2))
		let object = try #require(JSONSerialization.jsonObject(with: data) as? NSDictionary)
		#expect(object == ["description": "x", "yield_count": 2])
	}
}
