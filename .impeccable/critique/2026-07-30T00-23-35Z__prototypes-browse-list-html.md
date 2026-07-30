---
target: prototypes/browse-list.html
total_score: 17
max_score: 36
na_heuristics: 10
p0_count: 2
p1_count: 2
timestamp: 2026-07-30T00-23-35Z
slug: prototypes-browse-list-html
---
Method: dual-agent (A: design-review sub-agent · B: detector/browser sub-agent)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 1 | Filter state collapsed to counts; with 9 filters active, 264px of the category bar is clipped so 2 of 5 active groups are invisible; no result count, no aria-live, no search feedback |
| 2 | Match System / Real World | 3 | damage/effort vocabulary is genuinely this product's; undercut by raw DB slugs as UI copy ("meal type", "middle-eastern") |
| 3 | User Control and Freedom | 1 | No clear-all, no per-group clear, no Escape; unwinding a 9-filter dead end takes up to 14 taps through 5 pickers |
| 4 | Consistency and Standards | 2 | Contradicts D1 (no tab bar/Trash link), D4 (no dark mode, no accent), D7 (bespoke dashed job cards vs "ordinary rows"), D14 (text glyphs, not Lucide); black fill means both "selected" and "carnage" |
| 5 | Error Prevention | 2 | Nothing prevents over-constrained filter sets; no per-option counts or dimming |
| 6 | Recognition Rather Than Recall | 1 | Closing a picker erases which values are selected; "cuisine · 2" forces recall or reopen |
| 7 | Flexibility and Efficiency | 2 | AND/OR logic verified correct; search + filter bar scroll away (not sticky) |
| 8 | Aesthetic and Minimalist Design | 3 | Restrained, warm, good row rhythm; 305px (40% of viewport) consumed before first recipe |
| 9 | Error Recovery | 2 | Failed-job copy is excellent but the row is an inert div that says "tap to fix"; zero-results offers no exit |
| 10 | Help and Documentation | n/a | Two named users, private by design; no help surface should exist |
| **Total** | | **17/36** | **Poor–Acceptable boundary (47%)** |

## Design Specificity Verdict

Partly authored, structurally interchangeable. The vocabulary (tidy/messy/carnage as first-class chips) and the failure copy are unmistakably this product; the warm neutral palette reads kitchen, not SaaS. But the screen itself is a generic filterable list: the two defining facts (propped phone + wet hands; 26-value closed vocabulary for two users) left no mark on the layout. Every target is 32.5px, all filtering lives in the least-reachable top 140px, and a small fixed taxonomy is hidden behind 5 opaque counters as if unbounded.

Deterministic scan: CLI detector clean (0 findings). Live injection found 1 anti-pattern, only with variant B's popover mounted: gpt-thin-border-wide-shadow on .pop (1px border + 24px shadow) — real but it is also the standard popover treatment. Detector ran under Chrome forced-dark, which itself exposed the missing color-scheme declaration: the page has no dark mode and auto-dark collapses the tag palette (the words are the only surviving signal — the D5 safety net doing all the work).

Measured layout bug (B, confirmed by both agents independently): .pop is position:absolute with no positioned ancestor, so it resolves against the viewport; max-width reads the viewport, the clamp math goes negative, and every popover renders flush-left at 12px regardless of anchor. Variant B never actually anchors — it is unjudgeable as built.

## Priority Issues

- [P0] Touch targets: every filter control is 32.5px (iOS minimum 44) with 6px gaps, at the top of the screen, for a wet-handed arm's-length user. Fix: 44px min-height chips, 10px gaps.
- [P0] Over-filtered dead end: invisible active filters + no clear-all + "No recipes match." with no action. Fix: persistent removable active-filter chip row, result count (aria-live), clear-all in the empty state.
- [P1] Variant B positioning bug (above) — fix so B can be judged at all.
- [P1] Primary action inert: recipe rows and the "tap to fix" job row are plain divs — unfocusable, unannounced, untappable. Fix: rows become links; job failure becomes a button/link.
- [P2] Modal/live-region a11y absent (no dialog role, focus management, Escape, aria-expanded, search label) and 4 contrast failures (#8a8378 empty state 3.35:1; sheet headings and chevron 3.75:1; chip/search borders 1.5–1.75:1 non-text).
- [P2] D4/D14 drift: no dark mode, no accent, text glyphs instead of Lucide; two colliding chip systems (black fill = selected AND carnage).

## Persona Red Flags

Casey (distracted mobile): 32.5px targets past a dead wordmark; "cuisine · 2" after an interruption; bar not sticky after scrolling; taps a recipe, nothing happens; B/C dismiss on any stray touch.
Sam (screen reader + colorblind): cannot open any recipe (divs); sheet leaves focus on body, nothing announces, no Escape; search results change silently; glyphs announce badly ("circle with left half black"); colorblind substance passes — words everywhere, zero red/green hues confirmed programmatically.
Riley (stress): bar overflows even at rest (90px clipped at 390px — damage, the signature filter, hidden by default); variant C's cuisine accordion pushes first result to 53% of viewport; sheet Done button collides with the band where the D1 tab bar will live; no empty-book state (D13); 94-char title wraps to 4 lines with no clamp; no missing-cover fallback.

## Minor Observations

"Done" mislabeled (selections are live — it's Close, or better, "Show N recipes"); no prefers-reduced-motion; newest-first ordering invisible; no debounce/pending state for a server-side search; innerHTML from titles; DB keys as UI copy; D11 pick-mode checkbox never tested against the row; D1 Trash link missing; .cat.open ring invisible.

## Questions to Consider

1. Why is anything hidden? effort + damage are six values total and already printed on every row — shown inline, the bar overflow and the recall problem mostly vanish, and A/B/C becomes a much smaller decision.
2. On a propped phone, why is the filter bar at the top? A single 44px "Filters (n)" button by the D1 tabs opening one all-groups sheet is one thumb-reachable target.
3. What is the search box for, given the filters? With hundreds of recipes and FTS over tags, typing "thai" beats three taps into cuisine; layout should say which is primary.

## Variant Recommendation (Assessment A)

A (bottom sheet), modified: it alone puts options in the thumb zone, has forgiving dismissal, and preserves list scroll position. C is worst-of-both (top-anchored AND pushes results below the fold) — cut. B is unjudgeable until the positioning fix lands; even fixed, popovers are a pointer idiom on a 390px screen. Owner decides after the polish pass makes B honest.
