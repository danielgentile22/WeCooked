import Foundation
import Testing

@testable import WeCookedKit

struct CaptureRequestTests {
	private func encoded(_ request: CaptureRequest) throws -> NSDictionary {
		let data = try Wire.makeEncoder().encode(request)
		return try #require(JSONSerialization.jsonObject(with: data) as? NSDictionary)
	}

	@Test func urlWithHtmlAndTextSendsThreeKeys() throws {
		let r = CaptureRequest.url(
			URL(string: "https://example.com/reel/1")!, html: "<html></html>", text: "2 eggs")
		#expect(
			try encoded(r) == [
				"url": "https://example.com/reel/1", "html": "<html></html>", "text": "2 eggs",
			])
	}

	@Test func urlWithTextSendsBothKeys() throws {
		let r = CaptureRequest.url(URL(string: "https://example.com/reel/1")!, html: nil, text: "2 eggs")
		#expect(try encoded(r) == ["url": "https://example.com/reel/1", "text": "2 eggs"])
	}

	@Test func urlAloneOmitsTheOtherKeys() throws {
		let r = CaptureRequest.url(URL(string: "https://example.com/pie")!, html: nil, text: nil)
		#expect(try encoded(r) == ["url": "https://example.com/pie"])
	}

	@Test func textSendsOnlyText() throws {
		#expect(try encoded(.text("Pancakes\n2 eggs")) == ["text": "Pancakes\n2 eggs"])
	}

	@Test func imagesSendSnakeCaseIdsInOrder() throws {
		#expect(try encoded(.images(["i2", "i1"])) == ["image_ids": ["i2", "i1"]])
	}

	@Test(arguments: [
		("https://example.com/pie", "https://example.com/pie"),
		("http://example.com/pie?x=1", "http://example.com/pie?x=1"),
		("www.example.com/pie", "https://www.example.com/pie"),
	])
	func linkDetectionMirrorsTheServer(text: String, expected: String) {
		#expect(CaptureRequest.link(in: text)?.absoluteString == expected)
	}

	@Test(arguments: [
		"Pancakes\n2 eggs", "https://example.com/pie and more", "see www.example.com",
		"ftp://example.com", "example.com/pie", "",
	])
	func proseIsNotALink(text: String) {
		#expect(CaptureRequest.link(in: text) == nil)
	}
}
