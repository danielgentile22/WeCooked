import SwiftUI
import WeCookedKit

/// D8. Two labelled groups, a Restore button per row, and one banner for the
/// last restore's outcome (ADR-025). Mirrors
/// `server/src/routes/trash/+page.svelte` branch for branch.
struct TrashScreen: View {
	@Environment(AppEnvironment.self) private var env

	var body: some View {
		TrashList(model: TrashModel(env: env))
	}
}

private struct TrashList: View {
	@State var model: TrashModel

	var body: some View {
		Loaded(resource: model.resource) { reply in
			List {
				if reply.trash.recipes.isEmpty && reply.trash.variations.isEmpty {
					Text("Trash is empty.")
						.foregroundStyle(.secondary)
						.frame(maxWidth: .infinity)
						.padding(.top, 48)
						.bare()
						.accessibilityIdentifier("trash-empty")
				}
				if !reply.trash.recipes.isEmpty {
					SwiftUI.Section("Recipes") {
						ForEach(reply.trash.recipes) { r in
							row(id: r.id.raw, title: r.title, deletedAt: r.deletedAt) {
								await model.restore(recipe: r.id)
							}
						}
					}
				}
				if !reply.trash.variations.isEmpty {
					SwiftUI.Section("Variations") {
						ForEach(reply.trash.variations) { v in
							row(
								id: v.id.raw, title: "\(v.title) · \(v.yieldCount.formatted()) \(v.yieldUnit)",
								deletedAt: v.deletedAt
							) {
								await model.restore(variation: v.id)
							}
						}
					}
				}
			}
		}
		// Above the list, not in it: Restore sits on rows far down a long Trash,
		// and the outcome has to show where the tap happened.
		.safeAreaInset(edge: .top) { notice.padding(.horizontal, 16) }
		.navigationTitle("Trash")
		.watching(model.resource)
	}

	@ViewBuilder private var notice: some View {
		switch model.notice {
		case .restored:
			Banner(kind: .success, text: "Restored.").accessibilityIdentifier("trash-notice")
		case .displaced:
			Banner(kind: .success, text: "Restored your version; the variation that held the same yield is in Trash.")
				.accessibilityIdentifier("trash-notice")
		case .failed(let message):
			Banner(kind: .error, text: message).accessibilityIdentifier("trash-error")
		case nil:
			EmptyView()
		}
	}

	private func row(id: String, title: String, deletedAt: Date, restore: @escaping () async -> Void) -> some View {
		HStack {
			VStack(alignment: .leading, spacing: 2) {
				Text(title).fontWeight(.semibold)
				Text("deleted \(deletedAt.formatted(.dateTime.day().month(.abbreviated)))")
					.font(.caption)
					.foregroundStyle(.secondary)
			}
			.frame(maxWidth: .infinity, alignment: .leading)
			.accessibilityElement(children: .combine)
			.accessibilityIdentifier("trash-row-\(id)")
			Button("Restore") { Task { await restore() } }
				.buttonStyle(.bordered)
				.accessibilityIdentifier("trash-restore-\(id)")
		}
	}
}
