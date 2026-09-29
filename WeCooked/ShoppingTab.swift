import SwiftUI
import WeCookedKit

/// D11. List with sections, rows tick optimistically through
/// `ShoppingModel.setTicked`, "Add recipes" opens `PickRecipesSheet`, Done
/// shopping asks once with the web's confirmation text. Mirrors
/// `server/src/routes/shopping/+page.svelte` branch for branch.
struct ShoppingTab: View {
	@Environment(AppEnvironment.self) private var env

	var body: some View {
		ShoppingScreen(model: ShoppingModel(env: env))
	}
}

private struct ShoppingScreen: View {
	@State var model: ShoppingModel
	@Environment(Router.self) private var router
	@State private var manualText = ""
	@State private var staplesOpen = false
	@State private var confirmingDone = false

	var body: some View {
		Loaded(resource: model.resource) { _ in
			List {
				if let header { Text(header).font(.subheadline).foregroundStyle(.secondary).bare().accessibilityIdentifier("shopping-header") }
				banners
				switch model.phase {
				case .building: building
				case .empty: empty
				case .list: list
				}
			}
		}
		.navigationTitle("Shopping")
		.watching(model.resource, every: .seconds(5))
		.task { await model.appear() }
		.confirmationDialog(
			"Clear \(model.progress.total) items and all ticks on both phones? The list cannot be brought back.",
			isPresented: $confirmingDone, titleVisibility: .visible
		) {
			Button("Clear list", role: .destructive) { Task { await model.doneShopping() } }
		}
	}

	private var header: String? {
		if model.phase == .building { return "Building…" }
		guard model.hasList else { return nil }
		return "\(model.progress.ticked) of \(model.progress.total) ticked · ticks sync to both phones"
	}

	@ViewBuilder private var banners: some View {
		if let error = model.buildError {
			Banner(kind: .error, text: error, actionTitle: "Tap to retry") { Task { await model.retryBuild() } }
				.bare()
				.accessibilityIdentifier("shopping-build-failed")
		}
		if let notice = model.notice {
			Banner(kind: .success, text: notice, actionTitle: "Dismiss") { model.dismissNotice() }
				.bare()
				.accessibilityIdentifier("shopping-notice")
		}
		if let banner = model.banner {
			Banner(kind: .error, text: banner).bare().accessibilityIdentifier("shopping-error")
		}
	}

	@ViewBuilder private var building: some View {
		Banner(kind: .working, text: "Building your list. You can lock your phone; the build carries on.")
			.bare()
			.accessibilityIdentifier("shopping-build-banner")
		SwiftUI.Section {
			ForEach(0..<5, id: \.self) { _ in
				VStack(alignment: .leading, spacing: 4) {
					Text("An ingredient line to buy")
					Text("about the other units · a recipe").font(.caption)
				}
				.redacted(reason: .placeholder)
				.accessibilityElement(children: .ignore)
				.accessibilityLabel("Loading")
				.accessibilityIdentifier("shopping-skeleton")
			}
		}
	}

	private var empty: some View {
		VStack(spacing: 16) {
			Text("Pick recipes to build a list.").foregroundStyle(.secondary)
			Button("Add recipes", systemImage: "list.bullet.rectangle") { router.sheet = .pickRecipes }
				.buttonStyle(.borderedProminent)
				.accessibilityIdentifier("shopping-pick")
		}
		.frame(maxWidth: .infinity)
		.padding(.top, 48)
		.bare()
	}

	@ViewBuilder private var list: some View {
		ForEach(model.sections) { section in
			if section.isCollapsedByDefault {
				SwiftUI.Section {
					DisclosureGroup(isExpanded: $staplesOpen) {
						ForEach(section.rows) { ItemRow(row: $0, model: model) }
					} label: {
						Text("Check you have (\(section.rows.count))").font(.subheadline.weight(.semibold))
					}
				}
			} else {
				SwiftUI.Section(section.section.title) {
					ForEach(section.rows) { ItemRow(row: $0, model: model) }
				}
			}
		}
		SwiftUI.Section {
			HStack {
				TextField("Add item (bin bags, milk…)", text: $manualText)
					.onSubmit(addManual)
					.submitLabel(.done)
					.accessibilityIdentifier("shopping-add-field")
				Button("Add", systemImage: "plus", action: addManual)
					.buttonStyle(.bordered)
					.disabled(manualText.trimmingCharacters(in: .whitespaces).isEmpty)
					.accessibilityIdentifier("shopping-add")
			}
			HStack {
				Text("Show amounts in").font(.subheadline).foregroundStyle(.secondary)
				Spacer()
				ForEach([UnitSystem.metric, .us], id: \.self) { units in
					Button {
						if model.units != units { model.toggleUnits() }
					} label: {
						Chip(title: units == .us ? "US" : "Metric", isSelected: model.units == units)
					}
					.buttonStyle(.borderless)
					.accessibilityIdentifier("shopping-units-\(units.rawValue)")
				}
			}
		}
		SwiftUI.Section {
			Button("Done shopping", systemImage: "trash", role: .destructive) { confirmingDone = true }
				.accessibilityIdentifier("shopping-done")
			Button("Add or remove recipes", systemImage: "pencil") { router.sheet = .pickRecipes }
				.accessibilityIdentifier("shopping-pick")
		}
	}

	private func addManual() {
		let text = manualText
		guard !text.trimmingCharacters(in: .whitespaces).isEmpty else { return }
		Task {
			await model.addManual(text)
			if model.banner == nil && manualText == text { manualText = "" }
		}
	}
}

/// Ticked reads as a checkmark and a strike, never colour alone (row 70).
private struct ItemRow: View {
	let row: ShoppingRow
	let model: ShoppingModel

	var body: some View {
		Button {
			model.setTicked(row.id, !row.ticked)
		} label: {
			HStack(spacing: 12) {
				Image(systemName: row.ticked ? "checkmark.circle.fill" : "circle")
					.font(.title2)
					.foregroundStyle(row.ticked ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
				VStack(alignment: .leading, spacing: 2) {
					Text(row.primary)
						.fontWeight(.semibold)
						.strikethrough(row.ticked)
						.foregroundStyle(row.ticked ? .secondary : .primary)
					if let secondary = row.secondary {
						Text(secondary).font(.caption).foregroundStyle(.secondary)
					}
				}
				.frame(maxWidth: .infinity, alignment: .leading)
			}
			.contentShape(.rect)
		}
		.buttonStyle(.plain)
		.accessibilityIdentifier("item-\(row.primary)")
		.accessibilityValue(row.ticked ? "ticked" : "unticked")
	}
}

/// Pick mode over the same list rows as browse, whole-number yield stepper
/// (minimum 1) per picked recipe, "Build list from N recipes".
struct PickRecipesSheet: View {
	@Environment(AppEnvironment.self) private var env

	var body: some View {
		PickRecipesForm(model: ShoppingModel(env: env))
	}
}

/// The recipes ticked for the next build and the portions each is built for.
private struct PickDraft {
	var selected: Set<RecipeID>
	var yields: [RecipeID: Double]

	/// Selection from the current picks; yields from each recipe's original,
	/// overridden by the current picks.
	init(pickable: [PickableRecipe], picks: [ShoppingPick]) {
		selected = Set(picks.map(\.recipeId))
		yields = Dictionary(pickable.map { ($0.id, $0.yieldCount) }, uniquingKeysWith: { first, _ in first })
		for pick in picks { yields[pick.recipeId] = pick.yieldCount }
	}

	func yield(_ recipe: PickableRecipe) -> Double { yields[recipe.id] ?? recipe.yieldCount }

	mutating func step(_ recipe: PickableRecipe, by delta: Double) {
		yields[recipe.id] = max(1, (yield(recipe) + delta).rounded())
	}

	mutating func toggle(_ id: RecipeID) {
		if selected.contains(id) { selected.remove(id) } else { selected.insert(id) }
	}

	func picks(from pickable: [PickableRecipe]) -> [BuildPick] {
		pickable.filter { selected.contains($0.id) }.map { BuildPick(recipeId: $0.id, yieldCount: yield($0)) }
	}
}

private struct PickRecipesForm: View {
	@State private var model: ShoppingModel
	@State private var draft: PickDraft
	@State private var submitting = false
	@Environment(\.dismiss) private var dismiss
	@Environment(Router.self) private var router

	init(model: ShoppingModel) {
		_model = State(initialValue: model)
		_draft = State(initialValue: PickDraft(pickable: model.pickable, picks: model.picks))
	}

	var body: some View {
		NavigationStack {
			Group {
				if model.pickable.isEmpty {
					VStack(spacing: 12) {
						Text("No recipes yet.").foregroundStyle(.secondary)
						Button("Add one first.") {
							router.sheet = nil
							router.tab = .add
						}
					}
					.frame(maxWidth: .infinity, maxHeight: .infinity)
				} else {
					List {
						SwiftUI.Section {
							ForEach(model.pickable) { row($0) }
						} header: {
							Text("Pick recipes and portions")
						} footer: {
							Text("Builds from saved variations, generating any missing ones first. One job; it survives a locked phone.")
						}
					}
				}
			}
			.safeAreaInset(edge: .bottom) { actions }
			.navigationTitle("New shopping list")
			.navigationBarTitleDisplayMode(.inline)
		}
	}

	private func row(_ recipe: PickableRecipe) -> some View {
		let picked = draft.selected.contains(recipe.id)
		return HStack(spacing: 10) {
			Button {
				draft.toggle(recipe.id)
			} label: {
				HStack(spacing: 12) {
					Image(systemName: picked ? "checkmark.square.fill" : "square")
						.font(.title2)
						.foregroundStyle(picked ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
					VStack(alignment: .leading, spacing: 2) {
						Text(recipe.title).fontWeight(.semibold)
						Text("written for \(recipe.yieldCount.formatted()) \(recipe.yieldUnit)")
							.font(.caption).foregroundStyle(.secondary)
					}
					.multilineTextAlignment(.leading)
					.frame(maxWidth: .infinity, alignment: .leading)
				}
				.contentShape(.rect)
			}
			.buttonStyle(.borderless)
			.foregroundStyle(.primary)
			.accessibilityIdentifier("pick-row-\(recipe.title)")
			.accessibilityValue(picked ? "picked" : "not picked")
			if picked { stepper(recipe) }
		}
	}

	private func stepper(_ recipe: PickableRecipe) -> some View {
		VStack(spacing: 4) {
			HStack(spacing: 6) {
				Button { draft.step(recipe, by: -1) } label: { Image(systemName: "minus") }
					.accessibilityLabel("Fewer \(recipe.yieldUnit) of \(recipe.title)")
					.accessibilityIdentifier("pick-minus-\(recipe.title)")
				Button { draft.step(recipe, by: 1) } label: { Image(systemName: "plus") }
					.accessibilityLabel("More \(recipe.yieldUnit) of \(recipe.title)")
					.accessibilityIdentifier("pick-plus-\(recipe.title)")
			}
			.buttonStyle(.bordered)
			Text("\(draft.yield(recipe).formatted()) \(recipe.yieldUnit)")
				.font(.caption.weight(.semibold))
				.monospacedDigit()
				.lineLimit(1)
				.accessibilityIdentifier("pick-yield-\(recipe.title)")
		}
		.fixedSize()
	}

	private var actions: some View {
		let picks = draft.picks(from: model.pickable)
		return VStack(spacing: 10) {
			if let banner = model.banner {
				Banner(kind: .error, text: banner).accessibilityIdentifier("shopping-error")
			}
			if !model.pickable.isEmpty {
				Button {
					build(picks)
				} label: {
					Text(buildLabel(picks.count)).frame(maxWidth: .infinity)
				}
				.buttonStyle(.borderedProminent)
				.controlSize(.large)
				.disabled(picks.isEmpty || submitting)
				.accessibilityIdentifier("pick-build")
			}
			Button(model.hasList ? "Cancel, keep current list" : "Cancel") { dismiss() }
				.controlSize(.large)
				.accessibilityIdentifier("pick-cancel")
		}
		.padding()
		.background(.bar)
	}

	private func buildLabel(_ count: Int) -> String {
		switch count {
		case 0: "Pick at least one recipe"
		case 1: "Build list from 1 recipe"
		default: "Build list from \(count) recipes"
		}
	}

	private func build(_ picks: [BuildPick]) {
		submitting = true
		Task {
			await model.startBuild(picks)
			submitting = false
			if model.banner == nil { dismiss() }
		}
	}
}

private extension WeCookedKit.Section {
	/// The web's SECTION_LABELS.
	var title: String {
		switch self {
		case .produce: "Produce"
		case .meatFish: "Meat and fish"
		case .dairy: "Dairy"
		case .dryGoods: "Dry goods"
		case .spices: "Spices"
		case .frozen: "Frozen"
		case .other: "Other"
		case .staples: "Check you have"
		case .unknown(let wire): wire
		}
	}
}
