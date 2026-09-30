import Foundation
import WebKit

/// Renders a page the way Mobile Safari would and returns its DOM, for sites
/// that 403 a bare server fetch (Serious Eats, Allrecipes) or fill in their
/// JSON-LD from a script (Pinterest). Nil means the page could not be
/// rendered in time; the server then fetches it itself.
@MainActor
public enum PageFetcher {
	/// The server's body limit leaves room for this plus the note.
	static let maxBytes = 4 << 20
	/// Client-rendered JSON-LD lands after `didFinish`; Pinterest needs about a second.
	static let settle: Duration = .seconds(1.5)

	public static func html(of url: URL, timeout: Duration = .seconds(15)) async -> String? {
		let rules = await blockRules()
		let loader = Loader(rules: rules)
		return await loader.load(url, timeout: timeout)
	}

	private static var rules: WKContentRuleList?

	/// Compiled once per process: the store caches by identifier on disk, but
	/// the lookup still costs a round trip to WebKit's content-blocker process.
	private static func blockRules() async -> WKContentRuleList? {
		if let rules { return rules }
		let json = """
			[{"trigger":{"url-filter":".*","resource-type":["image","media","font","svg-document"]},\
			"action":{"type":"block"}}]
			"""
		rules = try? await WKContentRuleListStore.default().compileContentRuleList(
			forIdentifier: "wecooked-no-media", encodedContentRuleList: json)
		return rules
	}

	/// Owns one web view for one load and resumes its continuation exactly
	/// once: from the settled `didFinish`, from a navigation failure, or from
	/// the timeout, whichever comes first. The web view is released when the
	/// load ends, which is what keeps the extension under its memory limit.
	@MainActor private final class Loader: NSObject, WKNavigationDelegate {
		private var webView: WKWebView?
		private var continuation: CheckedContinuation<String?, Never>?
		private var pending: [Task<Void, Never>] = []

		init(rules: WKContentRuleList?) {
			let configuration = WKWebViewConfiguration()
			configuration.websiteDataStore = .nonPersistent()
			if let rules { configuration.userContentController.add(rules) }
			webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 844), configuration: configuration)
			super.init()
			webView?.navigationDelegate = self
		}

		func load(_ url: URL, timeout: Duration) async -> String? {
			await withCheckedContinuation { continuation in
				self.continuation = continuation
				pending.append(Task { [weak self] in
					try? await Task.sleep(for: timeout)
					self?.finish(nil)
				})
				webView?.load(URLRequest(url: url))
			}
		}

		private func finish(_ html: String?) {
			guard let continuation else { return }
			self.continuation = nil
			for task in pending { task.cancel() }
			pending = []
			webView?.stopLoading()
			webView?.navigationDelegate = nil
			webView = nil
			continuation.resume(returning: html)
		}

		func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
			pending.append(Task { [weak self] in
				guard (try? await Task.sleep(for: PageFetcher.settle)) != nil else { return }
				await self?.readDocument()
			})
		}

		func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
			finish(nil)
		}

		func webView(
			_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error
		) {
			finish(nil)
		}

		private func readDocument() async {
			guard let webView, continuation != nil else { return }
			let result = try? await webView.evaluateJavaScript("document.documentElement.outerHTML")
			guard let html = result as? String, !html.isEmpty else { return finish(nil) }
			finish(Self.truncated(html))
		}

		private static func truncated(_ html: String) -> String {
			guard html.utf8.count > maxBytes else { return html }
			return String(decoding: html.utf8.prefix(maxBytes), as: UTF8.self)
		}
	}
}
