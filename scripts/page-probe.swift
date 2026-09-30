import Foundation
import WebKit

// Loads each URL in an offscreen WKWebView from this Mac and prints what the
// DOM exposes: status, JSON-LD Recipe, og:description, text length. The proof
// behind ADR-041: run it at home, not from a datacenter.
//
//   swiftc -O scripts/page-probe.swift -o build/page-probe
//   build/page-probe https://www.seriouseats.com/bucatini-pasta-amatriciana-recipe

let probe = """
(() => {
  const blocks = [...document.querySelectorAll('script[type="application/ld+json"]')].map(s => s.textContent);
  const isRecipe = d => d && (d['@type'] === 'Recipe' || (Array.isArray(d['@type']) && d['@type'].includes('Recipe')));
  let recipe = null;
  for (const b of blocks) {
    try {
      const nodes = [JSON.parse(b)].flat();
      const graphs = nodes.flatMap(d => [d && d['@graph'] || []].flat());
      recipe = [...nodes, ...graphs].find(isRecipe) || null;
      if (recipe) break;
    } catch (e) {}
  }
  const meta = n => document.querySelector(`meta[property="${n}"],meta[name="${n}"]`)?.content || null;
  return JSON.stringify({
    title: document.title,
    htmlLen: document.documentElement.outerHTML.length,
    ldBlocks: blocks.length,
    recipeName: recipe ? recipe.name : null,
    ingredients: recipe ? (recipe.recipeIngredient || []).length : 0,
    ogDescription: (meta('og:description') || '').slice(0, 200),
    textLen: (document.body?.innerText || '').length
  });
})()
"""

final class Delegate: NSObject, WKNavigationDelegate {
	let done: (String) -> Void
	var status = 0
	init(done: @escaping (String) -> Void) { self.done = done }
	func webView(_ w: WKWebView, decidePolicyFor r: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
		if r.isForMainFrame, let h = r.response as? HTTPURLResponse { status = h.statusCode }
		decisionHandler(.allow)
	}
	func webView(_ w: WKWebView, didFinish n: WKNavigation!) {
		DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
			w.evaluateJavaScript(probe) { r, e in
				self.done("status=\(self.status) final=\(w.url?.absoluteString ?? "") \(r as? String ?? "error \(String(describing: e))")")
			}
			// PROBE_DUMP_DIR=dir saves each page's outerHTML as <host>.html, to feed the server's pageContent.
			if let dir = ProcessInfo.processInfo.environment["PROBE_DUMP_DIR"], let host = w.url?.host {
				w.evaluateJavaScript("document.documentElement.outerHTML") { r, _ in
					try? (r as? String)?.write(toFile: "\(dir)/\(host).html", atomically: true, encoding: .utf8)
				}
			}
		}
	}
	func webView(_ w: WKWebView, didFail n: WKNavigation!, withError e: Error) { done("didFail \(e)") }
	func webView(_ w: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) { done("didFailProvisionalNavigation \(e)") }
}

let cfg = WKWebViewConfiguration()
cfg.websiteDataStore = .nonPersistent()
let web = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 844), configuration: cfg)
// The Mac's default UA is desktop Safari; the phone sends this one on its own.
web.customUserAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1"

var queue = Array(CommandLine.arguments.dropFirst())
var delegate: Delegate?
func next() {
	guard let u = queue.first, let url = URL(string: u) else { exit(0) }
	queue.removeFirst()
	print("=== \(u)")
	let start = Date()
	var finished = false
	delegate = Delegate { out in
		guard !finished else { return }
		finished = true
		print(String(format: "%.1fs ", Date().timeIntervalSince(start)) + out)
		next()
	}
	web.navigationDelegate = delegate
	web.load(URLRequest(url: url))
	DispatchQueue.main.asyncAfter(deadline: .now() + 25) {
		guard !finished else { return }
		finished = true
		print("timeout")
		next()
	}
}
next()
RunLoop.main.run()
