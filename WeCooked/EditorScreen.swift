import SwiftUI
import WeCookedKit

/// One editor for three jobs (PRODUCT principle 4): review a draft, edit a
/// recipe, type a new one. It binds `model.form` and calls `model.save()`; the
/// rules live in `EditorForm`.
struct EditorScreen: View {
	@State var model: EditorModel
	@Environment(Router.self) private var router
	@Environment(\.dismiss) private var dismiss

	var body: some View {
		Group {
			if model.phase == .extracting {
				VStack(spacing: 16) {
					Banner(
						kind: .working,
						text: "Extracting… You can leave this page; the draft card on Recipes will be ready to review.")
					ProgressView()
				}
				.padding()
				.frame(maxHeight: .infinity, alignment: .top)
				.accessibilityIdentifier("editor.extracting")
			} else {
				EditorFields(model: model)
			}
		}
		.navigationTitle(title)
		.navigationBarTitleDisplayMode(.inline)
		.task { await model.appear() }
		.onChange(of: model.phase) { _, phase in
			switch phase {
			case .saved(let id):
				router.leaveEditor(showing: .recipe(id, savedVariation))
			case .removed:
				if case .recipe = model.origin { router.recipesPath = [] } else { dismiss() }
			default:
				break
			}
		}
	}

	private var title: String {
		switch model.origin {
		case .draft: "Review draft"
		case .recipe: "Edit recipe"
		case .manual: "New recipe"
		}
	}

	/// An edited variation reopens on that variation, as the web's `?v=` redirect.
	private var savedVariation: VariationID? {
		if case .recipe(_, let v) = model.origin { v } else { nil }
	}
}

/// Scroll targets: extraction warnings jump to a section, and a refused save
/// scrolls to the first issue.
private enum Anchor: Hashable { case top, title, yield, ingredients, steps, tags }

/// Where a focused text field lives, so "Add ingredient" and "Add step" can put
/// the cursor in the new line. Also the row identity in the lists below.
private enum Line: Hashable {
	case ingredient(group: Int, item: Int)
	case step(Int)
}

private struct EditorFields: View {
	@Bindable var model: EditorModel
	@Environment(AppEnvironment.self) private var env
	@State private var yieldText = ""
	@State private var confirmDiscard = false
	@State private var confirmReset = false
	@State private var confirmDelete = false
	@FocusState private var focus: Line?

	private var form: EditorForm { model.form }
	/// Seeded from something the server holds, so the unit toggle swaps bodies
	/// instead of naming the system being typed ("editing" on the web).
	private var isLoaded: Bool { form.baseline != nil }

	var body: some View {
		ScrollViewReader { proxy in
			Form {
				banners(proxy: proxy)
				titleSection
				photosSection
				yieldSection
				timesSection
				ingredientsSection
				stepsSection
				tagsSection
				sourceSection
				notesSection
				destructiveSection
			}
			.watching(env.store.resource(.vocabulary))
			.scrollDismissesKeyboard(.interactively)
			.toolbar {
				ToolbarItem(placement: .confirmationAction) {
					if model.phase == .saving {
						ProgressView()
					} else {
						Button("Save recipe") {
							focus = nil
							Task {
								await model.save()
								if let first = model.issues.first {
									withAnimation { proxy.scrollTo(scrollTarget(anchor(for: first)), anchor: .top) }
								}
							}
						}
						.accessibilityIdentifier("editor.save")
					}
				}
			}
			.confirmationDialog(
				"Delete “\(deleteTitle)”? You can restore it from Trash.", isPresented: $confirmDelete,
				titleVisibility: .visible
			) {
				Button("Delete recipe", role: .destructive) { Task { await model.deleteRecipe() } }
			}
		}
		.onAppear { yieldText = Self.format(form.yieldCount) }
		.onChange(of: form.yieldCount) { _, count in
			if (Self.parse(yieldText) ?? 0) != count { yieldText = Self.format(count) }
		}
	}

	// MARK: Banners

	@ViewBuilder private func banners(proxy: ScrollViewProxy) -> some View {
		let serverIssues = model.issues.compactMap { if case .server(let text) = $0 { text } else { nil } }
		let failed: String? = if case .extractionFailed(let text) = model.phase { text } else { nil }
		let hasBanners =
			failed != nil || model.recipeChanged || !serverIssues.isEmpty || !model.warnings.isEmpty
			|| model.damageReasoning != nil
		let rows = VStack(spacing: 8) {
			if let failed {
				Banner(kind: .error, text: failed, actionTitle: "Try again") { Task { await model.retryExtraction() } }
			}
			if model.recipeChanged {
				Banner(kind: .warning, text: "This recipe changed since you started editing")
			}
			ForEach(serverIssues, id: \.self) { Banner(kind: .error, text: $0) }
			ForEach(model.warnings, id: \.self) { warning in
				if let target = jumpTarget(warning) {
					Banner(kind: .warning, text: warning, actionTitle: "Jump to \(target == .steps ? "steps" : "ingredients")") {
						withAnimation { proxy.scrollTo(scrollTarget(target), anchor: .top) }
					}
				} else {
					Banner(kind: .warning, text: warning)
				}
			}
			if let reasoning = model.damageReasoning {
				Banner(kind: .info, text: "Damage: \(reasoning)")
			}
		}
		if hasBanners || pastedText != nil {
			Section {
				if hasBanners {
					rows
						.listRowInsets(EdgeInsets())
						.listRowBackground(Color.clear)
						.id(Anchor.top)
				}
				if let pasted = pastedText {
					DisclosureGroup("Pasted text") {
						Text(pasted)
							.font(.footnote.monospaced())
							.textSelection(.enabled)
					}
				}
			}
		}
	}

	/// A step list has no row of its own to land on, so a jump lands on step 1.
	private func scrollTarget(_ anchor: Anchor) -> AnyHashable {
		if anchor == .steps, !form.shown.steps.isEmpty { return Line.step(0) }
		return anchor
	}

	/// The web's rule: a warning that names steps or ingredients links there.
	private func jumpTarget(_ warning: String) -> Anchor? {
		if warning.localizedCaseInsensitiveContains("step") { return .steps }
		if warning.localizedCaseInsensitiveContains("ingredient") { return .ingredients }
		return nil
	}

	private var pastedText: String? {
		guard case .draft(let job) = model.origin,
			case .draft(let draft) = env.store.resource(.draft(job)).value
		else { return nil }
		return draft.sourceText
	}

	private func anchor(for issue: EditorIssue) -> Anchor {
		switch issue {
		case .titleRequired: .title
		case .yieldInvalid: .yield
		case .ingredientRequired: .ingredients
		case .effortRequired, .damageRequired: .tags
		case .server: .top
		}
	}

	/// Inline, under the section it is about. Icon plus words, never colour alone.
	@ViewBuilder private func issues(_ which: Set<EditorIssue>) -> some View {
		let found = model.issues.filter(which.contains)
		if !found.isEmpty {
			VStack(alignment: .leading, spacing: 4) {
				ForEach(found, id: \.self) { issue in
					Label(issue.message, systemImage: "exclamationmark.circle")
						.foregroundStyle(.red)
				}
			}
		}
	}

	// MARK: Title, photos, yield, times

	private var titleSection: some View {
		Section {
			TextField("Title", text: $model.form.title, axis: .vertical)
				.font(.title3.weight(.semibold))
				.accessibilityIdentifier("editor.title")
				.id(Anchor.title)
		} header: {
			Text("Title")
		} footer: {
			issues([.titleRequired])
		}
	}

	private var photosSection: some View {
		Section("Photos") {
			if !form.images.isEmpty {
				ScrollView(.horizontal) {
					HStack(spacing: 10) {
						ForEach(Array(form.images.enumerated()), id: \.element.id) { index, image in
							EditorThumb(
								url: image.url, index: index, isCover: form.coverImageId == image.id,
								makeCover: { model.form.coverImageId = image.id },
								remove: { model.form.removePhoto(image.id) })
						}
					}
					.padding(.vertical, 4)
				}
				.scrollIndicators(.hidden)
				.accessibilityLabel("Photos; tap one to make it the cover")
			}
			PhotoSources(identifier: "editor.photos.add", onJPEG: { await model.upload(photo: $0) }) {
				Label("Add photos", systemImage: "camera")
			}
			.buttonStyle(.borderless)
			if !model.uploads.isEmpty {
				let n = model.uploads.count
				HStack(spacing: 8) {
					ProgressView()
					Text("Uploading \(n) photo\(n > 1 ? "s" : "")…")
				}
				.foregroundStyle(.secondary)
			}
		}
	}

	private var yieldSection: some View {
		Section {
			HStack(spacing: 8) {
				Button { bumpYield(-1) } label: { Image(systemName: "minus").frame(width: 32, height: 32) }
					.accessibilityLabel("Decrease yield")
					.accessibilityIdentifier("editor.yield.minus")
				TextField("4", text: yieldBinding)
					.keyboardType(.decimalPad)
					.multilineTextAlignment(.center)
					.frame(width: 56)
					.padding(.vertical, 6)
					.background(.fill.tertiary, in: .rect(cornerRadius: 8))
					.accessibilityLabel("Yield count")
					.accessibilityIdentifier("editor.yield.count")
				Button { bumpYield(1) } label: { Image(systemName: "plus").frame(width: 32, height: 32) }
					.accessibilityLabel("Increase yield")
					.accessibilityIdentifier("editor.yield.plus")
				TextField("servings", text: $model.form.yieldUnit)
					.accessibilityLabel("Yield unit")
					.accessibilityIdentifier("editor.yield.unit")
			}
			.buttonStyle(.borderless)
			.id(Anchor.yield)
		} header: {
			Text("Yield")
		} footer: {
			issues([.yieldInvalid])
		}
	}

	/// Typed text is kept as typed ("1." mid-entry); the form gets its value, or
	/// 0 while it does not parse, which `payload()` reports as an invalid yield.
	private var yieldBinding: Binding<String> {
		Binding(
			get: { yieldText },
			set: {
				yieldText = $0
				model.form.yieldCount = Self.parse($0) ?? 0
			})
	}

	private func bumpYield(_ delta: Double) {
		let next = ((form.yieldCount + delta) * 10).rounded() / 10
		if next > 0 { model.form.yieldCount = next }
	}

	private static func parse(_ text: String) -> Double? {
		Double(text.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: "."))
			.flatMap { $0.isFinite ? $0 : nil }
	}

	private static func format(_ count: Double) -> String {
		count.formatted(.number.grouping(.never).locale(Locale(identifier: "en_US_POSIX")))
	}

	private var timesSection: some View {
		Section("Times") {
			HStack(spacing: 16) {
				minutesField("Prep minutes", \.prepMinutes, identifier: "editor.prep")
				minutesField("Cook minutes", \.cookMinutes, identifier: "editor.cook")
			}
		}
	}

	private func minutesField(
		_ label: String, _ path: WritableKeyPath<EditorForm, Int?>, identifier: String
	) -> some View {
		VStack(alignment: .leading, spacing: 4) {
			Text(label).font(.caption).foregroundStyle(.secondary)
			TextField(
				label,
				text: Binding(
					get: { model.form[keyPath: path].map(String.init) ?? "" },
					set: { model.form[keyPath: path] = Int($0.filter(\.isNumber)) }),
				prompt: Text("")
			)
			.keyboardType(.numberPad)
			.padding(.horizontal, 10)
			.padding(.vertical, 6)
			.background(.fill.tertiary, in: .rect(cornerRadius: 8))
			.accessibilityIdentifier(identifier)
		}
		.frame(maxWidth: .infinity, alignment: .leading)
	}

	// MARK: Ingredients and steps

	private var ingredientsSection: some View {
		Section {
			unitsRow.id(Anchor.ingredients)
			ForEach(form.shown.ingredients.indices, id: \.self) { g in
				groupHeadingRow(g)
				ForEach(form.shown.ingredients[g].items.indices.map { Line.ingredient(group: g, item: $0) }, id: \.self) {
					line in
					if case .ingredient(_, let i) = line { ingredientRow(group: g, item: i) }
				}
				Button {
					model.form.shown.ingredients[g].items.append("")
					focus = .ingredient(group: g, item: model.form.shown.ingredients[g].items.count - 1)
				} label: {
					Label("Add ingredient", systemImage: "plus")
				}
				.accessibilityIdentifier("editor.ingredient.add.\(g)")
			}
			Button {
				model.form.shown.ingredients.append(IngredientGroup(heading: nil, items: [""]))
				focus = .ingredient(group: model.form.shown.ingredients.count - 1, item: 0)
			} label: {
				Label("Add group", systemImage: "plus")
			}
			.accessibilityIdentifier("editor.group.add")
		} header: {
			Text("Ingredients")
		} footer: {
			issues([.ingredientRequired])
		}
	}

	/// New recipe: names the system being typed. Loaded: shows the other body,
	/// and is off until that body exists.
	private var unitsRow: some View {
		VStack(alignment: .leading, spacing: 6) {
			Text(isLoaded ? "Units" : "Written in").font(.caption).foregroundStyle(.secondary)
			Picker(
				"Unit system",
				selection: Binding(get: { model.form.shownUnits }, set: { model.form.show($0) })
			) {
				ForEach([UnitSystem.metric, .us], id: \.self) { units in
					Text(unitsLabel(units)).tag(units)
				}
			}
			.pickerStyle(.segmented)
			.disabled(isLoaded && form.other == nil)
			.accessibilityIdentifier("editor.units")
		}
	}

	private func unitsLabel(_ units: UnitSystem) -> String {
		let name = units == .us ? "US" : "Metric"
		return form.baseline?.sourceUnits == units ? "\(name) · as written" : name
	}

	private func groupHeadingRow(_ g: Int) -> some View {
		HStack(spacing: 8) {
			TextField(
				"Group heading (optional)",
				text: Binding(
					get: { form.shown.ingredients[safe: g]?.heading ?? "" },
					set: { value in
						guard model.form.shown.ingredients.indices.contains(g) else { return }
						model.form.shown.ingredients[g].heading = value.isEmpty ? nil : value
					})
			)
			.font(.subheadline.italic())
			.accessibilityLabel("Group heading")
			.accessibilityIdentifier("editor.group.\(g).heading")
			let groups = form.shown.ingredients.count
			if groups > 1 {
				LineControls(
					noun: "group", identifier: "editor.group.\(g)", isFirst: g == 0, isLast: g == groups - 1,
					move: { delta in
						focus = nil
						model.form.shown.ingredients.swapAt(g, g + delta)
					},
					remove: {
						focus = nil
						model.form.shown.ingredients.remove(at: g)
					})
			}
		}
	}

	private func ingredientRow(group g: Int, item i: Int) -> some View {
		let count = form.shown.ingredients[safe: g]?.items.count ?? 0
		return HStack(alignment: .firstTextBaseline, spacing: 4) {
			TextField(
				"Ingredient",
				text: Binding(
					get: { form.shown.ingredients[safe: g]?.items[safe: i] ?? "" },
					set: { value in
						guard model.form.shown.ingredients[safe: g]?.items.indices.contains(i) == true else { return }
						model.form.shown.ingredients[g].items[i] = value
					}),
				axis: .vertical
			)
			.focused($focus, equals: .ingredient(group: g, item: i))
			.accessibilityLabel("Ingredient line")
			.accessibilityIdentifier("editor.ingredient.\(g).\(i)")
			LineControls(
				noun: "ingredient", identifier: "editor.ingredient.\(g).\(i)", isFirst: i == 0,
				isLast: i == count - 1,
				move: { model.form.moveIngredient(group: g, from: i, by: $0) },
				remove: {
					focus = nil
					model.form.shown.ingredients[g].items.remove(at: i)
				})
		}
	}

	private var stepsSection: some View {
		Section {
			ForEach(form.shown.steps.indices.map { Line.step($0) }, id: \.self) { line in
				if case .step(let i) = line { stepRow(i) }
			}
			Button {
				model.form.shown.steps.append("")
				focus = .step(model.form.shown.steps.count - 1)
			} label: {
				Label("Add step", systemImage: "plus")
			}
			.accessibilityIdentifier("editor.step.add")
			.id(Anchor.steps)
		} header: {
			Text("Steps")
		} footer: {
			Text("Steps may be empty; a spice mix is a legal recipe.")
		}
	}

	private func stepRow(_ i: Int) -> some View {
		HStack(alignment: .top, spacing: 4) {
			Text("\(i + 1)").bold().foregroundStyle(.tint).frame(minWidth: 18, alignment: .leading)
			TextField(
				"Step \(i + 1)",
				text: Binding(
					get: { form.shown.steps[safe: i] ?? "" },
					set: { value in
						guard model.form.shown.steps.indices.contains(i) else { return }
						model.form.shown.steps[i] = value
					}),
				axis: .vertical
			)
			.lineLimit(2...8)
			.focused($focus, equals: .step(i))
			.accessibilityLabel("Step \(i + 1)")
			.accessibilityIdentifier("editor.step.\(i)")
			LineControls(
				noun: "step", identifier: "editor.step.\(i)", isFirst: i == 0,
				isLast: i == form.shown.steps.count - 1,
				move: { model.form.moveStep(from: i, by: $0) },
				remove: {
					focus = nil
					model.form.shown.steps.remove(at: i)
				})
		}
	}

	// MARK: Tags

	@ViewBuilder private var tagsSection: some View {
		let vocabulary = env.store.resource(.vocabulary)
		Section {
			if let vocab = vocabulary.value {
				ChipGroup(
					title: "Meal type", group: "meal", values: vocab.mealTypes, selected: form.mealTypes,
					label: \.title
				) { model.form.toggleMeal($0) }
				.id(Anchor.tags)
				ChipGroup(
					title: "Cuisine", group: "cuisine", values: vocab.cuisines, selected: form.cuisine.map { [$0] } ?? [],
					label: \.title
				) { model.form.toggleCuisine($0) }
				ChipGroup(
					title: "Protein", group: "protein", values: vocab.proteins, selected: form.protein.map { [$0] } ?? [],
					label: \.title
				) { model.form.toggleProtein($0) }
			} else {
				ProgressView().accessibilityLabel("Loading").id(Anchor.tags)
			}
			ChipGroup(
				title: "Effort (required)", group: "effort", values: Effort.allCases,
				selected: form.effort.map { [$0] } ?? [], label: \.word, collapses: false
			) { model.form.effort = $0 }
			ChipGroup(
				title: "Damage (required)", group: "damage", values: Damage.allCases,
				selected: form.damage.map { [$0] } ?? [], label: \.word, collapses: false
			) { model.form.damage = $0 }
		} header: {
			Text("Tags")
		} footer: {
			issues([.effortRequired, .damageRequired])
		}
	}

	// MARK: Source, notes

	private var sourceSection: some View {
		Section("Source") {
			VStack(alignment: .leading, spacing: 4) {
				Text("Where it came from").font(.caption).foregroundStyle(.secondary)
				TextField("Ottolenghi, Simple, p.112", text: optional(\.sourceText))
					.accessibilityIdentifier("editor.sourceText")
			}
			VStack(alignment: .leading, spacing: 4) {
				Text("URL").font(.caption).foregroundStyle(.secondary)
				TextField("URL", text: optional(\.sourceUrl), prompt: Text(""))
					.keyboardType(.URL)
					.textContentType(.URL)
					.textInputAutocapitalization(.never)
					.autocorrectionDisabled()
					.accessibilityIdentifier("editor.sourceUrl")
			}
		}
	}

	private var notesSection: some View {
		Section("Notes") {
			TextField("Notes", text: optional(\.notes), prompt: Text(""), axis: .vertical)
				.lineLimit(3...12)
				.accessibilityIdentifier("editor.notes")
		}
	}

	/// An empty field is "none", not an empty string.
	private func optional(_ path: WritableKeyPath<EditorForm, String?>) -> Binding<String> {
		Binding(
			get: { model.form[keyPath: path] ?? "" },
			set: { model.form[keyPath: path] = $0.isEmpty ? nil : $0 })
	}

	// MARK: Destructive zone (D10)

	private var destructiveSection: some View {
		Section {
			Button(confirmReset ? "Really start over? Tap again to discard your edits" : "Start over") {
				if confirmReset {
					confirmReset = false
					focus = nil
					model.startOver()
				} else {
					confirmReset = true
				}
			}
			.accessibilityIdentifier("editor.startOver")
			switch model.origin {
			case .draft:
				Button(confirmDiscard ? "Really discard this draft? Tap again" : "Discard draft", role: .destructive) {
					if confirmDiscard {
						confirmDiscard = false
						Task { await model.discardDraft() }
					} else {
						confirmDiscard = true
					}
				}
				.accessibilityIdentifier("editor.discard")
			case .recipe:
				Button("Delete recipe", role: .destructive) { confirmDelete = true }
					.accessibilityIdentifier("editor.delete")
			case .manual:
				EmptyView()
			}
		}
	}

	private var deleteTitle: String {
		guard case .recipe(let id, let v) = model.origin,
			let title = env.store.resource(.recipe(id, variation: v)).value?.recipe.title
		else { return form.title }
		return title
	}
}

/// Up, down and remove for one ingredient line or step (D9: arrows, no drag).
private struct LineControls: View {
	let noun: String
	let identifier: String
	let isFirst: Bool
	let isLast: Bool
	let move: (Int) -> Void
	let remove: () -> Void

	var body: some View {
		HStack(spacing: 0) {
			Button { move(-1) } label: { Image(systemName: "arrow.up").frame(width: 30, height: 30) }
				.disabled(isFirst)
				.accessibilityLabel("Move \(noun) up")
				.accessibilityIdentifier("\(identifier).up")
			Button { move(1) } label: { Image(systemName: "arrow.down").frame(width: 30, height: 30) }
				.disabled(isLast)
				.accessibilityLabel("Move \(noun) down")
				.accessibilityIdentifier("\(identifier).down")
			Button(action: remove) { Image(systemName: "xmark").frame(width: 30, height: 30) }
				.accessibilityLabel("Remove \(noun)")
				.accessibilityIdentifier("\(identifier).remove")
		}
		.buttonStyle(.borderless)
		.imageScale(.small)
		.fixedSize()
	}
}

/// One tag group. Multi- and single-select differ only in the `toggle` the
/// caller passes. Long groups collapse behind "Show all N", but a selected
/// value always stays visible.
private struct ChipGroup<T: Hashable>: View {
	let title: String
	let group: String
	let values: [T]
	let selected: [T]
	let label: (T) -> String
	var collapses = true
	let toggle: (T) -> Void
	@State private var expanded = false

	static var cutoff: Int { 8 }

	init(
		title: String, group: String, values: [T], selected: [T], label: @escaping (T) -> String,
		collapses: Bool = true, toggle: @escaping (T) -> Void
	) {
		self.title = title
		self.group = group
		self.values = values
		self.selected = selected
		self.label = label
		self.collapses = collapses
		self.toggle = toggle
	}

	private var isCollapsed: Bool { collapses && !expanded && values.count > Self.cutoff }

	private var visible: [T] {
		let listed = isCollapsed ? values.enumerated().filter { $0.offset < Self.cutoff || selected.contains($0.element) }.map(\.element) : values
		// A saved value the vocabulary no longer lists still shows, so it can be cleared.
		return listed + selected.filter { !values.contains($0) }
	}

	var body: some View {
		VStack(alignment: .leading, spacing: 8) {
			Text(title).font(.subheadline.weight(.medium))
			Flow {
				ForEach(visible, id: \.self) { value in
					Button { toggle(value) } label: {
						Chip(title: label(value), isSelected: selected.contains(value))
					}
					.buttonStyle(.plain)
					.accessibilityIdentifier("editor.tag.\(group).\(label(value))")
				}
				if isCollapsed {
					Button { expanded = true } label: { Chip(title: "Show all \(values.count)") }
						.buttonStyle(.plain)
						.accessibilityIdentifier("editor.tag.\(group).showAll")
				}
			}
		}
		.padding(.vertical, 4)
	}
}

/// A photo in the editor: tap to make it the cover, which carries a star and
/// the word, never a colour alone.
private struct EditorThumb: View {
	let url: URL
	let index: Int
	let isCover: Bool
	let makeCover: () -> Void
	let remove: () -> Void

	var body: some View {
		ZStack(alignment: .topTrailing) {
			Button(action: makeCover) {
				CachedImage(url: url)
					.frame(width: 96, height: 96)
					.clipShape(.rect(cornerRadius: 10))
					.overlay(alignment: .bottomLeading) {
						if isCover {
							Label("Cover", systemImage: "star.fill")
								.font(.caption2.weight(.semibold))
								.padding(.horizontal, 6)
								.padding(.vertical, 3)
								.background(.thinMaterial, in: .capsule)
								.padding(4)
						}
					}
			}
			.buttonStyle(.plain)
			.accessibilityLabel(isCover ? "Cover photo" : "Make cover photo")
			.accessibilityAddTraits(isCover ? .isSelected : [])
			.accessibilityIdentifier("editor.photo.\(index)")
			Button(action: remove) {
				Image(systemName: "xmark.circle.fill")
					.font(.title3)
					.symbolRenderingMode(.palette)
					.foregroundStyle(.white, .black.opacity(0.6))
			}
			.buttonStyle(.borderless)
			.padding(4)
			.accessibilityLabel("Remove photo")
			.accessibilityIdentifier("editor.photo.\(index).remove")
		}
	}
}

extension Array {
	fileprivate subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}
