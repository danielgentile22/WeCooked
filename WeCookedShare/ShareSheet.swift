import SwiftUI

struct ShareSheet: View {
	let model: ShareModel

	var body: some View {
		@Bindable var model = model
		NavigationStack {
			Form {
				switch model.phase {
				case .loading:
					ProgressView().frame(maxWidth: .infinity)
				case .signedOut:
					Text("Sign in to We Cooked first")
				case .failed(let message):
					Text(message)
				case .ready(let content), .sending(let content):
					Section {
						preview(content)
						if case .images(let pages) = content { pageStatus(pages) }
					}
					if content.takesNote {
						Section {
							TextField("Caption or note", text: $model.note, axis: .vertical)
								.lineLimit(3...8)
								.disabled(isSending)
								.accessibilityIdentifier("share.note")
						}
					}
					Section {
						captureButton
					}
					.listRowInsets(EdgeInsets())
					.listRowBackground(Color.clear)
				}
			}
			.navigationTitle("We Cooked")
			.navigationBarTitleDisplayMode(.inline)
			.toolbar {
				ToolbarItem(placement: .cancellationAction) {
					Button(isDone ? "Close" : "Cancel") { model.close() }
						.accessibilityIdentifier("share.close")
				}
			}
		}
		.task { await model.start() }
	}

	private var isDone: Bool {
		switch model.phase {
		case .signedOut, .failed: true
		default: false
		}
	}

	private var isSending: Bool {
		if case .sending = model.phase { true } else { false }
	}

	private func preview(_ content: ShareModel.Content) -> some View {
		let line: String =
			switch content {
			case .link(let url): url.absoluteString
			case .text(let text):
				text.split(whereSeparator: \.isNewline).first.map(String.init) ?? text
			case .images(let pages): pages.count == 1 ? "1 screenshot" : "\(pages.count) screenshots"
			}
		return Text(line)
			.lineLimit(2)
			.truncationMode(.middle)
			.accessibilityIdentifier("share.preview")
	}

	private func pageStatus(_ pages: [ShareModel.Page]) -> some View {
		HStack(spacing: 12) {
			ForEach(pages) { page in
				switch page.state {
				case .uploading: ProgressView().controlSize(.small)
				case .uploaded: Image(systemName: "checkmark.circle.fill").foregroundStyle(.tint)
				}
			}
		}
		.accessibilityElement(children: .ignore)
		.accessibilityLabel(uploadedLabel(pages))
	}

	private func uploadedLabel(_ pages: [ShareModel.Page]) -> String {
		let done = pages.count { $0.state.imageID != nil }
		return "\(done) of \(pages.count) uploaded"
	}

	private var captureButton: some View {
		Button {
			Task { await model.capture() }
		} label: {
			Text(isSending ? "Capturing…" : "Capture")
				.frame(maxWidth: .infinity)
		}
		.buttonStyle(.borderedProminent)
		.controlSize(.large)
		.disabled(!model.canCapture)
		.accessibilityIdentifier("share.capture")
	}
}
