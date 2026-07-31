# We Cooked: UI decisions

Settled 2026-07-29 with the owner, before phase 3 of the build. These cover
every UI decision that did not need a prototype. The four screens that do need
one are listed at the end of [DECISIONS.md](./DECISIONS.md) ("Decisions
deferred to prototypes"); prototypes are built in separate sessions and
reviewed by the owner.

Constraint carried into everything: no meaning encoded in color alone, and
never in red versus green. The owner is red-green colorblind. Every status
carries a word or an icon; every chip carries its word.

---

## D1. App shell and navigation

Bottom tab bar, three items: **Recipes** (home), **Add** (+), **Shopping**.
Thumb-reach on a phone, and those are the only three destinations. Trash is a
small link at the bottom of the Recipes list, not a nav item. No hamburger, no
top nav.

## D2. Login

One password field, one button, autofocus, `autocomplete="current-password"`
so iOS Keychain and Face ID do the work. Error text on failure, rate-limit
message when hit (SPEC 8.5). No logo art in v1.

## D3. Capture entry (the Add tab)

One screen:

- A single paste box that accepts a URL or recipe text (ADR-010 decides which
  path it takes).
- An "Add photos" button; added pages show as thumbnails before extraction.
- A primary "Extract" button.
- A quiet "type it in myself" link straight to the empty review form.

All four paths terminate in the review form (ADR-004).

## D4. Typography and theme

- System font stack (SF on iOS). No webfonts.
- Base 17px. Cooking-screen body 19 to 20px, sized for arm's length (SPEC 7.4).
- Light and dark from day one, via `prefers-color-scheme`. Cooking at night is
  real, and retrofitting dark mode is misery.
- One accent color, chosen visually in the first prototype (the cooking
  screen) and reused everywhere after. Chosen 2026-07-29: **saffron**,
  `#b45309` in light mode, `#f59e0b` in dark mode (text on the fill: white in
  light, `#2a1a00` in dark). Both pass contrast as button fills and sit on the
  blue-yellow axis, so they stay vivid under red-green colorblindness.

## D5. Chips

One chip component app-wide: tags on cards, filters on browse, yield chips on
the recipe screen. Selected state is filled plus a checkmark, never a
color-shift alone. Chips always carry their word.

## D6. Errors and progress

Inline banners only. No toast system, no toast library. One `Banner`
component (icon, text, optional action such as "tap to retry") covers every
case in SPEC 6.4, 7.2, and 7.5: extraction warnings, reconvert pending or
failed, stale variation updating, job errors.

## D7. Job cards on browse

Pending and failed capture jobs (SPEC 6.5) render as ordinary list rows with a
status line instead of tag chips: "Extracting…" with a spinner glyph,
"Failed: tap to fix" with a warning glyph. No special card design.

## D8. Trash

Plain list, two labelled groups (Recipes, Variations). Each row: title (plus
yield for variations), deleted date, Restore button. After a restore that
displaces a live variation, a banner states what happened (ADR-025).

## D9. Reordering in the editor

Up/down arrow buttons per line, for ingredient lines and steps. No drag and
drop: mobile drag is a dependency or a bug farm. Revisit only if the arrows
prove annoying in practice.

## D10. Delete placement

"Delete recipe" sits at the bottom of the edit form in a destructive zone.
"Delete variation" lives behind the variation chip's detail. Nothing
destructive on the cooking screen. Confirmation is one native-style sheet;
Trash is the real safety net (ADR-013).

## D11. Shopping list entry flow

From the Shopping tab, "Add recipes" opens the browse list in pick mode: a
checkbox per row, then a yield stepper per picked recipe, then Build. Reuses
the browse list wholesale. Pick-mode visual details are settled in the
shopping list prototype.

## D12. Desktop

Single centered column, max-width about 44rem, same components. No
desktop-specific layout in v1. Phone is the primary device.

## D13. Empty states

One line plus one action each. Recipes: "Add your first recipe". Shopping:
"Pick recipes to build a list". No illustrations.

## D14. Icons

**Lucide**, via `lucide-svelte`. Clean modern stroke icons, MIT licensed,
tree-shaken so only the icons actually used ship to the phone. The owner
explicitly wants the app to look clean and modern, so this is a deliberate
exception to the no-new-dependencies reflex. Use Lucide everywhere an icon
appears; no mixing icon sets, no ad-hoc SVGs unless Lucide lacks the glyph.

## D15. Unit toggle persistence

`localStorage`, per device (ADR-019). Default: **metric**.

## D16. PWA identity

App icon and theme colors are designed for looks, not minimalism: a simple
glyph mark on the D4 accent color, drawn as SVG during the first prototype
session, exported at 180, 192, and 512 plus a maskable 512 (SPEC 8.7).
`theme_color` and `background_color` match the accent and background from D4,
with sensible dark-mode values.

## D17. Missing-cover fallback

Added 2026-07-30 (second grilling round). A recipe with no cover image shows
a neutral tile: surface color with the D16 pot glyph, identical for every
coverless recipe. No initials, no hashed per-recipe colors: that
reintroduces meaning by color and reads as a contacts app.

---

## Prototypes

Four, matching the list in DECISIONS.md, built in this order:

1. **Cooking screen** first: 95% of use, and it sets the type scale, accent
   color, and app icon direction for everything else.
2. **Review form.**
3. **Browse list.**
4. **Shopping list.**

Nothing in D1 to D16 requires a fifth prototype.
