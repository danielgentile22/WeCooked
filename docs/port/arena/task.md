# Arena task: shape of the We Cooked iOS app

Repo: /Users/daniel/Projects/we-cooked. Read, in this order:
- docs/port/PLAN.md (the port plan; you are designing unit 2 and the skeleton every later unit fills)
- server/src/routes/api/v1/README.md (the API the app talks to)
- docs/port/web-inventory.md sections 3, 4, 6 and 7 (domain types, job polling, per-device state, client-only behaviour the app must reimplement)
- WeCookedKit/Tests/Fixtures/*.json (real replies; the Swift models must decode these)
- PRODUCT.md and docs/UI.md (product and UI constraints; the native app should feel better than the web app, not merely match it)

Produce a DESIGN PACKAGE, not an app. Write Swift files with `fatalError("not implemented")` bodies, doc comments, and pseudocode where logic is tricky. Include:

1. `project.yml` for XcodeGen: app target `WeCooked` (SwiftUI, iOS 26 minimum, bundle id kitchen.wecooked.ios, Swift 6 language mode, strict concurrency), a local Swift package `WeCookedKit` the app depends on, a unit test target for the package that reads the fixtures, and a placeholder for a later `WeCookedShare` extension target with an app group. Explain how `xcodegen generate` plus `xcodebuild` builds and tests it.
2. `WeCookedKit/Package.swift` and the module map: which files, which types live where, and why.
3. Models: Swift types for everything in the fixtures (RecipeDetail, VariationChip, BrowseRow, DraftCard, DraftView, RecipeInput, BodyText, IngredientGroup, ShoppingState, ShoppingItem, Trash, JobPoll, tag enums, error codes). Decide how unknown enum values from the server are handled. Show how the fixture-driven decoding test is written.
4. API client: one type over URLSession that takes the base URL and a token store, maps `{error}` bodies to a typed error, handles 401 (log out), honours `X-Session-Token`, uploads raw JPEG, and exposes one method per endpoint. Show three call sites.
5. Token store: Keychain, shared with the future share extension via an access group.
6. App state and caching: how screens get data, how a recipe already seen shows instantly on reopen while refreshing (the web app has no offline mode, the native app should never show a spinner for something it has seen), how mutations update what is on screen, and where per-device state lives (unit preference, strikes per variation per session, editor drafts, the "seen build" marker). Trace these access patterns through the structure: open recipe list, tap recipe, toggle units, strike a line, calculate a new yield and poll, tick a shopping item from two phones, edit a recipe and return to the list.
7. Job polling: one reusable piece the calculate, capture, refresh, reconvert and shopping build flows all use, with the 1.5 s then 5 s cadence and the 5 minute timeout.
8. Navigation and app target structure: tab shell (Recipes, Add, Shopping), the recipe screen, the editor, sheets, and how a share extension or a push notification would later deep-link to a draft.
9. Editor payload rule (inventory section 7, RecipeForm payload) as a pure function with its signature and the test cases it must pass.

Constraints: iOS 26 minimum, Swift 6 strict concurrency, Observation framework (@Observable), no third-party dependencies, SF Symbols instead of Lucide, system fonts. Prefer fewer files with clear boundaries over many thin ones.

Write everything under your output directory, mirroring the intended repo layout (project.yml at the top, WeCooked/, WeCookedKit/). Write RATIONALE.md per the rationale template at /Users/daniel/.claude/skills/architect/references/rationale-template.md, with the caller's usage written first. Do not modify the repo.
