import Foundation
import Observation

/// Where the app runs. The app target reads these from Info.plist build
/// settings (`WCBaseURL`, `WCKeychainGroup`, `WCAppGroup`), so Debug points at
/// a local server and Release at wecooked.kitchen with no code change.
public struct AppConfig: Sendable {
	/// Ends in `/api/v1/`.
	public var baseURL: URL
	/// `<TeamID>.kitchen.wecooked.shared`, or nil in tests.
	public var keychainGroup: String?
	/// `group.kitchen.wecooked`, or nil in tests.
	public var appGroup: String?
	public init(baseURL: URL, keychainGroup: String? = nil, appGroup: String? = nil) {
		self.baseURL = baseURL
		self.keychainGroup = keychainGroup
		self.appGroup = appGroup
	}
}

/// The composition root. The app builds one; the share extension builds a
/// leaner one from `APIClient` alone. Every screen model takes this and
/// nothing else, so there is one place that says what the app is made of.
///
/// 401 handling without a cycle: the client yields to a stream, the
/// environment listens and signs out. The client knows nothing about the app.
@MainActor @Observable
public final class AppEnvironment {
	public private(set) var isSignedIn: Bool

	@ObservationIgnored public let config: AppConfig
	@ObservationIgnored public let tokens: any TokenStore
	@ObservationIgnored public let api: APIClient
	@ObservationIgnored public let store: Store
	@ObservationIgnored public let device: DeviceState
	@ObservationIgnored public let images: ImageStore
	/// This install's `DeviceIdentity`, already on every request `api` sends.
	@ObservationIgnored public let deviceID: String
	/// Kept in step with the shopping list for the widget; see `feedWidget`.
	@ObservationIgnored public let widgetSnapshot: SnapshotFile
	/// Called after each write or removal of `widgetSnapshot`. The app sets it
	/// to reload the widget's timelines; the package knows nothing of WidgetKit.
	@ObservationIgnored public var onSnapshotWritten: @MainActor @Sendable () -> Void = {}

	public init(
		config: AppConfig, tokens: any TokenStore, defaults: any KeyValueStore,
		cachesDirectory: URL, session: URLSession = .shared
	) {
		let (unauthorized, signal) = AsyncStream<Void>.makeStream()
		let deviceID = DeviceIdentity.id(in: defaults)
		let api = APIClient(
			baseURL: config.baseURL, tokens: tokens, deviceID: deviceID, session: session,
			onUnauthorized: { signal.yield() })
		self.deviceID = deviceID
		self.config = config
		self.tokens = tokens
		self.api = api
		self.store = Store(
			api: api, cache: DiskCache(directory: cachesDirectory.appending(path: "v1")),
			poller: JobPoller(api: api))
		self.device = DeviceState(store: defaults)
		self.images = ImageStore(directory: cachesDirectory.appending(path: "images"))
		self.widgetSnapshot = SnapshotFile(appGroup: config.appGroup)
		self.isSignedIn = tokens.read() != nil
		Task { [weak self] in
			for await _ in unauthorized { self?.signOut() }
		}
		feedWidget()
	}

	/// Rewrites the widget's file whenever the shopping reply, the section
	/// order, the unit system or the outbox changes, so the widget shows what
	/// the tab would. Nothing is written before the first reply (an absent
	/// file and an empty list read differently) or while signed out; the
	/// second check runs at write time because a value read just before
	/// `signOut` can still be waiting in the stream.
	private func feedWidget() {
		let inputs = changes { [weak self] () -> ShoppingSnapshot? in
			guard let self, isSignedIn, let reply = store.resource(.shopping).value else { return nil }
			return ShoppingSnapshot(
				items: reply.list.items,
				order: store.resource(.vocabulary).value?.sectionOrder ?? Section.known,
				units: device.units, pending: device.pendingTicks, now: .now)
		}
		Task { [weak self] in
			for await snapshot in inputs {
				guard let self, let snapshot, isSignedIn else { continue }
				widgetSnapshot.write(snapshot)
				onSnapshotWritten()
			}
		}
	}

	public func logIn(password: String) async throws {
		try await api.login(password: password)
		isSignedIn = true
	}

	public func signOut() {
		tokens.clear()
		store.wipe()
		device.wipe()
		widgetSnapshot.remove()
		onSnapshotWritten()
		isSignedIn = false
	}

	/// Scene phase, forwarded. Waits stop in the background and restart on
	/// resume from the cached replies, with a fresh five minute budget.
	public func didEnterBackground() { store.suspend() }
	public func didBecomeActive() { store.resume() }
}

/// Somewhere in the app that something outside it can point at. The grammar
/// is the web app's routes, so one parser serves a universal link
/// (`https://wecooked.kitchen/drafts/<id>`), the custom scheme with the same
/// path (`wecooked://drafts/<id>`), a push payload's `link`, and the share
/// extension's hand-off. The app's `Router` is the only consumer.
public enum DeepLink: Hashable, Sendable {
	case recipes
	case recipe(RecipeID, variation: VariationID?)
	case draft(JobID)
	case add
	case shopping
	case trash

	public static let scheme = "wecooked"
	/// App-group defaults key where the share extension leaves a `url` string
	/// for the app to open on its next foreground.
	public static let pendingLinkKey = "pendingLink"

	public init?(url: URL) {
		guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
		let pathSegments = url.pathComponents.filter { $0 != "/" }
		let segments: [String]
		switch parts.scheme {
		case Self.scheme:
			// `wecooked://drafts/<id>` parses "drafts" as the host.
			segments = (parts.host.map { [$0] } ?? []) + pathSegments
		case "http", "https":
			segments = pathSegments
		default:
			return nil
		}
		let variation = parts.queryItems?.first { $0.name == "v" }?.value.map { VariationID($0) }
		self.init(segments: segments, variation: variation)
	}

	/// A path as the web app spells it: `/`, `/recipes/<id>`, `/drafts/<id>`,
	/// `/add`, `/shopping`, `/trash`.
	public init?(path: String) {
		guard let url = URL(string: "\(Self.scheme)://" + path.drop(while: { $0 == "/" })) else { return nil }
		self.init(url: url)
	}

	private init?(segments: [String], variation: VariationID?) {
		switch (segments.first, segments.dropFirst().first, segments.count) {
		case (nil, _, _), ("recipes", nil, 1): self = .recipes
		case ("recipes", let id?, 2) where !id.isEmpty: self = .recipe(RecipeID(id), variation: variation)
		case ("drafts", let id?, 2) where !id.isEmpty: self = .draft(JobID(id))
		case ("add", nil, 1): self = .add
		case ("shopping", nil, 1): self = .shopping
		case ("trash", nil, 1): self = .trash
		default: return nil
		}
	}

	public init?(pushPayload: [AnyHashable: Any]) {
		guard let s = pushPayload["link"] as? String, let url = URL(string: s) else { return nil }
		self.init(url: url)
	}

	/// The custom-scheme spelling, for the share extension's hand-off.
	public var url: URL {
		let path: String
		switch self {
		case .recipes: path = "recipes"
		case .recipe(let id, let v): path = "recipes/\(id)" + (v.map { "?v=\($0)" } ?? "")
		case .draft(let id): path = "drafts/\(id)"
		case .add: path = "add"
		case .shopping: path = "shopping"
		case .trash: path = "trash"
		}
		return URL(string: "\(Self.scheme)://\(path)")!
	}
}
