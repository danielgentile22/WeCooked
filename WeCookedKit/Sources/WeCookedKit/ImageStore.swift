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

	/// The same normalisation for a bitmap that was never encoded: a camera
	/// shot or a shared screenshot. Draws it once at the capped size with the
	/// orientation applied and encodes once, so the shot skips the full-size
	/// encode and decode `normalise(_ data:)` would cost.
	public static func normalise(_ image: CGImage, orientation: CGImagePropertyOrientation) throws -> Data {
		let turned = orientation.rawValue >= 5
		let longEdge = max(image.width, image.height)
		let scale = longEdge > maxEdge ? CGFloat(maxEdge) / CGFloat(longEdge) : 1
		// The stored bitmap at the target scale, before turning.
		let w = (CGFloat(image.width) * scale).rounded()
		let h = (CGFloat(image.height) * scale).rounded()
		let (outW, outH) = turned ? (Int(h), Int(w)) : (Int(w), Int(h))
		let space =
			image.colorSpace.flatMap { $0.model == .rgb ? $0 : nil } ?? CGColorSpace(name: CGColorSpace.sRGB)!
		guard let ctx = CGContext(
			data: nil, width: outW, height: outH, bitsPerComponent: 8, bytesPerRow: 0,
			space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
		else { throw Failure.encodingFailed }
		ctx.interpolationQuality = .high
		ctx.concatenate(transform(orientation, width: w, height: h))
		ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
		guard let drawn = ctx.makeImage() else { throw Failure.encodingFailed }
		return try encode(drawn)
	}

	/// Maps the stored bitmap, drawn at (0, 0, w, h), onto the upright output
	/// in Core Graphics coordinates (y up). Each case is the EXIF meaning of
	/// the tag; `aBitmapComesOutAsTheTaggedFileWould` checks all eight
	/// against ImageIO.
	private static func transform(_ o: CGImagePropertyOrientation, width w: CGFloat, height h: CGFloat)
		-> CGAffineTransform
	{
		switch o {
		case .up: .identity
		case .upMirrored: CGAffineTransform(a: -1, b: 0, c: 0, d: 1, tx: w, ty: 0)
		case .down: CGAffineTransform(a: -1, b: 0, c: 0, d: -1, tx: w, ty: h)
		case .downMirrored: CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: 0, ty: h)
		case .leftMirrored: CGAffineTransform(a: 0, b: -1, c: -1, d: 0, tx: h, ty: w)
		case .right: CGAffineTransform(a: 0, b: -1, c: 1, d: 0, tx: 0, ty: w)
		case .rightMirrored: CGAffineTransform(a: 0, b: 1, c: 1, d: 0, tx: 0, ty: 0)
		case .left: CGAffineTransform(a: 0, b: 1, c: -1, d: 0, tx: h, ty: 0)
		@unknown default: .identity
		}
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
		guard let source = CGImageSourceCreateWithData(data as CFData, nil),
			let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
			let w = props[kCGImagePropertyPixelWidth] as? Int, let h = props[kCGImagePropertyPixelHeight] as? Int
		else { return nil }
		let orientation = props[kCGImagePropertyOrientation] as? UInt32 ?? 1
		return orientation >= 5 ? (h, w) : (w, h)
	}
}
