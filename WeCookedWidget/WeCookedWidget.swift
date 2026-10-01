import SwiftUI
import WeCookedKit
import WidgetKit

@main
struct WeCookedWidgetBundle: WidgetBundle {
	var body: some Widget { ShoppingWidget() }
}

/// The unticked shopping list, read from the snapshot the app writes into the
/// app group. Tapping anywhere opens the Shopping tab.
struct ShoppingWidget: Widget {
	var body: some WidgetConfiguration {
		StaticConfiguration(kind: SnapshotFile.widgetKind, provider: SnapshotProvider()) { entry in
			ShoppingWidgetView(entry: entry)
		}
		.configurationDisplayName("Shopping list")
		.description("Your unticked shopping list.")
		.supportedFamilies([.systemMedium, .systemLarge])
	}
}

struct SnapshotEntry: TimelineEntry {
	let date: Date
	let snapshot: ShoppingSnapshot?
}

struct SnapshotProvider: TimelineProvider {
	private var file: SnapshotFile {
		SnapshotFile(appGroup: Bundle.main.infoDictionary?["WCAppGroup"] as? String)
	}

	func placeholder(in context: Context) -> SnapshotEntry {
		SnapshotEntry(date: .now, snapshot: .fixture)
	}

	func getSnapshot(in context: Context, completion: @escaping (SnapshotEntry) -> Void) {
		completion(SnapshotEntry(date: .now, snapshot: context.isPreview ? .fixture : file.read()))
	}

	/// One entry and no refresh: the app reloads this kind after every write,
	/// so the widget never polls.
	func getTimeline(in context: Context, completion: @escaping (Timeline<SnapshotEntry>) -> Void) {
		completion(Timeline(entries: [SnapshotEntry(date: .now, snapshot: file.read())], policy: .never))
	}
}

struct ShoppingWidgetView: View {
	let entry: SnapshotEntry
	@Environment(\.widgetFamily) private var family

	private var maxLines: Int { family == .systemMedium ? 4 : 10 }

	var body: some View {
		content
			.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
			.widgetURL(DeepLink.shopping.url)
			.containerBackground(.fill.tertiary, for: .widget)
	}

	@ViewBuilder
	private var content: some View {
		switch entry.snapshot?.display(maxLines: maxLines, now: entry.date) {
		case nil:
			Text("Open We Cooked to see your list").foregroundStyle(.secondary)
		case .empty:
			Text(ShoppingSnapshot.emptyText).foregroundStyle(.secondary)
		case .list(let lines, let footer):
			VStack(alignment: .leading, spacing: 4) {
				Label("Shopping", systemImage: "cart").font(.headline)
				ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
					Text(line).font(.body).lineLimit(1)
				}
				Spacer(minLength: 0)
				if let footer {
					Text(footer).font(.caption).foregroundStyle(.secondary)
				}
			}
		}
	}
}

extension ShoppingSnapshot {
	static let fixture = ShoppingSnapshot(
		items: [
			Line(textUs: "2 lb chicken thighs", textMetric: "900 g chicken thighs"),
			Line(textUs: "1 cup basmati rice", textMetric: "200 g basmati rice"),
			Line(textUs: "3 limes", textMetric: "3 limes"),
			Line(textUs: "1 bunch cilantro", textMetric: "1 bunch cilantro"),
			Line(textUs: "14 oz coconut milk", textMetric: "400 ml coconut milk"),
			Line(textUs: "2 tbsp fish sauce", textMetric: "30 ml fish sauce"),
		],
		staples: 4, units: .us, savedAt: .now)

	static let emptyFixture = ShoppingSnapshot(items: [], staples: 0, units: .us, savedAt: .now)

	static let staleFixture = ShoppingSnapshot(
		items: fixture.items, staples: fixture.staples, units: .metric,
		savedAt: Date(timeIntervalSinceNow: -3 * 24 * 3600))
}

#Preview("Medium", as: .systemMedium) {
	ShoppingWidget()
} timeline: {
	SnapshotEntry(date: .now, snapshot: .fixture)
	SnapshotEntry(date: .now, snapshot: .emptyFixture)
	SnapshotEntry(date: .now, snapshot: .staleFixture)
}

#Preview("Large", as: .systemLarge) {
	ShoppingWidget()
} timeline: {
	SnapshotEntry(date: .now, snapshot: .fixture)
	SnapshotEntry(date: .now, snapshot: .emptyFixture)
	SnapshotEntry(date: .now, snapshot: .staleFixture)
}
