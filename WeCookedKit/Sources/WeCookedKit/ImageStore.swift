import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Image bytes, cached by the URL's host and path. The server's presigned URLs
/// change every day in the query string only (the signature), while the path
/// (`/bucket/images/<id>/display.jpg`) never does, so keying on the path means
/// a browse cover (which has no image id beside it) and a recipe photo both
/// hit the cache tomorrow. Bytes only: the app target turns `Data` into
/// `Image`, which keeps UIKit out of the package.
///
/// The presigned request carries its own credentials in the query string, so it
/// goes through a bare `URLSession`, never `APIClient` (no bearer header).
/// That session has no `URLCache`: this store's own disk copy is the cache, and
/// the shared URL cache would keep every image a second time (issue #74).
public actor ImageStore {
	private let directory: URL
	private let session: URLSession
	private var memory: [String: Data] = [:]
	private var recent: [String] = []
	private var inflight: [String: Task<Data?, Never>] = [:]
	private static let memoryLimit = 60

	/// One per process: image loads share connections, and none of them cache.
	public static let downloads: URLSession = {
		let config = URLSessionConfiguration.default
		config.urlCache = nil
		config.requestCachePolicy = .reloadIgnoringLocalCacheData
		return URLSession(configuration: config)
	}()

	public init(directory: URL, session: URLSession = ImageStore.downloads) {
		self.directory = directory
		self.session = session
	}

	var sessionConfiguration: URLSessionConfiguration { session.configuration }

	public static func key(for url: URL) -> String {
		(url.host() ?? "") + url.path()
	}

	private func file(_ key: String) -> URL {
		let safe = key.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? key
		return directory.appending(path: safe)
	}

	/// Memory, then disk, then network; concurrent asks for one path share one
	/// download. A failed download returns nil and is not cached, so the next
	/// appearance tries again.
	public func data(for url: URL) async -> Data? {
		let key = Self.key(for: url)
		if let d = memory[key] { return d }
		if let d = try? Data(contentsOf: file(key)) {
			remember(key, d)
			return d
		}
		if let t = inflight[key] { return await t.value }
		let session = session
		let task = Task<Data?, Never> {
			guard let (data, response) = try? await session.data(from: url),
				let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
				!data.isEmpty
			else { return nil }
			return data
		}
		inflight[key] = task
		let d = await task.value
		inflight[key] = nil
		if let d {
			remember(key, d)
			let target = file(key)
			try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
			try? d.write(to: target, options: .atomic)
		}
		return d
	}

	private func remember(_ key: String, _ d: Data) {
		memory[key] = d
		recent.removeAll { $0 == key }
		recent.append(key)
		while recent.count > Self.memoryLimit, let oldest = recent.first {
			recent.removeFirst()
			memory[oldest] = nil
		}
	}

	/// Sign-out.
	public func evictAll() {
		memory.removeAll()
		recent.removeAll()
		try? FileManager.default.removeItem(at: directory)
	}
}

/// Decoding at the size an image shows (issue #73). A 56pt row tile needs a
/// 168px square at 3x, not the 1200px display copy's 5.7 MB bitmap: ImageIO
/// decodes straight to the smaller size, orientation applied, and the app's
/// decoded cache charges each entry its bitmap bytes. CoreGraphics only, so it
/// runs in the package tests.
public enum ImageDecode {
	/// The frame in pixels, each side rounded up to 32 so a frame settling by
	/// a point or two keeps its decoded entry.
	public static func pixels(_ points: CGSize, scale: CGFloat) -> CGSize {
		func up(_ v: CGFloat) -> CGFloat { max(32, (v * scale / 32).rounded(.up) * 32) }
		return CGSize(width: up(points.width), height: up(points.height))
	}

	/// The decoded cache's key: the stored object (`ImageStore.key`, so the
	/// daily signature does not matter) at one frame size.
	public static func key(_ url: URL, pixels: CGSize) -> String {
		"\(ImageStore.key(for: url))@\(Int(pixels.width))x\(Int(pixels.height))"
	}

	/// Decoded just big enough to fill `pixels` the way `scaledToFill` does
	/// (the short side covers the frame), never above the source.
	public static func image(_ data: Data, toFill pixels: CGSize) -> CGImage? {
		guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
			let size = JPEG.size(of: source), size.width > 0, size.height > 0
		else { return nil }
		let fill = max(pixels.width / CGFloat(size.width), pixels.height / CGFloat(size.height))
		let longEdge = max(size.width, size.height)
		let options: [CFString: Any] = [
			kCGImageSourceCreateThumbnailFromImageAlways: true,
			kCGImageSourceCreateThumbnailWithTransform: true,
			kCGImageSourceThumbnailMaxPixelSize: min(longEdge, Int((CGFloat(longEdge) * fill).rounded(.up))),
			kCGImageSourceShouldCacheImmediately: true,
		]
		return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
	}

	/// What an entry costs the decoded cache: its bitmap bytes.
	public static func cost(of image: CGImage) -> Int { image.bytesPerRow * image.height }
}

/// Client-side normalisation before upload, mirroring `server/src/lib/images.ts`:
/// apply the EXIF orientation, cap the long edge at 3000 px, encode JPEG at
/// quality 0.9. ImageIO only, so it runs in the package tests and inside the
/// share extension.
public enum JPEG {
	public static let maxEdge = 3000
	public static let quality = 0.9
	public static let maxUploadBytes = 8 * 1024 * 1024

	public enum Failure: Error, Sendable { case unreadable, encodingFailed }

	public static func normalise(_ data: Data) throws -> Data { try thumbnail(data, maxEdge: maxEdge) }

	/// The same normalisation with a smaller cap, for the suggestion widget's covers.
	public static func thumbnail(_ data: Data, maxEdge: Int) throws -> Data {
		guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { throw Failure.unreadable }
		let options: [CFString: Any] = [
			kCGImageSourceCreateThumbnailFromImageAlways: true,
			kCGImageSourceCreateThumbnailWithTransform: true,
			kCGImageSourceThumbnailMaxPixelSize: maxEdge,
			kCGImageSourceShouldCacheImmediately: true,
		]
		guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
			throw Failure.unreadable
		}
		return try encode(image)
	}

	static func encode(_ image: CGImage) throws -> Data {
		let out = NSMutableData()
		guard let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else {
			throw Failure.encodingFailed
		}
		CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
		guard CGImageDestinationFinalize(dest) else { throw Failure.encodingFailed }
		return out as Data
	}

	/// Pixel size of an encoded image, after orientation. Used by tests and by
	/// the editor to show a photo's dimensions.
	public static func size(of data: Data) -> (width: Int, height: Int)? {
		CGImageSourceCreateWithData(data as CFData, nil).flatMap(size(of:))
	}

	static func size(of source: CGImageSource) -> (width: Int, height: Int)? {
		guard let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
			let w = props[kCGImagePropertyPixelWidth] as? Int, let h = props[kCGImagePropertyPixelHeight] as? Int
		else { return nil }
		let orientation = props[kCGImagePropertyOrientation] as? UInt32 ?? 1
		return orientation >= 5 ? (h, w) : (w, h)
	}
}
