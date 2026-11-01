import SwiftUI
import WeCookedKit
import WidgetKit

/// A recipe from the book for today, read from the file the app writes into
/// the app group. Only the Cook button opens the recipe; a tap anywhere else
/// opens the app as it was, so there is deliberately no `widgetURL`.
struct SuggestionWidget: Widget {
	var body: some WidgetConfiguration {
		StaticConfiguration(kind: SuggestionFile.widgetKind, provider: SuggestionProvider()) { entry in
			SuggestionWidgetView(entry: entry)
		}
		.configurationDisplayName("Tonight")
		.description("A recipe from your book, a new one each day.")
		.supportedFamilies([.systemSmall])
	}
}

struct SuggestionEntry: TimelineEntry {
	let date: Date
	/// Nil before the app has written the book once.
	let pick: SuggestionSnapshot.Pick??
	let cover: UIImage?

	static let notYet = SuggestionEntry(date: .now, pick: .none, cover: nil)
}

struct SuggestionProvider: TimelineProvider {
	private var file: SuggestionFile {
		SuggestionFile(appGroup: Bundle.main.infoDictionary?["WCAppGroup"] as? String)
	}

	private func entry(_ snapshot: SuggestionSnapshot?, on date: Date) -> SuggestionEntry {
		guard let snapshot else { return .notYet }
		let pick = snapshot.pick(on: date)
		let cover = pick?.cover.flatMap { UIImage(contentsOfFile: file.cover(named: $0).path()) }
		return SuggestionEntry(date: date, pick: .some(pick), cover: cover)
	}

	func placeholder(in context: Context) -> SuggestionEntry {
		SuggestionEntry(date: .now, pick: .some(.fixture), cover: nil)
	}

	func getSnapshot(in context: Context, completion: @escaping (SuggestionEntry) -> Void) {
		completion(context.isPreview ? placeholder(in: context) : entry(file.read(), on: .now))
	}

	/// One entry per day from midnight, a week ahead, then ask again. The app
	/// reloads this kind whenever the book changes.
	func getTimeline(in context: Context, completion: @escaping (Timeline<SuggestionEntry>) -> Void) {
		let snapshot = file.read()
		let days = snapshot?.days(from: .now) ?? [(Calendar.current.startOfDay(for: .now), nil)]
		let entries = days.map { day in entry(snapshot, on: max(day.start, .now)) }
		completion(Timeline(entries: entries, policy: .atEnd))
	}
}

struct SuggestionWidgetView: View {
	let entry: SuggestionEntry
	@Environment(\.widgetRenderingMode) private var renderingMode

	var body: some View {
		content
			.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
			.containerBackground(for: .widget) { background }
	}

	private var onPhoto: Bool { entry.cover != nil }

	@ViewBuilder
	private var content: some View {
		switch entry.pick {
		case .none:
			message("Open We Cooked to get a suggestion")
		case .some(.none):
			message("Add a recipe to get suggestions")
		case .some(.some(let pick)):
			VStack(alignment: .leading, spacing: 6) {
				Text("Tonight")
					.font(.caption.weight(.semibold))
					.foregroundStyle(onPhoto ? AnyShapeStyle(.white.opacity(0.85)) : AnyShapeStyle(.secondary))
				Spacer(minLength: 0)
				Text(pick.title)
					.font(.headline)
					.lineLimit(3)
					.minimumScaleFactor(0.85)
					.foregroundStyle(onPhoto ? AnyShapeStyle(.white) : AnyShapeStyle(.primary))
				cookButton(pick.id)
			}
		}
	}

	/// Tinted and clear home screens draw the widget in two layers, default and
	/// accent, and a prominent button puts its fill and its label in the same
	/// one, so the label vanishes. There the fill is a faint capsule in the
	/// default layer and only the label takes the accent.
	@ViewBuilder
	private func cookButton(_ id: RecipeID) -> some View {
		let label = Label("Cook", systemImage: "frying.pan")
			.font(.subheadline.weight(.semibold))
			.frame(maxWidth: .infinity)
		if renderingMode == .fullColor {
			Button(intent: CookRecipeIntent(recipe: id)) { label }
				.buttonStyle(.borderedProminent)
				.buttonBorderShape(.capsule)
		} else {
			Button(intent: CookRecipeIntent(recipe: id)) {
				label
					.widgetAccentable()
					.padding(.vertical, 7)
					.background(Capsule().fill(.white.opacity(0.18)))
			}
			.buttonStyle(.plain)
		}
	}

	private func message(_ text: String) -> some View {
		VStack(alignment: .leading, spacing: 6) {
			Label("Tonight", systemImage: "frying.pan").font(.headline)
			Text(text).font(.subheadline).foregroundStyle(.secondary)
		}
	}

	@ViewBuilder
	private var background: some View {
		if let cover = entry.cover {
			Image(uiImage: cover)
				.resizable()
				.scaledToFill()
				.overlay(
					LinearGradient(
						colors: [.black.opacity(0.35), .clear, .black.opacity(0.75)],
						startPoint: .top, endPoint: .bottom))
		} else {
			Rectangle().fill(.fill.tertiary)
		}
	}
}

extension SuggestionSnapshot.Pick {
	static let fixture = SuggestionSnapshot.Pick(
		id: "01FIXTURE", title: "Green curry with chicken thighs", effort: .weeknight, damage: .messy)
}

#Preview("Small", as: .systemSmall) {
	SuggestionWidget()
} timeline: {
	SuggestionEntry(date: .now, pick: .some(.fixture), cover: nil)
	SuggestionEntry(date: .now, pick: .some(.fixture), cover: UIImage(systemName: "photo"))
	SuggestionEntry(date: .now, pick: .some(nil), cover: nil)
	SuggestionEntry.notYet
}
