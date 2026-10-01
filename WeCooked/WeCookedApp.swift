import SwiftUI
import WeCookedKit
import WidgetKit

@main
struct WeCookedApp: App {
	@State private var env = Self.makeEnvironment()
	@State private var router = Router()
	@UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
	@Environment(\.scenePhase) private var scenePhase

	var body: some Scene {
		WindowGroup {
			RootView()
				.environment(env)
				.environment(router)
				.environment(delegate.push)
				.onOpenURL { url in
					if let link = DeepLink(url: url) { router.open(link) }
				}
				// Issue #42, story 17: a reinstall signs in before its next foreground, so the
				// token is re-registered the moment the session exists.
				.onChange(of: env.isSignedIn) { _, signedIn in
					if signedIn { delegate.push.registerIfAuthorized() }
				}
				// `initial: true` so a cold launch from the share extension also
				// picks up the link it left behind.
				.onChange(of: scenePhase, initial: true) { _, phase in
					// Idempotent. This is the first point where both exist, and a
					// notification tap that beat it is replayed here.
					delegate.attach(env: env, router: router)
					switch phase {
					case .active:
						env.didBecomeActive()
						// Issue #42, story 15: the first capture from either entry point asks.
						if case .draft = router.consumePendingLink(from: env) {
							delegate.push.askIfNeeded()
						}
						if env.isSignedIn { delegate.push.registerIfAuthorized() }
					case .background:
						env.didEnterBackground()
					default:
						break
					}
				}
		}
	}

	/// Reads WCBaseURL / WCKeychainGroup / WCAppGroup from Info.plist. A missing
	/// key is a build misconfiguration, so it traps at launch, not at first use.
	static func makeEnvironment() -> AppEnvironment {
		let info = Bundle.main.infoDictionary ?? [:]
		let base = URL(string: info["WCBaseURL"] as! String)!
		let config = AppConfig(
			baseURL: base, keychainGroup: info["WCKeychainGroup"] as? String,
			appGroup: info["WCAppGroup"] as? String)
		let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
			.appending(path: "kitchen.wecooked")
		let env = AppEnvironment(
			config: config,
			tokens: KeychainTokenStore.automatic(accessGroup: config.keychainGroup),
			defaults: DefaultsStore(suiteName: config.appGroup),
			cachesDirectory: caches)
		env.onSnapshotWritten = { WidgetCenter.shared.reloadTimelines(ofKind: SnapshotFile.widgetKind) }
		return env
	}
}
