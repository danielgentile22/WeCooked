import CoreGraphics
import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers

@testable import WeCookedKit

struct JPEGTests {
	/// A flat image of the given size, encoded as `type` with an EXIF
	/// orientation tag.
	static func image(width: Int, height: Int, type: UTType, orientation: Int = 1) throws -> Data {
		let space = CGColorSpaceCreateDeviceRGB()
		let ctx = try #require(CGContext(
			data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
			space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
		ctx.setFillColor(CGColor(red: 0.7, green: 0.3, blue: 0.1, alpha: 1))
		ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
		let cg = try #require(ctx.makeImage())
		let out = NSMutableData()
		let dest = try #require(CGImageDestinationCreateWithData(out, type.identifier as CFString, 1, nil))
		CGImageDestinationAddImage(dest, cg, [kCGImagePropertyOrientation: orientation] as CFDictionary)
		#expect(CGImageDestinationFinalize(dest))
		return out as Data
	}

	@Test func capsTheLongEdgeAtThreeThousand() throws {
		let big = try Self.image(width: 4000, height: 2000, type: .png)
		let out = try JPEG.normalise(big)
		let size = try #require(JPEG.size(of: out))
		#expect(size.width == 3000)
		#expect(size.height == 1500)
		#expect(out.starts(with: [0xFF, 0xD8]), "JPEG magic")
	}

	@Test func leavesSmallImagesAtTheirSizeAndAppliesOrientation() throws {
		let small = try Self.image(width: 300, height: 200, type: .jpeg, orientation: 6)
		let out = try JPEG.normalise(small)
		let size = try #require(JPEG.size(of: out))
		#expect(size.width == 200 && size.height == 300, "rotated 90 degrees, tag applied and dropped")
		let source = try #require(CGImageSourceCreateWithData(out as CFData, nil))
		let props = try #require(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
		#expect((props[kCGImagePropertyOrientation] as? Int ?? 1) == 1)
	}

	@Test func garbageIsUnreadable() {
		#expect(throws: JPEG.Failure.self) { try JPEG.normalise(Data("not an image".utf8)) }
	}
}
