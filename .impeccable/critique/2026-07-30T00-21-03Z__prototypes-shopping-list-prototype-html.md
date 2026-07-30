---
target: shopping list prototype
total_score: 18
max_score: 40
na_heuristics: 
p0_count: 3
p1_count: 3
timestamp: 2026-07-30T00-21-03Z
slug: prototypes-shopping-list-prototype-html
---
Method: dual-agent (A: design review sub-agent · B: detector sub-agent)

# Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | Build teleports to a finished list; ADR-027's job (the "survives a locked phone" reassurance) has no pending/progress state |
| 2 | Match System / Real World | 3 | Aisle order and provenance are strong, but steppers produce "4.5 eggs" / "2.5 onions" |
| 3 | User Control and Freedom | 1 | "Done shopping" wipes both phones with no confirmation or undo; no route back to a built list after unchecking recipes |
| 4 | Consistency and Standards | 1 | Violates D1 (no tab bar), D4 (no dark mode, 16px base, unsanctioned green accent), D14 (text glyphs, no Lucide), D5 (fill-only selected state) |
| 5 | Error Prevention | 1 | Destructive control unguarded and in the keyboard-dismiss landing zone; rebuild silently drops ticks |
| 6 | Recognition Rather Than Recall | 2 | No denominator or "N left"; ticks inside collapsed staples counted but invisible |
| 7 | Flexibility and Efficiency | 2 | Tap target is the 24px checkbox only; re-render kills add-item focus |
| 8 | Aesthetic and Minimalist Design | 2 | Three text registers per line at equal weight; rarely-used unit toggle owns the prime slot |
| 9 | Error Recovery | 1 | No error state exists; D6 Banner absent despite ADR-027 designing for benign mid-build failure |
| 10 | Help and Documentation | 3 | The two syncnote lines are exemplary but only pre-fact; nothing reassures during build or at clearing |
| **Total** | | **18/40** | **Poor — major fixes before this answers its own question** |

# Design Specificity Verdict

Authored at the data layer (aisle sections, "check you have", per-line provenance, ADR-aware copy), category-interchangeable at the surface: the list screen is a stock bordered-card checklist, entirely achromatic, with the product's one distinctive concept (provenance) rendered as the smallest greyest text. Accent #2f5d50 is a fourth colour that pre-empts the still-pending D4 decision (saffron recommended), and it is a green in a product engineered around a red-green colourblind owner.

Deterministic scan: 1 finding — flat-type-hierarchy (6 sizes packed into 11–20px). Verified, not a false positive. Objective facts: no dark-mode media query, no focus styles authored, disabled CTA contrast 2.04:1 (fail), 22–24px checkboxes and ~32px topbar controls (below 44px), border contrast 1.32:1. Browser overlay skipped (headless sub-agent).

# Priority Issues

- **[P0] "Done shopping" is an unguarded, irreversible, both-phones wipe wearing the checkmark (the safest glyph on screen), directly in the keyboard-dismiss thumb zone.** Fix: confirmation naming the scope, a non-checkmark glyph, distance from the add field.
- **[P0] Every tick re-renders the whole list**, destroying keyboard focus and screen-reader position, with no aria-live feedback. Fix: mutate the one row; live-region the count; real list semantics and whole-row labels.
- **[P0] Token divergence from D4/cooking prototype**: no dark mode, 16px base, rival accent, viewport-fit=cover without safe-area padding. Fix: adopt the cooking prototype's token block verbatim.
- **[P1] No bottom tab bar (D1) and no build/job state (ADR-027)** — the thumb-zone geometry is judged in space that won't exist and the flow's hardest moment is skipped. Fix: add tab bar, delete the in-content back button, add building/failure Banner states.
- **[P1] Rebuild silently discards ticks**, contradicting "human edits are never silently destroyed". Fix: Banner naming kept/reset ticks.
- **[P1] The most-used control (the tick) is the smallest and least reachable.** Fix: whole row is the label, min-height 48px.
- **[P2] Flat line hierarchy; provenance/alt-units always-on.** Fix: semibold tabular-nums quantity, one muted secondary line.
- **[P2] No denominator/progress.** Fix: "12 of 24 ticked".

# Persona Red Flags

- **Casey (one-handed, in shop):** 24px left-edge tick target; Done under the add field; unit toggle wasting the prime slot; unreadable 12px provenance; no "N left" without scrolling; focus lost after each manual add.
- **Sam (SR/keyboard):** full re-render on tick (blocking); no aria-live; div soup instead of ul/li; text glyphs (‹ ▾ ✓) announced unpredictably; disabled CTA at 2:1; static chevron lies about details state. Colour-independence itself passes cleanly.
- **Riley (stress):** empty state unreachable and its CSS dead; stranded state (built list, uncheck all, no way back); fractional counts ("4.5 eggs"); tick-key collision between manual "milk" and dairy milk; long-token overflow (no min-width:0); manual items always land in "other".

# Minor Observations

Header count includes invisible collapsed-staples ticks; esc() misses apostrophes; two primary-button scales (16/17px); "0 ticked" as greeting; manual-lines-survive-rebuild is modelled correctly and worth preserving.

# Questions to Consider

1. Why is "Done shopping" a button at all, versus an undoable auto-clear when the last non-staple line is ticked?
2. Are provenance and alt-units aisle-time information or kitchen-table information — should shop view demote them?
3. The one distinctive sync feature is invisible: where is the evidence of the other person?
