import Foundation
import Testing

@testable import WeCookedKit

/// Access to the server-recorded replies in `Tests/Fixtures`.
enum Fixtures {
	static let directory: URL = Bundle.module.resourceURL!.appending(path: "Fixtures")

	static var names: [String] {
		let files = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
		return files.filter { $0.hasSuffix(".json") }.map { String($0.dropLast(5)) }.sorted()
	}

	static func data(_ name: String) throws -> Data {
		try Data(contentsOf: directory.appending(path: "\(name).json"))
	}
}
