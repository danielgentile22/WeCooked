import SwiftUI
import WeCookedKit

/// D3. One paste box, photos (PhotosPicker + camera, downsized in
/// `ImageEncoder` to a 3000 px long edge at JPEG 0.9 with orientation applied,
/// then `CaptureModel.add(jpeg:)`), Extract, and "type it in myself".
struct AddTab: View {
	@Environment(AppEnvironment.self) private var env
	@Environment(Router.self) private var router
	@State private var model: CaptureModel?

	var body: some View {
		// After `extract()` returns a JobID: router.tab = .recipes; router.recipesPath = [.draft(job)]
		// so the person lands on the draft screen that waits for extraction.
		NotBuiltYet()
			.navigationTitle("Add")
	}
}
