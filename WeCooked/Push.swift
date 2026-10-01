import SwiftUI
import UIKit
import UserNotifications
import WeCookedKit
import os

private let log = Logger(subsystem: "kitchen.wecooked", category: "push")

/// The one owner of push state on this phone. Whether the user has been asked
/// is not stored here: `UNNotificationSettings.authorizationStatus` is the
/// system's own record of it, so there is no second flag to keep in step.
@MainActor @Observable
final class PushCoordinator {
	@ObservationIgnored private let center = UNUserNotificationCenter.current()
	@ObservationIgnored var env: AppEnvironment?

	/// The first capture queued from this phone asks; never at launch. A phone
	/// that already said yes re-registers here too, so a capture after a
	/// reinstall reaches the server even before the next launch.
	func askIfNeeded() {
		Task {
			guard await center.notificationSettings().authorizationStatus == .notDetermined else {
				return registerIfAuthorized()
			}
			do {
				if try await center.requestAuthorization(options: [.alert, .sound]) {
					UIApplication.shared.registerForRemoteNotifications()
				}
			} catch {
				log.error("notification permission request failed: \(error)")
			}
		}
	}

	/// Every launch while signed in. Idempotent: the server upserts by device
	/// id, so registration follows the phone rather than the install.
	func registerIfAuthorized() {
		Task {
			switch await center.notificationSettings().authorizationStatus {
			case .authorized, .provisional, .ephemeral:
				UIApplication.shared.registerForRemoteNotifications()
			case .notDetermined, .denied:
				break
			@unknown default:
				break
			}
		}
	}

	/// A failure here is logged and never shown: push is an addition, and
	/// everything else works without it.
	func didRegister(deviceToken: Data) {
		guard let env else {
			log.error("push token arrived before the environment was attached")
			return
		}
		let token = deviceToken.map { String(format: "%02x", $0) }.joined()
		#if DEBUG
		let environment = PushEnvironment.sandbox
		#else
		let environment = PushEnvironment.production
		#endif
		Task {
			do {
				try await env.api.registerDevice(token: token, environment: environment)
				log.info("registered push token")
			} catch {
				log.error("push registration failed: \(error)")
			}
		}
	}
}

@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate {
	let push = PushCoordinator()

	/// A tap can arrive before SwiftUI has built `env` and `router` (a cold
	/// launch from the notification), so it waits here and replays on `attach`.
	private enum Wiring {
		case waiting(pending: DeepLink?)
		case attached(AppEnvironment, Router)
	}
	private var wiring: Wiring = .waiting(pending: nil)

	func attach(env: AppEnvironment, router: Router) {
		guard case .waiting(let pending) = wiring else { return }
		wiring = .attached(env, router)
		push.env = env
		if let pending { router.open(pending) }
	}

	func application(
		_ application: UIApplication,
		didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
	) -> Bool {
		UNUserNotificationCenter.current().delegate = self
		return true
	}

	func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
		push.didRegister(deviceToken: deviceToken)
	}

	func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
		log.error("remote notification registration failed: \(error)")
	}

	private func open(_ link: DeepLink) {
		log.info("push tap opens \(String(describing: link))")
		switch wiring {
		case .attached(_, let router): router.open(link)
		case .waiting: wiring = .waiting(pending: link)
		}
	}

	private func refresh(for link: DeepLink?) {
		log.info("push in foreground, refreshing")
		guard case .attached(let env, _) = wiring else { return }
		if case .draft(let job) = link {
			env.store.invalidate(.recipes, .draft(job))
		} else {
			env.store.invalidate(.recipes)
		}
	}
}

/// `@preconcurrency`: the center calls its delegate on the main queue, so the
/// main-actor methods satisfy the nonisolated requirements with a runtime
/// check instead of hops. The completion-handler forms are deliberate: the
/// async forms call UIKit's completion from the task's thread, and UIKit
/// asserts that it runs on the main one.
extension AppDelegate: @preconcurrency UNUserNotificationCenterDelegate {
	/// The payload is read once, here; everything past this point trusts `DeepLink`.
	func userNotificationCenter(
		_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
		withCompletionHandler completionHandler: @escaping () -> Void
	) {
		if let link = DeepLink(pushPayload: response.notification.request.content.userInfo) {
			open(link)
		} else {
			log.error("push tap carried no usable link")
		}
		completionHandler()
	}

	func userNotificationCenter(
		_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
		withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
	) {
		refresh(for: DeepLink(pushPayload: notification.request.content.userInfo))
		completionHandler([])
	}
}
