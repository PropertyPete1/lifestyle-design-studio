# The LDT self-made content lane

The LDT schedule can be filled with **zero operator-supplied footage**. Three
generators share one design system (the posted "leads going cold" look: navy
gradient, green dot mark, big clean type — [ldt-design.js](src/ldt-design.js)):

| Generator | Format | Module |
|---|---|---|
| Narrative carousel | 8 slides, 1080×1350: hook → problem ×3 → solution ×3 → CTA | [ldt-carousel-gen.js](src/ldt-carousel-gen.js) |
| Promo card | single story-ad-format feed image | [ldt-card-gen.js](src/ldt-card-gen.js) |
| Text-motion reel | ~10s 1080×1920, ken-burns plates, crossfades, **silent** (music licensing) | [ldt-text-reel.js](src/ldt-text-reel.js) |

## Copy doctrine

Copy is **authored, not model-generated**: every hook line (one per canonical
hook style per angle), every problem beat, and every solution beat lives in
the angle table, where CI can hold all of it to the claims doctrine at once:

- solution slides are pinned claims, essentially verbatim;
- problem slides describe the reader's world, never the product, and carry
  **no numbers, digit or spelled** (a figure belongs to a pinned claim or
  nowhere — tests enforce this bluntly);
- every angle × style × format's full visible text passes a claims-gate
  equivalence check (banned patterns + exact-figure honesty) in CI, and the
  runner must gate the real text again at runtime before rendering;
- the meta angle ("this post was scheduled and captioned by the product it's
  about") is offered **only** while `metaAngle.enabled` is true in the claims
  file — the line must never appear on a hand-posted deck.

## Rotation

Hook styles rotate through the variation engine: `planVariation({ brand:
"ldt", previousStyle: previousLdtHookStyle(log) })` — the `previousStyle`
override exists because LDT log entries are brand-scoped, not city/slot-
shaped. Angles rotate deterministically by date with a no-immediate-repeat
rule (`pickAngle`), and the LDT brief (`learning/brief-ldt.json`, written
once "ldt" joins the learn step's BRANDS roster) steers the 70/30 split
exactly as the realty brief does.

## Slot priority — the account never goes silent

[ldt-slot-filler.js](src/ldt-slot-filler.js) builds the plan:

1. **clip** — every eligible operator clip from the intake folder, oldest
   first (always first when present);
2. **carousel** — the strongest self-made format leads;
3. **card / text_reel** — alternating behind it.

The previous self-made kind is demoted to last resort, never banned: with
every other generator failing, repeating a format still beats an empty slot.
The plan is a fall-through list — the runner takes the first entry that
renders and passes its gates.

## Integration (wired in ldt-main.js)

The runner walks the plan in two parts: the existing clip path first (per-clip
QC + blocklisting, oldest first), then the self-made chain — for each kind,
gate the format's full visible text through `checkClaimsCompliance` at
runtime, render (`renderNarrativeDeck` / `renderCard` / `renderTextReel`),
post (images via `uploadSlides`/`schedulePost`, the reel via
`uploadToBrand`/`createSingleBrandPost`), record, then verify the returned
postIds with `verifyReelPublication` (scheduler acceptance ≠ published). A
`FORCE_VIDEO_ID` pin short-circuits the whole self-made chain (`selfMadeAllowed`),
and each format posts at most once per day (`hasBrandTypeToday`) on top of
cadence.

Log types: `ldt_carousel`, `ldt_card`, `ldt_text_reel` — entries carry
`angle`, `hook_style`, and the `generation` tag block so the rotation rules
and the learn step can read them (`reelEntries` admits `*_text_reel` alongside
`*_clip`: everything posted as a reel gets scored; image formats stay out of
the reel brief). **Cadence caps are unchanged and stay in the runner**: the
plan only fills the slot the cadence guard already granted.
