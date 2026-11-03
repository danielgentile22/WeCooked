import Foundation
import Testing

@testable import WeCookedKit

/// Cold start does no cache decoding or widget work before the first frame:
/// the environment reads nothing until the app calls `startFeeds()` (#78).
@MainActor
struct StartupTests {
	static func bareEnv() -> AppEnvironment {
		AppEnvironment(
			config: AppConfig(baseURL: URL(string: "http://localhost/api/v1/")!),
			tokens: InMemoryTokenStore("t"), defaults: DeviceStateTests.Memory(),
			cachesDirectory: FileManager.default.temporaryDirectory.appending(path: UUID().uuidString))
	}

	@Test func buildingTheEnvironmentReadsNoCache() {
		let env = Self.bareEnv()
		#expect(!env.store.holds(Key<ShoppingResponse>.shopping.name))
		#expect(!env.store.holds(Key<BrowseResponse>.recipes().name))
		#expect(!env.store.holds(Key<Vocabulary>.vocabulary.name))
	}

	@Test func startingTheFeedsIsIdempotentAndReadsTheirInputs() async {
		let env = Self.bareEnv()
		env.startFeeds()
		env.startFeeds()
		#expect(env.store.holds(Key<ShoppingResponse>.shopping.name))
		#expect(env.store.holds(Key<BrowseResponse>.recipes().name))
	}

	/// Each cover holds until it sees all three in flight; fetched one after
	/// another, the first would time out alone and come back missing.
	@Test func widgetCoversFetchConcurrentlyAndShrinkOffTheMainThread() async throws {
		let inFlight = CallCounter()
		let onMain = CallCounter()
		let png = try JPEGTests.image(width: 1200, height: 600, type: .png)
		let wanted = (0..<3).map { (name: "c\($0).jpg", url: URL(string: "https://r2.test/images/\($0)/display.jpg")!) }
		let covers = await SuggestionFile.shrinkCovers(
			wanted,
			fetch: { _ in
				_ = inFlight.next()
				for _ in 0..<100 where inFlight.count < 3 { try? await Task.sleep(for: .milliseconds(5)) }
				return inFlight.count < 3 ? nil : png
			},
			shrink: { data in
				if Thread.isMainThread { _ = onMain.next() }
				return try? JPEG.thumbnail(data, maxEdge: SuggestionFile.coverEdge)
			})
		#expect(Set(covers.keys) == ["c0.jpg", "c1.jpg", "c2.jpg"])
		#expect(onMain.count == 0)
		let first = try #require(covers["c0.jpg"])
		let size = try #require(JPEG.size(of: first))
		#expect(size.width == SuggestionFile.coverEdge)
	}
}
