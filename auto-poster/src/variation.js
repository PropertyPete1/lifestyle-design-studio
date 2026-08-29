/**
 * variation.js — the variation engine: deliberate rotation, every choice tagged.
 *
 * WHY THIS EXISTS. The pipeline used to pick a hook style by weighted random
 * inside the caption builder and THROW THE CHOICE AWAY — the style reached the
 * console log and nothing else. Performance could never map back to a decision,
 * which means nothing could be learned from it. This module makes the choice
 * once, up front, and hands back a record main.js writes onto the posted-log
 * entry, so every post carries the decisions that shaped it.
 *
 * WHAT ROTATES, AND WHAT IS ONLY TAGGED — stated here because pretending to
 * rotate an axis the pipeline does not control would corrupt the data:
 *
 *   ROTATED   hook style        six canonical styles (src/hook-styles.js),
 *                               never the same style twice in a row
 *   ROTATED   caption length    short / medium / long buckets, fresh captions
 *                               only (a restructured caption preserves the
 *                               original's facts and cannot honestly be short)
 *   TAGGED    posting time      the cron fixes the slots; slot/hour/weekday are
 *                               recorded and analyzed, not chosen here
 *   TAGGED    topic             observed from the video (city, price overlay,
 *                               community-KB match), not synthesized
 *   TAGGED    voice persona     voiceover.js already rotates it; the id is
 *                               already on the log entry (voiceover_persona)
 *
 * ─── THE 70/30 RULE ─────────────────────────────────────────────────────────
 *
 * With a fresh weekly brief on disk (learning/brief-<brand>.json, written by
 * scripts/run-learning-loop.mjs): 70% of picks lean into the brief's winners,
 * weighted by their measured scores; 30% explore uniformly across everything
 * not on the kill list — including styles with too little data to rank,
 * because exploration is the only thing that fixes an insufficient sample.
 *
 * Without a brief (or with a stale one): fall back to the legacy
 * performance-weights.json (its five styles mapped onto the canonical six),
 * and finally to a uniform pick. The pick NEVER fails — a variation problem
 * must not cost a posting slot.
 *
 * ─── THE KILL LIST ──────────────────────────────────────────────────────────
 *
 * A style on the brief's kill list is not picked, by either arm. If the kill
 * list ever swallows every eligible style, it is ignored with a loud warning
 * rather than obeyed — an over-aggressive scorer must not silence generation.
 */

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { HOOK_STYLE_IDS, toCanonicalStyle, classifyCanonicalStyle } from "./hook-styles.js";
import { validPosts } from "./state.js";
import { loadWeights } from "./analytics.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const LEARNING_DIR = join(__dirname, "..", "learning");

/** The brand this pipeline generates for. Future brands get their own key. */
export const DEFAULT_BRAND = "lifestyle";

/** A brief older than this is history, not guidance. */
export const BRIEF_FRESH_DAYS = 14;

export const EXPLOIT_RATIO = 0.7;

/**
 * Caption length buckets. `target` is what the prompt asks for; the validator's
 * 200-char floor stays untouched underneath all of them.
 */
export const CAPTION_LENGTH_BUCKETS = {
  short: { id: "short", min: 600, max: 1000, target: "600-1,000 characters — tight and punchy, cut every section to its best two bullets" },
  medium: { id: "medium", min: 1000, max: 1500, target: "1,000-1,500 characters — balanced" },
  long: { id: "long", min: 1500, max: 2000, target: "1,500-2,000 characters — information-dense, not thin" },
};
export const CAPTION_LENGTH_IDS = Object.keys(CAPTION_LENGTH_BUCKETS);

/** Path of a brand's brief. Exported so the learn step writes the same place. */
export function briefPath(brand = DEFAULT_BRAND) {
  return join(LEARNING_DIR, `brief-${brand}.json`);
}

/**
 * Load a brand's brief, or null. Never throws: a malformed brief degrades to
 * "no brief" (the legacy-weights fallback), never to a dead posting run.
 */
export function loadBrief(brand = DEFAULT_BRAND) {
  const path = briefPath(brand);
  if (!existsSync(path)) return null;
  try {
    const brief = JSON.parse(readFileSync(path, "utf-8"));
    return brief && typeof brief === "object" ? brief : null;
  } catch (err) {
    console.warn(`[Variation] Brief for "${brand}" unreadable (${err.message}) — falling back`);
    return null;
  }
}

/** Is this brief recent enough to steer generation? */
export function briefIsFresh(brief, now = new Date()) {
  const stamp = brief?.generated_at ? new Date(brief.generated_at).getTime() : NaN;
  if (!Number.isFinite(stamp)) return false;
  return now.getTime() - stamp <= BRIEF_FRESH_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * The hook style of the pipeline's most recent reel post, canonical.
 *
 * Every city fans out to the same accounts, so "consecutive" is account-level:
 * the last reel entry across ALL cities. Tagged entries answer directly;
 * legacy entries are classified from their stored caption; an unclassifiable
 * entry imposes no constraint (null).
 */
export function previousHookStyle(log) {
  const posts = validPosts(log);
  for (let i = posts.length - 1; i >= 0; i--) {
    const p = posts[i];
    if (p.type || p.platform === "instagram_main_native") continue;
    if (!p.city || !p.slot) continue; // reels carry city+slot; receipts don't
    if (p.generation?.hook_style) return toCanonicalStyle(p.generation.hook_style);
    const classified = classifyCanonicalStyle(p.caption);
    return classified === "unknown" ? null : classified;
  }
  return null;
}

/** The caption-length bucket of the most recent FRESH-caption reel, or null. */
export function previousLengthBucket(log) {
  const posts = validPosts(log);
  for (let i = posts.length - 1; i >= 0; i--) {
    const p = posts[i];
    if (p.type || p.platform === "instagram_main_native") continue;
    if (!p.city || !p.slot) continue;
    const bucket = p.generation?.caption_length_bucket;
    if (bucket && CAPTION_LENGTH_BUCKETS[bucket]) return bucket;
    // Untagged or restructured entries impose no constraint, keep looking back
    // only one entry deep for tagged data — older history is not "previous".
    return null;
  }
  return null;
}

/** Kill-listed values for one axis, from a brief. Absent brief → empty set. */
export function killedValues(brief, axis) {
  const list = Array.isArray(brief?.kill_list) ? brief.kill_list : [];
  return new Set(list.filter((k) => k && k.axis === axis).map((k) => k.value));
}

/** Weighted pick from { value: weight } — weights ≤ 0 are excluded. */
function weightedPick(weightsByValue, rand) {
  const entries = Object.entries(weightsByValue).filter(([, w]) => Number.isFinite(w) && w > 0);
  if (entries.length === 0) return null;
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let roll = rand() * total;
  for (const [value, w] of entries) {
    roll -= w;
    if (roll <= 0) return value;
  }
  return entries[entries.length - 1][0];
}

/**
 * Pick one value for an axis under the 70/30 rule.
 *
 * `pool` — every eligible value (previous + killed already removed).
 * `winners` — { value: score } measured winners from the brief (may be empty).
 */
export function pickWithExploration({ pool, winners, rand }) {
  if (pool.length === 0) return { value: null, source: "empty_pool" };
  const winnerWeights = {};
  for (const [value, score] of Object.entries(winners || {})) {
    if (pool.includes(value) && Number.isFinite(score) && score > 0) winnerWeights[value] = score;
  }
  const haveWinners = Object.keys(winnerWeights).length > 0;
  if (haveWinners && rand() < EXPLOIT_RATIO) {
    const value = weightedPick(winnerWeights, rand);
    if (value) return { value, source: "exploit" };
  }
  return { value: pool[Math.floor(rand() * pool.length) % pool.length], source: "explore" };
}

/** Brief winners for an axis as { value: score }, minus insufficient samples. */
export function briefWinners(brief, axis) {
  const table = brief?.[axis];
  if (!table || typeof table !== "object") return {};
  const out = {};
  for (const [value, row] of Object.entries(table)) {
    if (!row || row.verdict === "kill" || row.verdict === "insufficient_sample") continue;
    if (Number.isFinite(row.score) && row.score > 0) out[value] = row.score;
  }
  return out;
}

/** Legacy performance-weights mapped onto canonical style ids. */
export function legacyStyleWeights() {
  try {
    const weights = loadWeights()?.weights || {};
    const out = {};
    for (const [legacyId, w] of Object.entries(weights)) {
      const canonical = toCanonicalStyle(legacyId);
      if (canonical && Number.isFinite(w) && w > 0) {
        // Two legacy ids can map to one canonical id; keep the larger signal.
        out[canonical] = Math.max(out[canonical] || 0, w);
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Plan this post's variation. The one entry point main.js calls.
 *
 * Returns the full decision record, ready to be written onto the posted-log
 * entry as `generation`. Never throws.
 */
export function planVariation({ log, brand = DEFAULT_BRAND, rand = Math.random, now = new Date(), brief: injectedBrief } = {}) {
  // `brief` is injectable so tests can exercise the picker without touching
  // the real learning/ directory. Production callers omit it.
  const brief = injectedBrief !== undefined ? injectedBrief : loadBrief(brand);
  const fresh = brief ? briefIsFresh(brief, now) : false;
  if (brief && !fresh) {
    console.warn(`[Variation] Brief for "${brand}" is stale (generated ${brief.generated_at}) — using fallback weights`);
  }
  const activeBrief = fresh ? brief : null;

  // ── hook style ────────────────────────────────────────────────────────────
  const previous = previousHookStyle(log);
  const killedStyles = killedValues(activeBrief, "hook_style");
  let stylePool = HOOK_STYLE_IDS.filter((id) => id !== previous && !killedStyles.has(id));
  let killListIgnored = false;
  if (stylePool.length === 0) {
    console.warn(`[Variation] Kill list excludes every hook style — ignoring it rather than going silent`);
    killListIgnored = true;
    stylePool = HOOK_STYLE_IDS.filter((id) => id !== previous);
  }

  let stylePick;
  let styleSource;
  if (activeBrief) {
    const picked = pickWithExploration({ pool: stylePool, winners: briefWinners(activeBrief, "hook_styles"), rand });
    stylePick = picked.value;
    styleSource = `brief_${picked.source}`;
  } else {
    const picked = pickWithExploration({ pool: stylePool, winners: legacyStyleWeights(), rand });
    stylePick = picked.value;
    styleSource = `legacy_weights_${picked.source}`;
  }
  if (!stylePick) {
    stylePick = stylePool[0] || HOOK_STYLE_IDS[0];
    styleSource = "default";
  }

  // ── caption length ────────────────────────────────────────────────────────
  const prevBucket = previousLengthBucket(log);
  const killedLengths = killedValues(activeBrief, "caption_length");
  let lengthPool = CAPTION_LENGTH_IDS.filter((id) => id !== prevBucket && !killedLengths.has(id));
  if (lengthPool.length === 0) lengthPool = CAPTION_LENGTH_IDS.filter((id) => id !== prevBucket);
  const lengthPicked = pickWithExploration({
    pool: lengthPool,
    winners: activeBrief ? briefWinners(activeBrief, "caption_lengths") : {},
    rand,
  });
  const lengthPick = lengthPicked.value || "long";

  const plan = {
    engine: "variation-v1",
    hook_style: stylePick,
    hook_style_source: styleSource,
    excluded_style: previous,
    caption_length_bucket: lengthPick,
    caption_length_source: activeBrief ? `brief_${lengthPicked.source}` : lengthPicked.source,
    brief_generated_at: activeBrief?.generated_at || null,
    kill_list_ignored: killListIgnored || undefined,
  };
  console.log(
    `[Variation] hook_style=${plan.hook_style} (${plan.hook_style_source}, previous=${previous || "none"}) ` +
    `caption_length=${plan.caption_length_bucket} (${plan.caption_length_source}) ` +
    `brief=${activeBrief ? activeBrief.generated_at : "none"}`
  );
  return plan;
}
