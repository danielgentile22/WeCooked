import Foundation
import Observation

// Everything between "I have a URL, some text or photos" and "it is a saved
// recipe". Two models: `CaptureModel` (the Add tab) and `EditorModel` (the
// review form for a draft, the edit form for a recipe, the blank form).

/// A photo on its way up. The app target downsizes (long edge 3000 px, JPEG
/// 0.9, EXIF orientation applied) before handing bytes here.
public struct PendingPhoto: Identifiable, Sendable {
	public enum State: Sendable { case uploading, uploaded(UploadedImage), failed(String) }
	public let id = UUID()
	public var state: State
}

@MainActor @Observable
public final class CaptureModel {
	public var text = ""
	public private(set) var photos: [PendingPhoto] = []
	public private(set) var error: String?
	public private(set) var isSubmitting = false
	@ObservationIgnored private let env: AppEnvironment

	public init(env: AppEnvironment) { self.env = env }

	/// Upload immediately on pick (role `capture`), as the web does; the
	/// thumbnail shows progress and failure copy "Could not upload a photo.
	/// Check the connection and try again."
	public func add(jpeg: Data) async { fatalError("not implemented") }
	public func remove(_ photo: PendingPhoto.ID) { fatalError("not implemented") }

	/// Text (URL or recipe text; the server decides which) or photos, never
	/// both. Returns the draft to open. The caller pushes `Route.draft(job)`,
	/// where `EditorModel` waits on the job.
	public func extract() async -> JobID? { fatalError("not implemented") }
}

@MainActor @Observable
public final class EditorModel {
	public enum Origin: Hashable, Sendable {
		case draft(JobID)
		case recipe(RecipeID, VariationID?)
		case manual
	}

	public enum Phase: Equatable, Sendable {
		/// Draft still extracting: a job is being followed.
		case extracting
		/// Draft failed: error banner with retry; the form beneath is blank plus link and photos.
		case extractionFailed(String)
		case editing
		case saving
		case saved(RecipeID)
	}

	public let origin: Origin
	public private(set) var phase: Phase
	public private(set) var issues: [EditorIssue] = []
	public private(set) var warnings: [String] = []
	public private(set) var damageReasoning: String?
	/// Every change is written through `device.saveEditorDraft` (debounced), and
	/// restored silently on reopen. "Start over" needs a second tap.
	public var form: EditorForm { didSet { persistDraft() } }

	@ObservationIgnored private let env: AppEnvironment

	public init(origin: Origin, env: AppEnvironment) { fatalError("not implemented") }

	/// Draft: watch the `DraftLookup` resource; while `status` is queued or
	/// running the Store is already waiting on the job and refetches the draft
	/// when it ends; on `.saved(id)` finish at once (reloading a saved draft
	/// redirects to the recipe). Recipe: seed from the cached `RecipeResponse`.
	/// Manual: blank form in the device's units.
	///
	/// Restoring an autosave: `device.editorDraft(key)` returns the form with
	/// the baseline it started from. If `saved.baselineDiffers(from: fresh)`
	/// the screen shows "This recipe changed since you started editing" with
	/// Start over, and the form used is `saved.rebased(onto: fresh)` so the
	/// payload rule diffs against what the server holds now.
	public func appear() async { fatalError("not implemented") }

	/// `form.payload()`; on `.incomplete` sets `issues` and stops. Otherwise
	/// create / update / saveDraft, then the matching `Store` effect
	/// (`recipeSaved`, `draftSaved`), discard the saved editor draft, and move
	/// to `.saved`. A 400 becomes an `issues`-style banner with the server text.
	public func save() async { fatalError("not implemented") }

	public func upload(photo jpeg: Data) async { fatalError("not implemented") }
	public func startOver() { fatalError("not implemented") }
	public func retryExtraction() async { fatalError("not implemented") }
	public func discardDraft() async { fatalError("not implemented") }
	public func deleteRecipe() async { fatalError("not implemented") }

	private func persistDraft() { /* env.device.saveEditorDraft(form, for: key) */ }
}
