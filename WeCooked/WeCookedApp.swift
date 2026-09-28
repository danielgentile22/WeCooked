import SwiftUI
import WeCookedKit

@main
struct WeCookedApp: App {
	@State private var env = Self.makeEnvironment()
	@State private var router = Router()
	@Environment(\.scenePhase) private var scenePhase

	var body: some Scene {
		WindowGroup {
			RootView()
				.environment(env)
				.environment(router)
				.onOpenURL { url in
					if let link = DeepLink(url: url) { router.open(link) }
				}
				// `initial: true` so a cold launch from the share extension also
				// picks up the link it left behind.
				.onChange(of: scenePhase, initial: true) { _, phase in
					switch phase {
					case .active:
						env.didBecomeActive()
						router.consumePendingLink(from: env)
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
		return AppEnvironment(
			config: config,
			tokens: KeychainTokenStore.automatic(accessGroup: config.keychainGroup),
			defaults: DefaultsStore(suiteName: config.appGroup),
			cachesDirectory: caches)
	}
}
