import Foundation
import Observation
import WeCookedKit

/// The whole sheet as one state machine. The view reads `phase`; only this
/// type moves it.
@MainActor @Observable final class ShareModel {
	enum Phase {
		case loading
		case signedOut
		case ready(Content)
		case sending(Content)
		case failed(String)
	}

	enum Content {
		case link(URL)
		case text(String)
		case images([Page])

		/// The capture contract has nowhere to put text alongside images.
		var takesNote: Bool {
			if case .images = self { false } else { true }
		}
	}

	struct Page: Identifiable {
		let id: Int
		var state: PageState
	}

	/// No per-page failure: any failed upload fails the whole share.
	enum PageState {
		case uploading
		case uploaded(ImageID)

		var imageID: ImageID? {
			if case .uploaded(let id) = self { id } else { nil }
		}
	}

	static let unreachable = "Could not reach We Cooked. Try again."

	private(set) var phase: Phase = .loading
	var note = ""
	/// The shared page, rendering from the moment the sheet opens so Capture
	/// waits on as little of it as possible.
	@ObservationIgnored private var renderedHTML: Task<String?, Never>?

	private let client: APIClient
	private let hasToken: Bool
	private let appGroup: String?
	private let context: NSExtensionContext?

	init(client: APIClient, hasToken: Bool, appGroup: String?, context: NSExtensionContext?) {
		self.client = client
		self.hasToken = hasToken
		self.appGroup = appGroup
		self.context = context
	}

	var canCapture: Bool {
		switch phase {
		case .ready(.link), .ready(.text): true
		case .ready(.images(let pages)):
			pages.allSatisfy { $0.state.imageID != nil }
		default: false
		}
	}

	func start() async {
		guard hasToken else {
			phase = .signedOut
			return
		}
		switch await SharedInput.read(context?.inputItems as? [NSExtensionItem] ?? []) {
		case .link(let url):
			renderedHTML = Task { await PageFetcher.html(of: url) }
			phase = .ready(.link(url))
		case .text(let text): phase = .ready(.text(text))
		case .images(let images): await upload(images)
		case nil: phase = .failed("Nothing here to capture. Share a link, text or screenshots.")
		}
	}

	func capture() async {
		guard canCapture, case .ready(let content) = phase else { return }
		let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
		phase = .sending(content)
		let request: CaptureRequest =
			switch content {
			case .link(let url): .url(url, html: await renderedHTML?.value, text: trimmed.isEmpty ? nil : trimmed)
			case .text(let text): .text(trimmed.isEmpty ? text : text + "\n\n" + trimmed)
			case .images(let pages):
				.images(pages.compactMap(\.state.imageID))
			}
		do {
			let job = try await client.capture(request)
			UserDefaults(suiteName: appGroup)?.set(DeepLink.draft(job).url.absoluteString, forKey: DeepLink.pendingLinkKey)
			context?.completeRequest(returningItems: nil)
		} catch {
			phase = .failed(Self.copy(for: error))
		}
	}

	/// The server's own words when it answered; the sheet's copy when it did not.
	static func copy(for error: any Error) -> String {
		switch error as? APIError {
		case nil, .transport, .malformedReply, .rejected(""), .notFound(""), .rateLimited(""): unreachable
		case .some(let api): api.message
		}
	}

	func close() {
		context?.cancelRequest(withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError))
	}

	private func upload(_ images: [Data]) async {
		phase = .ready(.images(images.indices.map { Page(id: $0, state: .uploading) }))
		let client = client
		do {
			try await withThrowingTaskGroup(of: (Int, ImageID).self) { group in
				for (index, data) in images.enumerated() {
					// One decode at a time: ten full-size bitmaps at once can pass
					// the extension's memory limit. Uploads still overlap.
					let jpeg = try await Self.normalised(data)
					group.addTask { (index, try await client.uploadImage(jpeg, role: .capture).id) }
				}
				for try await (index, id) in group { markUploaded(index, id) }
			}
		} catch is JPEG.Failure {
			phase = .failed("One of these images could not be read. Try a screenshot instead.")
		} catch {
			phase = .failed(Self.copy(for: error))
		}
	}

	private func markUploaded(_ index: Int, _ id: ImageID) {
		guard case .ready(.images(var pages)) = phase else { return }
		pages[index].state = .uploaded(id)
		phase = .ready(.images(pages))
	}

	@concurrent private nonisolated static func normalised(_ data: Data) async throws -> Data {
		try JPEG.normalise(data)
	}
}
