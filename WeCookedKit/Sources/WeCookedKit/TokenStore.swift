import Foundation
import Security
import os

/// The session token, in one place both the app and the share extension read.
/// Synchronous on purpose: a Keychain read is microseconds and every request
/// needs it. The token is a signed, year-long bearer string; the server rolls
/// it forward (`X-Session-Token`) and `APIClient` writes the new one back.
public protocol TokenStore: Sendable {
	func read() -> String?
	func write(_ token: String)
	func clear()
}

/// Keychain-backed store. `accessGroup` is the shared group
/// (`<TeamID>.kitchen.wecooked.shared`) both targets list in
/// `keychain-access-groups`; pass nil in tests and previews to use the
/// process's default group. Items are `afterFirstUnlock` so a background push
/// handler or the extension can read them while the phone is locked but has
/// been unlocked once since boot. Never synchronised to iCloud.
public struct KeychainTokenStore: TokenStore {
	public let service: String
	public let accessGroup: String?

	public init(service: String = "kitchen.wecooked.session", accessGroup: String?) {
		self.service = service
		self.accessGroup = accessGroup
	}

	private var query: [String: Any] {
		var q: [String: Any] = [
			kSecClass as String: kSecClassGenericPassword,
			kSecAttrService as String: service,
			kSecAttrAccount as String: "token",
			kSecAttrSynchronizable as String: false,
		]
		if let accessGroup { q[kSecAttrAccessGroup as String] = accessGroup }
		return q
	}

	public func read() -> String? {
		var q = query
		q[kSecReturnData as String] = true
		q[kSecMatchLimit as String] = kSecMatchLimitOne
		var out: CFTypeRef?
		guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess,
			let data = out as? Data
		else { return nil }
		return String(data: data, encoding: .utf8)
	}

	public func write(_ token: String) {
		let data = Data(token.utf8)
		let update = [kSecValueData as String: data]
		if SecItemUpdate(query as CFDictionary, update as CFDictionary) == errSecItemNotFound {
			var add = query
			add[kSecValueData as String] = data
			add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
			SecItemAdd(add as CFDictionary, nil)
		}
	}

	public func clear() {
		SecItemDelete(query as CFDictionary)
	}
}

/// For tests and previews. `OSAllocatedUnfairLock` makes it honestly `Sendable`.
public final class InMemoryTokenStore: TokenStore {
	private let box: OSAllocatedUnfairLock<String?>
	public init(_ token: String? = nil) { box = OSAllocatedUnfairLock(initialState: token) }
	public func read() -> String? { box.withLock { $0 } }
	public func write(_ token: String) { box.withLock { $0 = token } }
	public func clear() { box.withLock { $0 = nil } }
}

extension KeychainTokenStore {
	/// The store the app and the extension should use. On the simulator in
	/// Debug the shared access group has no signed entitlement behind it and
	/// every Keychain call fails with errSecMissingEntitlement, so the token
	/// lives in memory for the run instead; a device build always uses the
	/// Keychain.
	public static func automatic(accessGroup: String?) -> any TokenStore {
		#if DEBUG && targetEnvironment(simulator)
		return InMemoryTokenStore()
		#else
		return KeychainTokenStore(accessGroup: accessGroup)
		#endif
	}
}
