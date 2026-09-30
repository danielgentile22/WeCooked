import SwiftUI
import WeCookedKit

/// A finished generation before its pick: three candidate cards to swipe
/// between, each with a comparison row, the title, the ingredients and Pick.
/// Below the deck, Try again and Discard act on the whole generation. The
/// screen stays the draft screen; a pick moves the same model to the form.
struct DeckView: View {
	let generation: GenerationView
	let model: EditorModel
	@Environment(Router.self) private var router
	@State private var page = 0
	@State private var confirmDiscard = false

	var body: some View {
		VStack(spacing: 12) {
			Text(generation.description)
				.font(.subheadline)
				.foregroundStyle(.secondary)
				.frame(maxWidth: .infinity, alignment: .leading)
				.padding(.horizontal)
			TabView(selection: $page) {
				ForEach(Array(generation.candidates.enumerated()), id: \.offset) { index, candidate in
					CandidateCard(candidate: candidate, index: index) { Task { await model.pick(index) } }
						.tag(index)
				}
			}
			.tabViewStyle(.page(indexDisplayMode: .always))
			VStack(spacing: 8) {
				ForEach(serverIssues, id: \.self) { Banner(kind: .error, text: $0) }
				Button {
					Task {
						if let job = await model.tryAgain() { router.recipesPath = [.draft(job)] }
					}
				} label: {
					Label("Try again", systemImage: "arrow.clockwise").frame(maxWidth: .infinity)
				}
				.buttonStyle(.bordered)
				.controlSize(.large)
				.accessibilityIdentifier("deck.tryAgain")
				Button(confirmDiscard ? "Really discard this generation? Tap again" : "Discard", role: .destructive) {
					if confirmDiscard {
						confirmDiscard = false
						Task { await model.discardDraft() }
					} else {
						confirmDiscard = true
					}
				}
				.accessibilityIdentifier("deck.discard")
			}
			.padding(.horizontal)
		}
		.padding(.vertical)
	}

	private var serverIssues: [String] {
		model.issues.compactMap { if case .server(let text) = $0 { text } else { nil } }
	}
}

private struct CandidateCard: View {
	let candidate: Candidate
	let index: Int
	let pick: () -> Void

	static let shownLines = 10

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: 12) {
				Flow(spacing: 6) {
					Chip(title: candidate.damage.word, systemImage: candidate.damage.symbol, style: .quiet)
					Chip(title: candidate.effort.word, systemImage: "timer", style: .quiet)
					if let prep = candidate.prepMinutes { Chip(title: "prep \(prep) min", style: .quiet) }
					if let cook = candidate.cookMinutes { Chip(title: "cook \(cook) min", style: .quiet) }
					if let protein = candidate.protein { Chip(title: protein.title, style: .quiet) }
					if let cuisine = candidate.cuisine { Chip(title: cuisine.title, style: .quiet) }
				}
				Text(candidate.title)
					.font(.title2.weight(.semibold))
					.accessibilityIdentifier("deck.title.\(index)")
				VStack(alignment: .leading, spacing: 4) {
					ForEach(Array(candidate.ingredients.prefix(Self.shownLines).enumerated()), id: \.offset) { _, line in
						Text(line).font(.subheadline)
					}
					if candidate.ingredients.count > Self.shownLines {
						Text("and \(candidate.ingredients.count - Self.shownLines) more")
							.font(.subheadline)
							.foregroundStyle(.secondary)
					}
				}
				Button(action: pick) {
					Label("Pick this one", systemImage: "checkmark").frame(maxWidth: .infinity)
				}
				.prominentButton()
				.controlSize(.large)
				.accessibilityIdentifier("deck.pick.\(index)")
			}
			.padding()
			.frame(maxWidth: .infinity, alignment: .leading)
			.background(Color(.secondarySystemBackground), in: .rect(cornerRadius: 16))
			.padding(.horizontal)
			// The page dots draw over the bottom of the page.
			.padding(.bottom, 36)
		}
		.accessibilityIdentifier("deck.card.\(index)")
	}
}
