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

## Integration seam (for ldt-main.js)

This PR ships generators + plan logic only; the LDT runner wires them:

```js
const plan = fillPlan({ log, intakeEligible });
// walk plan: "clip" → existing clip path; "carousel" → gate deckText() then
// renderNarrativeDeck() and post via uploadSlides/schedulePost;
// "card" → gate cardText() then renderCard(); "text_reel" → gate reelText()
// then renderTextReel() and post as a reel/video.
```

Log types: `ldt_carousel`, `ldt_card`, `ldt_text_reel` — entries should carry
`angle` and `generation.hook_style` so the rotation rules and the learn step
can read them. **Cadence caps are unchanged and stay in the runner**: the
plan only fills the slot the cadence guard already granted.
