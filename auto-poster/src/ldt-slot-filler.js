/**
 * ldt-slot-filler.js — how an LDT slot gets filled when the operator
 * supplied nothing: the account never goes silent because the intake folder
 * is empty.
 *
 * PRIORITY ORDER, per the addendum:
 *
 *   1. clip        an operator-supplied recording from the intake folder
 *                  (PRIMARY working: compose-card sends, voice turns, THE
 *                  FLOOR) — always first when one is eligible
 *   2. carousel    the self-made 8-slide narrative deck
 *   3. card        the single story-ad-format promo card
 *   3. text_reel   the text-motion reel (card and text_reel alternate)
 *
 * The generated kinds rotate with a no-immediate-repeat rule read from the
 * brand's own log entries: two consecutive self-made posts never share a
 * kind, and the carousel — the strongest format — leads whenever the last
 * self-made post wasn't one. The order is a PLAN, not a guarantee: the
 * runner walks it and takes the first kind that renders and passes its
 * gates, so a generator failure degrades to the next format, never to
 * silence.
 *
 * Pure functions — the runner (ldt-main.js) owns all I/O, cadence guards
 * (unchanged by this module: the plan fills at most the slot the cadence
 * guard already granted), and the claims gate calls.
 */

import { HOOK_STYLE_IDS, toCanonicalStyle, classifyCanonicalStyle } from "./hook-styles.js";
import { validPosts } from "./state.js";
import { chicagoDayOf } from "./brands.js";

/** The self-made kinds, strongest first. Log types are `ldt_<kind>`. */
export const SELF_MADE_KINDS = ["carousel", "card", "text_reel"];

/** Map a log entry's type to a self-made kind, or null. */
export function kindOfEntry(entry) {
  const m = /^ldt_(carousel|card|text_reel)$/.exec(String(entry?.type || ""));
  return m ? m[1] : null;
}

/** The brand's most recent self-made kind, or null. */
export function previousSelfMadeKind(log, brandKey = "ldt") {
  const posts = validPosts(log);
  for (let i = posts.length - 1; i >= 0; i--) {
    const p = posts[i];
    if (p.brand !== brandKey) continue;
    const kind = kindOfEntry(p);
    if (kind) return kind;
    if (p.type === "ldt_clip" || p.type === "ldt_promo") return null; // a clip/legacy promo resets the rotation
  }
  return null;
}

/**
 * The brand's most recent hook style (tagged on any LDT entry, clip or
 * self-made), for the variation engine's no-consecutive-repeat rule. LDT
 * entries carry the style either as generation.hook_style or as the lane's
 * own top-level hook_style field.
 */
export function previousLdtHookStyle(log, brandKey = "ldt") {
  const posts = validPosts(log);
  for (let i = posts.length - 1; i >= 0; i--) {
    const p = posts[i];
    if (p.brand !== brandKey) continue;
    const tagged = p.generation?.hook_style || p.hook_style;
    if (tagged) return toCanonicalStyle(tagged) || null;
    if (p.caption) {
      const classified = classifyCanonicalStyle(p.caption);
      return classified === "unknown" ? null : classified;
    }
    return null;
  }
  return null;
}

/**
 * The brand's most recent self-made ANGLE, so two consecutive decks/cards
 * never tell the same story.
 */
export function previousSelfMadeAngle(log, brandKey = "ldt") {
  const posts = validPosts(log);
  for (let i = posts.length - 1; i >= 0; i--) {
    const p = posts[i];
    if (p.brand !== brandKey) continue;
    if (kindOfEntry(p)) return p.angle || p.promo_angle || null;
  }
  return null;
}

/**
 * The angle a self-made post already used EARLIER TODAY (Chicago day), or
 * null.
 *
 * This — not previousSelfMadeAngle — is what the runner feeds pickAngle, and
 * the distinction is load-bearing. pickAngle rotates by date, so consecutive
 * DAYS already land on different angles; excluding yesterday's angle as well
 * shrinks the pool from five to four, and the day-number modulo over that
 * smaller pool settles into a fixed four-cycle that starves one angle out of
 * the table completely (measured: `after_hours` never posts). The only
 * repeat the date rotation cannot prevent is the one within a single day —
 * both slots share a date, so both would tell the same story. Scoping the
 * exclusion to today fixes that without costing an angle.
 */
export function todaysSelfMadeAngle(log, brandKey = "ldt", now = new Date()) {
  const today = chicagoDayOf(now);
  const posts = validPosts(log);
  for (let i = posts.length - 1; i >= 0; i--) {
    const p = posts[i];
    if (p.brand !== brandKey) continue;
    if (!kindOfEntry(p)) continue;
    if (chicagoDayOf(p.timestamp) !== today) return null; // newest is older than today
    return p.angle || p.promo_angle || null;
  }
  return null;
}

/**
 * The ordered self-made plan for this slot.
 *
 * carousel leads unless the previous self-made post was a carousel; card and
 * text_reel alternate behind it. The full list is returned (not just the
 * head) so the runner can fall through: a generator that fails its render
 * or its gate hands the slot to the next kind rather than going silent.
 */
export function selfMadePlan({ log, brandKey = "ldt" } = {}) {
  const previous = previousSelfMadeKind(log, brandKey);
  const rest = SELF_MADE_KINDS.filter((k) => k !== previous);
  // The no-repeat rule demotes the previous kind to last resort, never to
  // impossible — with every other generator failing, repeating a format
  // still beats an empty slot.
  return previous ? [...rest, previous] : [...SELF_MADE_KINDS];
}

/**
 * The full slot plan: operator clips first (one plan entry per eligible
 * clip, oldest first — the runner already walks clips with per-clip QC and
 * blocklisting), then the self-made chain. `intakeEligible` is the eligible
 * list from pickIntakeCandidates; generation is planned even when clips
 * exist, because every clip can still fail QC.
 */
export function fillPlan({ log, intakeEligible = [], brandKey = "ldt" } = {}) {
  return [
    ...intakeEligible.map((clip) => ({ kind: "clip", clip })),
    ...selfMadePlan({ log, brandKey }).map((kind) => ({ kind })),
  ];
}

/**
 * May the self-made chain run at all this dispatch? Policy, in one testable
 * place:
 *
 *   - A FORCE_VIDEO_ID pin short-circuits ALL self-made fallback: a pin
 *     names a clip, and a blocked pin must exit red, never quietly post a
 *     generated piece instead (the runner owns the red exit).
 *   - MODE=selfmade runs the chain on demand (no clips this dispatch).
 *   - MODE=auto runs it only when the brand config opts in
 *     (contentSources.promoWhenNoClip — the key predates the multi-format
 *     lane; it now gates ALL self-made generation, not just the old promo).
 *   - MODE=clip never generates.
 */
export function selfMadeAllowed({ mode = "auto", forceVideoId = "", brand = null } = {}) {
  if (forceVideoId) return false;
  if (mode === "selfmade") return true;
  return mode === "auto" && Boolean(brand?.contentSources?.promoWhenNoClip);
}

/** Sanity export for tests: the plan can never be empty. */
export function planNeverEmpty(plan) {
  return Array.isArray(plan) && plan.length >= SELF_MADE_KINDS.length;
}

export { HOOK_STYLE_IDS };
