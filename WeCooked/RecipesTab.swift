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
	@State private var showFilters = false

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
		.toolbar {
			ToolbarItem(placement: .topBarTrailing) {
				Button { showFilters = true } label: {
					if filters.tagCount > 0 {
						Label("\(filters.tagCount)", systemImage: "line.3.horizontal.decrease")
							.labelStyle(.titleAndIcon)
					} else {
						Label("Filters", systemImage: "line.3.horizontal.decrease")
					}
				}
				.accessibilityLabel(filters.tagCount > 0 ? "Filters, \(filters.tagCount) active" : "Filters")
			}
		}
		.sheet(isPresented: $showFilters) { FilterSheet(filters: $filters) }
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
			ContentUnavailableView("No recipes match.", systemImage: "magnifyingglass")
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

extension BrowseFilters {
	var tagCount: Int {
		mealTypes.count + cuisines.count + proteins.count + efforts.count + damages.count
	}
	/// The search text stays; only the chips clear.
	var withoutTags: BrowseFilters {
		var cleared = BrowseFilters()
		cleared.q = q
		return cleared
	}
}

/// Five groups of chips over `Vocabulary`. OR within a group and AND across
/// groups is the server's rule; this only edits the sets.
struct FilterSheet: View {
	@Binding var filters: BrowseFilters
	@Environment(AppEnvironment.self) private var env
	@Environment(\.dismiss) private var dismiss

	var body: some View {
		NavigationStack {
			Loaded(resource: env.store.resource(.vocabulary)) { vocab in
				ScrollView {
					VStack(alignment: .leading, spacing: 24) {
						TagGroup("Meal type", vocab.mealTypes, $filters.mealTypes) { $0.title }
						TagGroup("Cuisine", vocab.cuisines, $filters.cuisines) { $0.title }
						TagGroup("Protein", vocab.proteins, $filters.proteins) { $0.title }
						TagGroup("Effort", vocab.efforts, $filters.efforts) { $0.word }
						TagGroup("Damage", vocab.damages, $filters.damages) { $0.word }
					}
					.padding()
				}
			}
			.watching(env.store.resource(.vocabulary))
			.navigationTitle("Filters")
			.navigationBarTitleDisplayMode(.inline)
			.toolbar {
				ToolbarItem(placement: .topBarLeading) {
					if filters.tagCount > 0 {
						Button("Clear") { filters = filters.withoutTags }
					}
				}
				ToolbarItem(placement: .topBarTrailing) {
					Button("Done") { dismiss() }
				}
			}
		}
	}
}

private struct TagGroup<T: Hashable>: View {
	let title: String
	let values: [T]
	@Binding var selected: Set<T>
	let label: (T) -> String

	init(_ title: String, _ values: [T], _ selected: Binding<Set<T>>, label: @escaping (T) -> String) {
		self.title = title
		self.values = values
		self._selected = selected
		self.label = label
	}

	var body: some View {
		VStack(alignment: .leading, spacing: 10) {
			Text(title).font(.headline)
			Flow {
				ForEach(values, id: \.self) { value in
					Button {
						if selected.remove(value) == nil { selected.insert(value) }
					} label: {
						Chip(title: label(value), isSelected: selected.contains(value))
					}
					.buttonStyle(.plain)
				}
			}
		}
	}
}

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
