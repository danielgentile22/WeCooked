import SwiftUI
import UIKit
import WeCookedKit

/// Builds its own `APIClient` from the shared Keychain token and this target's
/// Info.plist; never the app's `AppEnvironment` or `Store`. On success the
/// draft's link goes to the app-group defaults, and the app opens it on its
/// next foreground.
final class ShareViewController: UIViewController {
	override func viewDidLoad() {
		super.viewDidLoad()
		let info = Bundle.main.infoDictionary ?? [:]
		let tokens = KeychainTokenStore.automatic(accessGroup: info["WCKeychainGroup"] as? String)
		let baseURL = URL(string: info["WCBaseURL"] as! String)!
		let model = ShareModel(
			client: APIClient(baseURL: baseURL, tokens: tokens),
			hasToken: tokens.read() != nil,
			appGroup: info["WCAppGroup"] as? String,
			context: extensionContext
		)
		let host = UIHostingController(rootView: ShareSheet(model: model))
		addChild(host)
		host.view.frame = view.bounds
		host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
		view.addSubview(host.view)
		host.didMove(toParent: self)
	}
}
