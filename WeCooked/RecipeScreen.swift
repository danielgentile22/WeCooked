import SwiftUI
import WeCookedKit

/// The cooking screen: 95 percent of use, so it gets the layout that reads at
/// arm's length with wet hands. Type scale 19 to 20 pt via Dynamic Type
/// (`.title3` body, not fixed points), tap a line to strike it, wake lock,
/// sticky ingredients while steps scroll.
///
/// Data path (three files): this view -> `RecipeModel.display` (WeCookedKit/
/// RecipeModel.swift) -> `Resource<RecipeResponse>` (WeCookedKit/Store.swift).
struct RecipeScreen: View {
	@State var model: RecipeModel

	var body: some View {
		Group {
			if let display = model.display {
				CookingBody(display: display, model: model)
			} else if model.resource.isFirstLoad {
				ProgressView()  // reached only for a recipe never seen on this phone
			} else if case .failed(let e) = model.resource.phase {
				Banner(kind: .error, text: e.message, actionTitle: "Try again") {
					Task { await model.resource.revalidate() }
				}
				.padding()
			}
		}
		.watching(model.resource)
		.task { await model.appear() }
		.keepsScreenAwake()
	}
}

private enum Confirmation: Identifiable {
	case deleteVariation(yield: Double, unit: String)
	case recalculate
	case deleteRecipe(title: String)

	var id: String {
		switch self {
		case .deleteVariation: "deleteVariation"
		case .recalculate: "recalculate"
		case .deleteRecipe: "deleteRecipe"
		}
	}

	var title: String {
		switch self {
		case .deleteVariation(let yield, let unit):
			"Delete the \(yield.formatted())-\(unit) version? It goes to Trash."
		case .recalculate:
			"Recalculate this version? Your edits will be lost (the edited version goes to Trash)."
		case .deleteRecipe(let title):
			"Delete “\(title)”? You can restore it from Trash."
		}
	}

	var buttonTitle: String {
		switch self {
		case .deleteVariation: "Delete this variation"
		case .recalculate: "Recalculate"
		case .deleteRecipe: "Delete recipe"
		}
	}
}

struct CookingBody: View {
	let display: RecipeDisplay
	@Bindable var model: RecipeModel
	@Environment(\.dismiss) private var dismiss
	@State private var ingredientsOpen = true
	@State private var showVariationDetail = false
	@State private var confirming: Confirmation?

	private var detail: RecipeDetail { display.detail }

	var body: some View {
		ScrollViewReader { proxy in
			ScrollView {
				LazyVStack(alignment: .leading, spacing: 16, pinnedViews: [.sectionHeaders]) {
					header
					Section {
						if ingredientsOpen { ingredients }
						steps
						notes
					} header: {
						ingredientsBar(proxy: proxy)
					}
				}
				.padding(.horizontal)
				.padding(.bottom, 40)
			}
		}
		.navigationBarTitleDisplayMode(.inline)
		.toolbar { toolbar }
		.confirmationDialog(
			confirming?.title ?? "", isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
			titleVisibility: .visible, presenting: confirming
		) { c in
			Button(c.buttonTitle, role: .destructive) { Task { await confirm(c) } }
		}
	}

	private func confirm(_ c: Confirmation) async {
		switch c {
		case .deleteVariation:
			await model.deleteVariation()
			showVariationDetail = false
		case .recalculate:
			await model.recalculate()
			showVariationDetail = false
		case .deleteRecipe:
			await model.deleteRecipe()
			if model.localBanner == nil { dismiss() }
		}
	}

	// MARK: Header

	@ViewBuilder private var header: some View {
		if !detail.images.isEmpty { photoStrip }
		Text(detail.title)
			.font(.title.bold())
			.accessibilityAddTraits(.isHeader)
		Text(metaLine)
			.font(.subheadline)
			.foregroundStyle(.secondary)
		source
		if !tags.isEmpty {
			Flow { ForEach(tags, id: \.self) { Chip(title: $0, style: .quiet) } }
		}
		variationChips
		if showVariationDetail && !detail.isOriginal {
			Button("Delete this variation", role: .destructive) {
				confirming = .deleteVariation(yield: detail.yieldCount, unit: detail.yieldUnit)
			}
		}
		stepper
		ForEach(Array(banners.enumerated()), id: \.offset) { banner($0.element) }
		if detail.stale && detail.handEdited {
			Banner(kind: .warning, text: "The original changed after you edited this version.")
			HStack(spacing: 12) {
				Button("Recalculate") { confirming = .recalculate }
				Button("Keep mine") { Task { await model.keepMine() } }
			}
			.buttonStyle(.bordered)
		}
		if let note = detail.scalingNote, !detail.isOriginal {
			Text(note).font(.subheadline).italic().foregroundStyle(.secondary)
		}
		if display.isFallback {
			Text("The \(display.units == .us ? "US" : "metric") version is not ready yet, so this is the recipe as written.")
				.font(.subheadline).italic().foregroundStyle(.secondary)
		}
	}

	private var photoStrip: some View {
		ScrollView(.horizontal) {
			HStack(spacing: 10) {
				ForEach(detail.images, id: \.id) { image in
					let width = min(260, max(100, CGFloat(image.width) / CGFloat(max(image.height, 1)) * 140))
					CachedImage(url: image.url)
						.frame(width: width, height: 140)
						.clipShape(.rect(cornerRadius: 10))
				}
			}
		}
		.scrollIndicators(.hidden)
		.accessibilityHidden(true)
	}

	private var metaLine: String {
		[
			"\(detail.yieldCount.formatted()) \(detail.yieldUnit)",
			detail.prepMinutes.map { "prep \($0) min" },
			detail.cookMinutes.map { "cook \($0) min" },
		]
		.compactMap { $0 }
		.joined(separator: " · ")
	}

	@ViewBuilder private var source: some View {
		if let raw = detail.sourceUrl, let url = URL(string: raw) {
			Link(detail.sourceText ?? raw, destination: url).font(.subheadline)
		} else if let text = detail.sourceText {
			Text(text).font(.subheadline).foregroundStyle(.secondary)
		}
	}

	private var tags: [String] {
		detail.mealTypes.map(\.title)
			+ [detail.cuisine?.title, detail.protein?.title].compactMap { $0 }
			+ [detail.effort.word, detail.damage.word]
	}

	private var variationChips: some View {
		Flow {
			ForEach(detail.variations) { chip in
				let selected = chip.id == detail.variationId
				Button {
					if selected {
						if !chip.isOriginal { showVariationDetail.toggle() }
					} else {
						showVariationDetail = false
						model.show(chip.id)
					}
				} label: {
					Chip(
						title: chip.isOriginal ? "\(chip.yieldCount.formatted()) · original" : chip.yieldCount.formatted(),
						isSelected: selected)
				}
				.buttonStyle(.plain)
			}
		}
		.animation(.default, value: detail.variations.map(\.id))
		.animation(.default, value: detail.variationId)
	}

	// MARK: Stepper

	private var stepper: some View {
		let unit = detail.yieldUnit
		let action = model.stepper.action(chips: detail.variations)
		let count = model.stepper.count?.formatted() ?? ""
		let label: String =
			switch action {
			case .show: "Show \(count)"
			case .calculate(let n): "Calculate for \(n.formatted())"
			case .unchanged: "Show \(count)"
			case .invalid: "Calculate"
			}
		let disabled = action == .invalid || action == .unchanged || isCalculating
		// Two rows: at 390 pt the unit and "Calculate for N" do not fit beside
		// the stepper, and the button wrapped one letter per line.
		return VStack(alignment: .leading, spacing: 10) {
			HStack(spacing: 10) {
				Button { withAnimation { model.stepper.step(-1) } } label: { Image(systemName: "minus") }
					.accessibilityLabel("Fewer \(unit)")
				TextField("Yield", text: $model.stepper.text)
					.keyboardType(.decimalPad)
					.multilineTextAlignment(.center)
					.font(.title3.weight(.semibold))
					.frame(width: 72)
					.padding(.vertical, 8)
					.background(.fill.tertiary, in: .rect(cornerRadius: 10))
					.accessibilityLabel("Yield count")
				Button { withAnimation { model.stepper.step(1) } } label: { Image(systemName: "plus") }
					.accessibilityLabel("More \(unit)")
				Text(unit).foregroundStyle(.secondary).lineLimit(1)
			}
			Button(label) { Task { await model.commitStepper() } }
				.prominentButton()
				.disabled(disabled)
		}
		.buttonStyle(.bordered)
		.controlSize(.large)
	}

	private var isCalculating: Bool {
		display.banners.contains {
			switch $0 {
			case .calculating, .calculationTimedOut: true
			default: false
			}
		}
	}

	// MARK: Banners

	private var banners: [RecipeDisplay.Banner] {
		display.banners + [model.localBanner].compactMap { $0 }
	}

	private func banner(_ b: RecipeDisplay.Banner) -> Banner {
		switch b {
		case .calculating(let n):
			Banner(kind: .working, text: "Calculating for \(n.formatted())…")
		case .calculationFailed(let text):
			Banner(kind: .error, text: text, actionTitle: "Try again") { Task { await model.retryCalculation() } }
		case .calculationTimedOut:
			Banner(kind: .warning, text: "Still working after 5 minutes", actionTitle: "Try again") {
				Task { await model.retryCalculation() }
			}
		case .refreshing:
			Banner(kind: .working, text: "The original changed, updating this version…")
		case .refreshFailed:
			Banner(
				kind: .error, text: "The original changed, but this version couldn't update.",
				actionTitle: "Tap to retry"
			) { Task { await model.retryRefresh() } }
		case .updated:
			Banner(kind: .success, text: "Updated to match the original.")
		case .reconvertPending:
			Banner(kind: .working, text: "Not yet updated from your edit. Updating…")
		case .reconvertFailed:
			Banner(kind: .error, text: "Couldn't update from your edit.", actionTitle: "Tap to retry") {
				Task { await model.retryReconvert() }
			}
		case .actionFailed(let text):
			Banner(kind: .error, text: text)
		}
	}

	// MARK: Body

	private func ingredientsBar(proxy: ScrollViewProxy) -> some View {
		Button {
			ingredientsOpen.toggle()
			if ingredientsOpen { withAnimation { proxy.scrollTo("ingredients", anchor: .top) } }
		} label: {
			HStack {
				Text("Ingredients").font(.headline)
				Spacer()
				Image(systemName: "chevron.down")
					.foregroundStyle(.secondary)
					.rotationEffect(.degrees(ingredientsOpen ? 180 : 0))
			}
			.padding(.horizontal, 14)
			.padding(.vertical, 12)
			.background(.regularMaterial, in: .rect(cornerRadius: 12))
			.contentShape(.rect)
		}
		.buttonStyle(.plain)
		.accessibilityAddTraits(.isHeader)
		.accessibilityValue(ingredientsOpen ? "expanded" : "collapsed")
		.id("ingredients")
	}

	private var ingredients: some View {
		ForEach(Array(display.body.ingredients.enumerated()), id: \.offset) { gi, group in
			if let heading = group.heading {
				Text(heading).font(.subheadline).italic().foregroundStyle(.secondary)
			}
			// Keyed by LineKey, not offset: the lazy stack flattens these loops,
			// so offsets repeat across groups and the steps, and repeats vanish.
			let lines = group.items.enumerated().map { (key: LineKey.ingredient(group: gi, item: $0.offset), text: $0.element) }
			ForEach(lines, id: \.key) { line in
				StrikableLine(text: line.text, number: nil, isStruck: display.struck.contains(line.key)) { model.strike(line.key) }
			}
		}
	}

	@ViewBuilder private var steps: some View {
		if !display.body.steps.isEmpty {
			Text("Steps").font(.headline).padding(.top, 8)
			let lines = display.body.steps.enumerated().map { (key: LineKey.step($0.offset), number: $0.offset + 1, text: $0.element) }
			ForEach(lines, id: \.key) { line in
				StrikableLine(text: line.text, number: line.number, isStruck: display.struck.contains(line.key)) { model.strike(line.key) }
			}
		}
	}

	@ViewBuilder private var notes: some View {
		if let notes = detail.notes {
			Text("Notes").font(.headline).padding(.top, 8)
			Text(notes).font(.title3)
		}
	}

	// MARK: Toolbar

	@ToolbarContentBuilder private var toolbar: some ToolbarContent {
		ToolbarItemGroup(placement: .topBarTrailing) {
			Picker("Units", selection: unitsBinding) {
				Text(unitsLabel(.metric)).tag(UnitSystem.metric)
				Text(unitsLabel(.us)).tag(UnitSystem.us)
			}
			.pickerStyle(.menu)
			NavigationLink("Edit", value: Route.edit(detail.id, detail.isOriginal ? nil : detail.variationId))
			Menu {
				Button("Delete recipe", role: .destructive) { confirming = .deleteRecipe(title: detail.title) }
			} label: {
				Label("More", systemImage: "ellipsis")
			}
		}
	}

	private var unitsBinding: Binding<UnitSystem> {
		Binding(get: { display.units }, set: { if $0 != display.units { model.toggleUnits() } })
	}

	private func unitsLabel(_ u: UnitSystem) -> String {
		let name = u == .us ? "US" : "Metric"
		return display.sourceIsAsWritten && u == detail.sourceUnits ? "\(name) · as written" : name
	}
}

private struct StrikableLine: View {
	let text: String
	let number: Int?
	let isStruck: Bool
	let action: () -> Void
	@State private var taps = 0

	var body: some View {
		Button {
			action()
			taps += 1
		} label: {
			HStack(alignment: .firstTextBaseline, spacing: 8) {
				if let number {
					Text("\(number).").bold().foregroundStyle(.tint)
				}
				Text(text)
					.strikethrough(isStruck)
					.foregroundStyle(isStruck ? .secondary : .primary)
			}
			.font(.title3)
			.multilineTextAlignment(.leading)
			.frame(maxWidth: .infinity, alignment: .leading)
			.padding(.vertical, 6)
			.contentShape(.rect)
		}
		.buttonStyle(.plain)
		.sensoryFeedback(.impact(weight: .light), trigger: taps)
		.accessibilityAddTraits(isStruck ? .isSelected : [])
		.accessibilityValue(isStruck ? "struck" : "")
	}
}
