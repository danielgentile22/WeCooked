# Recipe Book v1: tech stack research

> Pre-build research, kept as delivered. Several recommendations were later
> overruled (for example Opus instead of Sonnet in ADR-016, one shared
> password instead of two accounts in ADR-008). [DECISIONS.md](../DECISIONS.md)
> is authoritative.

Researched 2026-07-27. All sources are first-party (official docs, source repos, specs, official pricing pages) and were accessed on 2026-07-27 unless noted.

## Recommendation

Build it as a **single SvelteKit app** (`adapter-node`, TypeScript, server routes as the backend, no separate API service), deployed as one **Fly machine** with `min_machines_running = 1`, storing data in **SQLite on a Fly volume continuously replicated to Cloudflare R2 with Litestream**, and recipe photos in the same **R2** bucket. Authenticate with a **single server-set `HttpOnly` session cookie** and two Argon2id password hashes: no identity provider. For extraction, call **Claude Sonnet 5 (`claude-sonnet-5`)** with **structured outputs** (`output_config.format`) and `effort: "low"`, run as a **background job the client polls**, never as a request the phone holds open.

The most important finding is about the URL feature, and it changes the design: **most recipe sites embed schema.org Recipe JSON-LD, so parse that first and only fall back to Claude when it is missing.** In a 19-site check today, 9 of the 14 pages that could be fetched had usable Recipe JSON-LD. That path is free, instant, and more accurate than an LLM, because it is the publisher's own data. The real problem with URLs turns out not to be extraction quality at all: **4 of 19 sites hard-blocked a server-side fetch with 403**, including Serious Eats, AllRecipes and Food Network. Budget engineering effort accordingly, and ship a "paste the text instead" escape hatch on day one.

Total running cost is about **$7/month**, of which the Anthropic API is under $1. Cost should not influence any decision here.

## Decision table

| Decision | Chosen | Runner-up | Why |
|---|---|---|---|
| Frontend | SvelteKit (`adapter-node`) | Server-rendered HTML plus htmx 2 | The 10-30s extraction job needs a persistent client shell and optimistic UI; htmx makes that a hand-rolled state machine |
| Page transitions | CSS view transitions | JS animation library | Shipped in iOS Safari since 18.0 (18.2 cross-document), so smoothness costs almost no code |
| Backend | SvelteKit server routes (TypeScript) | Python plus FastAPI | One service, one language, one deploy; Python only wins if you want `recipe-scrapers` off the shelf |
| Host | fly.io | Hetzner VM plus Caddy | Correct pick: persistent disk plus long requests rules out Workers and Vercel; Fly buys managed TLS, secrets, and deploys |
| Database | SQLite on a Fly volume | Postgres | Fly Managed Postgres starts at $38/month, roughly 5x the whole rest of the stack, for a few hundred rows |
| Durability | Litestream to R2 | Fly volume snapshots alone | Fly documents daily snapshots that "may not have your latest data"; a single volume can lose data outright |
| SQLite replication | Litestream | LiteFS | LiteFS's last commit is 2025-04-22; Litestream shipped v0.5.15 six days ago |
| Image storage | Cloudflare R2 | Tigris | Free egress, and 10 GB free tier covers this app entirely; Tigris pricing page 404s today |
| Model | Claude Sonnet 5 | Claude Opus 5 | Extraction is not a frontier task; Sonnet is the "fast" tier at 1/5 the output price, and cost is irrelevant either way |
| Structured JSON | `output_config.format` | Tool use with a schema | First-party, no longer beta, guarantees schema-valid JSON |
| URL extraction | JSON-LD first, LLM fallback | LLM always | Free, instant, and more accurate when present; roughly two thirds of fetchable pages have it |
| Fetching the URL | Your own fetcher | Anthropic `web_fetch` tool | You need the HTML locally for JSON-LD anyway, and you control User-Agent, redirects, and error handling |
| Extraction UX | Background job plus polling | Held-open streaming request | A backgrounded phone drops the connection; streaming JSON is not renderable progress anyway |
| Auth | Server-set cookie plus 2 password hashes | Cloudflare Access | Least machinery that is not embarrassing; Access adds an interstitial on every cold open |
| Prompt caching / Batch API | Neither | n/a | Cache window is 5 minutes and usage is a few calls a week; batch turnaround is not compatible with standing in a kitchen |

## 1. Frontend and rendering approach

### What iOS Safari can actually do now

Stable is Safari 26.5; Safari 27 is in beta from WWDC26. The features that determine whether a web app can feel good on a phone:

| Feature | iOS Safari status | Source |
|---|---|---|
| Same-document view transitions (`document.startViewTransition`) | Safari 18.0 | [caniuse](https://caniuse.com/view-transitions) |
| Cross-document view transitions (`@view-transition { navigation: auto }`) | Safari 18.2 | [caniuse](https://caniuse.com/cross-document-view-transitions), [WebKit](https://webkit.org/blog/16967/two-lines-of-cross-document-view-transitions-code-you-can-use-on-every-website-today/) |
| `popover` attribute | Safari 17.0 | [caniuse](https://caniuse.com/mdn-html_global_attributes_popover) |
| `transition-behavior: allow-discrete` | Safari 17.4 | [WebKit 17.4](https://webkit.org/blog/15063/webkit-features-in-safari-17-4/) |
| `@starting-style` | Safari 17.5 (display transitions 18.0) | [WebKit 18.0](https://webkit.org/blog/15865/webkit-features-in-safari-18-0/) |
| CSS anchor positioning | Safari 26.0 | [caniuse](https://caniuse.com/css-anchor-positioning), [WebKit 26.0](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/) |
| Scroll-driven animations (`animation-timeline`) | Safari 26.0, moved off the main thread in 26.4 | [caniuse](https://caniuse.com/mdn-css_properties_animation-timeline), [WebKit 26.4](https://webkit.org/blog/17862/webkit-features-for-safari-26-4/) |
| Scroll anchoring | Safari 27 beta only | [WebKit 27 beta](https://webkit.org/blog/17967/news-from-wwdc26-webkit-in-safari-27-beta/) |
| `interpolate-size` / `calc-size()` | Not supported in any Safari | [caniuse](https://caniuse.com/mdn-css_properties_interpolate-size), [WebKit bug 295132](https://bugs.webkit.org/show_bug.cgi?id=295132) |
| Speculation Rules API | Not in stable; prefetch work visible in [STP 246](https://webkit.org/blog/18128/release-notes-for-safari-technology-preview-246/), WebKit position unresolved ([standards-positions#54](https://github.com/WebKit/standards-positions/issues/54)) | as cited |

Two practical gaps. You cannot animate height to `auto` declaratively, so expanding recipe steps need the `grid-template-rows: 0fr/1fr` trick or a JS-measured max-height. And you cannot buy prefetch-driven instant navigation on iOS, so "instant" has to come from your own client-side routing or prefetch on `touchstart`.

The single most important fact is that **cross-document view transitions have been on iOS since 18.2**. Two lines of CSS give a plain server-rendered multi-page app the animated page transitions that used to require a SPA router, and they degrade silently where unsupported. That removes most of the historical case for reaching for a JS framework purely to get smoothness.

### Candidates

- **Server-rendered HTML plus htmx.** Smallest payload, least tooling. View transitions via `hx-swap="...transition:true"` ([htmx](https://htmx.org/essays/view-transitions/)). Note that [htmx 4](https://four.htmx.org/docs) is still at beta and changes defaults meaningfully (explicit attribute inheritance, `fetch()` instead of XHR, error responses now swap), so htmx 2 is the stable target. Weakness for this app: the 10-30s Anthropic call wants a job that survives navigation and an optimistic pending state, which in htmx means SSE plus out-of-band swaps and a hand-written state machine.
- **SvelteKit.** Svelte 5 shipping monthly ([May 2026 release notes](https://svelte.dev/blog/whats-new-in-svelte-may-2026)). View transitions are a documented one-liner via `onNavigate` ([SvelteKit docs](https://svelte.dev/docs/kit/$app-navigation)). Compiles away, so the runtime shipped to the phone is small.
- **Next.js / React.** Currently 16.2 stable with 16.3 in preview ([Next.js blog](https://nextjs.org/blog/next-16-3-instant-navigations)). It also has the heaviest upgrade tax of the group: there is a standing [security release program](https://nextjs.org/blog/next-security-release-program) and a [July 2026 security release](https://nextjs.org/blog/july-2026-security-release) patching 16.2.11 and 15.5.21. For a solo maintainer that is recurring unpaid work, and it ships the largest baseline JS.
- **React Router v7.** Fine, `viewTransition` prop on `Link`/`Form` ([docs](https://reactrouter.com/how-to/view-transitions)), but still React-sized.
- **Astro 7.** Their own docs now say using Astro's ClientRouter "will increasingly become unnecessary" as browsers ship view transitions ([Astro docs](https://docs.astro.build/en/guides/view-transitions/)). Astro is aimed at content sites, not two-user CRUD with a slow AI endpoint.
- **SolidStart.** Best-in-class runtime, thinnest docs and smallest ecosystem. Highest solo-maintenance risk.
- **Plain Vite SPA plus API.** You hand-roll routing, data loading, and there is no server-rendered first paint.

### Call: SvelteKit with `adapter-node`

In priority order:

1. **The 10-30s Anthropic call dominates the UX.** You need a persistent client shell that shows a pending extraction, lets the user keep browsing, and updates in place when the job lands. That is native in SvelteKit and awkward in htmx. This is the deciding factor, not smoothness.
2. **Smoothness for the least code.** Svelte compiles to small bundles and page transitions are a few lines.
3. **Maintenance surface.** One dependency tree, Vite underneath, no separate bundler config. Materially less churn than Next.js.
4. **Nothing is foreclosed.** SvelteKit has a first-class service worker story, so adding offline later is additive, not a rewrite. Nothing here is iOS-specific.
5. **Fly fit.** `adapter-node` emits a plain Node server. Containerize it, no platform-specific adapter.

Runner-up: server-rendered HTML plus htmx 2 plus `@view-transition { navigation: auto }`, if writing almost no JavaScript matters more than the async-job UX. Do not start on htmx 4 while it is in beta.

iOS layout caveats regardless of framework: use `dvh` rather than `vh`, keep tap targets clear of the bottom safe area, and expect no scroll anchoring until users are on iOS 27.

## 2. Add to Home Screen and PWA on iOS in 2026

**The headline change: Safari 26 removed installability requirements entirely.** Per [WebKit 26.0](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/), "By default, every website added to the Home Screen opens as a web app" and "There are now zero requirements for 'installability' in Safari." Users can opt out with an "Open as Web App" toggle at add time. `apple-mobile-web-app-capable` and manifest `display` still work but are no longer required. Ship a manifest anyway, because on Android/Chrome `display: standalone` plus installability criteria still gate the install prompt.

- **Status bar.** Still the legacy `<meta name="apple-mobile-web-app-status-bar-style">`, documented only in Apple's [archived Configuring Web Applications](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/ConfiguringWebApplications/ConfiguringWebApplications.html). No manifest equivalent Apple honours. Use `black-translucent` together with `viewport-fit=cover`.
- **Safe areas.** `viewport-fit=cover` plus `env(safe-area-inset-*)`, unchanged since iOS 11 ([WebKit, Designing Websites for iPhone X](https://webkit.org/blog/7929/designing-websites-for-iphone-x/)). In standalone mode the bottom inset is the home indicator rather than browser chrome, so recompute padding, do not copy it from the tab experience.
- **Icons.** `apple-touch-icon` in the head takes precedence over manifest `icons`; manifest icons are honoured since iOS 15.4 when no `apple-touch-icon` exists ([WebKit 15.4](https://webkit.org/blog/12445/new-webkit-features-in-safari-15-4/)). Ship one 180x180 PNG as `apple-touch-icon` plus 192/512 manifest icons for Android.
- **Web Push.** iOS 16.4 added Web Push for Home Screen web apps only, never for Safari tabs ([WebKit 16.4](https://webkit.org/blog/13966/webkit-features-in-safari-16-4/), [Web Push for Web Apps on iOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)). Permission requires a direct user gesture. [Declarative Web Push](https://webkit.org/blog/16535/meet-declarative-web-push/) shipped in iOS 18.4 and removes the service worker requirement ([WebKit 18.4](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/)). Chrome on Android has no install requirement, so this is an iOS-only constraint.
- **Badging.** Works for Home Screen web apps, granted alongside notification permission ([WebKit](https://webkit.org/blog/14112/badging-for-home-screen-web-apps/)).
- **Storage eviction.** ITP deletes script-writable storage after 7 days of no interaction, but Home Screen web apps are exempt and keep their own use counter; installation is also a positive signal for `navigator.storage.persist()` ([Updates to Storage Policy](https://webkit.org/blog/14403/updates-to-storage-policy/), [Tracking Prevention in WebKit](https://webkit.org/tracking-prevention/)). Since you are not doing offline this only affects cached UI state, but it is one more reason to keep the source of truth on the server.
- **EU/DMA alternative engines.** [BrowserEngineKit](https://developer.apple.com/documentation/browserenginekit) exists and there is a [browser choice screen](https://developer.apple.com/support/browser-choice-screen/) since iOS 18.2. Nothing material here. The 2024 regression that forced EU home-screen web apps back into Safari was reverted ([WebKit bug 268643](https://bugs.webkit.org/show_bug.cgi?id=268643)). Keep targeting WebKit.

**What is still missing versus Android/Chrome:** no `beforeinstallprompt`, so you cannot trigger install from your own UI and must show a short "tap Share, then Add to Home Screen" hint. No manifest `shortcuts`, `share_target`, `protocol_handlers`, or `related_applications`. No push in Safari tabs. Splash screens on iOS still require per-resolution `apple-touch-startup-image` link tags with no manifest-driven equivalent, which is high-maintenance for no real payoff: skip custom splash screens and instead make your first paint cheap and correctly coloured.

## 3. Backend language and framework

The LLM requirement barely constrains this choice, which is itself the useful finding. As shown in section 4.5, Anthropic ships seven official SDKs generated from one spec and they all released on the same day. There is no language here where you are stuck on a community-maintained client.

What actually differentiates:

- **Python (FastAPI or Litestar).** Three concrete advantages. First, [recipe-scrapers](https://github.com/hhursev/recipe-scrapers) is Python and has no JS equivalent of comparable coverage (section 4.8), and it does real work in the URL path. Second, Pydantic lets you define the recipe model once and emit it as the JSON Schema for `output_config.format`, so the schema cannot drift from the type. Third, FastAPI now has first-party SSE: [`EventSourceResponse`](https://fastapi.tiangolo.com/tutorial/server-sent-events/) landed in 0.135.0, so the progress channel needs no extra dependency. Django is overkill and [transactions still do not work in async mode](https://docs.djangoproject.com/en/stable/topics/async/).
- **Node/TypeScript.** The advantage is one language across the stack if the frontend is SvelteKit, and SvelteKit's `adapter-node` already gives you a Node server, so "backend" can just be SvelteKit server routes with no second service. That is a genuinely smaller system: one repo, one process, one deploy, one dependency tree.
- **Go.** Excellent single-binary deploys and a mature SDK, but you hand-roll streaming accumulation (`message.Accumulate(event)`) and you will write more code for HTML parsing and image resizing than in either alternative.
- **Elixir/Phoenix.** LiveView is a genuinely good answer to "server-rendered but feels live," and it would handle the async extraction job elegantly. But there is **no official Anthropic Elixir SDK** on [the SDK list](https://platform.claude.com/docs/en/cli-sdks-libraries/overview), so you would hand-roll the Messages API over Finch, including SSE frame parsing, vision content blocks, and retry/backoff. For a one-person hobby app that is the highest-effort option on this list, and it is permanent maintenance you own alone.

Two SDK behaviours worth knowing whichever you pick: the SDKs **retry twice by default**, so a transient failure silently costs two more full extraction calls (lower this for a user-facing path), and the Messages API caps request size at **32 MB**, which is comfortable for resized photos.

**Call: TypeScript, as SvelteKit server routes, with no separate backend service.** The decisive argument is that this app is small enough that a second service is pure overhead. One SvelteKit app on one Fly machine, with `+page.server.ts` and a couple of `+server.ts` endpoints, is the whole backend. The Anthropic TypeScript SDK is a first-class citizen in every docs example.

The honest cost of that call: you give up recipe-scrapers and will write your own JSON-LD parser and normalizer. Given that the messy-shape normalization (section 4.8) is most of that library's value for a single-format use case, and you can lift its approach without its 635 site-specific modules, that is maybe a day of work. If that day sounds worse than running two services, invert the decision and use Python plus FastAPI for the backend with SvelteKit as a separate frontend. Both are defensible. Do not run both languages if you can avoid it.

## 4. The Anthropic integration

This is the crux, so this section is the long one.

### 4.1 Current model lineup and IDs

Anthropic's developer docs moved host at some point before today: `docs.claude.com/en/docs/...` now 302-redirects to `platform.claude.com/docs/en/...`. Old links still work but write new ones against `platform.claude.com`.

Current lineup, from the [models overview](https://platform.claude.com/docs/en/about-claude/models/overview) (accessed 2026-07-27):

| Model | API ID | Input $/MTok | Output $/MTok | Context | Max output | Latency (Anthropic's word) |
|---|---|---|---|---|---|---|
| Claude Fable 5 | `claude-fable-5` | $10 | $50 | 1M | 128k | Slower |
| Claude Opus 5 | `claude-opus-5` | $5 | $25 | 1M | 128k | Moderate |
| Claude Sonnet 5 | `claude-sonnet-5` | $3 (intro $2 through 2026-08-31) | $15 (intro $10) | 1M | 128k | Fast |
| Claude Haiku 4.5 | `claude-haiku-4-5-20251001` | $1 | $5 | 200k | 64k | Fastest |

All current models support image input. Prices from the [pricing page](https://platform.claude.com/docs/en/about-claude/pricing). Sonnet 5's introductory $2/$10 rate is explicitly documented as ending 2026-08-31, after which it becomes $3/$15, so budget at the post-August number.

Two model-ID facts worth internalising, both from the same page. First, "Starting with the Claude 4.6 generation, model IDs use a dateless format that is also a pinned snapshot, not an evergreen pointer." So `claude-sonnet-5` will not silently become Sonnet 6. Second, the [deprecations page](https://platform.claude.com/docs/en/about-claude/model-deprecations) is the thing to watch; Opus 4.1 is already slated for retirement on 2026-08-05.

**Recommendation: Claude Sonnet 5 (`claude-sonnet-5`) for both extraction paths.** Recipe extraction from clean HTML text or a single photo of a printed page is not a frontier reasoning task. It is structured extraction from a legible source. Sonnet 5 is the documented "best combination of speed and intelligence" tier, it is 5x cheaper on output than Opus 5, and latency matters here because a human is holding a phone. Set `output_config.effort` to `"low"` or `"medium"` explicitly: the [effort docs](https://platform.claude.com/docs/en/build-with-claude/effort) say the API default is `high` on Sonnet 5, and recommend low effort "for high-volume or latency-sensitive workloads." Extraction is exactly that. Do not use Haiku 4.5 for the photo path without testing it: it is the only current model with a 200k context and it is a generation behind on vision.

Escalate to `claude-opus-5` only if evals show Sonnet 5 mangling messy cookbook photography. That is a per-call cost change of roughly 2.5x, which at this volume is invisible.

### 4.2 Getting reliable structured JSON

Use **structured outputs**, not hand-rolled JSON prompting and not tool-use-as-a-schema-hack. Per the [structured outputs docs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs), the current first-party mechanism is the `output_config.format` request field:

```json
"output_config": {
  "format": {
    "type": "json_schema",
    "schema": { "type": "object", "properties": { ... }, "required": [...], "additionalProperties": false }
  }
}
```

Key facts, all from that page:

- It is **no longer beta**. The older beta parameter `output_format` and beta header `structured-outputs-2025-11-13` still work for a transition period, but `output_config.format` is the current standard. If you find a tutorial using `output_format`, it is stale.
- Supported on Claude 4.5 and later, which covers Sonnet 5 and Opus 5.
- The response is guaranteed to be valid JSON matching the schema, returned in the text content block.
- Schema restrictions that will bite a recipe schema: `additionalProperties` must be `false`; recursive schemas are not supported; numeric constraints (`minimum`, `maximum`) and string constraints (`minLength`, `maxLength`) are **not** supported; array `minItems` only accepts 0 or 1. String formats including `duration` and `uri` are supported, which is convenient for ISO 8601 cook times.
- A separate feature, `strict: true` on a tool definition, guarantees valid tool call arguments. You do not need it here. Use JSON outputs for "give me the recipe," strict tools only if you later add an agentic loop.

Practical consequence: validate ranges (yield is a positive number, times are sane) in your own code, because the schema layer will not do it.

### 4.3 Vision: photographing a cookbook page

All from the [vision docs](https://platform.claude.com/docs/en/build-with-claude/vision):

- **Formats:** JPEG, PNG, GIF, WebP. Animations unsupported (first frame only).
- **Max size:** 10 MB per image base64-encoded on the Claude API directly. Overall request size limit is 32 MB.
- **Max dimensions:** 8000x8000 px.
- **Images per request:** 100 for 200k-context models, 600 otherwise. Above 20 images in one request a stricter per-image dimension limit kicks in (resize so neither dimension exceeds 2000 px). Irrelevant at your scale unless you shoot a whole chapter.
- **Token cost:** images are billed in visual tokens of 28x28 px each, so `ceil(w/28) * ceil(h/28)`. Models are tiered: Claude 4.7 and later are "high-resolution" (max long edge 2576 px, cap 4784 visual tokens); everything else is "standard" (1568 px, 1568 tokens). Sonnet 5 is in the high-resolution tier. Anything bigger is downscaled server-side preserving aspect ratio.

The numbers that matter for an iPhone photo. A modern iPhone main-camera shot is 24 MP (about 5712x4284) or 12 MP (4032x3024) and lands well over 10 MB as HEIC or a high-quality JPEG. So **you must resize and re-encode client-side or server-side before sending.** Two separate reasons: the 10 MB hard limit, and cost/latency. Anthropic's own table shows a 3840x2160 image downscaled to 2576x1449 costing the full 4784 visual token cap on the high-resolution tier, which they price at "about $23.92 per thousand" at Opus 5's $5/MTok. Sending a raw 24 MP photo buys you nothing over sending a 2576-px-long-edge JPEG, because the server throws the extra pixels away anyway.

Concrete guidance for this app: resize the long edge to 2576 px, encode JPEG at quality ~85, and send that. At Sonnet 5's post-August $3/MTok input, 4784 visual tokens is about $0.014 per photo. The docs explicitly warn that heavy JPEG compression "can make text difficult to read," so do not push quality below about 80 for a page of printed recipe text.

Three constraints the docs are specific about that are easy to miss:

1. **Claude does not read image metadata** ("Claude does not parse or receive any metadata from images passed to it"). That means **EXIF orientation is not honoured**. An iPhone photo taken in the wrong grip is stored upright with an EXIF rotation flag; if your resize pipeline strips EXIF without physically rotating the pixels, Claude sees a sideways page. The docs separately list "rotated" images among the things Claude "might hallucinate or make mistakes" on. Use a library that applies EXIF orientation on load (Pillow's `ImageOps.exif_transpose`, sharp's `.rotate()` with no argument). This is the single most likely silent-quality bug in the photo path.
2. **HEIC is not a supported format.** iPhones shoot HEIC by default. However, the browser side saves you: a `<input type="file" accept="image/*">` on iOS Safari, and `canvas.toBlob()`, both produce JPEG. If you resize client-side in a canvas you get JPEG for free and you also solve the upload-size problem on cellular. Do that.
3. **Multi-page recipes:** send both photos as separate `image` blocks in one message, labelled "Image 1:" / "Image 2:" as the docs suggest, and let one call produce one recipe. Do not make two calls and try to merge.

For source type, prefer **base64 inline** over the Files API here. The Files API (`file_id`, beta header `files-api-2025-04-14`) exists to avoid resending image bytes across many conversation turns. Your extraction is one-shot. Inline base64 is one fewer round trip and one fewer beta surface.

### 4.4 Handling a pasted URL: first-party web fetch vs fetching it yourself

Anthropic does have a first-party server tool. From the [web fetch tool docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool):

- Tool type `web_fetch_20260318` is the latest (earlier: `web_fetch_20260309`, `web_fetch_20260209`, `web_fetch_20250910`). Not beta, no beta header shown.
- **No additional charge** beyond the tokens the fetched content consumes. The docs estimate an average 10 kB page at ~2,500 tokens.
- Parameters that matter: `max_content_tokens` (truncates fetched content), `max_uses`, `allowed_domains` / `blocked_domains`, `citations`, `use_cache`.
- **Hard limitation: "The web fetch tool currently does not support websites dynamically rendered with JavaScript."**
- Security model: Claude cannot construct URLs. It can only fetch URLs that "previously appeared in the conversation context." A user-pasted URL qualifies, so your use case works. Error code `url_not_in_prior_context` covers the other case. URLs are capped at 250 characters.
- Anthropic-side restrictions block private addresses and honour `robots.txt`, surfacing as `url_not_allowed`.
- Results are cached by Anthropic by default; `use_cache: false` bypasses at a latency cost.

**Recommendation: fetch the HTML yourself.** Three reasons, in order of weight:

1. The JSON-LD path (section 4.8) needs the raw HTML in your process anyway. If you are already fetching, handing the same bytes to Claude costs nothing extra and removes a whole tool-use round trip from the latency budget.
2. You control the failure modes. Anthropic's fetcher honours `robots.txt` and blocks some hosts; when it fails you get an opaque `url_not_accessible` inside a 200 response and have to parse tool-result blocks to find out. Your own fetcher lets you set a browser User-Agent, follow redirects, handle a 403 by telling the user "this site blocks us, take a photo instead," and cache the HTML.
3. You can strip the page before sending. A modern recipe blog is 300 kB of HTML for 2 kB of recipe. Running the body through a readability/boilerplate stripper before sending cuts input tokens by an order of magnitude and reduces the chance the model latches onto the wrong content.

Keep `web_fetch` in your back pocket as a fallback for the case where your own fetch gets blocked but Anthropic's egress is not. That is a nice-to-have, not v1.

### 4.5 SDK maturity: Python vs TypeScript

Checked the GitHub release metadata directly on 2026-07-27:

| SDK | Latest release | Published | Stars |
|---|---|---|---|
| [anthropic-sdk-python](https://github.com/anthropics/anthropic-sdk-python) | v0.120.0 | 2026-07-24 | 3,778 |
| [anthropic-sdk-typescript](https://github.com/anthropics/anthropic-sdk-typescript) | sdk-v0.115.0 | 2026-07-24 | 2,059 |
| [anthropic-sdk-go](https://github.com/anthropics/anthropic-sdk-go) | v1.61.0 | 2026-07-24 | 1,159 |
| [anthropic-sdk-ruby](https://github.com/anthropics/anthropic-sdk-ruby) | v1.59.0 | 2026-07-24 | 360 |
| [anthropic-sdk-java](https://github.com/anthropics/anthropic-sdk-java) | v2.52.0 | 2026-07-24 | 354 |

Every one of these shipped a release on the same day, three days ago. That is the signature of a shared code generator, and it is the strongest available evidence for parity: these SDKs are generated from one API spec, so new API surface lands everywhere at once. None are archived.

Anthropic's own [CLI, SDKs and libraries page](https://platform.claude.com/docs/en/cli-sdks-libraries/overview) lists seven official client SDKs (Python, TypeScript, C#, Go, Java, PHP, Ruby) and states each "provides idiomatic interfaces, type safety, and built-in support for streaming, retries, and error handling." It does not rank them.

Where they genuinely differ is ergonomics, and Python and TypeScript are the two that get first-class treatment in the docs. Both appear in every code sample on every docs page I read. Both have `.messages.stream()` with a high-level accumulator (`get_final_message()` in Python, `finalMessage()` in TypeScript) documented on the [streaming page](https://platform.claude.com/docs/en/api/streaming). Python additionally has both sync and async clients and Pydantic models. Go, Java and C# require you to hand-roll accumulation via `Accumulate()`/`MessageAccumulator`.

**Call: Python and TypeScript are at parity for anything this app needs.** Pick the SDK to match your backend language, not the other way round. If you want a tiebreaker, Python's Pydantic response models pair naturally with a Pydantic recipe model that you can also emit as the JSON Schema for `output_config.format`, so the schema is defined once. That is a real, small win.

### 4.6 Latency and the right UX pattern

Anthropic does not publish per-model latency SLAs, only relative rankings ("Fast" for Sonnet 5). So I cannot cite a number for how long your extraction takes; you will have to measure it. What I can cite:

- The [streaming docs](https://platform.claude.com/docs/en/api/streaming) say the SDKs "require streaming to avoid HTTP timeouts" for requests with large `max_tokens`. A recipe is small (a few thousand output tokens), so you are not forced into streaming by that rule.
- `effort` is the primary latency lever. Anthropic recommends `low` effort "when you're optimizing for speed (because Claude answers with fewer tokens)."
- There is a [fast mode](https://platform.claude.com/docs/en/build-with-claude/fast-mode) research preview, but it is Opus 5 / Opus 4.8 only and priced at $10/$50 per MTok. Not for you.

**The right UX pattern is a background job plus a status channel, not a held-open streaming request.** Reasoning:

- Streaming JSON to a phone is useless as UX. Structured output arrives as one JSON blob; there is no "watch the recipe appear word by word" experience worth building, and partial JSON is not renderable.
- A phone on cellular that backgrounds Safari (user switches apps, screen locks) will drop an open connection. A 10-30s held request is a coin flip. A job the server owns survives that; the user reopens the app and the recipe is there.
- It generalises. "Scale this recipe" and "what can I cook with what's in the fridge" are the same shape.

Concretely: `POST /extractions` returns a job id immediately and renders an optimistic pending card; the server does the Anthropic call; the client polls that job every second or subscribes to a one-line SSE endpoint. Both are trivial. Poll if you want less machinery.

The perceived-latency trick that matters more than any of this: for the URL case, JSON-LD (section 4.8) returns in under a second for most sites, so most URL pastes never hit the 10-30s path at all.

### 4.7 Prompt caching and the Batch API at this scale

**Prompt caching: not worth it, with one caveat.** From the [prompt caching docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), the minimum cacheable prompt is 1,024 tokens on Sonnet 5 (512 on Opus 5, 4,096 on Haiku 4.5), the default TTL is 5 minutes, and a 5-minute cache write costs 1.25x base input while a read costs 0.1x. Your cacheable prefix is a system prompt plus a JSON schema, realistically 500-1500 tokens. Two people adding a recipe every few days will essentially never get a cache hit inside a 5-minute window, so you would pay the 1.25x write premium every time and read it back never. Skip it. The caveat: if you later add a chat-style "what can I cook" feature where the user's whole recipe collection is the prefix and they ask several questions in a row, caching becomes worth it immediately. Low hundreds of recipes is a meaningful prefix.

**Batch API: not applicable.** The [batch docs](https://platform.claude.com/docs/en/build-with-claude/batch-processing) give a 50% discount on input and output with "most batches finishing in less than 1 hour." Your user is standing in a kitchen. A 50% discount on a workload costing single-digit dollars per month is not worth an asynchronous turnaround measured in tens of minutes. The one legitimate use: a one-time bulk import if Daniel ever wants to backfill 200 bookmarked URLs. Do that as a batch, do nothing else as a batch.

**Rate limits are a non-issue.** [Start tier](https://platform.claude.com/docs/en/api/rate-limits) gives Sonnet 5 1,000 RPM, 2M input tokens/min and 400k output tokens/min, with a $500/month organisation spend cap. Set a lower self-imposed spend limit in the Console as a runaway-loop backstop; that is the only rate-limit action worth taking.

### 4.8 Does schema.org JSON-LD make the LLM unnecessary for the URL case?

Partly, and this is the biggest available simplification, but it does not remove the LLM. I had this checked empirically rather than assumed.

**The type.** [schema.org/Recipe](https://schema.org/Recipe) extends `HowTo` extends `CreativeWork`. Relevant properties: `name`, `recipeIngredient`, `recipeInstructions`, `prepTime`/`cookTime`/`totalTime` (ISO 8601 [Duration](https://schema.org/Duration)), `recipeYield`, `image`, `nutrition`, `author`.

**Why sites embed it.** [Google's recipe structured data documentation](https://developers.google.com/search/docs/appearance/structured-data/recipe) requires only `name` and `image` for rich-result eligibility. Everything a recipe app actually wants is merely *recommended*. That is exactly why coverage is broad but completeness is uneven: a site can rank fine while omitting times or nutrition.

**Empirical check, 19 real recipe pages fetched 2026-07-27 by curl, retried with a desktop Chrome User-Agent:**

| Site | Fetch | Recipe JSON-LD | Notes |
|---|---|---|---|
| cooking.nytimes.com | 200 | Yes | 4 HowToStep, `totalTime PT21H30M`. No `prepTime`, no nutrition. Served to an unauthenticated fetch |
| bbcgoodfood.com | 200 | Yes | Best in sample, all fields, clean ISO durations |
| bonappetit.com | 200 | Yes | `cookTime: "20 minutes"`, not ISO 8601 |
| delish.com | 200 | Yes | Complete, but `cookTime: PT0S` is junk |
| budgetbytes.com | 200 | Yes | `recipeYield` is an array |
| sallysbakingaddiction.com | 200 | Yes | Complete except nutrition |
| recipetineats.com | 200 | Yes | Instructions are 5 HowToSection, not flat steps |
| kingarthurbaking.com | 406, then 200 with browser UA | Yes | Instructions are 17 plain strings |
| loveandlemons.com | 200 | No | Recipe card in HTML but only `Article` JSON-LD |
| smittenkitchen.com | 200 | No | Zero `ld+json` blocks, prose recipe |
| davidlebovitz.com | 200 | No | JSON-LD present but `WebSite` only |
| Substack food newsletter | 200 | No | No recipe markup |
| instagram.com, tiktok.com | 200 | No | JS shells, no text |
| seriouseats.com | **403** | n/a | Dotdash Meredith bot wall |
| allrecipes.com | **403** | n/a | Same wall, browser UA did not help |
| foodnetwork.com | **403** | n/a | Akamai Access Denied |
| 101cookbooks.com | **403** | n/a | Cloudflare interstitial |

Totals: 14 of 19 fetched at all, 9 of those 14 had usable Recipe JSON-LD, and **4 major sites hard-blocked a server-side fetch**.

**The finding that reframes the problem: your dominant failure mode is not bad markup, it is not getting the HTML at all.** Three of the largest US recipe destinations returned 403 to a datacenter IP, and a browser User-Agent header did not help (it rescued exactly one site, King Arthur). That is edge bot detection, not UA sniffing, and no amount of header tuning fixes it. This is also why Anthropic's server-side `web_fetch` is not a magic escape hatch: it is fetching from a datacenter too, and it additionally honours `robots.txt`.

**Existing tooling.** [hhursev/recipe-scrapers](https://github.com/hhursev/recipe-scrapers) is MIT-licensed, actively maintained (last commit 2026-07-25, latest tag 15.11.0, roughly 2.2k stars) and contains about 635 per-domain modules. Its README states it parses "Schema markup (including JSON-LD, Microdata, and RDFa formats) or OpenGraph metadata," and it has a `wild_mode=True` generic path. Critically it is a parser, not a fetcher, so it inherits none of the bot-wall problem and raises rather than guessing when there is no schema. There is no JavaScript equivalent with comparable coverage, which is a genuine, if small, argument for a Python backend.

**The call: JSON-LD first, LLM fallback.** Not "LLM always," and not "LLM always with JSON-LD as a hint." When JSON-LD is present it is better than what an LLM would produce, because it is the publisher's own structured data; paying 10-30 seconds and per-call cost to re-derive an ingredient array that already exists as an array is pure waste. But roughly a third of fetchable pages have no usable Recipe node, and those pages (Smitten Kitchen, David Lebovitz, Love and Lemons, Substack) have perfectly extractable prose, so the LLM adds real coverage.

Three implementation notes that will save you real debugging:

1. **The normalizer is the work, not the fetch.** Every messy shape schema.org permits actually appeared in the sample: instructions as a bare string, a string array, `HowToStep` objects, and `HowToSection` wrappers; yield as string, number, and array; image as string, object, and array. Parse ISO 8601 durations strictly and fall through to a loose parser on failure rather than dropping the field. Treat `PT0S` as absent.
2. **Trigger the LLM fallback on three conditions:** no Recipe node, a Recipe node missing `recipeIngredient` or `recipeInstructions`, or a parse yielding fewer than two ingredients.
3. **Do the fetch-reliability work before the LLM work.** It is the bigger source of failures. Build a plain "paste the recipe text instead" escape hatch on day one. Then the photo path doubles as the fallback for blocked sites, which is a nice property: for AllRecipes you photograph the screen or paste the text, and the same extraction pipeline handles it.

## 5. Data and images

### Database: SQLite on a Fly volume, with Litestream

Managed Postgres is disqualified on price alone. [Fly Managed Postgres](https://fly.io/docs/mpg/) starts at **$38/month** for the Basic plan (shared-2x, 1GB) plus $0.28 per provisioned GB. That is roughly ten times the cost of the entire rest of this stack, to serve two people and a few hundred rows. No. The older self-hosted option is also a dead end: its docs page is now titled ["Fly Postgres (Unmanaged)"](https://fly.io/docs/postgres/) and opens with "We are not able to provide support or guidance for unmanaged Postgres."

Turso and LiteFS are both solving replication problems you do not have, and **LiteFS is dormant: do not build on it.** The [repository](https://github.com/superfly/litefs) is not archived but `main` has had no commit since **2025-04-22**. More decisively, [Fly's own LiteFS docs](https://fly.io/docs/litefs/) now say "We are not able to provide support or guidance for this product. Use with caution," and LiteFS Cloud was [retired on 2024-10-15](https://fly.io/docs/litefs/cloud-backups/). Contrast [Litestream](https://github.com/benbjohnson/litestream), which is very much alive: v0.5.15 released 2026-07-21, repo pushed to today.

Turso is viable and its [free tier](https://turso.tech/pricing) is real (5 GB, 500M row reads/month, 1-day point-in-time restore), but it adds a vendor going through a rewrite: the [Turso repo](https://github.com/tursodatabase/turso) states plainly "we have not yet reached 1.0," and their [roadmap post](https://turso.tech/blog/upcoming-changes-to-the-turso-platform-and-roadmap) announces removal of edge replicas and `ATTACH`. A local SQLite file has no vendor and no roadmap risk.

So: **SQLite file on a Fly volume, continuously replicated to object storage with Litestream.**

### Be honest about the single-volume risk

Fly's own [volumes documentation](https://fly.io/docs/volumes/overview/) is unusually blunt and you should read it as written:

- A volume "is a slice of an NVMe drive on the same physical server as the Machine on which it's mounted and it's tied to that hardware." One volume lives on one physical server in one region and cannot be moved.
- "Always provision at least two volumes per app."
- "If you only have a single copy of your data on a single volume, and that drive fails, then the data is lost."
- Snapshots: "Fly.io takes daily block-level snapshots of volumes. We keep snapshots for five days by default, but you can configure the snapshot retention to be from 1 to 60 days."
- And critically: "Daily automatic snapshots may not have your latest data. You should still implement your own backup plan for important data."

Read that plainly. A single-machine, single-volume Fly app can lose data on a host drive failure, and the built-in mitigation is a **daily** snapshot, meaning your worst-case loss is up to 24 hours of recipes. For a two-person recipe book that is not catastrophic, but it is also completely avoidable, and Fly explicitly tells you not to rely on snapshots alone.

This is exactly why Litestream is in the recommendation rather than optional. It streams the SQLite WAL to S3-compatible storage continuously, so your recovery point is seconds rather than a day, and your restore path does not depend on Fly's snapshot retention at all. Set volume snapshot retention up from the 5-day default while you are at it, since snapshots are cheap and the [first 10GB/month is free](https://fly.io/docs/about/pricing/).

Do not bother running two volumes. Two volumes without replication logic buys you nothing for SQLite, and Litestream is the cheaper answer to the same risk.

### Images: Cloudflare R2, not the volume

Recipe photos should not live on the Fly volume. Same durability argument, plus they bloat every snapshot.

[Cloudflare R2](https://developers.cloudflare.com/r2/pricing/) is the pick: $0.015/GB-month Standard, **egress free**, and a monthly free tier of 10 GB storage, 1M Class A operations and 10M Class B operations. A few hundred recipe photos resized to 2576 px long edge will be comfortably under 1 GB, so **this line item is $0.00** and stays that way for years. Free egress also means serving images straight from R2 to the phones costs nothing, and keeps image bytes off your Fly bandwidth bill.

[Tigris](https://www.tigrisdata.com/docs/pricing/) is the close runner-up and the lower-friction option, since it is Fly's integrated partner and bills onto your Fly invoice: 5 GB free, then $0.02/GB-month, also with free egress. R2 wins narrowly on a bigger free tier. Both crush S3, which charges $0.023/GB-month **plus $0.09/GB egress**. Either is correct; pick R2 for the free tier or Tigris for the single invoice.

Point Litestream at the same R2 bucket. One storage dependency, one set of credentials.

### Is Fly the right host at all?

Yes. Daniel picked correctly, and the reason is the 10-30 second LLM call plus a persistent SQLite file plus multi-megabyte photo uploads, which together eliminate most of the competition.

Fly documents **no maximum request duration**. The [fly.toml reference](https://fly.io/docs/reference/configuration/) exposes `http_options.idle_timeout` but states no default and no ceiling, and it is an *idle* timeout, so an actively streaming response never trips it. Worth knowing: the widely repeated "60 second Fly timeout" appears only on community.fly.io, not in the docs. On cold starts, Fly's actual documented words are "usually this takes well under a second" for a stopped machine; the frequently quoted "~250ms" figure is not in their docs.

- **Cloudflare Workers plus D1 and R2** is the only genuinely competitive serverless option and could be near-free. The [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) are fine for a slow LLM call: there is no hard duration limit for HTTP-triggered Workers as long as the client stays connected, and waiting on a subrequest does not burn CPU time. So the 10-30s call is not the blocker. The blocker is that you cannot run a normal SQLite file, you cannot run Litestream, and you lose a real filesystem and local-dev parity. That is a genuine platform lock-in for a two-user app in exchange for saving a few dollars.
- **Vercel is disqualified by a hard limit, not by duration.** Duration is now fine (Hobby allows [300s with Fluid compute](https://vercel.com/docs/functions/limitations)), but the **4.5 MB request body cap directly blocks cookbook photo uploads**, and there is no persistent disk at all, so SQLite is out.
- **Render's free tier is unusable here:** [Render spins down a free service after 15 minutes of no traffic and spin-up "takes about one minute"](https://render.com/docs/free). A one-minute wait before seeing a recipe is disqualifying. Paid Starter is $7/month plus $0.25/GB disks, roughly double Fly.
- **Railway** has no recurring free tier (a one-time $5 credit), and [sleeping services may return "a 502 Bad Gateway response"](https://docs.railway.com/reference/app-sleeping) on first wake.
- **A plain VM with Caddy** is the last real alternative. What you give up is what Fly is actually selling: `fly deploy` from a Dockerfile, automatic TLS, managed secrets, no OS patching. Note that Hetzner is no longer the obvious bargain in the US: their [2026-06-15 repricing](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/) took the US CPX11 from €5.99 to €17.49, while the EU CX23 is €5.49.

The one Fly-specific thing to get right is covered above: single volume, so continuous off-volume backup is mandatory, not optional.

## 6. Auth for exactly two people

The requirement, stated correctly, is not "authentication." It is: **two known humans, on four known devices, log in once and never think about it again, and nobody else gets in.**

**Recommendation: a single server-set session cookie, backed by two per-user password hashes (Argon2id), with a one-year `Max-Age`, `HttpOnly`, `Secure`, `SameSite=Lax`.** That is roughly forty lines of code and one `users` table with two rows. Add passkeys later if you feel like it, not now.

**The ITP question has a clean answer and it is favourable.** This is the fact the whole plan rests on, so here is the primary source verbatim. From [WebKit's ITP 2.1 post](https://webkit.org/blog/8613/intelligent-tracking-prevention-2-1/):

> "all persistent client-side cookies, i.e. persistent cookies created through document.cookie, are capped to a seven day expiry."

and, unambiguously:

> "Only cookies created through document.cookie are affected by this change."

WebKit explicitly names the workaround as the thing you should be doing anyway: authentication cookies "should be set in an HTTP response and marked `Secure` and `HttpOnly`." The separate [7-day purge](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/) covers script-writable storage (IndexedDB, LocalStorage, SessionStorage, Service Worker registrations, cache), not HTTP cookies.

Home Screen web apps get a further explicit carve-out in that same post:

> "Web applications added to the home screen are not part of Safari and thus have their own counter of days of use... We do not expect the first-party in such a web application to have its website data deleted."

So: `Set-Cookie: session=<256-bit random>; Max-Age=31536000; Path=/; Secure; HttpOnly; SameSite=Lax`, re-issued on each use so the year always slides forward. One trap: [CNAME cloaking caps cookies at 7 days](https://webkit.org/blog/11338/cname-cloaking-and-bounce-tracking-defense/), so serve the app and its auth endpoint from the same hostname. Do not put the login behind a different subdomain via CNAME.

Why not the alternatives:

- **Cloudflare Access is disqualified by a documented ceiling**, which is the cleanest rejection in this document. [Access session duration maxes out at one month](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/), default 24 hours. The requirement is a year. Free tier is 50 seats, so cost was never the issue.
- **Passkeys solve the wrong layer.** WebAuthn is an authentication ceremony, not a session mechanism: after a successful assertion you still issue a session cookie, and that cookie is what lasts the year. Libraries are healthy ([SimpleWebAuthn](https://www.npmjs.com/package/@simplewebauthn/server), [py_webauthn](https://pypi.org/project/webauthn/)) and [iOS support has been solid since 16.1](https://passkeys.dev/device-support/). Add passkeys later as a nicer login moment if you want. They do not replace the cookie and they do not reduce the work.
- **Tailscale** makes the phone worse: reaching a tailnet-only service needs an always-on VPN, and a dropped VPN produces a network error rather than a login prompt.
- **Clerk / Auth0 / WorkOS** are all free at two users, and all are a hosted identity provider plus a redirect flow plus a vendor, bolted onto an app used by two people who share a kitchen.
- **Magic links** need an email sender, and on iOS the link opens in Safari rather than the installed home-screen app, landing the session in the wrong storage container. That is a genuinely broken flow here, not just an annoying one.

Practical detail: make the login form a real `<form>` with `autocomplete="username"` and `autocomplete="current-password"` so iOS Keychain offers to save and autofill it. That single attribute pair is most of the perceived quality of a login screen on a phone.

## 7. Cost

All figures from [Fly's pricing page](https://fly.io/docs/about/pricing/), accessed 2026-07-27. Note that Fly "no longer offers plans to new customers" and is pay-as-you-go, so there is no plan fee and no free allowance for a new org.

| Line item | Spec | Monthly |
|---|---|---|
| Fly machine | shared-cpu-1x, 512 MB (Amsterdam example) | $3.32 |
| Fly volume | 3 GB at $0.15/GB | $0.45 |
| Volume snapshots | under the first 10 GB free | $0.00 |
| Outbound bandwidth | a few GB at $0.02/GB (NA/EU) | ~$0.10 |
| Cloudflare R2 | under the 10 GB free tier | $0.00 |
| Shared IPv4 and IPv6 | free (dedicated IPv4 is $2) | $0.00 |
| Anthropic API | see below | ~$0.50 |
| **Total** | | **~$4.40/month** |

Three notes. 512 MB is the honest baseline; if server-side image resizing turns out to need headroom, 1 GB is $5.92 and the total becomes about $7. Snapshot billing is new: Fly's pricing page states "Starting January 1st 2026, we're introducing charges for volume snapshot storage," so older cost comparisons will understate this. And do **not** enable scale-to-zero to save three dollars. Fly's [autostop docs](https://fly.io/docs/launch/autostop-autostart/) confirm new apps default to `auto_stop_machines = "stop"` with `min_machines_running = 0`, and while cold start is documented as "well under a second," that is still latency in front of "I want to look at a recipe right now." Set `min_machines_running = 1`.

**Anthropic usage.** Using post-August Sonnet 5 pricing ($3/MTok input, $15/MTok output) so the number does not go stale on 2026-09-01:

- A cookbook photo at 2576 px long edge is capped at 4,784 visual tokens, plus roughly 500 tokens of prompt and schema, and produces maybe 800 output tokens. That is about **$0.028 per photo**.
- A URL that falls through to the LLM, with the HTML stripped to roughly 8,000 tokens, is about **$0.036 per recipe**.
- A URL where JSON-LD succeeds costs **$0.00**.

At an enthusiastic 30 new recipes a month with two thirds resolved by JSON-LD, that is well under $1. Even at 200 recipes a month it stays under $6. **The Anthropic bill is not a meaningful part of this budget**, which is worth internalizing: it means you should choose models for quality and latency, not price, and escalating to Opus 5 for the photo path costs pennies.

A dedicated IPv4 address is $2/month if you need one; Fly issues shared IPv4 for HTTP apps by default, so you likely do not, but I did not confirm that from a primary source.

## Risks and things I could not verify

Ordered by how much they could change a decision.

**Could not confirm from a primary source:**

1. **Where Fly volume snapshots physically live.** Neither the volumes, snapshots, nor pricing pages state whether snapshots are stored off-host or off-site. Survival of a host failure is implied by the docs' framing but never stated. This is a direct argument for the Litestream backup rather than trusting snapshots, and it is the most consequential gap in this document.
2. **Whether cross-document view transitions fire correctly inside an iOS standalone home-screen web app**, as opposed to a Safari tab. No primary source states either way. Test on device before committing to a cross-document architecture. This is cheap to check and would change the frontend approach if it fails.
3. **Whether iOS Add to Home Screen copies Safari's existing cookies into the web app's container.** [WebKit documents this for macOS Add to Dock only](https://webkit.org/blog/14205/). Assume the installed app may start logged out, and make sure the login flow works from a cold install.
4. **Fly's default proxy request and idle timeout.** Documented as a setting with no stated default or maximum. Set `http_options.idle_timeout` explicitly rather than relying on a default you cannot read.
5. **Whether Fly issues a free shared IPv4 for HTTP apps by default.** Pricing lists shared IPv4 as free, but I did not confirm the allocation behaviour. Worst case this is $2/month.
6. **Web Push's install-only requirement on iOS as of 26.5/27.** Documented for 16.4 and 18.4 with no reversal found, but no 2026-dated Apple page restates it. Only matters if you add notifications, which v1 does not.
7. **Current `apple-touch-startup-image` requirements.** Only archived Apple documentation covers splash screens. The recommendation is to skip them, which sidesteps this.
8. **Formal end-of-life dates** for legacy unmanaged Fly Postgres and for LiteFS. Both are signposted as unsupported; neither has a published sunset date.

**Risks that are verified but worth stating plainly:**

- **Bot-blocking will break the URL feature for some big sites, permanently.** 4 of 19 sites returned 403 to a datacenter fetch and a browser User-Agent did not help. This is not fixable by better code. It is a product constraint, and the mitigation is the photo path plus a paste-text fallback, not more engineering on the fetcher.
- **A single Fly volume can lose data.** Fly says so in their own words. Mitigated by Litestream, not by snapshots. If you skip Litestream, your worst case is losing up to 24 hours of recipes.
- **The 19-site JSON-LD sample is a snapshot, not a guarantee.** Coverage was 9 of 14 fetchable pages today. Sites change their markup. Build the LLM fallback properly rather than treating it as an edge case.
- **iOS Safari has no `interpolate-size`**, so any height-auto animation needs a workaround. Minor, but it will surprise you the first time.
- **Sonnet 5's introductory pricing ends 2026-08-31**, five weeks from now. The costs in this document use the post-August rate deliberately.
- **The docs host moved.** `docs.claude.com` now redirects to `platform.claude.com`. Anything you bookmarked or that an LLM remembers may point at the old host, and `output_format` (the old beta parameter) is superseded by `output_config.format`.

## Open questions for the owner

These were the questions left for the owner to decide. Everything else in this document was the researcher's call.

1. **One service or two?** I recommended a single SvelteKit app in TypeScript, which means writing your own JSON-LD normalizer (roughly a day). The alternative is SvelteKit plus a Python FastAPI backend, which gets you `recipe-scrapers` for free but doubles the number of things to deploy and keep running. This is a taste call about what you would rather maintain, and both answers are defensible.
2. **Do you actually want to run the box?** Fly at about $4/month buys managed TLS, secrets, and one-command deploys. A Hetzner VM with Caddy is cheaper in the EU and gives you total control at the cost of owning OS patching and backups forever. I recommended Fly because attention is your scarce resource, but if you enjoy sysadmin work, the VM is a reasonable choice and simplifies the durability story.
3. **What is the acceptable worst case for data loss?** I assumed "essentially zero, this is our recipe collection" and recommended continuous Litestream replication. If you would genuinely shrug at losing a day of edits, you can skip Litestream and rely on Fly's daily snapshots, and the setup gets simpler.
4. **How much do you care about recipes from Serious Eats, AllRecipes, and Food Network specifically?** These three hard-block server-side fetching. If they are where most of your cooking comes from, the URL feature matters much less than the photo and paste-text paths, and that should reorder what gets built first.
5. **Where should the two of you be able to add recipes from?** I assumed the web app only. If you want to share a URL from Safari or Instagram straight into the app, note that iOS does not support the manifest `share_target`, so there is no good web-only answer, and this would need a Shortcut. Worth deciding before the UI is designed.
6. **Is a shared login acceptable, or do you want two separate accounts?** Two accounts costs almost nothing extra and lets you attribute who added what, which tends to be nice a year later. One shared login is marginally simpler. I assumed two.
