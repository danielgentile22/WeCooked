import SwiftUI
import WeCookedKit

/// The Generate path on the Add tab: a description, a yield count, one button.
/// A started generation lands on its draft screen on the Recipes tab, exactly
/// as Extract does, so Back returns to the list where the card lives.
struct GenerateScreen: View {
	@State var model: GenerateModel
	@Environment(Router.self) private var router
	@State private var yieldText = ""

	var body: some View {
		Form {
			Section {
				TextField(
					"What is in the fridge, how long you have, how much mess you can take",
					text: $model.description, axis: .vertical
				)
				.lineLimit(4...10)
				.accessibilityLabel("Description")
				.accessibilityIdentifier("generate.description")
			}
			Section("Yield") {
				HStack(spacing: 8) {
					Button { model.step(-1) } label: { Image(systemName: "minus").frame(width: 32, height: 32) }
						.accessibilityLabel("Decrease yield")
						.accessibilityIdentifier("generate.yield.minus")
					TextField("4", text: yieldBinding)
						.keyboardType(.numberPad)
						.multilineTextAlignment(.center)
						.frame(width: 56)
						.padding(.vertical, 6)
						.background(.fill.tertiary, in: .rect(cornerRadius: 8))
						.accessibilityLabel("Yield count")
						.accessibilityIdentifier("generate.yield.count")
					Button { model.step(1) } label: { Image(systemName: "plus").frame(width: 32, height: 32) }
						.accessibilityLabel("Increase yield")
						.accessibilityIdentifier("generate.yield.plus")
					Text("servings")
						.font(.subheadline)
						.foregroundStyle(.secondary)
				}
				.buttonStyle(.borderless)
			}
			if let error = model.error {
				Banner(kind: .error, text: error)
					.listRowInsets(EdgeInsets())
					.listRowBackground(Color.clear)
					.accessibilityIdentifier("generate.error")
			}
			Section {
				Button {
					Task {
						guard let job = await model.start() else { return }
						router.tab = .recipes
						router.recipesPath = [.draft(job)]
					}
				} label: {
					Label(model.isSubmitting ? "Starting…" : "Generate", systemImage: "wand.and.stars")
						.frame(maxWidth: .infinity)
				}
				.prominentButton()
				.controlSize(.large)
				.disabled(model.isSubmitting)
				.accessibilityIdentifier("generate.start")
			}
		}
		.navigationTitle("Describe what you want")
		.navigationBarTitleDisplayMode(.inline)
		.onAppear { yieldText = String(model.yieldCount) }
		.onChange(of: model.yieldCount) { _, count in
			if Int(yieldText) != count { yieldText = String(count) }
		}
	}

	/// Typed text is kept as typed (an empty field mid-entry); the model takes
	/// only a whole number in range, so the count never goes bad.
	private var yieldBinding: Binding<String> {
		Binding(
			get: { yieldText },
			set: {
				yieldText = $0
				model.set(yield: $0)
			})
	}
}
