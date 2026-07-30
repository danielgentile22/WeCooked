# Prototype notes

## browse-list.html

Question: does the SPEC 7.3 browse list feel right, and which collapsed-filter
picker: A bottom sheet, B anchored popover, or C inline accordion? Switch via
`?variant=` or the floating bar.

Uses cooking-prototype tokens with accent A (saffron), PENDING the
cooking-screen verdict; swap the `--accent` values in `:root` if B or C wins.
Critique snapshot: `.impeccable/critique/2026-07-30T00-23-35Z__prototypes-browse-list-html.md`
(17/36 pre-polish; Assessment A recommends variant A, and suggests showing
effort + damage inline with one "Filters" entry for the rest — not applied,
owner's call). Known ceilings left as-is: search has no debounce or pending
state (server-side FTS in production), job rows are static fixtures, no
missing-cover fallback, newest-first ordering invisible without dates.

Verdict (2026-07-29, Daniel): **C, inline accordion.** Filter options expand
in place beneath the category bar; no overlay, no modal machinery. Note for
the build: the critique preferred A on thumb-reach grounds and measured that
C's largest group (cuisine, 7 values) pushes the first result to ~53% of a
390px-wide viewport while open. Daniel picked C with that known; keep the
accordion compact (44px chips, tight padding) and close it on selection-free
outside taps. Delete the prototype once the real browse route exists.

## shopping-list-prototype.html

Question: does the SPEC 7.6 / ADR-015 shopping list feel right on a phone?
One design (no variants): empty state, pick mode with yield steppers, fake
build job with D6 banner, merged list with dual units, provenance, shared
ticks, manual lines, staples collapsed, confirmed "Done shopping".

Uses cooking-prototype tokens with accent A (saffron), PENDING the
cooking-screen verdict; swap `--accent` in `:root` if B or C wins.
Critique snapshot: `.impeccable/critique/2026-07-30T00-21-03Z__prototypes-shopping-list-prototype-html.md`
(18/40 pre-polish). Known ceilings left in `ponytail:` comments: fixed fake
build delay (no failure/retry state), manual lines always land in "other".
No wake lock (needs the real PWA context).

Verdict: _pending Daniel's look. Record here, then delete the prototype._

## review-form-prototype.html

Question: does the SPEC 7.2 field order and interaction set (groups, up/down
reorder, chip cardinality, body toggle) feel right on an iPhone, and which
layout: A card stack, B tabs, or C accordion sheet? Switch via `?variant=` or
the floating bar.

Verdict (2026-07-29, Daniel): **A, card stack.** One open scroll of card
sections. This is also the layout the critique judged safest for the ADR-004
job: the extraction always passes in front of human eyes before Save. Note
for the build: A means the full-scale tag section (47 chips) and the editor
live on one long page, so keep the "Show all N" collapse for long tag groups
and the warning jump-links; they are what make one scroll workable. The
critique's open question of whether edit-existing mode later wants C's live
summaries stays open in the snapshot; it would need an ADR (partially breaks
"one editor"). Delete the prototype once the real review route exists.

Design pass 2026-07-29 (impeccable critique 16/40, snapshot in
.impeccable/critique/): adopted cooking-prototype tokens (warm palette, saffron
accent, dark mode), Lucide inline icons, 44px targets, full-width editor lines,
real SPEC 3.4 tag vocabulary ("messy", not "some dishes"), undo on remove,
warning jump-links with field markers, sessionStorage draft. Open design
questions the critique raised (mode split A-vs-C, confirmation-as-an-act,
per-field warning targeting in the schema) are in the snapshot's Questions.

## cooking-screen.prototype.html

Question: does the SPEC 7.4/7.5 cooking screen feel right, and which accent
color + icon glyph does the app adopt (D4/D16)?

Open the file directly in a browser (iPhone or narrow window). Variants via
the floating bar or arrow keys:

- A: Saffron, `#b45309` light / `#f59e0b` dark (recommended)
- B: Teal, `#0f766e` light / `#2dd4bf` dark
- C: Indigo, `#4f46e5` light / `#818cf8` dark

Icon glyph proposal: lidded pot with three steam wisps, single stroke, shown
on the accent tile at the bottom of the page.

Design pass 2026-07-29 (impeccable critique 26/40 pre-polish, snapshot in
`.impeccable/critique/2026-07-30T00-26-46Z__prototypes-cooking-screen-prototype-html.md`):
polish applied — 44px targets throughout, strike lines are real buttons
(keyboard + aria-pressed), fixed role="status" banner with working AND done
states, busy Calculate button, hand-authored 6-portion data, Lucide check,
quiet read-only tag chips + "messy" damage tag, neutral cover (accent-fair),
rem-based type, reduced-motion + safe-area guards, struck-text contrast fixed.
Known ceilings (deliberate, prototype-only): no wake lock, strikes memory-only
(production: sessionStorage per recipe), no failure banner exercised, yields
other than 4/6/8 reuse 4-portion body. Bigger design questions for the build,
not the prototype: controls unreachable when deep in steps, no live-step
marker, no "cooked it" ending (see snapshot Questions).

Verdict (2026-07-29, Daniel): **Accent A, saffron** (`#b45309` light /
`#f59e0b` dark). Recorded in docs/UI.md D4. Icon glyph and interaction notes:
no objection raised; pot-with-steam glyph stands as the D16 direction unless
Daniel says otherwise. Delete the prototype once the real cooking route
exists.
