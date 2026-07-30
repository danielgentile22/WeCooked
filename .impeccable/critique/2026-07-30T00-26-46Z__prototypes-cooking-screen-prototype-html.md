---
target: prototypes/cooking-screen.prototype.html
total_score: 26
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
timestamp: 2026-07-30T00-26-46Z
slug: prototypes-cooking-screen-prototype-html
---
Method: dual-agent (A: design review sub-agent, opus-4.8 · B: detector sub-agent, sonnet-5)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | Working banner scrolls away mid-job; completion is silent |
| 2 | Match System / Real World | 4 | Excellent: sublinear scaling, vessel/time changes, "as written" marker |
| 3 | User Control and Freedom | 2 | No cancel on Calculate, no bulk clear-strikes |
| 4 | Consistency and Standards | 2 | Tag chips visually identical to interactive yield chips; seg control shape outlier; text ✓ not Lucide |
| 5 | Error Prevention | 3 | Core never-trigger-work rule is excellent; Calculate unguarded next to `+` |
| 6 | Recognition Rather Than Recall | 4 | Sticky ingredients kill the memory bridge; verified zero scroll drift |
| 7 | Flexibility and Efficiency | 3 | Unit toggle persisted; no type-size control, no keyboard path |
| 8 | Aesthetic and Minimalist Design | 3 | Clean; but first viewport is metadata, Notes styled quietest |
| 9 | Error Recovery | 1 | None of the SPEC 7.5/D6 failure banners exist; failed job would hide Calculate forever |
| 10 | Help and Documentation | 2 | Tap-to-strike has zero affordance (explained only in fake note text) |
| **Total** | | **26/40** | **Acceptable** |

## Design Specificity Verdict

Interaction-specific and data-specific; visually category-interchangeable. The yield-chip/stepper/Calculate model is unmistakably this product's (verified: stepper never triggers work, button only on chipless numbers). The hand-authored sublinear fake data (salt 8g→13g, 28cm→34cm casserole) is the best argument on screen. But composition is generic recipe-page, damage rating (tidy/messy/carnage) absent, nothing says the household ever cooked it.

Deterministic scan: 2 findings. REAL: `side-tab` — banner's 4px accent border-left (craft-floor bans colored border-left >1px). FALSE-POSITIVE: `single-font` — system stack is mandated (D4). Browser overlay skipped: single browser session reserved by Assessment A.

## Priority Issues

- **[P1] Wet-hand touch targets under 44px**: yield chips 40x32, stepper halves seamless in one pill, ingredient rows 40px. Fix: min-height 44px chips, bigger stepper with dividers, taller rows. (polish)
- **[P1] Strike lines inaccessible**: bare `<li>` with delegated click; tabIndex -1, no role, no aria-pressed; memory-only Set dies on iOS PWA discard mid-braise. Fix: full-width buttons with aria-pressed; persistence deferred to build. (polish/harden)
- **[P1] The money moment has no reassurance and no ending**: button vanishes on tap, banner is in-flow (scrolls away, top:617px), removed silently on completion, no role="status", calculating never reset on failure. Fix: fixed/sticky status with role="status", disabled in-place button state, completion message, failure reset. (polish)
- **[P2] First viewport is metadata**: 200px cover + tags before any cooking content; Notes (real substitutions) styled smallest/lowest-contrast. Fix: shrink cover, promote Notes to cooking scale. (layout)
- **[P2] Product vocabulary missing / chip semantics**: no damage tag; span-chips identical to button-chips; ✓ not Lucide; hardcoded orange cover gradient biases the accent-A judgment. Fix: add damage chip, differentiate tag chips, Lucide check, neutral cover. (polish)

## Persona Red Flags

- **Casey (one-handed, interrupted)**: all controls at top of 2916px doc, hardest thumb zone; smallest target (40x32 chip) has largest consequence; strikes lost on OS discard; no cancel on Calculate.
- **Sam (a11y)**: strike interaction 100% keyboard/SR-inaccessible (11 focusable elements, none content); banner unannounced; absolute px root defeats browser font-size prefs; struck text 2.5:1 light / 2.9:1 dark; no prefers-reduced-motion; sticky misses safe-area-inset-top. Colorblind constraint verified genuinely satisfied in every state.
- **Wife mid-cooking (60cm, wet hands)**: To-finish group below fold of invisible inner scroller; open block eats 50% viewport; no live-step indicator; no wake lock in file (SPEC calls it non-negotiable).

## Minor Observations

Strike keys survive yield switch though text differs; chip row wraps/shifts ~25px when ✓ inserts (reserve width); .seg only non-pill control; "converted" sublabel reads as promise; STEPS aliasing (marked ponytail); no theme-color/PWA meta; "Portions" not a programmatic group; Calculate-for-6 result shows unchanged 4-portion body so the payoff is invisible; icon glyph reads correctly on all three accents.

## Questions to Consider

1. What on this screen shows that *we cooked* it? (No last-cooked, no damage rating, no note attribution; ends on empty photo strip.)
2. Steps carry "3 hours" / "12 minutes" and the screen holds a wake lock — is a tappable timer a feature or scope creep?
3. Can the accent be judged against a hardcoded orange cover gradient that harmonizes with variant A and fights B and C?
