import UIKit
import UniformTypeIdentifiers
import WeCookedKit

/// What the share sheet handed over, reduced to the one input a capture takes.
/// Safari shares a URL plus the page title as text; the URL wins.
enum SharedInput: Sendable {
	case link(URL)
	case text(String)
	case images([Data])

	@MainActor static func read(_ items: [NSExtensionItem]) async -> SharedInput? {
		let providers = items.flatMap { $0.attachments ?? [] }
		for p in providers where p.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
			if let url = await load(p, .url, as: webURL) { return .link(url) }
		}
		for p in providers where p.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
			if let text = await load(p, .plainText, as: plainText) { return .text(text) }
		}
		var images: [Data] = []
		for p in providers where p.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
			guard images.count < CaptureRequest.maxImages else { break }
			if let data = await load(p, .image, as: imageData) { images.append(data) }
		}
		return images.isEmpty ? nil : .images(images)
	}

	/// The conversion runs inside the completion handler, so only a `Sendable`
	/// value crosses back.
	@MainActor private static func load<T: Sendable>(
		_ provider: NSItemProvider, _ type: UTType, as convert: @escaping @Sendable (Any) -> T?
	) async -> T? {
		await withCheckedContinuation { continuation in
			provider.loadItem(forTypeIdentifier: type.identifier, options: nil) { item, _ in
				continuation.resume(returning: item.flatMap(convert))
			}
		}
	}

	private static let webURL: @Sendable (Any) -> URL? = { item in
		guard let url = item as? URL, let scheme = url.scheme?.lowercased(),
			scheme == "http" || scheme == "https"
		else { return nil }
		return url
	}

	private static let plainText: @Sendable (Any) -> String? = { item in
		let text: String? =
			switch item {
			case let s as String: s
			case let a as NSAttributedString: a.string
			case let d as Data: String(data: d, encoding: .utf8)
			default: nil
			}
		guard let text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
		return text
	}

	/// Photos arrive as data or a file URL; a screenshot shared straight from
	/// the markup editor arrives as a `UIImage`.
	private static let imageData: @Sendable (Any) -> Data? = { item in
		switch item {
		case let d as Data: d
		case let u as URL where u.isFileURL: try? Data(contentsOf: u)
		case let i as UIImage: i.pngData()
		default: nil
		}
	}
}
