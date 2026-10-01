import Foundation

/// One install of the app on one phone, as the server's push sender knows it.
/// The app and the share extension read the same app-group defaults, so a
/// capture queued from either is tagged with the same id and its push reaches
/// this phone. Not part of `DeviceState`: sign-out keeps it, so signing back
/// in does not orphan the push token the server already holds.
public enum DeviceIdentity {
	public static let key = "deviceId"

	/// The stored id, or a new lowercase UUID stored on first call.
	public static func id(in store: any KeyValueStore) -> String {
		if let data = store.data(forKey: key), let id = String(data: data, encoding: .utf8), !id.isEmpty {
			return id
		}
		let id = UUID().uuidString.lowercased()
		store.set(Data(id.utf8), forKey: key)
		return id
	}
}
