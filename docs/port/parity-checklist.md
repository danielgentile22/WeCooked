# Parity checklist

One row per behaviour the web app has, drawn from `web-inventory.md`. A row
passes when it works in the native app against the real server. The Sim
column is ticked by the agent on the simulator with seeded data. The Phone
column is ticked by the owner on a device.

| # | Area | Behaviour | Sim | Phone |
|---|------|-----------|-----|-------|
| 1 | Login | Wrong password shows "Wrong password." inline | | |
| 2 | Login | Five failures show the 15 minute rate limit message | | |
| 3 | Login | Success lands on Recipes, token survives relaunch | | |
| 4 | Login | A 401 from any call returns to the login screen | | |
| 5 | Browse | Recipes newest first with thumbnail or pot tile, title, effort and damage chips | x | |
| 6 | Browse | Search filters as you type, prefix matching, debounced | x | |
| 7 | Browse | Tag filters per group, OR within a group, AND across groups | x | |
| 8 | Browse | Extracting drafts show a status row and update when done or failed | x | |
| 9 | Browse | Ready and failed drafts open the draft screen | x | |
| 10 | Browse | Empty states: "No recipes match." and "Add your first recipe" | x | |
| 11 | Browse | Trash link at the bottom | x | |
| 12 | Browse | A recipe seen before opens instantly, then refreshes | x | |
| 13 | Recipe | Header: title, yield, prep and cook, cover, source line linked when a URL exists | x | |
| 14 | Recipe | Tag chips in order: meal types, cuisine, protein, effort, damage | x | |
| 15 | Recipe | Variation chips ascending, original marked, tap switches | x | |
| 16 | Recipe | Selected non-original chip reveals Delete this variation with confirmation | | |
| 17 | Recipe | Stepper: plus and minus by 1, decimal input, never zero, resets on variation change | x | |
| 18 | Recipe | "Show N" when the yield exists, "Calculate for N" otherwise | x | |
| 19 | Recipe | Calculate shows the banner, polls, and switches to the new variation | | |
| 20 | Recipe | A pending calculation resumes after relaunch | | |
| 21 | Recipe | Calculation failure shows the error text with retry | | |
| 22 | Recipe | Stale untouched variation: "updating" banner, then "Updated to match the original." | | |
| 23 | Recipe | Stale hand-edited: Recalculate (confirmed) and Keep mine | | |
| 24 | Recipe | Unit toggle with "as written" marker, remembered per device, default metric | x | |
| 25 | Recipe | Reconvert pending and failed banners on the non-source units, with retry | | |
| 26 | Recipe | Sticky collapsible ingredients with group headings, numbered steps, notes, photo strip | x | |
| 27 | Recipe | Tap to strike ingredients and steps, per device, survives unit toggle, kept 12 hours across relaunch (owner decision) | x | |
| 28 | Recipe | Screen stays awake while the recipe is visible | | |
| 29 | Recipe | Edit opens the editor for the viewed variation | x | |
| 30 | Add | Paste box: URL creates an extract_url job, text an extract_paste job | x | |
| 31 | Add | Empty paste shows "Paste some recipe text first." | x | |
| 32 | Add | Photos upload on pick, thumbnails with remove, at most 8 | x | |
| 33 | Add | Upload failure copy shown | | |
| 34 | Add | "Type it in myself" opens the empty editor | x | |
| 35 | Draft | Queued or running shows progress and polls | x | |
| 36 | Draft | Failed shows the error text and Try again | x | |
| 37 | Draft | Warnings shown as banners | x | |
| 38 | Draft | Damage reasoning and pasted text shown | x | |
| 39 | Draft | Done seeds the editor with the draft, images and source URL | x | |
| 40 | Draft | Save creates the recipe and opens it; the card leaves Browse | x | |
| 41 | Draft | Discard asks twice, then removes the draft | x | |
| 42 | Draft | A saved draft reopened goes to its recipe | | |
| 43 | Editor | Defaults: yield 4 servings, metric, effort and damage unselected | x | |
| 44 | Editor | Opens in the device's units when a counterpart exists | x | |
| 45 | Editor | Unit toggle swaps bodies when editing, disabled without a counterpart | x | |
| 46 | Editor | Ingredient groups: add, remove, reorder lines and groups | x | |
| 47 | Editor | Steps: add, remove, reorder | x | |
| 48 | Editor | Tags: multi meal types, single cuisine and protein with clear, effort and damage required | x | |
| 49 | Editor | Photos upload on pick, first is cover, tap sets cover, removing cover moves it | x | |
| 50 | Editor | Server validation messages shown inline | | |
| 51 | Editor | Draft autosaves per device for 7 days and restores silently, Start over asks twice (owner decision) | x | |
| 52 | Editor | Payload rule matches the web app exactly (unit tests) | x | |
| 53 | Editor | Delete recipe at the bottom with confirmation, goes to Trash | x | |
| 54 | Shopping | Sections in order, generated then manual, staples collapsed | | |
| 55 | Shopping | Item text follows units, secondary line shows the other units and source titles | | |
| 56 | Shopping | Header count "N of M ticked" | | |
| 57 | Shopping | Tick is instant, queued without signal and sent later, and a tick from the other phone appears within 5 s (owner decision) | | |
| 58 | Shopping | Pick mode: checkbox per recipe, whole number stepper min 1, Build | | |
| 59 | Shopping | Build shows a banner and skeletons, then the list | | |
| 60 | Shopping | Rebuild banner with kept and reset counts, shown once | | |
| 61 | Shopping | Build failure shows error text with retry | | |
| 62 | Shopping | Add a manual line | | |
| 63 | Shopping | Done shopping asks twice, clears everything | | |
| 64 | Shopping | Empty state "Pick recipes to build a list" | | |
| 65 | Trash | Two groups, title, yield for variations, deleted date, Restore | | |
| 66 | Trash | Restore variation that displaces shows the displaced banner | | |
| 67 | Trash | Restore errors shown | | |
| 68 | Shell | Three tabs, Recipes, Add, Shopping | | |
| 69 | Shell | Light and dark follow the phone | | |
| 70 | Shell | No meaning by colour alone, chips carry words, selected state has a checkmark | | |
