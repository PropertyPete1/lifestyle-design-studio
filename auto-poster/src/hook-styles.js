/**
 * hook-styles.js — the canonical hook-style vocabulary for the learning loop.
 *
 * SIX STYLES, chosen deliberately so performance can map to a decision:
 *
 *   question           "would you believe…?" / "what does $300k get you…?"
 *   bold_claim         "this might be the best new build I've toured this month"
 *   pov                "this is what new construction is supposed to feel like"
 *   stat               opens on a real number from the video's own facts
 *   story_open         a one-beat generic-buyer mini-scenario, no invented facts
 *   pattern_interrupt  "wait." / "stop scrolling." / "don't buy yet."
 *
 * ─── WHY A REGISTRY AND NOT ANOTHER if/else ─────────────────────────────────
 *
 * The old path (analytics.js + caption.js) had FIVE styles that existed in two
 * places at once: a regex classifier over published captions and a prompt
 * instruction inside the caption builder — and nothing guaranteed they agreed.
 * The learning loop needs a third consumer (the weekly scorer) and a fourth
 * (the variation engine), so the vocabulary lives here once, and every consumer
 * reads the same table. A style with no instruction cannot be picked; a style
 * with no classifier cannot be scored; the tests assert every entry has both.
 *
 * ─── LEGACY ALIASES ─────────────────────────────────────────────────────────
 *
 * analytics.js classified history into question / bold_claim / wait_tease /
 * reaction / vibe. Those posts are real measurements and are not thrown away;
 * they are mapped onto the canonical six:
 *
 *   vibe       → pov                (the vibe examples ARE point-of-view lines)
 *   wait_tease → pattern_interrupt  (the wait/stop/don't-scroll family)
 *   reaction   → story_open         (a reaction hook is a one-beat narrator story)
 *
 * The mapping is a judgment call, so anything that consumes a mapped style
 * carries provenance ("inferred", never "tagged") and the weekly brief states
 * the mapping rather than presenting merged counts as if they were native.
 *
 * ─── HONESTY, INHERITED ─────────────────────────────────────────────────────
 *
 * Every instruction below writes INTO the existing caption prompt, which
 * already carries the lead-gating rules, the no-invented-facts rules and the
 * price-consistency check downstream. The stat style gets the strictest
 * wording of all six because it is the one a model would otherwise satisfy by
 * inventing a number — the exact failure reel-hooks.js exists to prevent.
 */

/** Canonical style ids, in a stable order (tests and the brief rely on it). */
export const HOOK_STYLE_IDS = [
  "question",
  "bold_claim",
  "pov",
  "stat",
  "story_open",
  "pattern_interrupt",
];

/** Legacy classifier ids → canonical ids. See the module header for the why. */
export const LEGACY_STYLE_ALIASES = {
  question: "question",
  bold_claim: "bold_claim",
  vibe: "pov",
  wait_tease: "pattern_interrupt",
  reaction: "story_open",
};

/**
 * The registry. `instruction(cityName)` returns the prompt fragment the
 * caption builder injects; `patterns` are first-line matchers for classifying
 * a published caption back into a style (used only for history and for posts
 * that predate tagging — a tagged post never goes through the classifier).
 */
export const HOOK_STYLES = {
  question: {
    id: "question",
    label: "Question",
    instruction: (cityName) =>
      `Write a QUESTION hook. Example: "would you believe this is brand new construction in ${cityName}?" or "what does $300,000 actually get you in ${cityName} right now?" (only use a number if one appears in the facts above)`,
    patterns: [
      /^(would|did|have|can|could|is|are|do|what|how|who|where|why|when)\b/,
      /\?/,
    ],
  },
  bold_claim: {
    id: "bold_claim",
    label: "Bold claim",
    instruction: () =>
      `Write a BOLD CLAIM hook. Example: "this might be the best new build I've toured this month" or "I've never seen finishes like this at this price point"`,
    patterns: [
      /^(this (might|is|could) be|i('ve| have) never|the best|most|hands down|no way|just hit)/,
    ],
  },
  pov: {
    id: "pov",
    label: "POV",
    instruction: () =>
      `Write a POV hook — put the viewer inside the moment. Example: "this is what new construction is supposed to feel like" or "POV: you just walked into your first brand new home". Atmosphere and feeling, not a list of features.`,
    patterns: [
      /^pov\b/,
      /^(this is what|imagine|picture this|the vibe|the energy|the feeling)/,
    ],
  },
  stat: {
    id: "stat",
    label: "Stat",
    instruction: () =>
      `Write a STAT hook that OPENS with a real number. THE NUMBER MUST APPEAR IN THE FACTS PROVIDED ABOVE (the video's price, sqft, beds, rate, or a community KB figure). Example: "$379,990 for brand new construction" or "2,100 square feet and the payment surprises people". If NO number appears in the facts above, DO NOT invent one — open with the single most concrete visible detail instead.`,
    patterns: [
      /^[^a-z]*\$?\d[\d,]*/i,
    ],
  },
  story_open: {
    id: "story_open",
    label: "Story open",
    instruction: () =>
      `Write a STORY-OPEN hook — one beat of a mini-scenario about an unnamed buyer or the narrator's own reaction. Example: "a first-time buyer teared up in this kitchen last week" is NOT allowed (it claims an event) — instead: "the kind of kitchen that stops a first tour cold" or "I was speechless when I walked in". NEVER invent a specific event, person, sale, offer, or deadline. The scenario is a vibe, not a claim.`,
    patterns: [
      /^(the .* made me|i (was|am)|my jaw|speechless|stunned|obsessed|in love)/,
      /^(the kind of|last (week|month)|every buyer|first tour)/,
    ],
  },
  pattern_interrupt: {
    id: "pattern_interrupt",
    label: "Pattern interrupt",
    instruction: () =>
      `Write a PATTERN-INTERRUPT hook — a hard stop that breaks the scroll. Example: "wait until you see the kitchen in this one 😮‍💨", "stop scrolling. look at this ceiling.", or "don't buy new construction before you see this". Short, abrupt, imperative.`,
    patterns: [
      /^(wait|you won't|you need to see|hold on|stop|don't scroll|don't buy|before you)/,
    ],
  },
};

/** Every canonical style has an instruction and at least one pattern. */
export function styleInstruction(styleId, cityName) {
  const style = HOOK_STYLES[styleId];
  if (!style) return null;
  return style.instruction(cityName);
}

/**
 * Classify a caption's first line into a CANONICAL style.
 *
 * Order matters and is deliberate: pattern_interrupt before question (a "wait
 * until you see…?" line is an interrupt that happens to end in a question
 * mark), stat before the rest (a line opening on a figure is a stat hook no
 * matter what follows). Returns "unknown" rather than guessing — an unknown is
 * a countable fact, a guess is a corrupted sample.
 */
export function classifyCanonicalStyle(caption) {
  if (!caption) return "unknown";
  // Strip leading emoji/space. \p{Extended_Pictographic} rather than
  // \p{Emoji} or \p{Emoji_Component}, because both of those match the ASCII
  // digits — and a stat hook's leading "2,100" must reach the classifier
  // intact. ZWJ and VS16 are named explicitly since they fall outside
  // Extended_Pictographic.
  const firstLine = String(caption)
    .split("\n")[0]
    .replace(/^[\p{Extended_Pictographic}\p{Emoji_Modifier}\u200d\ufe0f\s]*/gu, "")
    .toLowerCase()
    .trim();
  if (!firstLine) return "unknown";

  const ORDER = ["pattern_interrupt", "stat", "question", "bold_claim", "story_open", "pov"];
  for (const id of ORDER) {
    for (const pattern of HOOK_STYLES[id].patterns) {
      if (pattern.test(firstLine)) return id;
    }
  }
  return "unknown";
}

/** Map a legacy classifier id (or a canonical one) to canonical, else null. */
export function toCanonicalStyle(styleId) {
  if (!styleId) return null;
  if (HOOK_STYLE_IDS.includes(styleId)) return styleId;
  return LEGACY_STYLE_ALIASES[styleId] || null;
}
