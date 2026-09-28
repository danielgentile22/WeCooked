import UIKit
import WeCookedKit

/// Placeholder for the share-sheet unit. Shape it will take:
///   1. read the URL / text / images from `extensionContext.inputItems`;
///   2. build `APIClient` from `KeychainTokenStore(accessGroup:)` and the base
///      URL in this target's Info.plist (`WCBaseURL`); no AppEnvironment;
///   3. images: `uploadImage(role: .capture)` each, then `capture(imageIds:)`;
///      URL or text (with the page caption for Instagram): `capture(text:)`;
///   4. write `wecooked://drafts/<job id>` to the app-group defaults key
///      `pendingLink`; the app reads it on foreground and routes via `DeepLink`;
///   5. `completeRequest`.
/// A push when extraction finishes later carries the same link.
final class ShareViewController: UIViewController {
	override func viewDidLoad() {
		super.viewDidLoad()
		extensionContext?.completeRequest(returningItems: nil)
	}
}
