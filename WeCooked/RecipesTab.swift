import SwiftUI
import WeCookedKit

/// Browse. Reads `Key.recipes(filters)`: search text and tag chips make a new
/// key, so each filter combination is cached and instant the second time. Draft
/// cards (D7) come from the same reply, and the Store waits on extracting
/// drafts on its own, so nothing here polls. Trash is the last row (D1).
struct RecipesTab: View {
	@Environment(AppEnvironment.self) private var env
	@Environment(Router.self) private var router
	@State private var filters = BrowseFilters()
	@State private var searchText = ""

	private var resource: Resource<BrowseResponse> { env.store.resource(.recipes(filters)) }

	var body: some View {
		Loaded(resource: resource) { list in
			List {
				if list.drafts.isEmpty && list.recipes.isEmpty {
					emptyState.listRowSeparator(.hidden)
				}
				ForEach(list.drafts) { DraftRow(card: $0) }
				ForEach(list.recipes) { RecipeRow(row: $0) }
				NavigationLink(value: Route.trash) {
					HStack(spacing: 12) {
						RowTile {
							Image(systemName: "trash").font(.title3).foregroundStyle(.secondary)
						}
						Text("Trash").foregroundStyle(.secondary)
					}
					.padding(.vertical, 6)
				}
			}
			.listStyle(.plain)
			.refreshable { await resource.revalidate() }
		}
		// A new filter is a new key, so a new identity: the old watch stops
		// and the new one starts, which fetches.
		.watching(resource)
		.id(filters)
		.navigationTitle("Recipes")
		.searchable(text: $searchText)
		.task(id: searchText) {
			try? await Task.sleep(for: .milliseconds(300))
			if !Task.isCancelled { filters.q = searchText }
		}
	}

	@ViewBuilder
	private var emptyState: some View {
		if filters.isEmpty {
			ContentUnavailableView {
				Label("Add your first recipe", systemImage: "book.closed")
			} actions: {
				Button("Add a recipe") { router.tab = .add }
					.buttonStyle(.borderedProminent)
			}
		} else {
			ContentUnavailableView.search(text: filters.q)
		}
	}
}

/// The leading tile every row has, so titles line up down the list.
private struct RowTile<Content: View>: View {
	@ViewBuilder var content: Content
	var body: some View {
		content
			.frame(width: 56, height: 56)
			.clipShape(.rect(cornerRadius: 8))
	}
}

struct RecipeRow: View {
	let row: BrowseRow
	var body: some View {
		NavigationLink(value: Route.recipe(row.id, nil)) {
			HStack(spacing: 12) {
				RowTile { CachedImage(url: row.coverUrl) }
				VStack(alignment: .leading, spacing: 6) {
					Text(row.title)
						.font(.body.weight(.semibold))
						.lineLimit(2)
					HStack(spacing: 6) {
						Chip(title: row.effort.word, systemImage: "timer", style: .quiet)
						Chip(title: row.damage.word, systemImage: row.damage.symbol, style: .quiet)
					}
				}
			}
			.padding(.vertical, 6)
		}
	}
}

struct DraftRow: View {
	let card: DraftCard
	var body: some View {
		NavigationLink(value: Route.draft(card.id)) {
			HStack(spacing: 12) {
				RowTile {
					Rectangle()
						.fill(Color(.secondarySystemBackground))
						.overlay {
							Image(systemName: "doc.text").font(.title3).foregroundStyle(.secondary)
						}
						.accessibilityHidden(true)
				}
				VStack(alignment: .leading, spacing: 6) {
					Text(card.title.isEmpty ? "Untitled draft" : card.title)
						.font(.body.weight(.semibold))
						.lineLimit(2)
					Label(card.status.line, systemImage: card.status.symbol)
						.font(.subheadline)
						.foregroundStyle(.secondary)
						.symbolEffect(.rotate, isActive: card.status == .extracting)
				}
			}
			.padding(.vertical, 6)
		}
	}
}

extension DraftCardStatus {
	/// D7: every status is a word plus a glyph.
	var line: String {
		switch self {
		case .extracting: "Extracting…"
		case .ready: "Ready to review"
		case .failed: "Failed: tap to fix"
		case .unknown(let s): s.capitalized
		}
	}
	var symbol: String {
		switch self {
		case .extracting: "arrow.triangle.2.circlepath"
		case .ready: "checkmark.circle"
		case .failed: "exclamationmark.triangle"
		case .unknown: "questionmark.circle"
		}
	}
}

extension Effort {
	var word: String {
		switch self {
		case .quick: "Quick"
		case .weeknight: "Weeknight"
		case .project: "Project"
		case .unknown(let s): s
		}
	}
}

extension Damage {
	var word: String {
		switch self {
		case .tidy: "Tidy"
		case .messy: "Messy"
		case .carnage: "Carnage"
		case .unknown(let s): s
		}
	}
	var symbol: String? {
		switch self {
		case .tidy: "sparkles"
		case .messy: "drop"
		case .carnage: "flame"
		case .unknown: nil
		}
	}
}

struct FilterSheet: View { var body: some View { Text("Filters") } }
struct UnitsSheet: View { var body: some View { NotBuiltYet() } }

struct TrashScreen: View {
	@Environment(AppEnvironment.self) private var env
	var body: some View {
		Loaded(resource: env.store.resource(.trash)) { _ in
			// D8: two labelled groups, Restore per row; a restore that displaced a
			// variation shows a banner (ADR-025). On restore: env.store.restored().
			NotBuiltYet()
		}
		.watching(env.store.resource(.trash))
		.navigationTitle("Trash")
	}
}
