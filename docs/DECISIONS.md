# We Cooked: Architecture Decision Records

Every decision taken on 2026-07-27, with the options that were actually
weighed and why the loser lost. A second pass on 2026-07-29, before any code,
resolved contradictions and gaps found in a pre-build review; those are
ADR-024 to ADR-032, and the ADRs they amend carry a dated note. A third pass
on 2026-07-30, after the four prototypes were settled, closed the questions
the prototypes and the first review left open; those are ADR-033 to ADR-040.
ADR-041 and ADR-042 came with the iOS port's first two features after parity
(2026-09-30), and ADR-043 with the third. ADR-045 and ADR-046 (2026-10-03) bring
the web app back as the laptop client and make parity a matrix in the repo. Referenced from [SPEC.md](./SPEC.md) as
`ADR-nn`. Evidence for the technical claims is in
[research/tech-stack.md](./research/tech-stack.md), which cites primary sources.

Each record has the same shape: the question, the options considered, the
decision, why, what it costs, and what would make it worth revisiting.

---

## ADR-001: SvelteKit, not server-rendered Python

**Question.** What builds the app?

**Options.**

- **A. Python (FastAPI) with Jinja templates and htmx, no build step.** One
  Dockerfile, one process, no npm. The most-exercised path for the Anthropic
  SDK.
- **B. Node/TypeScript with SvelteKit.** One language front to back, real
  interactivity, small runtime shipped to the phone because Svelte compiles
  away.
- **C. Next.js / React.** The most tutorials and the most machinery.
- **D. Go with templ.** Tiny image, fast boot, least pleasant for iterating on
  LLM glue code.

**Decision: B, SvelteKit with `adapter-node` and TypeScript.**

**Why.** A was the initial recommendation and it was wrong for this app. The
owner's requirements include "a very nice, smooth UI" as a stated hard
requirement, plus client-side image processing (canvas decode, EXIF rotation,
resize before upload), a polling job UI, a unit toggle, a portion stepper, and
multi-select for shopping lists. That is the exact workload where htmx stops
saving effort and starts costing it. Svelte compiles away rather than shipping a
runtime, so the phone payload stays small, and view transitions are a documented
one-liner via `onNavigate`.

C loses on machinery for no benefit at this size. D loses because the Anthropic
TypeScript and Python SDKs are the two mature ones and Go would mean more
hand-rolling for a hobby app.

**Costs.** A build step and a `node_modules`. Accepted.

**Revisit if.** Never, realistically. This is a foundation decision.

---

## ADR-002: One service, not two

**Question.** Does the Claude integration live in a separate backend?

**Options.**

- **A. One SvelteKit app**, server routes handle the API and the jobs.
- **B. SvelteKit frontend plus a separate Python backend**, if Python is
  preferred for the LLM work.

**Decision: A.**

**Why.** Two users. There is no argument for a second process, a second deploy,
a second log stream, or a network hop between them. The Anthropic TypeScript and
Python SDKs are at parity for streaming, retries, timeouts, typed responses, and
image helpers, so the usual reason to reach for Python does not apply.

**Costs.** If a genuinely heavy processing workload arrives later (video, large
batch jobs), it will need extracting. That is a real but unlikely future.

**Revisit if.** A feature arrives that needs a Python-only library.

---

## ADR-003: Ingredients are grouped plain strings, not parsed quantities

**Question.** How are ingredients stored?

**Options.**

- **A. Flat list of plain strings.** "2 tbsp olive oil, plus more for
  drizzling" is one string. Nothing parsed.
- **B. Structured `{qty, unit, item, note}`.** Enables arithmetic scaling and
  ingredient matching.
- **C. Grouped plain strings.** Sections ("For the sauce") preserved, contents
  still unparsed.

**Decision: A plus C, that is, grouped plain strings.**

**Why.** B is the trap. It looks like it unlocks scaling, but scaling a recipe is
not multiplication (see ADR-012): doubling a curry does not double the chilli,
and halving a cake changes the tin and the bake time. B would produce recipes
that look scaled and cook badly, and it would make every extraction subtly
wrong in a way that is tedious to correct (four fields per line instead of one).

C over plain A because real cookbook recipes constantly have sub-components, and
flattening "For the dough" into "For the filling" makes the recipe worse to read
every single time you cook it. It is cheap now and annoying to retrofit.

The unparsed string is only viable **because** Claude is in the loop at runtime.
This decision and ADR-012 are the same decision viewed from two sides.

**Costs.** No arithmetic is possible on ingredients without a Claude call. That
is by design.

**Revisit if.** Never. Structured quantities would be a rewrite of the data
model and the value is illusory.

---

## ADR-004: Extraction lands in a review form before saving

**Question.** What happens to a Claude extraction: save it, or confirm it?

**Options.**

- **A. Save immediately, edit later.** Fastest happy path.
- **B. Editable review screen, confirm before save.** One extra tap.
- **C. Review screen with low-confidence fields highlighted.**

**Decision: B.**

**Why.** The invariant this buys is "every recipe in the book has been read by a
human once", which turns the book from probably-right into trustworthy. The cost
is one tap. Under A you accumulate silently-wrong recipes and discover them
mid-cook with flour on your hands, which is the worst possible moment.

C was rejected because model self-reported confidence is unreliable, and it adds
schema and UI for information you would skim past anyway. What replaced it is
narrower and honest: `extraction_warnings`, a list of **concrete observable
gaps** ("step 4 was cut off at the page edge"), not a confidence score.

The structural payoff is larger than the correctness payoff: B means URL, paste,
photo, and manual entry all terminate at the same screen, so there is exactly
**one recipe editor** in the codebase.

**Consequences.** Two follow-on rules were adopted with it. Manual entry is a
first-class path, not an afterthought. And a failed extraction drops into the
same form, empty, with the source attached, so failure is never a dead end.

---

## ADR-005: Cooking screen is one scroll with sticky ingredients

**Question.** How is a recipe presented while cooking?

**Options.**

- **A. One scrollable page**, ingredients then steps.
- **B. Step-by-step cards, one per screen, swipeable.**
- **C. A, with the ingredient list kept reachable** (collapsible sticky block).

**Decision: C, plus wake lock, tap-to-strike-through, and large type.**

**Why.** A is the laziest and nearly right, but the constant scroll back to check
"was it 2 eggs or 3" is the single most repeated annoyance in cooking from a
phone. C fixes it with a sticky element, which is cheap.

B was rejected on cooking grounds, not technical ones: card decks destroy the
overview, hide what is coming next, and depend on step boundaries that an
extraction chose arbitrarily.

The three additions are each small and each removes a real irritation. Wake lock
(`navigator.wakeLock`, available in iOS Safari since 16.4) is table stakes for a
cooking app. Strike-through state is deliberately **ephemeral and per-device**:
no DB write, no sync, cleared on leaving. This contrasts with shopping list ticks
(ADR-015), which must sync, and the difference is that shopping happens with the
two people in different places.

**Explicitly cut.** Timers parsed from step text, voice control, "hey what's
next".

**Amended 2026-07-30.** Strikes are per session rather than cleared on
leaving the recipe: `sessionStorage` keyed by variation id, so a locked phone
mid-cook does not lose them (ADR-036). Still per device, still never synced.

**Amended 2026-09-30.** The ingredient bar pins only while the ingredient
list is on screen (issue #45). Pinned for the whole recipe, it cost a strip
of an already tight phone screen through every step and note, and the owner
prefers the space. "Was it 2 eggs or 3" is a scroll up again, the cost
option A had. A navigation bar shortcut back to the ingredients was
considered and not built; it waits for a real complaint.

---

## ADR-006: Text search plus Claude-assigned tags

**Question.** How do you find a recipe among a few hundred?

**Options.**

- **A. One list plus a text filter** over title, ingredients, tags.
- **B. A, plus tags you assign by hand.**
- **C. Semantic search through Claude.**

**Decision: A, with tags assigned by Claude at extraction (recorded as "A+").**

**Why.** B fails on human behaviour: manual tagging is a chore that stops in week
three, and half-tagged data is worse than none. The insight that resolves it is
that the Claude call is **already happening** during extraction, so tags cost
nothing extra and the human never does the chore. Tags then work as filter chips
and as searchable text, and stay editable in the review form when one is wrong.

C is genuinely the killer feature of an LLM recipe book and it is the strongest
v2 candidate. It loses for v1 because it costs a round trip per search and
cannot beat substring matching for "carbonara", which is most searches. It slots
in cleanly later behind the same box: if the filter returns nothing, offer "ask
Claude".

**Consequence.** Tags must come from a fixed vocabulary or the chips become
noise (ADR-007).

---

## ADR-007: Fixed tag vocabulary, including a damage rating

**Question.** What tags exist, and who defines them?

**Options.**

- **A. Free-form tags from Claude.** It will emit "quick", "fast", and
  "weeknight" for the same idea, and the chip row becomes unusable.
- **B. A fixed closed vocabulary in the prompt.**

**Decision: B**, five groups: meal type, cuisine, protein, effort, damage.

**Rejected from the draft vocabulary.**

- **Diet tags beyond vegetarian and vegan.** Gluten-free and dairy-free were
  drafted and removed. They read as safety claims, and a model inferring them
  from an ingredient list will eventually be wrong about soy sauce or stock.
  Then vegetarian and vegan were dropped too when the owner replaced the group.
  If anyone in the household ever has a real allergy, this needs handling
  properly rather than as a tag.
- **Method tags** (`one-pot`, `oven`, `grill`, `slow`, `no-cook`). Drafted, then
  replaced by damage at the owner's request.

**The damage tag** is the owner's idea and is the most distinctive thing in the
app: how much of the kitchen this recipe destroys. A dish involving rice, a deep
fry, and something in the oven wrecks the kitchen; a one-pot weeknight meal does
near-zero damage.

It is defined by an explicit counting rubric (in SPEC section 3.4) rather than
by vibes, because a tag that means something different each time is worse than
no tag. Three levels, `tidy` / `messy` / `carnage`, ordered so the chips sort
sensibly. The suspected real use is a one-tap "what can we cook tonight that
does not wreck the kitchen" filter.

**Cardinality.** Cuisine is at most one, deliberately: recipes that are
genuinely two cuisines are rare, and multi-select turns the filter into noise.
Effort and damage are exactly one and required. Meal type is multi.

**Accessibility.** Chips always carry their word. Meaning is never encoded in
colour, and never in red versus green, the most common color blindness.

**Revisit if.** A vocabulary value is missing. The lists live in the prompt and
in a `CHECK` constraint, so adding one is a one-line change plus a migration of
the constraint, not a migration of meaning.

---

## ADR-008: One shared password

**Question.** How do two people log in?

**Options.**

- **A. A single shared password**, session cookie lasting a year.
- **B. Two accounts with individual credentials.**
- **C. Passkeys / WebAuthn.**
- **D. Magic links by email.**
- **E. Cloudflare Access in front of the app.**

**Decision: A.**

**Why.** The access boundary here is "us versus the internet", not one
household member versus the other. They share a kitchen and they share the
book. B buys per-user attribution, which nobody wants, and costs a users table, a real login form, and
password resets that would be handled by SSHing into a box.

C is the nicest login on an iPhone (Face ID directly) but is real WebAuthn
machinery, and device-loss recovery is a problem nobody should solve for a
two-person recipe app. D means an email round trip every time a cookie expires.
E was disqualified by research: Cloudflare Access has a documented maximum
session length of one month, against a one-year requirement.

In practice iOS Keychain saves the password, so re-entry is a Face ID prompt on
the rare occasions it happens.

**Non-negotiables adopted regardless.** HTTPS only, `HttpOnly` + `Secure` +
`SameSite=Lax`, Argon2id hash in a secret rather than in the repo, and a hard
rate limit on failed attempts.

**Incident response.** If the password leaks: change it, redeploy, both people
re-enter it once. That is the complete plan, and it is proportionate.

**Revisit if.** Anyone outside the household needs access. B is a small
migration, not a rewrite.

---

## ADR-009: Images are a list with a cover flag

**Question.** How are photos modelled, given they serve two different jobs (the
picture you look at, and the page Claude reads)?

**Options.**

- **A. One list of images per recipe, one flagged as the cover.**
- **B. Separate "source scans" from "hero photo"** as distinct concepts.
- **C. No images in v1.**

**Decision: A.**

**Why.** B is conceptually tidier and costs two upload flows, two pieces of UI,
and a decision to make on every screen. A costs one table and one nullable
foreign key, and it gets the important property for free: **the cookbook page
you photographed stays attached to the recipe forever**, which is exactly what
you want the first time an extraction turns out to have dropped a step. C is not
available because the photo-extraction feature needs image storage anyway.

**Four rules adopted with it.**

1. **Multiple images per extraction.** A cookbook recipe is often a two-page
   spread or continues overleaf. The API takes several images in one request, so
   "add another photo" before extracting is nearly free.
2. **Copy remote images to R2, never hotlink.** Link rot is real, and hotlinking
   leaks your reading habits to the source site.
3. **Rotate pixels on upload, then strip EXIF.** Claude ignores EXIF
   orientation, so metadata-only rotation delivers a sideways page. See ADR-023.
4. **Keep a full-size copy plus a display copy.** Storage is free at this volume,
   and it means re-running extraction against a better model in a year does not
   require re-photographing the book.

---

## ADR-010: Blocked sites get a paste path, not a scraper arms race

**Question.** Four major recipe sites (Serious Eats, AllRecipes, Food Network,
101 Cookbooks) returned 403 to a server-side fetch during research. What do we
do about it?

**Options.**

- **A. One input accepting a URL or pasted text**, with a clear failure path to
  the photo flow.
- **B. Headless browser (Playwright) on Fly.**
- **C. A paid scraping proxy.**
- **D. Anthropic's server-side web fetch tool.**

**Decision: A.**

**Why.** This is Cloudflare working correctly, not a bug to fix, and it will get
worse over time rather than better. B means hundreds of megabytes of RAM on a
machine costing six dollars a month, and naive headless Chrome loses to modern
bot detection anyway: an arms race maintained forever for four websites. C means
a new vendor, a new key, and a monthly bill. D is worth a test during the build
but Anthropic's fetcher is also a datacenter IP, so the same 403s are the likely
outcome; it is not something to design around.

A never fails. It covers blocked sites, paywalled sites you are logged into on
your phone, recipes in emails, and recipes in text messages. Three taps
(select all, copy, paste) beats a clever thing that works on 85% of sites and
breaks silently on the rest.

**Consequence adopted.** When a fetch is blocked, the app says so plainly:
"This site blocks automated readers. Copy the recipe text and paste it instead."
Not a generic error, and not a silent empty form.

**Known iOS limitation, recorded so it is not re-attempted.** The Share Sheet
cannot hand a URL to a web app. The Web Share Target API is Chrome and Android
only. Copy and paste is the ceiling on iOS short of a native wrapper.

---

## ADR-011: Always call Claude, even when JSON-LD exists

**Question.** Most recipe sites embed schema.org Recipe JSON-LD (9 of the 14
reachable sites in a 19-site sample). Research recommended parsing it and
skipping Claude to save money. Do we?

**Options.**

- **A. JSON-LD wins, skip Claude entirely** when it is present.
- **B. Always call Claude, passing JSON-LD as authoritative input.**
- **C. JSON-LD for literal fields, a second cheap Claude call for derived
  fields.**

**Decision: B.**

**Why.** A does not actually work, and the reason is ADR-007. Effort, damage,
cuisine, protein, section headings, and the unit conversion are **derived
judgments that no web page embeds**. Under A you would still need a Claude call
for all of them, so you would have saved nothing and acquired a second code
path. C is two calls and two failure modes to save a few cents.

Under B, JSON-LD becomes a **quality floor rather than a shortcut**: when
present, the ingredient strings are exactly what the author wrote, so there is
no transcription drift; when absent, Claude reads the stripped HTML. Same output
shape either way.

The saving A was chasing is a rounding error against a bill that is a few
dollars a month, and one code path is worth more than that. It also means URL,
paste, and photo all run the same prompt against different inputs: one prompt to
tune instead of three.

---

## ADR-012: Portion variations are saved siblings, not a cache

**Question.** How does the app handle cooking a recipe at a different number of
portions?

**Options.**

- **A. Parse quantities and multiply.**
- **B. Claude rewrites the recipe for the new yield, result persisted.**
- **C. Scale ingredients only, leave the steps alone.**

**Decision: B.**

**Why.** A is the obvious answer and it is wrong, because **scaling a recipe is
not multiplication**. Salt, chilli, and strong aromatics scale sublinearly.
Leavening scales sublinearly upward. Tins and bake times change. A would produce
something that looks scaled and cooks badly, and it would require the structured
ingredients rejected in ADR-003. This is precisely the class of work that a
hand-rolled app does badly and that an LLM does well, which is the premise of
the whole project.

C loses because step text carries quantities, tin sizes, and times. Scaling the
ingredients while leaving "pour into a 20cm tin and bake 45 minutes" untouched
produces a recipe that contradicts itself.

**The correction that mattered.** The initial design treated scaled outputs as a
*cache*, invalidated when the original changed. The owner corrected this: they
are **variations**, and a variation can contain hand edits made at the stove. A
cache can be thrown away; work done by a human cannot. This changed the data
model.

**Rules adopted.**

- The original is immutable with respect to scaling, permanently labelled
  "original".
- Editing a variation affects **only** that variation, and marks it
  `hand_edited`.
- Range capped at 0.25x to 4x, beyond which the note leads with a warning.
- The scaling note names what did not scale linearly. This is what makes the
  output trustworthy rather than magic.
- Scaling reasons in metric, because grams scale cleanly and cups do not, then
  emits both unit systems (ADR-019).
- Variations are deletable; the original is not.
- Not savable as a separate recipe. It is a variation of one dish, and "save as
  new recipe" would fill the list with duplicates of the same thing.

**Staleness policy** (the one place the app can destroy work, so it was decided
explicitly):

- **Untouched variations regenerate lazily** on next open. Nothing is lost, the
  cost is a fraction of a cent, and variations never reopened are never paid
  for.
- **Hand-edited variations are never touched automatically.** A banner offers
  "Recalculate" (with a warning, and the old body goes to Trash) or "Keep mine".
- Rejected: always asking, even for untouched variations (taps on decisions with
  no wrong answer), and always recalculating everything immediately (will
  eventually eat an edit made at the stove).
- Only **substantive** edits mark variations stale: ingredients, steps, original
  yield. Title, tags, notes, and images do not. Field-level, no semantic
  diffing.

**Interaction rule, specified by the owner.** Moving the stepper from 3 to 4 to 5
to 6 must **never** trigger a calculation. Work begins only when an explicit
"Calculate for 6" button is pressed. Existing variations are chips and switch
instantly.

**Amended 2026-07-29.** "Recalculate" replaces the whole variation rather than
soft-deleting a body (ADR-025), and lazy regeneration of untouched variations
is specified as stale-while-revalidate (ADR-029).

**Amended 2026-07-30.** The stepper's number is also a tappable numeric input
accepting one decimal place, so fractional yields are reachable (ADR-037).
The never-trigger-work rule is unchanged.

---

## ADR-013: Soft delete everywhere, no edit history

**Question.** What is recoverable, and how?

**Options.**

- **A. One soft-delete mechanism** (`deleted_at`) covering recipes, variations,
  and bodies replaced by recalculation, with a Trash screen.
- **B. Full revision history** with a timeline and rollback.
- **C. Hard delete, rely on Litestream for recovery.**

**Decision: A.**

**Why.** One column and one screen cover all three ways work can be lost: a
mis-tapped recipe delete, a mis-tapped variation delete, and the ADR-012
recalculation that replaces a hand-edited body.

B is a revisions table, a diff view, and a "which version am I looking at"
question on every screen, for a recipe edited twice a year. A museum.

C confuses disaster recovery with undo. Recovering one recipe from a Litestream
replica means restoring a database copy to a scratch machine and extracting a
row. Nobody would ever do that; they would retype the recipe.

**Accepted gap, stated plainly.** The review form protects extractions and Trash
protects deletions, but **nothing catches a bad edit to an existing recipe**.
Overwrite a method and save, and that text is gone. This is the price of not
building B and it is recorded as a known risk.

**Amended 2026-07-29.** Trash holds recipes and variations only. Bodies are
never soft-deleted individually; a recalculation trashes the whole variation
(ADR-025), which makes "one soft-delete mechanism" literally true.

---

## ADR-014: v1 scope boundary

**Question.** What is out?

**Decision.** Everything in SPEC section 1.2. Recorded here because "we will add
it later" is where specs rot.

Two that were nearly kept:

- **Cook log** (three columns and a button, and "what did we eat last week" is a
  question that gets asked). Cut because the value only arrives after months of
  consistent tapping, which is a habit nobody has yet.
- **Web push** when extraction finishes. Genuinely supported on iOS for
  home-screen apps since 16.4, so not blocked, just not worth a notification
  permission prompt for a twenty-second job you are already watching.

One that moved **in** during the interview: **shopping lists** (ADR-015).

---

## ADR-015: Shopping lists build from variations, one active list

**Question.** Added to scope by the owner: take one or more recipes with a
portion count each, produce a shopping list.

**Key design decision: build from variations, not from originals.** If a
6-portion variation exists it is used, including any stove-side corrections; if
it does not, it is generated first through the normal scale job and saved. This
costs an extra call sometimes, and it guarantees the shopping list and the
recipe you cook from can never disagree. The generated variation is kept, so the
cost is not wasted.

Then one merge pass does the annoying part: combining the same ingredient across
recipes, reconciling compatible units, keeping incompatible ones as separate
lines rather than inventing a conversion, and grouping by supermarket section.

**Fork 1, pantry staples.**

- **A. A separate "check you have" section**, collapsed at the bottom.
- **B. Omit staples entirely.**
- **C. A staples list maintained in settings.**

**Decision: A.** A list with fourteen things you already own is a list you stop
trusting, so they must leave the main list. But B fails the week you actually
are out of olive oil, and C is a settings chore done once and never revisited.

**Fork 2, lifecycle.**

- **A. One active list**, replaced when you build a new one.
- **B. Multiple named lists.**

**Decision: A.** A second list is a v2 problem you will know you have.

**Other rules.**

- **Ticking is shared and persisted.** This is the one piece of state that must
  sync, and it is the deliberate opposite of the cooking screen's ephemeral
  strike-throughs (ADR-005): one person is in the shop, the other is at home
  remembering the coriander.
- Manual lines (bin bags, milk) are first-class and survive rebuilds.
- Every line records which recipes it came from.
- Changing the recipe set rebuilds the merge. Ticks survive on exact text match
  and reset otherwise. **This is deliberately dumb**: fuzzy matching would
  sometimes preserve a tick it should not, and a wrongly-ticked line in a shop
  is worse than a wrongly-unticked one.

**Amended 2026-07-29.** The build runs as one job that generates missing
variations inline before the merge call (ADR-027).

**Amended 2026-07-30.** Ticks sync by polling (ADR-033), and "Done shopping"
hard-deletes the list contents, manual lines included; the single list row is
permanent and `is_active` is dropped from the schema (ADR-034).

---

## ADR-016: Opus 5 at medium effort, with three spend guards

**Question.** Which model, and what stops a runaway bill?

**Options.**

- **A. Sonnet 5 everywhere.** Research recommendation. About $0.60/month.
- **B. Mixed tiers**, cheap model for merge and scale.
- **C. Opus 5 for photos, Sonnet for the rest.**
- **D. Opus 5 everywhere.**

**Decision: D, `claude-opus-5` at effort `medium`.**

**Why.** The owner's reasoning, and it is correct: *"I would rather spend more
money than have to find a bunch of mistakes."* The marginal cost is roughly
$3/month, and the thing being bought is not having to proofread extractions. At
these absolute numbers, choosing a model on price is optimising the wrong
variable. Research reached the same conclusion from the other direction: "the
Anthropic bill is not a meaningful part of this budget, which means you should
choose models for quality and latency, not price."

B is ruled out by the owner's standing rule against Haiku, and would mean
debugging quality differences across two models to save cents.

**Cost.** Opus 5 is $5/MTok input and $25/MTok output against Sonnet's
post-August $3/$15. Per call: photo extraction about $0.07, URL without JSON-LD
about $0.09, scaling about $0.06, shopping merge about $0.05. At 30 recipes, 20
scalings, and 8 lists a month, about $3.50. Total app cost moves from about
$4.40 to about $10 per month.

**Effort `medium`, set explicitly**, because the API default on this generation
is `high`. Reasoning tokens bill as output, and Anthropic does not publish how
many a given effort level emits, so the $3.50 estimate assumes roughly 1,000
extra output tokens per call. This is the least certain number in the spec.

**Three independent spend guards**, because each can fail alone:

1. **50 jobs per day** (owner's number, halved from a suggested 100), enforced at
   insert. Fifty jobs of the most expensive kind is about $4.50/day, so a stuck
   loop unnoticed for a month costs roughly $135 rather than an unbounded
   amount. High enough never to be hit while cooking, low enough that it cannot
   become a four-figure surprise.
2. **`maxRetries: 1`**, against the SDK default of 2. One transient failure
   would otherwise silently bill three full extractions.
3. **A spend limit in the Anthropic Console**, which does not depend on the
   application code being correct.

**Accepted consequences.** Opus is documented as "Moderate" latency against
Sonnet's "Fast", so extractions run longer. The background job model (ADR-023)
absorbs this entirely. Anthropic's fast mode is Opus-only but costs $10/$50 per
MTok, which is not worth it for a job nobody is staring at.

**Prompt caching and the Batch API are both off.** Caching needs a 512-token
minimum prefix and has a five-minute TTL, so two people adding a recipe every few
days would pay the 1.25x write premium every time and never read a warm cache.
Batch trades latency for cost, and a human is waiting.

**Amended 2026-07-29.** The daily cap counts Claude calls rather than job
inserts, because one shopping-list build job can make several calls
(ADR-027). The number stays 50.

---

## ADR-017: Fly.io, one machine, region `iad`

**Question.** Where does it run?

**Options.** Fly.io (owner's default), Vercel, Render, Railway, a plain VM with
Caddy.

**Decision: Fly.io, one `shared-cpu-1x` machine with 1 GB in `iad`.**

**Why.** Vercel is **disqualified outright**: a 4.5 MB request body cap, which
cookbook photo uploads exceed. Render's free tier spins down after 15 minutes
and takes "about one minute" to wake, which is unusable in front of "I want to
look at a recipe right now"; paid Starter is roughly double Fly. Railway has no
recurring free tier and documents 502s on wake. A plain VM is the only real
alternative and it trades managed TLS, managed secrets, and one-command deploys
for OS patching you own forever.

`iad` (Ashburn) because both users are in Northern Virginia. With a single
machine, region choice is the entire latency budget.

**1 GB rather than 512 MB** because server-side image derivation with `sharp`
wants headroom. The difference is about $2.60 a month.

**`min_machines_running = 1`, scale-to-zero off.** Fly's docs say cold start is
"well under a second", but that is still latency in front of the main use case,
and a SQLite app with a mounted volume does not want to be stopped.

**Exactly one machine.** Two machines sharing one volume is data corruption.

---

## ADR-018: A dedicated domain, not a business domain

**Question.** Host it on a path of a business domain the owner co-owns, on a
subdomain of it, or somewhere new?

**Options.**

- **A. A new dedicated domain.**
- **B. A subdomain of the business domain.**
- **C. A path on the business domain.**

**Decision: A.** The owner registered **`wecooked.kitchen`** at Cloudflare
Registrar.

**Why C is the worst option.** Three technical problems on top of the ownership
one. Path-based hosting requires something in front of the business site to
reverse-proxy `/recipe-book/*` to Fly, and most site hosts (Webflow, Squarespace,
Framer, most CMSs) cannot do it. The PWA then needs a base path, and Add to Home
Screen scopes the app to that path, so any stray link drops you into a normal
browser tab. And `Path=/recipe-book` **is not a security boundary**: the recipe
book would share an origin with the company marketing site, so any XSS there,
including from a marketing tag added by someone else, reaches the app.

**Why B loses despite being technically clean.** It is one CNAME and it has
proper cookie isolation. The problem is ownership. It is the business's domain
and the owner is a co-founder, not the sole owner. If the company is sold, wound
down, rebranded, or simply left behind, the domain goes with it, and so does the
recipe book's identity: both people re-adding the app, logging in again, every
bookmark broken. It also puts a personal side project in a business's DNS.

**On registrar choice.** Cloudflare Registrar sells at wholesale with no markup
and no first-year-discount trick, so the `.kitchen` renewal is the real number
permanently. This matters: the 2012-era gTLDs have no ICANN price cap (unlike
`.com`), much smaller registration volumes to spread fixed costs across, and are
deliberately priced as premium products. Elsewhere a `.kitchen` at $5 for year
one can renew at $40 forever. Cloudflare also already hosts the R2 bucket, so
domain, DNS, and photo storage are one account.

**DNS configuration.** `A` and `AAAA` records to Fly with the **proxy off**
(grey cloud). Orange-cloud proxying in front of Fly means two CDNs and
Cloudflare's certificate handling fighting Fly's automatic issuance.

---

## ADR-019: Both unit systems stored, always

**Question.** American recipes arrive in cups and sticks, European ones in grams.
What does the book store?

**Options.**

- **A. Keep whatever the source used.** Zero work, zero conversion risk,
  permanently mixed book.
- **B. Normalise everything to metric on import.**
- **C. Keep the source, convert on demand behind a toggle.**

**Decision: the owner's variant of C.** Both systems are **stored on every
recipe and every variation**, generated eagerly in the same Claude call as the
extraction, with a toggle to switch and an "as written" marker on the source.

**Why not A.** It was the initial recommendation and the owner overruled it
correctly. Baking in cups is worse than baking in grams, and a *scaled* recipe in
cups is worse again ("one and a third cups plus two tablespoons").

**Why not B.** It silently rewrites the source data at import, and volume to
weight depends entirely on the ingredient (a cup of flour and a cup of honey are
nothing alike). A wrong conversion is a ruined cake, and the review form would be
the only thing standing between the two.

**Why eager rather than on demand.** Generating at extraction costs a few cents
more and makes the toggle instant at the stove, which is the only place it
matters. On-demand generation would put a spinner in front of a person mid-cook
to save nothing worth having.

**What converts.** Not just ingredient lines: step text carries quantities, and
also **oven temperatures** (375°F to 190°C, rounded to real oven settings) and
**pan sizes** (9 inch to 23 cm). Missing those makes the toggle a half-measure.
Nothing else changes: the two bodies must read as the same recipe.

**Scaling runs in metric internally** and emits both, so a 6-portion variation of
an American recipe gives sensible grams *and* sensible cups.

**Shopping lists show both on every line**, primary first per the toggle, because
American packaging is in pounds and ounces whatever the recipe says.

**The toggle is remembered per device**, so the two people can prefer different
systems on their own phones without a shared setting to fight over.

**Amended 2026-07-29.** `is_source` is redefined as "the body a human last
authored", and reconvert failures surface as a banner on the derived body
(ADR-028).

**The hand-edit problem, and the fork it created.** Editing one body makes its
counterpart wrong.

- **A. Regenerate the counterpart on save.** One cheap call per edit.
- **B. Mark the counterpart stale** with a "not converted" note.

**Decision: A.** B is free and it lets quietly inconsistent recipes into the
book, which is the exact thing this feature exists to prevent. A costs about
five cents per edit and buys an invariant ("both systems always agree") that
nobody ever has to remember to check.

---

## ADR-020: Yield is a count plus a unit word

**Question.** The scaling UI says "serves 6", but a lot of cooking does not work
that way: 12 muffins, 24 cookies, 2 loaves, 1 litre of stock.

**Decision.** Yield is a number plus a unit word, both filled by Claude from the
vocabulary the source used. Scaling changes the count and never the unit word,
so the control reads "Makes 12 muffins" with a stepper on the number and the
chips read `12`, `24`, `36`. Default to `servings` when the source does not say.

**Why.** "Serves 24 cookies" is nonsense, and the alternative (forcing everything
into servings) would make the app read wrong for a whole category of what gets
cooked. Nothing else in the system cares: shopping lists and search only touch
ingredient lines.

---

## ADR-021: SQLite on a volume, with Litestream as a hard requirement

**Question.** Where does the data live, and how is it not lost?

**Options.**

- **A. SQLite on a Fly volume, replicated with Litestream to R2.**
- **B. Fly Managed Postgres.**
- **C. Turso.**
- **D. SQLite with LiteFS.**
- **E. SQLite on a volume, trusting Fly's daily snapshots.**

**Decision: A.**

**Why.** B starts at $38/month, roughly four times the entire rest of the stack,
to serve two people and a few hundred rows. Fly's self-hosted Postgres is
documented as unmanaged with the words "we are not able to provide support or
guidance". C is viable with a real free tier, but adds a vendor mid-rewrite:
their own repository states "we have not yet reached 1.0" and their roadmap
announces removal of features. A local SQLite file has no vendor and no roadmap
risk.

D is dead: no commits since April 2025, and Fly's own documentation says they
cannot support it. Litestream, by the same author, is actively maintained.

**Why E is not acceptable, and this is the important part.** Fly's own
documentation states that a single volume can lose data and that daily snapshots
"may not have your latest data". Research also could not confirm from any
primary source whether snapshots are even stored off-host. That uncertainty is
the strongest argument in the whole research document, and it is why **Litestream
is mandatory rather than optional**: it makes the recovery point seconds rather
than a day, and it makes the restore path independent of Fly entirely.

**Consequence: the restore drill is a build step**, scheduled in phase 2, before
there is anything worth losing. An untested backup is a belief, not a backup.

---

## ADR-022: Cloudflare R2 for photos

**Options.** R2, Tigris (Fly's integrated partner), AWS S3, or the Fly volume
itself.

**Decision: R2.**

**Why.** 10 GB free storage and free egress, so a few hundred resized photos are
$0.00 and stay that way for years. Free egress also means serving images
directly to the phones costs nothing and keeps image bytes off the Fly bandwidth
bill. Tigris is a close and perfectly reasonable runner-up (5 GB free, bills onto
the Fly invoice, also free egress) and R2 wins narrowly on free tier size, plus
it is now the same account as the domain. S3 loses on egress charges ($0.09/GB).

Storing photos on the Fly volume was rejected: it puts user data in the one place
with a documented durability warning (ADR-021), and it makes the volume grow.

---

## ADR-023: Background jobs with client polling

**Question.** Claude calls take seconds to tens of seconds. How does the client
wait?

**Options.**

- **A. Blocking request, spinner on screen.**
- **B. A job row in the database, polled by the client.**
- **C. Stream the fields in as they generate**, so the form visibly fills.

**Decision: B.**

**Why.** A is simplest and fails on the actual device: twenty seconds is long
enough that a person backgrounds the app or locks the phone, and **iOS kills
in-flight fetches when they do**. B is barely more code (one table, one endpoint)
and removes that entire class of bug. Submit, and the extraction appears in the
list immediately as "extracting"; tap to watch or walk away; close the app and
come back to it done.

**Amended 2026-07-29.** "The extraction appears in the list", not "the
recipe": no recipe row exists until a human saves the review form. The job
row is the draft (ADR-024).

C is genuinely delightful and the most "the app is thinking" of the three, but
partial JSON from a structured-output call is awkward to parse mid-stream, and it
means a state machine for a twenty-second event. It can be layered on top of B
later without touching the data model.

**Three rules adopted with it.**

1. **Poll at 1.5 s, back off after 30 s.** No websockets for two users.
2. **Failures are visible, never silent.** A failed job stays in the list as
   "extraction failed, tap to see why", and tapping opens the review form with
   the source attached.
3. **Retries capped at one**, against the SDK default of two, so a flaky call
   cannot silently triple the bill (ADR-016).

**Also adopted:** jobs left `running` at boot are marked failed with
`interrupted`, so a deploy mid-extraction surfaces as something retryable rather
than a row that hangs forever.

---

## ADR-024: The job row is the draft

*2026-07-29, pre-build review.*

**Question.** ADR-023 said a submitted extraction "appears in the list
immediately", but the `recipe` table has required fields (title, effort,
damage) that are unknown at submit time and no draft status. And
`image.recipe_id` was `NOT NULL`, yet capture photos upload before any recipe
exists. Where does an in-flight extraction live?

**Options.**

- **A. The job row is the draft.** No recipe row until Save.
- **B. A stub recipe row at submit**, with a `status` column and placeholder
  values.

**Decision: A.**

**Why.** B leaks draft semantics into every read path forever: every query
grows a `status = 'live'` filter next to `deleted_at IS NULL`, and
placeholder titles and tags are lies in the data. A keeps the invariant that
a recipe row always means "a human confirmed this", which is Goal 1 verbatim.

**Consequences.** `image.recipe_id` is nullable; pre-save uploads are
referenced by id from the job's `input_json` and claimed on save. The browse
list unions in queued, running, and failed capture jobs as cards read from
the `job` table. The review form is seeded from `input_json` and
`result_json`.

**Amended 2026-07-30.** Done-but-unsaved jobs are cards too ("ready to
review"), the card condition is `recipe_id IS NULL`, and drafts gain a
Discard action (ADR-035).

---

## ADR-025: Recalculate replaces the variation; Restore always wins

*2026-07-29, pre-build review.*

**Question.** ADR-012 promised that Recalculate soft-deletes the old
hand-edited body into Trash, but `body` has no `deleted_at` and the
`body_unique` index forbids two bodies of one unit system on a variation. The
schema could not deliver the promise.

**Options.**

- **A. Add `deleted_at` to `body`** and make the unique index partial; Trash
  grows a third row type.
- **B. Recalculate soft-deletes the whole variation** and creates a fresh one
  at the same yield.
- **C. Drop the recoverability promise.**

**Decision: B.**

**Why.** Zero new columns, zero new Trash UI, and the thing you want back
after a regretted recalculation is the whole variation as you knew it, not a
disembodied body row needing a "restore into which variation?" answer. C is
off-brand for an app whose design principle is that human work is never
destroyed silently. Only non-original variations can be stale (staleness is
measured against the original), so this path never touches `is_original`.

**Restore rule.** Because every recalculation leaves a trashed variation
colliding with its live replacement at the same yield, the collision is the
common case. **Restore always wins**: the colliding live variation is
soft-deleted into Trash and the restored one takes the slot. One rule,
reversible in both directions, and "Restore" on a replaced variation means
exactly "undo the recalculation" in one tap. The UI says what happened:
"Restored your edited version; the recalculated one is in Trash."

---

## ADR-026: Photos are served with presigned R2 URLs

*2026-07-29, pre-build review.*

**Question.** The spec said images are "served directly from R2", but never
how that squares with auth. The bucket holds photographed pages of
copyrighted cookbooks and photos from inside the house.

**Options.**

- **A. Public bucket, unguessable ULID keys.** Zero code, but every URL is a
  permanent unauthenticated public link, and it quietly publishes scanned
  book pages to the open internet.
- **B. Presigned GET URLs** (SigV4, 7-day expiry, signed at render time).
- **C. Proxy image bytes through the app.** Cookie auth for free, but every
  image byte lands back on the Fly machine and bandwidth bill.

**Decision: B.**

**Why.** The only option keeping both properties the spec committed to:
direct-from-R2 delivery with free egress, and a private book. A few lines
with the S3 client already needed for uploads.

**Caching wrinkle.** A naively-signed URL changes on every render and
defeats the browser cache. Round the signing timestamp to the day, so URLs
are stable for 24 hours, which covers a cooking session.

---

## ADR-027: One build job; the quota counts Claude calls

*2026-07-29, pre-build review.*

**Question.** ADR-015 requires shopping builds to generate missing variations
first, then merge. That is N `scale` calls followed by one `shopping_merge`
call, and the job table has no dependency concept. Who sequences it?

**Options.**

- **A. Job dependencies** (`depends_on` column, runner-side ordering). Real
  machinery for one use case.
- **B. The client orchestrates.** Dies the moment the phone locks, the exact
  failure mode ADR-023 exists to eliminate.
- **C. One fat job.** The `shopping_merge` job generates missing variations
  inline (each saved as a real variation), then merges.

**Decision: C.**

**Why.** The pipeline is inherently sequential-then-merge with no value in
observing intermediate states. One job row, one thing to poll, survives a
locked phone. A mid-build failure is benign: variations saved before the
failure persist, so a retry only pays for what is left.

**Quota consequence.** A C-style build is one job making N+1 Claude calls, so
the daily cap counts **Claude calls, not job inserts**: incremented inside
the API wrapper, checked before each call, env var renamed to
`DAILY_CALL_CAP`. This keeps the 50 meaning what it says for every future
compound job.

---

## ADR-028: `is_source` means "the body a human last authored"

*2026-07-29, pre-build review.*

**Question.** `is_source` meant "as the source recipe was written". Edit the
metric body of a US-source recipe and reconvert regenerates the US body: the
"as written" marker now points at machine-generated text, silently breaking
the mitigation for known risk 5.

**Options.**

- **A. Flag immutable, marker stays.** The marker lies exactly when you need
  it: debugging a suspect conversion mid-bake.
- **B. Clear `is_source` on both when a reconvert overwrites the source
  body.** Never lies, but tells you nothing.
- **C. Redefine: `is_source` is the body a human last authored**; the flag
  moves to whichever body was edited on save.

**Decision: C.**

**Why.** The marker's real job at the stove is "which of these did a human
write, and which did a machine convert", and C answers that correctly
forever. For a never-edited recipe it coincides exactly with the old meaning.
The UI label stays "as written" rather than inventing a second term.

**Reconvert failure handling, decided with it.** If the reconvert job for a
variation is queued, running, or failed, the derived body shows a banner:
"Not yet updated from your edit" or "Couldn't update, tap to retry". Detected
from the job table, no new schema. Same stale-while-revalidate idiom as
ADR-029, so the app has one pattern for "this text is being regenerated".
Rejected: doing nothing (rare and silent is the worst combination in the one
place the spec calls a ruined bake) and blocking the save (destroys
save-returns-immediately and loses the edit if the phone locks).

---

## ADR-029: Stale untouched variations regenerate stale-while-revalidate

*2026-07-29, pre-build review.*

**Question.** ADR-012 said untouched stale variations "regenerate lazily on
next open" and stopped. That is a 10 to 30 second Opus call, possibly
failing, possibly capped, in front of someone who tapped a chip to cook.

**Decision.** Open shows the old body immediately with a banner: "The
original changed, updating this version…". The scale job runs behind it; on
completion the body swaps in and the banner flips to "updated". On failure or
a cap hit, the stale body stays fully usable and the banner reads "couldn't
update, tap to retry". Cooking is never blocked by a spinner.

**Why.** The old body is not garbage: it is a coherent recipe based on the
previous original, strictly better than a spinner. The accepted wrinkle is
the mid-read swap; the banner announces it, the delta derives from an edit
the owner made themselves, and suppress-swap-if-scrolled cleverness is
machinery a two-person app does not need. Rejected: blocking (spinner between
a hungry person and a recipe) and prompting (converts ADR-012's explicit
"no prompt" policy into a prompt).

---

## ADR-030: The original yield lives on the original variation only

*2026-07-29, pre-build review.*

**Question.** `recipe.yield_count` stored "the original yield" while the
`is_original` variation also had a `yield_count`: two copies of one fact with
no stated sync rule, and the staleness logic keys off exactly this value.

**Decision.** Drop `recipe.yield_count`. The original yield is the original
variation's `yield_count`, one source of truth. `yield_unit` stays on
`recipe` because it is shared by all variations.

**Why.** Deleting a column beats maintaining an invariant. No read path has
the recipe row but not its variations; the browse list only shows title,
cover, and two chips.

---

## ADR-031: Sessions slide

*2026-07-29, pre-build review.*

**Question.** "One year expiry" was ambiguous: fixed date, or sliding?

**Decision.** Sliding. On any authenticated request whose cookie issued-at is
older than 30 days, re-issue a fresh cookie in the response.

**Why.** Three lines that delete the only recurring annoyance in the auth
design (an annual re-login, probably mid-recipe with wet hands). A stolen
cookie still cannot outlive `SESSION_SECRET` rotation, which remains the
entire revocation story. The 30-day threshold just avoids setting a cookie on
every response; anything from a day to a month is fine.

---

## ADR-032: Migrations are numbered SQL files plus `PRAGMA user_version`

*2026-07-29, pre-build review.*

**Question.** No migrations story existed, and ADR-007 already promises
tag-vocabulary changes will need one, with live data on the volume.

**Options.**

- **A. Numbered `.sql` files** applied at boot by a ~15-line runner keyed on
  `PRAGMA user_version`, each in its own transaction.
- **B. A migration tool** (drizzle-kit, atlas, dbmate).

**Decision: A.**

**Why.** SQLite ships the version counter and a loop over sorted files is the
whole tool; the migration files double as the readable history of the schema.
Known caveat either way: SQLite has no `ALTER COLUMN`, so `CHECK` changes use
the create-copy-rename dance. A heavier tool would not remove that.

---

## ADR-033: Shopping ticks sync by polling

*2026-07-30, second grilling round.*

**Question.** "Ticking is shared and persisted" was the one piece of state
that must sync, and the spec never said how the other phone learns about a
tick.

**Options.**

- **A. Poll the list while the Shopping tab is visible.**
- **B. Websockets or SSE.**

**Decision: A.** Poll `GET /api/v1/shopping` every 5 s while visible, pause
on hidden, refetch immediately on `visibilitychange` back to visible. Ticks
are per-item POSTs, applied optimistically on the ticking phone. Conflicts
are last write wins per item; a double tick is idempotent.

**Why.** The app already has exactly one sync idiom, polling (ADR-023), and
"no websockets for two users" was already decided there. 5 s rather than the
job system's 1.5 s because a shopping list is walked around a shop, not
stared at: the at-home tick arrives before the shopper reaches the next
aisle, at a third of the chatter.

---

## ADR-034: One shopping list row forever; Done shopping hard-deletes

*2026-07-30, second grilling round.*

**Question.** `shopping_list.is_active` implied archived lists, but nothing
in v1 reads an archived list, `shopping_list_item` has no `deleted_at`, and
the spec never said what "Done shopping" clears.

**Options.**

- **A. One permanent list row; Done shopping hard-deletes items and the
  recipe set. Drop `is_active`.**
- **B. Archive on done (`is_active = 0`), new row per build.**

**Decision: A.** Manual lines are cleared too: done means you bought the bin
bags. The two-step confirmation settled in the shopping prototype is the
mistap guard.

**Why.** B creates rows nothing reads; list history is the cook log by
another name, and that was cut (ADR-014). Hard delete is safe because merged
items and ticks are transient machine state, and a manual line is seconds to
retype, not stove-side work. Deleting a column beats maintaining a vestige.

---

## ADR-035: Unsaved captures are cards with a Discard action

*2026-07-30, second grilling round.*

**Question.** SPEC 6.5 listed browse cards for queued, running, and failed
capture jobs. A done job whose draft was never saved matched none of those
and silently vanished from every screen. And there was no way to get rid of a
capture you regret, or its orphaned `recipe_id = NULL` images.

**Options.**

- **A. Card condition is "capture kind and `recipe_id IS NULL`"**; Save
  writes the recipe id onto the job row; failed and ready-to-review cards get
  a Discard action that hard-deletes the job and soft-deletes its images.
- **B. Age out unsaved jobs after N days.**
- **C. Discard routes through Trash.**

**Decision: A.**

**Why.** The condition needs zero new schema and makes done-but-unsaved show
as "ready to review", which is the correct reading of "the job row is the
draft" (ADR-024). B hides work silently, which violates "failures are
visible". C is off target: Trash protects human work, and a job row is
machine output; the no-silent-destruction principle does not apply to it.
Images are soft-deleted anyway because they cost nothing to keep and photos
are the one part a human produced. No cancel for running jobs: they finish in
seconds, then you discard.

---

## ADR-036: Strikes are per session, in sessionStorage

*2026-07-30, second grilling round.*

**Question.** SPEC said strikes are "cleared on leaving the recipe"; the
cooking prototype notes said "production: sessionStorage per recipe". These
conflict.

**Decision.** `sessionStorage`, keyed by variation id. Survives a locked
phone and an accidental tab-away mid-cook; evaporates by the next day. Still
per device, never synced, no DB writes.

**Why.** Locking the phone is constant while cooking, and iOS can kill the
page on lock. Memory-only strikes would be lost at exactly the wet-hands
moment the screen exists for. What "ephemeral" was actually protecting is
that next week's cook starts clean, and session scope preserves that.

---

## ADR-037: Fractional yields via a numeric input on the stepper

*2026-07-30, second grilling round.*

**Question.** `yield_count` is `REAL` and "1 litre" is a legal yield, but a
whole-step stepper can never halve a 1-litre stock or a 2-loaf bake, and
halving is the most common scale operation after doubling.

**Options.**

- **A. Stepper stays whole-step; the number is a tappable numeric input**
  accepting any positive value with up to one decimal place.
- **B. Integer-only, live without halving.**

**Decision: A.** Input rounds to one decimal; zero and negatives rejected;
chips display the decimal as typed. The 0.25x to 4x soft cap (SPEC 5.5)
applies unchanged.

**Why.** B bakes a real limitation into exactly the yield-unit recipes
ADR-020 exists to support. Everything downstream already copes: the column is
`REAL` and the unique-yield index does not care.

---

## ADR-038: The review form keeps a sessionStorage draft

*2026-07-30, second grilling round.*

**Question.** iOS evicts a backgrounded PWA freely. Ten minutes of typed
corrections in the review form are human work, and the spec was silent on
losing them. The prototype added a sessionStorage draft during its design
pass without a decision ratifying it.

**Options.**

- **A. sessionStorage draft**, keyed by job id (recipe id when editing, a
  fixed key for manual entry), written on every change, restored silently,
  cleared on Save or Discard.
- **B. Server-side draft persistence.**
- **C. A beforeunload confirmation prompt.**

**Decision: A.**

**Why.** Principle 1 says human edits are never silently destroyed, and typed
corrections qualify. B is real machinery (an endpoint, a merge story) for a
one-device activity: you type on the phone you are holding. C nags, and iOS
PWAs do not fire it reliably; the silent restore is what makes navigating
away safe. Accepted cost: a draft started on the phone cannot be continued on
the laptop.

---

## ADR-039: Concurrent edits are last write wins

*2026-07-30, second grilling round.*

**Question.** Both phones open the review form for the same recipe and both
save. Nothing in the spec addressed it.

**Options.**

- **A. Accept last write wins**, record it as a known risk.
- **B. Stale-write rejection: save carries `updated_at`, server refuses if it
  moved.**
- **C. Optimistic locking with a conflict or merge UI.**

**Decision: A.** Recorded as known risk 7.

**Why.** Two people who share a kitchen editing the same recipe
simultaneously without knowing is a coincidence measured in years, and the
damage when it fires is already accepted as known risk 1: a bad edit is
unrecoverable, edit history was cut (ADR-013). This is the same gap, not a
new one. B is barely gentler than the overwrite (a rejection that forces a
reload also eats the edit), and C is absurd at this scale.

---

## ADR-040: Unit tests only, over the five load-bearing pieces of logic

*2026-07-30, second grilling round.*

**Question.** The spec mandated exactly one test (the EXIF fixture, SPEC 8.2)
and said nothing else about testing.

**Options.**

- **A. Vitest unit tests over the pure logic where a silent bug costs real
  work**: the EXIF fixture, `content_version` bump rules, tick preservation
  on rebuild, the migration runner, the daily-cap check.
- **B. Add a browser or E2E suite.**
- **C. Only the mandated EXIF test.**

**Decision: A.** Vitest because it is already in the SvelteKit template. No
component tests, no coverage targets.

**Why.** Each of the five is a branch of logic whose silent failure destroys
work or money: a wrong staleness rule eats a variation, a wrong tick rule
mis-ticks in a shop, a broken migration corrupts the live file, a broken cap
unbounds the bill. B is machinery serving two users who will notice a broken
button in hours; the review form is the integration test. C leaves the
listed four failure modes silent.

---

## ADR-041: The phone renders the page; the server fetch is the fallback

**Question.** ADR-010 chose a paste path over a scraper arms race. On
2026-09-30 the first real share from the phone failed: Serious Eats answers
402 to the server's fetcher, and curl from a home connection with Safari
headers gets a 403 challenge page. Dotdash Meredith owns Serious Eats,
Allrecipes, Simply Recipes, Food & Wine, EatingWell and The Spruce Eats, so
the paste path would be the normal path for most links shared. What now?

**Options.**

- **A. Render on the phone.** The share sheet and the Add tab load the link
  in an offscreen WKWebView and post the rendered DOM with the link. The
  server reduces it at ingest and keeps its own fetch only as a fallback.
- **B. A server fetcher that passes as a browser** (TLS fingerprint, headers)
  or a paid fetch proxy.
- **C. Stay on ADR-010: paste the text.**

**Decision: A.**

**Why.** A throwaway WKWebView on a Mac at home settled it in an afternoon:
Serious Eats and Allrecipes return 200 with Recipe JSON-LD, a Pinterest pin
carries JSON-LD, and an Instagram reel exposes its full caption in
`og:description` with no login. Curl from the same address gets the 403
challenge, so it is the browser engine and its residential address together
that pass, and the phone has both for free. B is the arms race ADR-010
refused, now with a bill. C makes the cook do the work on most links.

**Shape.** The wire contract grows one optional field, `{url, html?, text?}`.
The server parses the page at the boundary (`pageContent`) and stores only
the reduced content in the job row, so retry works and rows stay small.
Rendered pages run 0.8 to 2 MB; the phone caps at 4 MB and blocks images,
media and fonts in the web view for the extension's memory limit. The
phone's fetch has a timeout; on failure it posts the bare link and the
server tries its own fetch as before. ADR-010's copy for a blocked fetch
stands, now also for 402 and 429.

**Consequence.** The server deploys before any app build that depends on a
contract change. The first share failed against a server that did not yet
know `text`; this one adds `html`.

---

## ADR-042: A generation is one job row for its whole life

**Question.** Issue #41 adds recipes from a description: one Claude call
returns three candidates, the cook picks one, and the pick opens the review
form. Where do the candidates live, and what happens to the row on a pick?

**Options.**

- **A. One row.** A `generate` job holds `{description, yield_count, picked}`
  as input and `{candidates}` as result. A pick writes `picked` on the same
  row; the row then reads as an ordinary draft seeded from
  `candidates[picked]`. The job id is the card key, the deep link and the
  review form's id throughout.
- **B. A pick spawns a draft.** The generation row keeps the candidates and a
  pick creates a new capture-like row with the chosen candidate as its
  result.
- **C. A pick overwrites the result** with the chosen candidate and drops the
  other two.

**Decision: A.**

**Why.** Every reader of a draft already keys on the job id (browse card,
`/drafts/:id`, the editor autosave, the share extension's pending link), so
B would hand the phone a second id mid-flow and leave a row behind that is
neither draft nor recipe. C makes "is this row choosing or a draft" a
question about the shape of `result_json`; `picked` is one field with one
meaning. The unpicked candidates stay in the row but nothing shows them:
the glossary's "gone" is about the cook's view.

**Shape.** `DRAFT_KINDS` (the three capture kinds plus `generate`) replaces
`CAPTURE_KINDS` as the one gate for "this job is a draft". One helper,
`draftOf(job)`, is the only reader of `result_json`, so the card title, the
review form seed and the save path never learn about candidates. Before a
pick, `GET /drafts/:id` answers a `GenerationView` (description, yield and
three trimmed candidates) instead of a `DraftView`; the Kit tells the two
apart by the `candidates` key the way it already tells a saved draft by
`recipe_id`. A pick out of range is a 400, a pick on a non-generation job
is a 404, the same pick twice is a no-op, and save on an unpicked row is
refused.

**Prompt.** The extraction system prompt says "transcribe faithfully, do not
add ingredients", which is the opposite of generation. The tag vocabulary,
damage rubric, yield rule and conversion rules moved into a shared
`RECIPE_RULES` block that both system prompts end with; the extraction text
is unchanged. Generation asks for exactly three recipes, distinct in
technique, cuisine or protein, each at the requested yield, written in
metric and converted to US. The count is checked in the handler, not the
schema, because the structured-output schema is not relied on for array
lengths. One call per generation, so the daily cap counts it like a capture.

**Consequence.** Migration 002 rebuilds the `job` table for the new kind, the
first migration since the schema. The web shows a generation card but sends
the cook to the phone to choose (web support is out of scope for #41).

---

## ADR-043: Covers come from the source page, else an image search

**Question.** Issue #44: most recipes arrive without a photo the household
took, so browse is a wall of pot tiles. Where does a cover come from, how is
a found image told apart from a household photo, and when does the work run?

**Options.**

- **A. Brave Search API, image endpoint.** About $5 per 1000 queries, inside
  the monthly $5 free credit at this household's volume. Plain GET with a
  subscription token.
- **B. Google Custom Search JSON API.** Closed to new customers and being
  shut down.
- **C. SerpApi.** Scrapes Google Images; the free tier is 100 searches a
  month, and past that it is a monthly subscription.
- **D. No search.** Only the source page's own photo; pasted text, cookbook
  photos and generations stay coverless.

**Decision: the source page first, then A.**

**Why.** The page's own photo is the right picture by construction: Recipe
JSON-LD `image`, then `og:image`, then `twitter:image`, collected from the
HTML the phone rendered (ADR-041) or, failing that, a server fetch. D leaves
every non-URL capture coverless, which is most of what the issue is about. B
is not available to sign up for, and C's free tier is a month of one busy
evening. A search hit can be the wrong dish, a person or a logo, so one
Claude vision call over at most four 512 px thumbnails picks the photograph
of this dish or none. A nonsense title gets no cover, not a random one.

**Marking.** A nullable `image.source_url` column, not a new `role`. Adding
a role means rebuilding `image` to change its CHECK, and `recipe.cover_image_id`
references `image` with `ON DELETE SET NULL`, so the rebuild's DROP would null
every cover. `role` stays `'photo'`; a non-null `source_url` says "fetched,
not taken", which is what the phone needs to let a household photo take over
the cover.

**When.** A follow-up `cover` job after a successful extraction or a pick,
so a draft is ready exactly as fast as before. The job writes
`cover_image_id` into the draft's `input_json`; it never touches the
extraction. If the cook saved first, the image goes to the recipe if it still
has no cover; if they discarded, it is soft-deleted.

**Copyright and privacy.** Found images go into the private bucket behind
presigned URLs (ADR-026), seen by the two people who cook from them, never
republished. The only thing that leaves the server is the recipe title, to
Brave.

**Where the fetch happens.** On the server, under the page fetch's SSRF rules
(public addresses only, every redirect hop checked). A CDN that blocks the
server costs the source step, and the search step covers it. Fetching image
bytes on the phone, as ADR-041 does for pages, is deferred until that turns
out to matter.

**Consequence.** Migration 003 adds the column and rebuilds `job` for the
`cover` kind. Each search-step cover is one Claude call against the daily cap
(ADR-027) on a smaller model, `COVER_MODEL`, default Sonnet. Without
`BRAVE_SEARCH_API_KEY` the search step is skipped and logged once.
`POST /api/v1/covers/backfill` gives existing recipes the same treatment.

**Revisit if** the source step fails for most captures (move the image fetch
to the phone), or Brave's pricing changes.

**Amended 2026-10-01.** "Find another photo" in the editor queues a cover
job in replace mode for a draft or a saved recipe whose cover is empty or
found, never one whose cover is a household photo. It skips the source step
(the page's photo is what the cook is replacing) and searches with 20 hits
instead of 10, past every image URL a cover job already found for that draft
or recipe; the route stores that list on the job. The new image takes the
cover and the found one it displaces is soft-deleted. Each tap is one Brave
query and one Claude call, so the server refuses a second while one is
pending.

---

## ADR-044: Push through Apple directly, the widget through a file

**Question.** Issue #42: a push that says a capture is ready and a home
screen widget with the shopping list. Who sends the push, how does the
server know which phone queued the capture, and how does the widget get the
list without a network or a token?

**Options.**

- **A. A push provider (OneSignal, Firebase Cloud Messaging).** A hosted
  service holds the device tokens and talks to Apple.
- **B. Apple's push service directly.** The server signs a token with the
  push key and posts to Apple over HTTP/2. Device tokens live in the
  server's own database.
- **C. No push.** The app polls while open, as today.

For the widget:

- **D. The widget calls the API.** It would need the session token, so the
  Keychain group, and a network in the shop.
- **E. The widget reads a snapshot the app writes** into the app group.

**Decision: B and E.**

**Why.** A is a third party holding household data and tokens for a
two-person app, against SPEC 1.1. B is one table, one key and one HTTP
call; Node's `http2` module speaks it without a dependency. C leaves the
reel-sharing gap the issue is about. D puts the session token in a third
process and fails exactly where the widget is needed, in a shop with no
signal. E works offline by construction: the app writes the unticked list
whenever the shopping reply or a local tick changes, in both unit systems,
and the widget renders the file.

**Which phone.** The app generates a random device identifier once, keeps
it in the app group defaults, and sends it as `X-Device-Id` on every
request; the share extension sends the same one. Each capture job records
it in a nullable `job.device_id`. When a capture finishes, done or failed,
the runner pushes to that device only, so one phone's captures never buzz
the other. `POST /devices` upserts the push token by device identifier, and
the app re-registers on every launch, so a reinstall or a token change is a
new row or an updated one, never a stale one. A token Apple reports as bad
is deleted.

**Never on the critical path.** The push runs after the job row is
finished, in its own try/catch; a failure is logged and the job is still
done. Missing push secrets turn the sender into a logged no-op, so a dev
server works without a key.

**Consequence.** Migration 004 adds `device` and `job.device_id`. Three Fly
secrets: `APNS_KEY`, `APNS_KEY_ID`, `APNS_TEAM_ID`. A third target,
`WeCookedWidget`, shares the app group only, never the Keychain group, so
it can never hold the token. The permission prompt is asked the first time
the phone queues a capture, never at launch.

**Revisit if** a lock screen or watch widget is wanted (a second snapshot
consumer), or if captures start from a third device (the device identifier
would want to become an account).

---

## ADR-045: The web app is the laptop client, at parity with iOS

**Question.** After the iOS port the web app was marked retired and `server/`
became "the backend plus an archive". The household cooks from a laptop on
the counter as well as from a phone. Does the laptop get a native Mac app, a
Catalyst build, or the web app back?

**Options.**

- **A. Bring the web app back as the laptop client**, at feature parity with
  iOS minus what is platform-bound, and lay it out for a laptop.
- **B. Mac Catalyst or "Designed for iPad"** from the existing Xcode project.
- **C. A native macOS target** sharing WeCookedKit.

**Decision: A.**

**Why.** The web app already exists, runs on the same process as the API,
and shares every server module with `/api/v1`, so parity is a matter of page
code, not a second client stack. B gives a phone layout in a window with no
sidebar, no hover, and no laptop type scale, and still needs App Store or
notarised distribution for one household. C is a third client to keep in step.
A browser tab on the kitchen laptop needs nothing installed.

**Shape.** Parity is enforced by rule, not by a shared codebase: CLAUDE.md
now says a behaviour added to one client is added to the other unless it is
platform-bound (share extension, widget, push). This round closed the gaps
found by audit: generation from a description with the candidate deck, found
covers followed and replaced ("Find another photo"), the editor autosave in
localStorage for 7 days with a rebase banner, all validation issues inline,
strikes kept 12 idle hours and dropped on a content change, calculation
retry and the 5 minute "still working" state, delete from the recipe page,
share the shopping list as text, and an offline tick outbox. The legacy
`/api/shopping-list` endpoints are gone; the page polls `/api/v1/shopping`.
Layout decisions are in UI.md D12.

**Consequence.** Every future feature lands on both clients in the same
change or names why not. Web verification is Playwright against the dev
server at 1440x900 and 390 wide; iOS verification is unchanged.

**Revisit if** a third device joins (the parity rule would want a shared
view model), or if the browser's wake lock proves unreliable on the counter.

---

## ADR-046: Parity is a matrix in the repo, checked per change

**Question.** ADR-045 made parity a rule in CLAUDE.md. A rule in prose is
only as good as the agent's memory of it. How is "both clients, or a named
reason" enforced without a shared codebase?

**Options.**

- **A. A parity matrix in the repo, plus an issue template.** `docs/PARITY.md`
  has one row per behaviour and one cell per client, each cell a reference
  into the code. The Behaviour issue template makes iOS, Web and
  Platform-bound the definition of done. A `/parity-audit` skill regenerates
  the gap table and flags stale cells.
- **B. A shared view model** (a TypeScript model compiled for both, or the web
  reading the same v1 views as iOS through a generated client), so one change
  reaches both clients.
- **C. Nothing beyond the CLAUDE.md line**, and an audit when drift is
  noticed.

**Decision: A.**

**Why.** B is the right answer at three clients and the wrong one at two: the
iOS views are SwiftUI over WeCookedKit models and the web pages are Svelte
over loaders, and a shared model would be a third thing to keep in step. C is
how the twenty gaps of ADR-045 accumulated. A costs one table row per feature
and makes the gap visible in review, which is where it is cheapest to close.

**Shape.** `docs/PARITY.md` is the matrix; `docs/port/parity-checklist.md` is
marked superseded and kept for the device passes. CLAUDE.md tells agents to
update the row in the same change. The issue template lives at
`.github/ISSUE_TEMPLATE/behaviour.yml`; the audit prompt is the
`parity-audit` skill under `.claude/skills/`. Shared rules that are
duplicated in Swift and Svelte (validation messages, input limits,
lifetimes, the share text) may move to the server case by case, with no
visible change to either client; each move is its own small change verified
on both.

**Consequence.** A change that adds behaviour without a PARITY.md row is
incomplete. A cell that no longer points at code is a bug the audit reports.

**Revisit if** a third client appears (then B), or if the matrix is routinely
stale, which would mean the per-change rule is not being followed and a CI
check that greps the cited files should replace it.

## Decisions deferred to prototypes

The owner asked that UI decisions be settled with prototypes rather than prose.
Four screens need one before phase 3 of the build:

1. The review form (the single editor).
2. The cooking screen, with the sticky ingredient block, the unit toggle, and
   the yield chips and stepper.
3. The browse list with search and tag chips.
4. The shopping list, with sections, dual units, and the staples block.

Constraint carried into all four: no meaning encoded in colour, and never in red
versus green.
