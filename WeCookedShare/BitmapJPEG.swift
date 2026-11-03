import UIKit
import WeCookedKit

// Compiled into the app as well (project.yml): its camera and this
// extension's screenshots are both bitmaps, and the package keeps UIKit out.

extension JPEG {
	/// A camera shot or a shared screenshot, drawn once at the capped size with
	/// its orientation (issue #77). A bitmap UIKit holds only as a Core Image
	/// image goes the encoded way.
	static func normalise(_ image: UIImage) throws -> Data {
		guard let cg = image.cgImage else {
			guard let data = image.jpegData(compressionQuality: quality) else { throw Failure.unreadable }
			return try normalise(data)
		}
		return try normalise(cg, orientation: CGImagePropertyOrientation(image.imageOrientation))
	}
}

extension CGImagePropertyOrientation {
	init(_ orientation: UIImage.Orientation) {
		self =
			switch orientation {
			case .up: .up
			case .upMirrored: .upMirrored
			case .down: .down
			case .downMirrored: .downMirrored
			case .left: .left
			case .leftMirrored: .leftMirrored
			case .right: .right
			case .rightMirrored: .rightMirrored
			@unknown default: .up
			}
	}
}
