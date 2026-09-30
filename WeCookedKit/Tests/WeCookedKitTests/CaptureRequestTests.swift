import Foundation
import Testing

@testable import WeCookedKit

struct CaptureRequestTests {
	private func encoded(_ request: CaptureRequest) throws -> NSDictionary {
		let data = try Wire.makeEncoder().encode(request)
		return try #require(JSONSerialization.jsonObject(with: data) as? NSDictionary)
	}

	@Test func urlWithTextSendsBothKeys() throws {
		let r = CaptureRequest.url(URL(string: "https://example.com/reel/1")!, text: "2 eggs")
		#expect(try encoded(r) == ["url": "https://example.com/reel/1", "text": "2 eggs"])
	}

	@Test func urlAloneOmitsTheTextKey() throws {
		let r = CaptureRequest.url(URL(string: "https://example.com/pie")!, text: nil)
		#expect(try encoded(r) == ["url": "https://example.com/pie"])
	}

	@Test func textSendsOnlyText() throws {
		#expect(try encoded(.text("Pancakes\n2 eggs")) == ["text": "Pancakes\n2 eggs"])
	}

	@Test func imagesSendSnakeCaseIdsInOrder() throws {
		#expect(try encoded(.images(["i2", "i1"])) == ["image_ids": ["i2", "i1"]])
	}
}
