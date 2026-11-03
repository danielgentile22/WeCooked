import Foundation
import Testing

@testable import WeCookedKit

struct ImageStoreTests {
	/// The store keeps its own disk copy keyed by path, so a download that also
	/// landed in the shared URL cache would be stored twice (issue #74).
	@Test func downloadsBypassTheSharedURLCache() async {
		let store = ImageStore(directory: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString))
		let config = await store.sessionConfiguration
		#expect(config.urlCache == nil)
		#expect(config.requestCachePolicy == .reloadIgnoringLocalCacheData)
	}

	@Test func keyIgnoresTheDailySignature() {
		let a = URL(string: "https://acct.r2.cloudflarestorage.com/b/images/x/display.jpg?X-Amz-Date=20260730T000000Z&X-Amz-Signature=aa")!
		let b = URL(string: "https://acct.r2.cloudflarestorage.com/b/images/x/display.jpg?X-Amz-Date=20260731T000000Z&X-Amz-Signature=bb")!
		#expect(ImageStore.key(for: a) == ImageStore.key(for: b))
	}
}
