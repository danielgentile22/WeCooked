import SwiftUI
import WeCookedKit

/// D3. One paste box, photos (library or camera, each through `JPEG.normalise`
/// then `CaptureModel.add(jpeg:)`), Extract, and "Type it in myself". An
/// extraction lands on its draft screen on the Recipes tab, so Back returns to
/// the list where the draft card lives.
struct AddTab: View {
	@State var model: CaptureModel
	@Environment(Router.self) private var router

	var body: some View {
		Form {
			Section {
				TextField("Paste recipe text here", text: $model.text, axis: .vertical)
					.lineLimit(7...14)
					.accessibilityLabel("Recipe text")
					.accessibilityIdentifier("add.paste")
				if model.photos.isEmpty {
					extractButton(title: "Extract", identifier: "add.extract")
				}
			}
			if let error = model.error {
				Banner(kind: .error, text: error)
					.listRowInsets(EdgeInsets())
					.listRowBackground(Color.clear)
					.accessibilityIdentifier("add.error")
			}
			Section {
				if !model.photos.isEmpty { strip }
				if let failure = uploadFailure {
					Banner(kind: .error, text: failure)
				}
				PhotoSources(
					remaining: CaptureModel.maxPhotos - livePhotos, identifier: "add.photos",
					onJPEG: { await model.add(jpeg: $0) }
				) {
					if isUploading {
						HStack(spacing: 8) {
							ProgressView()
							Text("Uploading…")
						}
					} else {
						Label(model.photos.isEmpty ? "Photograph a cookbook" : "Add another page", systemImage: "camera")
					}
				}
				.disabled(isUploading)
				if !model.photos.isEmpty {
					extractButton(title: pagesTitle, identifier: "add.extractPhotos")
						.disabled(isUploading)
				}
			}
			Section {
				NavigationLink(value: Route.newRecipe) {
					Label("Type it in myself", systemImage: "keyboard")
				}
				.accessibilityIdentifier("add.typeIt")
			}
		}
		.navigationTitle("Add a recipe")
	}

	private func extractButton(title: String, identifier: String) -> some View {
		Button {
			Task {
				guard let job = await model.extract() else { return }
				router.tab = .recipes
				router.recipesPath = [.draft(job)]
			}
		} label: {
			Label(model.isSubmitting ? "Starting…" : title, systemImage: "sparkles")
				.frame(maxWidth: .infinity)
		}
		.prominentButton()
		.controlSize(.large)
		.disabled(model.isSubmitting)
		.accessibilityIdentifier(identifier)
	}

	private var pagesTitle: String {
		model.photos.count == 1 ? "Extract this page" : "Extract these \(model.photos.count) pages"
	}

	private var isUploading: Bool {
		model.photos.contains { if case .uploading = $0.state { true } else { false } }
	}

	/// Failed pages are skipped by Extract, so they do not count toward the limit.
	private var livePhotos: Int {
		model.photos.count { if case .failed = $0.state { false } else { true } }
	}

	private var uploadFailure: String? {
		model.photos.lazy.compactMap { if case .failed(let text) = $0.state { text } else { nil } }.first
	}

	private var strip: some View {
		ScrollView(.horizontal) {
			HStack(spacing: 10) {
				ForEach(Array(model.photos.enumerated()), id: \.element.id) { index, photo in
					PageThumb(photo: photo, number: index + 1) { model.remove(photo.id) }
				}
			}
			.padding(.vertical, 4)
		}
		.scrollIndicators(.hidden)
		.accessibilityLabel("Cookbook pages, in order")
	}
}

/// A picked page: spinner while it uploads, the page once it is up, a warning
/// glyph if it failed. The remove button stays in every state.
private struct PageThumb: View {
	let photo: PendingPhoto
	let number: Int
	let remove: () -> Void

	var body: some View {
		ZStack(alignment: .topTrailing) {
			Group {
				switch photo.state {
				case .uploading:
					Rectangle().fill(.fill.tertiary).overlay { ProgressView() }
						.accessibilityLabel("Page \(number), uploading")
				case .uploaded(let image):
					CachedImage(url: image.url)
						.accessibilityLabel("Page \(number)")
				case .failed:
					Rectangle().fill(.fill.tertiary)
						.overlay { Image(systemName: "exclamationmark.triangle").font(.title2).foregroundStyle(.secondary) }
						.accessibilityLabel("Page \(number), upload failed")
				}
			}
			.frame(width: 84, height: 112)
			.clipShape(.rect(cornerRadius: 10))
			.accessibilityIdentifier("add.photo.\(number - 1)")
			Button(action: remove) {
				Image(systemName: "xmark.circle.fill")
					.font(.title3)
					.symbolRenderingMode(.palette)
					.foregroundStyle(.white, .black.opacity(0.6))
			}
			.buttonStyle(.borderless)
			.padding(4)
			.accessibilityLabel("Remove photo")
			.accessibilityIdentifier("add.photo.\(number - 1).remove")
		}
	}
}
