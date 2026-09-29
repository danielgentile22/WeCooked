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

	/// The web's copy for a failed upload, on the Add tab and in the editor.
	public static let uploadFailedText = "Could not upload a photo. Check the connection and try again."
}

@MainActor @Observable
public final class CaptureModel {
	public static let maxPhotos = 8

	public var text = ""
	public private(set) var photos: [PendingPhoto] = []
	public private(set) var error: String?
	public private(set) var isSubmitting = false
	@ObservationIgnored private let env: AppEnvironment

	public init(env: AppEnvironment) { self.env = env }

	/// Upload immediately on pick (role `capture`), as the web does; the
	/// thumbnail shows progress and failure copy "Could not upload a photo.
	/// Check the connection and try again."
	public func add(jpeg: Data) async {
		error = nil
		let live = photos.filter { if case .failed = $0.state { false } else { true } }
		guard live.count < Self.maxPhotos else {
			error = "At most 8 pages per recipe."
			return
		}
		let photo = PendingPhoto(state: .uploading)
		photos.append(photo)
		let state: PendingPhoto.State
		do {
			state = .uploaded(try await env.api.uploadImage(jpeg, role: .capture))
		} catch {
			state = .failed(PendingPhoto.uploadFailedText)
		}
		if let i = photos.firstIndex(where: { $0.id == photo.id }) { photos[i].state = state }
	}

	/// Client-side only, as on the web: the uploaded image row is left unclaimed.
	public func remove(_ photo: PendingPhoto.ID) {
		photos.removeAll { $0.id == photo }
	}

	/// Text (URL or recipe text; the server decides which) or photos, never
	/// both: any photo on the strip means the photos are sent and the text is
	/// not. Returns the draft to open. The caller pushes `Route.draft(job)`,
	/// where `EditorModel` waits on the job.
	public func extract() async -> JobID? {
		error = nil
		let request: @Sendable (APIClient) async throws -> JobID
		if photos.isEmpty {
			let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
			guard !trimmed.isEmpty else {
				error = "Paste some recipe text first."
				return nil
			}
			request = { try await $0.capture(text: trimmed) }
		} else {
			var ids: [ImageID] = []
			for p in photos {
				switch p.state {
				case .uploading: return nil
				case .uploaded(let image): ids.append(image.id)
				case .failed: continue
				}
			}
			guard !ids.isEmpty else {
				error = "Add at least one photo first."
				return nil
			}
			request = { [ids] in try await $0.capture(imageIds: ids) }
		}
		isSubmitting = true
		defer { isSubmitting = false }
		do {
			let job = try await request(env.api)
			text = ""
			photos = []
			env.store.invalidate(.recipes)
			return job
		} catch {
			self.error = APIError.wrapping(error).message
			return nil
		}
	}
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
		/// The draft was discarded or the recipe deleted: the screen leaves.
		case removed
	}

	public let origin: Origin
	public private(set) var phase: Phase
	public private(set) var issues: [EditorIssue] = []
	public private(set) var warnings: [String] = []
	public private(set) var damageReasoning: String?
	/// The restored autosave was started from bodies the server no longer
	/// holds: show "This recipe changed since you started editing" with Start
	/// over. Cleared only by `startOver()`.
	public private(set) var recipeChanged = false
	/// Photos picked in the editor and still uploading. A finished upload
	/// leaves this list and joins `form.images`; a failed one leaves it and
	/// sets an issue.
	public private(set) var uploads: [PendingPhoto] = []
	/// Every change is written through `device.saveEditorDraft` (debounced), and
	/// restored silently on reopen. "Start over" needs a second tap.
	public var form: EditorForm { didSet { persistDraft() } }

	@ObservationIgnored private let env: AppEnvironment
	/// What the server holds now, as a form. The autosave is measured against
	/// it and Start over returns to it. Nil until the origin has been read.
	@ObservationIgnored private var fresh: EditorForm?
	/// Nil until known: a recipe's key is its variation id, which a
	/// `.recipe(id, nil)` origin learns from the reply.
	@ObservationIgnored private var key: EditorKey?
	@ObservationIgnored private var autosave: Task<Void, Never>?
	static let autosaveDelay: Duration = .milliseconds(400)

	public init(origin: Origin, env: AppEnvironment) {
		self.origin = origin
		self.env = env
		form = .blank(units: env.device.units)
		switch origin {
		case .draft(let job):
			phase = .extracting
			if let cached = env.store.resource(.draft(job)).value { apply(cached, job: job) }
		case .recipe(let id, let v):
			phase = .editing
			if let cached = env.store.resource(.recipe(id, variation: v)).value { adopt(recipe: cached) }
		case .manual:
			phase = .editing
			adopt(.blank(units: env.device.units), key: .manual)
		}
	}

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
	///
	/// For a draft this runs until the task is cancelled (the screen's
	/// `.task`), so a retried extraction is followed without another call.
	public func appear() async {
		switch origin {
		case .draft(let job):
			let resource = env.store.resource(.draft(job))
			await resource.revalidate()
			if resource.value == nil, case .failed(let e) = resource.phase {
				phase = .extractionFailed(e.message)
			}
			for await lookup in Observations({ resource.value }) {
				if let lookup { apply(lookup, job: job) }
			}
		case .recipe(let id, let v):
			let resource = env.store.resource(.recipe(id, variation: v))
			await resource.revalidate()
			if let r = resource.value {
				adopt(recipe: r)
			} else if case .failed(let e) = resource.phase {
				issues = [.server(e.message)]
			}
		case .manual:
			break
		}
	}

	/// `form.payload()`; on `.incomplete` sets `issues` and stops. Otherwise
	/// create / update / saveDraft, then the matching `Store` effect
	/// (`recipeSaved`, `draftSaved`), discard the saved editor draft, and move
	/// to `.saved`. A 400 becomes an `issues`-style banner with the server text.
	public func save() async {
		guard isEditable else { return }
		let input: RecipeInput
		switch form.payload() {
		case .incomplete(let found):
			issues = found
			return
		case .ready(let ready): input = ready
		}
		let before = phase
		issues = []
		phase = .saving
		do {
			let saved: RecipeID
			switch origin {
			case .draft(let job):
				saved = try await env.api.saveDraft(job, input)
				env.store.draftSaved(job, recipe: saved)
			case .recipe(let id, let v):
				let original = env.store.resource(.recipe(id, variation: v)).value?.recipe.isOriginal ?? (v == nil)
				_ = try await env.api.updateRecipe(id, input, variation: original ? nil : v)
				env.store.recipeSaved(id, input: input)
				saved = id
			case .manual:
				saved = try await env.api.createRecipe(input)
				env.store.recipeSaved(saved, input: input)
			}
			forgetAutosave()
			phase = .saved(saved)
		} catch {
			issues = [.server(APIError.wrapping(error).message)]
			phase = before
		}
	}

	/// Role `photo`. The first photo becomes the cover (`EditorForm.addPhoto`).
	public func upload(photo jpeg: Data) async {
		let pending = PendingPhoto(state: .uploading)
		uploads.append(pending)
		defer { uploads.removeAll { $0.id == pending.id } }
		do {
			let image = try await env.api.uploadImage(jpeg, role: .photo)
			form.addPhoto(DraftImage(id: image.id, url: image.url))
		} catch {
			issues = [.server(PendingPhoto.uploadFailedText)]
		}
	}

	/// The second tap of Start over: drop the autosave and return to what the
	/// server holds now.
	public func startOver() {
		forgetAutosave()
		recipeChanged = false
		issues = []
		if let fresh { form = fresh }
	}

	/// "Try again" on a failed draft. Drops the autosave as the web does; the
	/// running `appear()` follows the requeued job.
	public func retryExtraction() async {
		guard case .draft(let job) = origin else { return }
		let resource = env.store.resource(.draft(job))
		issues = []
		if case .draft(let d) = resource.value, d.status == .failed {
			do {
				try await env.api.retryDraft(job)
			} catch {
				issues = [.server(APIError.wrapping(error).message)]
				return
			}
		}
		forgetAutosave()
		fresh = nil
		phase = .extracting
		await resource.revalidate()
		if resource.value == nil, case .failed(let e) = resource.phase {
			phase = .extractionFailed(e.message)
		}
	}

	/// The second tap of Discard. The server refuses while still extracting.
	public func discardDraft() async {
		guard case .draft(let job) = origin else { return }
		await remove {
			try await $0.api.discardDraft(job)
			$0.store.draftDiscarded(job)
		}
	}

	/// After the screen's confirmation. The recipe goes to Trash.
	public func deleteRecipe() async {
		guard case .recipe(let id, _) = origin else { return }
		await remove {
			try await $0.api.deleteRecipe(id)
			$0.store.recipeDeleted(id)
		}
	}

	// MARK: - Private

	private var isEditable: Bool {
		switch phase {
		case .editing, .extractionFailed: true
		case .extracting, .saving, .saved, .removed: false
		}
	}

	private func remove(_ work: (AppEnvironment) async throws -> Void) async {
		issues = []
		do {
			try await work(env)
			forgetAutosave()
			phase = .removed
		} catch {
			issues = [.server(APIError.wrapping(error).message)]
		}
	}

	private func apply(_ lookup: DraftLookup, job: JobID) {
		switch phase {
		case .saving, .saved, .removed: return
		case .extracting, .extractionFailed, .editing: break
		}
		switch lookup {
		case .saved(let id):
			env.device.discardEditorDraft(.draft(job))
			phase = .saved(id)
		case .draft(let d):
			warnings = d.warnings
			damageReasoning = d.damageReasoning
			let seed = { EditorForm(seed: d.initial ?? DraftSeed(images: []), sourceText: d.sourceText, units: self.env.device.units) }
			switch d.status {
			case .done:
				adopt(seed(), key: .draft(job))
				phase = .editing
			case .failed, .timeout:
				adopt(seed(), key: .draft(job))
				phase = .extractionFailed(d.errorText ?? "Could not read that recipe. Try again.")
			case .queued, .running, .unknown:
				phase = .extracting
			}
		}
	}

	private func adopt(recipe r: RecipeResponse) {
		adopt(EditorForm(recipe: r.recipe, units: env.device.units), key: .recipe(r.recipe.variationId))
	}

	/// Take `next` as what the server holds. The working form is the autosave
	/// on first read, the form on screen after that unless it is untouched, in
	/// which case the newer server copy simply replaces it.
	private func adopt(_ next: EditorForm, key: EditorKey) {
		let working: EditorForm? =
			if let fresh { form == fresh ? nil : form } else { env.device.editorDraft(key) }
		self.key = key
		fresh = next
		if let working {
			if working.baselineDiffers(from: next) { recipeChanged = true }
			form = working.rebased(onto: next)
		} else {
			form = next
		}
	}

	/// Debounced. The autosave holds only work that differs from the server's
	/// copy, so opening and leaving an editor leaves nothing behind to restore.
	private func persistDraft() {
		autosave?.cancel()
		guard let key, let fresh, isEditable else { return }
		let form = form
		let device = env.device
		autosave = Task {
			try? await Task.sleep(for: Self.autosaveDelay)
			if Task.isCancelled { return }
			if form == fresh { device.discardEditorDraft(key) } else { device.saveEditorDraft(form, for: key) }
		}
	}

	private func forgetAutosave() {
		autosave?.cancel()
		autosave = nil
		if let key { env.device.discardEditorDraft(key) }
	}

	/// Test seam: the pending autosave, if any, has been written.
	func autosaveSettled() async { await autosave?.value }
}
