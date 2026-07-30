---
target: prototypes/review-form-prototype.html
total_score: 16
max_score: 40
na_heuristics: 
p0_count: 2
p1_count: 3
timestamp: 2026-07-30T00-23-00Z
slug: prototypes-review-form-prototype-html
---
Method: dual-agent (A: design-review subagent · B: detector subagent)

# Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 1 | No reconvert banner (SPEC 7.2), no save/dirty state; "not saved yet" is static text |
| 2 | Match System / Real World | 3 | Vocabulary right, but damage value "some dishes" should be "messy" (SPEC 3.4) |
| 3 | User Control and Freedom | 1 | ✕ removes lines/steps/groups instantly, no undo, no discard, no draft |
| 4 | Consistency and Standards | 1 | D4 (no dark mode, no accent), D6 (bespoke warning box), D14 (emoji icons), D12 (430px cap) all violated |
| 5 | Error Prevention | 1 | 34px destructive ✕ 6px from ↓; requirements only revealed in a post-hoc alert() |
| 6 | Recognition Rather Than Recall | 2 | Warnings name referents in prose only; no anchor or marker on the truncated step 4 |
| 7 | Flexibility and Efficiency | 2 | No Enter-to-add-next-line in the list editor; manual entry is 6 taps per ingredient |
| 8 | Aesthetic and Minimalist Design | 2 | Eleven equal-weight cards; Ingredients/Steps look like Source/Notes |
| 9 | Error Recovery | 1 | Only error surface is alert(); doesn't name which requirement failed or move focus |
| 10 | Help and Documentation | 2 | Arity cards are right; the highest-stakes fact (body regeneration on edit) is the quietest 13px text |
| **Total** | | **16/40** | **Poor** |

# Design Specificity Verdict

Category-interchangeable (2/10 authored). Pure neutral grayscale; the saffron accent, warm stone palette, and dark mode from the incumbent cooking-screen prototype appear nowhere. The two product-specific inventions ("as written" pill, damage tags) are the quietest elements on the page. Deterministic scan: clean (0 findings, exit 0) — detector silence is not quality evidence here; every real issue was judgment-layer. Browser overlay: not attempted (browser confirmation step unavailable to the subagent).

# Priority Issues

- [P0] Verification through a ~30-character window: ingredient inputs share a row with three buttons, leaving ~30 visible characters; steps scroll inside 2-row boxes. The one screen whose job is "human reads the extraction" clips the thing being read. Fix: full-width wrapping text, controls moved off the text row.
- [P0] D4 violated / identity fork: no dark mode, no accent, cool-gray palette vs the incumbent warm stone + saffron. Fix: adopt the cooking prototype's :root tokens verbatim.
- [P1] Tags untested at real scale and one value wrong: 21 chips shown vs 47 real (meal 11, cuisine 19, protein 11); "some dishes" fails the DB CHECK ("messy"). Fix: real vocabulary + disclosure for long groups.
- [P1] Systematic 44pt failure, worst on destructive ✕ (34px, 6px from ↓), no undo. Fix: 44px targets, separate ✕ from arrows, inline undo banner per D6.
- [P1] No thread from warning to referent and no interruption-surviving state: warnings are prose with no anchors; state is a bare object; ←/→ reloads the page outside inputs. Fix: warnings as jump-links marking their fields; draft autosave.

# Persona Red Flags

- Casey (mobile): no persistence, arrow-key reload data loss, 34px ✕ mis-taps, Save-on-every-tab in B fails on a field in another tab, notes buried under fixed chrome.
- Sam (screen reader): variant C display:none removes the only labels for title/source/notes and all headings; variant B declares tabs without tab behavior; positional aria-labels renumber on reorder with no live region; ::before checkmark pollutes accessible names; effort/damage are radios announced as toggles; warnings never announced; no :focus-visible styles.
- Jordan (first-timer): first screen opens on failure (warning box); "ADR-004" in shipped copy; "bodies" unexplained; three grammars for chip arity; damage unexplained; nothing marked required; no way out; variant C lets Save happen without ingredients ever rendering.

# Minor Observations

Emoji as UI icons (⚠️ 📷) and text glyphs standing in for Lucide; body capped at 430px vs D12's 44rem; no main landmark; flat h2 hierarchy; yield unit visually unlabeled; Prep min/Cook min abbreviations; no photo add/remove; save has no states; disabled reorder cue is opacity-only; one hard-coded title for three form modes; editing one body leaves counterpart silently stale (SPEC 7.2 banner missing).

# Questions to Consider

1. Should confirmation be an act rather than an assumption (warning count that decrements, Save that names what it confirms), given B and C allow Save without the ingredients rendering?
2. Is this two surfaces sharing one field set — first-review must be one open scroll, edit-existing wants C's live summaries — needing a mode, not a winner?
3. Should machine-guessed fields be visually distinct from transcribed ones until touched? If yes, extraction_warnings as flat strings can't say which field, and the highest-leverage output is a schema change.
