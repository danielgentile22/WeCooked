# We Cooked: ubiquitous language

Glossary only. Implementation lives in docs/SPEC.md; reasoning in
docs/DECISIONS.md.

## Terms

**Recipe.** The thing you cook. A recipe row exists only after a human
confirmed it in the review form.

**Variation.** A rendering of a recipe at a particular yield. Saved data,
never a cache; can carry hand edits made at the stove. Exactly one per recipe
is the **original**, permanently labelled so, and it cannot be deleted.

**Body.** The ingredients and steps of one variation in one unit system (US
or metric). Every variation has both. The body a human last authored is
marked **as written**; the other is machine-converted.

**Capture.** Getting a recipe into the book, by URL, pasted text, photos, or
typing. All capture paths terminate in the review form.

**Draft.** A capture that has not yet been saved as a recipe. Lives entirely
in its job row. Appears on the browse list as a card until saved or
discarded.

**Discard.** Throwing away a draft. Distinct from **Delete**: deleting a
recipe or variation is soft and goes to Trash, because it destroys human
work; discarding a draft is hard, because a draft is machine output.

**Trash.** Where soft-deleted recipes and variations go, restorable. Only
those two things; nothing else is ever in Trash.

**Strike.** Tapping a line on the cooking screen to cross it off. Per device,
per session, never shared.

**Tick.** Checking off a shopping list line. Shared between both phones and
persisted. The deliberate opposite of a strike.

**Build.** Turning a set of (recipe, yield) picks into the shopping list via
one merge job.

**Staple.** A shopping line for something a kitchen normally already has.
Separated into a collapsed "check you have" section, never dropped.

**Yield.** A count plus a unit word ("12 muffins"). Scaling changes the
count, never the word.

**Damage.** How much of the kitchen a recipe destroys: tidy, messy, or
carnage, scored by a fixed rubric.
