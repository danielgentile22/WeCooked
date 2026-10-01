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
	public static let maxPhotos = CaptureRequest.maxImages

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
			error = "At most \(Self.maxPhotos) pages per recipe."
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

	/// Text or photos, never both: any photo on the strip means the photos are
	/// sent and the text is not. A lone link goes up with the rendered page
	/// (see `PageFetcher`); anything else is recipe text. Returns the draft to
	/// open. The caller pushes `Route.draft(job)`, where `EditorModel` waits on
	/// the job.
	public func extract() async -> JobID? {
		error = nil
		isSubmitting = true
		defer { isSubmitting = false }
		let request: @Sendable (APIClient) async throws -> JobID
		if photos.isEmpty {
			let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
			guard !trimmed.isEmpty else {
				error = "Paste some recipe text first."
				return nil
			}
			if let url = CaptureRequest.link(in: trimmed) {
				let html = await PageFetcher.html(of: url)
				request = { try await $0.capture(.url(url, html: html, text: nil)) }
			} else {
				request = { try await $0.capture(.text(trimmed)) }
			}
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
			request = { [ids] in try await $0.capture(.images(ids)) }
		}
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

/// The Generate path on the Add tab: a description and a yield count become
/// one `generate` job. Same shape as `CaptureModel.extract`: validate, post,
/// hand the job to the caller, who pushes `Route.draft(job)`.
@MainActor @Observable
public final class GenerateModel {
	public static let yieldRange = 1...100

	public var description = ""
	public private(set) var yieldCount = 4
	public private(set) var error: String?
	public private(set) var isSubmitting = false
	@ObservationIgnored private let env: AppEnvironment

	public init(env: AppEnvironment) { self.env = env }

	/// Minus and plus. Clamped, never starts work (ADR-012).
	public func step(_ delta: Int) {
		yieldCount = min(max(yieldCount + delta, Self.yieldRange.lowerBound), Self.yieldRange.upperBound)
	}

	/// The typed field. A whole number in range is taken; anything else leaves
	/// the count as it was, so a half-typed field cannot send a bad yield.
	public func set(yield text: String) {
		guard let n = Int(text.trimmingCharacters(in: .whitespaces)), Self.yieldRange.contains(n) else { return }
		yieldCount = n
	}

	/// Returns the job to open. The card goes onto the cached browse list at
	/// once (`Store.generationStarted`), which is also how the editor knows the
	/// running job is a generation.
	public func start() async -> JobID? {
		error = nil
		isSubmitting = true
		defer { isSubmitting = false }
		let trimmed = description.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !trimmed.isEmpty else {
			error = "Describe what you want to cook."
			return nil
		}
		do {
			let job = try await env.api.generate(GenerateRequest(description: trimmed, yieldCount: yieldCount))
			env.store.generationStarted(job, description: trimmed)
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
		/// A generation finished and nothing is picked yet: the deck shows, no form.
		case choosing(GenerationView)
		case editing
		case saving
		case saved(RecipeID)
		/// The draft was discarded or the recipe deleted: the screen leaves.
		case removed
	}

	/// "Find another photo". Pending while the server's cover job for this
	/// draft or recipe runs, whoever started it.
	public enum CoverSearch: Equatable, Sendable {
		case idle
		case pending
		case failed(String)
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
	public private(set) var coverSearch: CoverSearch = .idle
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
			if let cached = env.store.resource(.recipe(id, variation: v)).value { apply(cached) }
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
	/// Draft and recipe run until the task is cancelled (the screen's
	/// `.task`), so a retried extraction or a found cover is followed
	/// without another call.
	public func appear() async {
		switch origin {
		case .draft(let job):
			let resource = env.store.resource(.draft(job))
			await resource.revalidate()
			if resource.value == nil, case .failed(let e) = resource.phase {
				phase = .extractionFailed(e.message)
			}
			for await lookup in changes(of: { resource.value }) {
				if let lookup { apply(lookup, job: job) }
			}
		case .recipe(let id, let v):
			let resource = env.store.resource(.recipe(id, variation: v))
			await resource.revalidate()
			if resource.value == nil, case .failed(let e) = resource.phase {
				issues = [.server(e.message)]
			}
			// The Store refetches the recipe when its watched cover job ends.
			for await r in changes(of: { resource.value }) {
				if let r { apply(r) }
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
				_ = try await env.api.updateRecipe(id, input, variation: isOriginal(id, v) ? nil : v)
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

	/// The counterpart body's regeneration, read from the recipe reply the
	/// editor was seeded from. Nil for drafts and new recipes.
	public var reconvert: PendingWork? {
		guard case .recipe(let id, let v) = origin else { return nil }
		return env.store.resource(.recipe(id, variation: v)).value?.recipe.reconvert
	}

	/// "Tap to retry" on the failed banner. Refetches the recipe itself, since
	/// nothing watches it while the editor is on top, and `reconvert` reads
	/// the requeued job from that reply.
	public func retryReconvert() async {
		guard case .recipe(let id, let v) = origin else { return }
		issues = []
		do {
			try await env.api.retryReconvert(id, variation: isOriginal(id, v) ? nil : v)
			await env.store.resource(.recipe(id, variation: v)).revalidate()
		} catch {
			issues = [.server(APIError.wrapping(error).message)]
		}
	}

	/// Shown for a draft or a saved recipe whose cover is missing or found,
	/// never over a photo the household took.
	public var canFindCover: Bool {
		if case .manual = origin { return false }
		switch phase {
		case .editing, .saving: break
		case .extracting, .extractionFailed, .choosing, .saved, .removed: return false
		}
		guard let cover = form.coverImageId else { return true }
		return form.images.first { $0.id == cover }?.sourceUrl != nil
	}

	/// Each tap is a paid search, so the server refuses a second while one
	/// runs. The refetched reply names the job, and the reply after it ends
	/// carries the new photo.
	public func findAnotherCover() async {
		guard canFindCover, coverSearch != .pending else { return }
		coverSearch = .pending
		do {
			switch origin {
			case .draft(let job):
				_ = try await env.api.findCover(draft: job)
				await env.store.resource(.draft(job)).revalidate()
			case .recipe(let id, let v):
				_ = try await env.api.findCover(recipe: id)
				await env.store.resource(.recipe(id, variation: v)).revalidate()
			case .manual:
				return
			}
		} catch {
			coverSearch = .failed(APIError.wrapping(error).message)
		}
	}

	/// Role `photo`. Cover rules live in `EditorForm.addPhoto`.
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

	/// A `.draft` origin that is a generation: the deck, or a draft lookup
	/// whose kind says so (running, failed, or picked).
	public var isGeneration: Bool {
		guard case .draft(let job) = origin else { return false }
		if case .choosing = phase { return true }
		guard case .draft(let d) = env.store.resource(.draft(job)).value else { return false }
		return d.kind == .generate
	}

	/// "Pick this one" on a deck card. The row is now a draft seeded from that
	/// candidate; the refetched lookup moves the same screen to `.editing`.
	public func pick(_ index: Int) async {
		guard case .draft(let job) = origin, case .choosing = phase else { return }
		issues = []
		do {
			try await env.api.pick(job, index: index)
			let resource = env.store.resource(.draft(job))
			await resource.revalidate()
			if let lookup = resource.value { apply(lookup, job: job) }
		} catch {
			issues = [.server(APIError.wrapping(error).message)]
		}
	}

	/// "Try again" on the deck: a fresh generation from the same description,
	/// replacing this one. Returns the new job; the screen replaces its route.
	public func tryAgain() async -> JobID? {
		guard case .draft(let old) = origin, case .choosing(let g) = phase else { return nil }
		issues = []
		do {
			let job = try await env.api.generate(GenerateRequest(description: g.description, yieldCount: g.yieldCount))
			env.store.generationStarted(job, description: g.description)
			// The new set is already on its way, so a failed discard only
			// leaves the old card on the list for the user to discard.
			if (try? await env.api.discardDraft(old)) != nil { env.store.draftDiscarded(old) }
			return job
		} catch {
			issues = [.server(APIError.wrapping(error).message)]
			return nil
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
		case .extracting, .choosing, .saving, .saved, .removed: false
		}
	}

	/// The original is addressed without a variation id. A `.recipe(id, v)`
	/// origin learns which it is from the reply; uncached, nil means original.
	private func isOriginal(_ id: RecipeID, _ v: VariationID?) -> Bool {
		env.store.resource(.recipe(id, variation: v)).value?.recipe.isOriginal ?? (v == nil)
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
		case .extracting, .extractionFailed, .choosing, .editing: break
		}
		switch lookup {
		case .saved(let id):
			env.device.discardEditorDraft(.draft(job))
			phase = .saved(id)
		case .choosing(let g):
			phase = .choosing(g)
		case .draft(let d):
			warnings = d.warnings
			damageReasoning = d.damageReasoning
			let seed = { EditorForm(seed: d.initial ?? DraftSeed(images: []), units: self.env.device.units) }
			switch d.status {
			case .done:
				let previous = fresh
				adopt(seed(), key: .draft(job))
				syncFoundCover(images: d.initial?.images ?? [], coverImageId: d.initial?.coverImageId, previous: previous)
				trackCoverJob(d.coverJobId)
				phase = .editing
			case .failed, .timeout:
				adopt(seed(), key: .draft(job))
				phase = .extractionFailed(d.errorText ?? "Could not read that recipe. Try again.")
			case .queued, .running, .unknown:
				phase = .extracting
			}
		}
	}

	private func apply(_ r: RecipeResponse) {
		switch phase {
		case .saving, .saved, .removed: return
		case .extracting, .extractionFailed, .choosing, .editing: break
		}
		let previous = fresh
		adopt(EditorForm(recipe: r.recipe, units: env.device.units), key: .recipe(r.recipe.variationId))
		syncFoundCover(
			images: r.recipe.images.map { DraftImage(id: $0.id, url: $0.url, sourceUrl: $0.sourceUrl) },
			coverImageId: r.recipe.coverImageId, previous: previous)
		trackCoverJob(r.recipe.coverJobId)
	}

	/// An edited form keeps its own images, so a cover job's result is merged
	/// in: a replaced found cover is gone from the server and leaves the strip,
	/// and a newly found one joins it. `previous` is the server copy before this
	/// reply; a found cover already in it was seen, so a refetch neither re-adds
	/// one the cook removed nor takes the cover back.
	private func syncFoundCover(images: [DraftImage], coverImageId: ImageID?, previous: EditorForm?) {
		let live = Set(images.map(\.id))
		let replaced = Set(form.images.filter { $0.sourceUrl != nil && !live.contains($0.id) }.map(\.id))
		if !replaced.isEmpty {
			form.images.removeAll { replaced.contains($0.id) }
			if let cover = form.coverImageId, replaced.contains(cover) { form.coverImageId = nil }
		}
		guard let coverImageId, let image = images.first(where: { $0.id == coverImageId }),
			image.sourceUrl != nil, previous?.images.contains(where: { $0.id == coverImageId }) != true
		else { return }
		// A saved recipe's own photos are all in `images`, so the seed rule in
		// `adoptFoundCover` cannot tell that the cook picked one meanwhile.
		if let previous, let cover = form.coverImageId, cover != previous.coverImageId,
			form.images.first(where: { $0.id == cover })?.sourceUrl == nil {
			form.images.append(image)
		} else {
			form.adoptFoundCover(image, over: images)
		}
	}

	private func trackCoverJob(_ job: JobID?) {
		if job != nil {
			coverSearch = .pending
		} else if coverSearch == .pending {
			coverSearch = .idle
		}
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
