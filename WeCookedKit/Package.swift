// swift-tools-version: 6.2
import PackageDescription

// One library target, one test target. No dependencies: Foundation, Security,
// Observation and Testing ship with the toolchain.
//
// macOS is listed only so `swift test` runs the pure suites in seconds. The app
// and the share extension are iOS-only; nothing in the package touches UIKit,
// which keeps it legal inside an app extension.
let package = Package(
	name: "WeCookedKit",
	platforms: [.iOS(.v26), .macOS(.v26)],
	products: [.library(name: "WeCookedKit", targets: ["WeCookedKit"])],
	targets: [
		.target(
			name: "WeCookedKit",
			swiftSettings: [.swiftLanguageMode(.v6)]
		),
		.testTarget(
			name: "WeCookedKitTests",
			dependencies: ["WeCookedKit"],
			// The fixtures live beside the tests, not inside a target folder, because
			// the server tests write them there. `path: "Tests"` widens the target
			// root so `.copy("Fixtures")` is legal; `sources` keeps the Swift files
			// to one subfolder.
			path: "Tests",
			exclude: ["Fixtures/README.md"],
			sources: ["WeCookedKitTests"],
			resources: [.copy("Fixtures")],
			swiftSettings: [.swiftLanguageMode(.v6)]
		),
	]
)
