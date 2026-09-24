/**
 * cadence.js — a real daily cap on the realty lane, the market rotation that
 * decides WHO gets the day, and a loop that moves the cap.
 *
 * THE UNIT IS ONE PIPELINE PUBLISH PER CHICAGO DAY, pooled across cities.
 *
 * That choice is forced, not preferred. A single run calls createPost once
 * (main.js) and the fan-out submits that one video to whatever networks each
 * qualifying Metricool profile has connected — three satellite Instagram
 * accounts, plus TikTok and YouTube on the main brand, whose Instagram is
 * withheld by mainBrandSkipIG so Peter posts it natively. Five automated
 * publications per publish, today. The pipeline does not choose that number:
 * getAllBrands reads it out of Metricool, so connecting one more profile
 * changes it without a deploy.
 *
 * So the other candidate units all fail:
 *   - per platform  — unenforceable. The pipeline has no per-network lever
 *     except mainBrandSkipIG, which is a withhold and not a count. Worse, the
 *     log cannot even measure it: recordPost writes a hardcoded literal
 *     ["tiktok","youtube","satellite_ig"] (main.js), the same three strings on
 *     every row regardless of what actually published.
 *   - per account   — same problem, and it moves when a profile is connected.
 *   - per city slot — already double-guarded by hasRecentPost (20h and 2h).
 *   - per day total across platforms — a number nobody decides and nobody
 *     experiences; it is five times the publish count by construction.
 *
 * One publish produces exactly one post on each connected account, so
 * publishes-per-day IS posts-per-day-per-account. That is the number the
 * frequency evidence is about and the number a follower experiences.
 *
 * WHAT IS COUNTED. Realty main-lane rows only:
 *   - trial_variant is EXCLUDED — it posts nowhere. trial-variant-main.js
 *     imports no Metricool posting function and records platforms: [] on all 51
 *     rows ever written; it renders a variant to Drive for manual posting.
 *     Counting it without gating it would also starve the real lane, since its
 *     13:15Z cron fires before the daily slot.
 *   - manual_confirm is EXCLUDED — it is the main-Instagram leg of a publish
 *     already counted. 78 of 81 such rows pair with a same-day, same-city
 *     main-lane row; they carry the DELIVERED file's Drive id rather than the
 *     source's, which is why a naive driveFileId join shows zero overlap.
 *   - linkedin and the ldt_* lanes are EXCLUDED — different networks, and LDT
 *     is paused.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE LAW, AS OF 2026-09-24 — Instagram is rate-limiting the accounts.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   1. ONE publish per Chicago day. cadence.json target 1, floor 1, ceiling 2,
 *      set directly by the operator (a history entry, not a loop step).
 *   2. ONE slot per day — DAILY_SLOT ("am"). Every other slot is retired.
 *   3. ONE market per day, rotating by Chicago date: San Antonio → Austin →
 *      Dallas, anchored so 2026-09-24 is San Antonio. Derived from the date
 *      alone — no cursor, nothing to drift, two runs on one day always agree.
 *   4. The decision file may NAME today's market (its `today` block, read and
 *      day-scoped in drive-decision.js). When it does, that market takes the
 *      day; when it does not, the rotation does. The file overrides a day; the
 *      calendar owns the sequence, so a named Tuesday does not shift Wednesday.
 *   5. THE GATE IS THE LAW. A run for any other city, any other slot, or a day
 *      already spent exits clean having posted nothing — whoever dispatched it.
 *      post.yml no longer fires the retired slots, but something outside this
 *      repo still does: over 2026-09-19..23, 7-11 runs a day reached this gate
 *      against 6 possible cron fires, and the SA pm slot (retired 2026-09-10)
 *      PUBLISHED on 5 of 7 days because the old gate let a slot it did not
 *      model through on the plain count. That exception is gone: a slot the
 *      law does not name never publishes.
 *
 * MEASURED, the 7 Chicago days to 2026-09-23: 2 publishes every single day
 * (the 2/day cap binding on all 7), 14 publishes, 42 satellite Instagram
 * reels from this pipeline alone, while Metricool showed ~20 reels per
 * satellite account in the same window — about a third of the satellite
 * volume is not this pipeline's. See the 2026-09-24 entry in cadence.json.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CADENCE_PATH = join(__dirname, "..", "cadence.json");

export const CADENCE_SCHEMA_VERSION = 1;

/**
 * The absolute ceiling, in CODE. brands.json may lower the operating range but
 * never raise it past this — the same rule resolveCadence keeps for the LDT
 * lane, and for the same reason: one edit to the config file that sets the
 * target must not also be able to raise the limit on the target.
 */
export const CADENCE_HARD_CEILING = 6;

/**
 * Operating range and target — the CODE defaults, which are what a missing or
 * corrupt cadence.json reads as. They match the file on purpose: if the file
 * is ever unreadable, the lane must fall back to the law, not to the old 2/day.
 *
 * TARGET 1 (2026-09-24). Instagram is rate-limiting/restricting the accounts.
 * The 2026-09-10 evidence (213 flagship posts, 2026-04-29 to 2026-09-09) put
 * 1/day at the best median views per post in the data — 1,555 against 1,470 at
 * 2/day and 852 at 3/day — so one a day is also the row the frequency evidence
 * liked most; the reach it gives up is the price of keeping the accounts.
 *
 * FLOOR 1, because zero is not a cadence.
 *
 * CEILING 2, down from 3. The loop may step back up to two if the decision
 * file argues for it after the dwell period, and no further: three a day is
 * what the accounts were doing when the restriction landed, and above two the
 * 2026-09-10 evidence collapses on 12, 5 and 24 posts anyway.
 *
 * WHAT THIS CAP DOES NOT DO. The flagship account, @lifestyledesignrealtytexas,
 * is never posted to by this pipeline (mainBrandSkipIG withholds it so Peter
 * posts natively). This cap governs the three satellite Instagram accounts,
 * the main TikTok and the main YouTube Short, and the supply of Drive
 * deliveries. The flagship's own cadence is a manual-posting decision.
 */
export const DEFAULT_FLOOR = 1;
export const DEFAULT_CEILING = 2;
export const DEFAULT_TARGET = 1;

/**
 * Evidence thresholds. Deliberately conservative, because the frequency
 * evidence is not merely contested — the remote side of it is an artifact.
 *
 * THE 1,543-VS-544 NUMBER IS REPRODUCIBLE, AND IT IS MEASURING THE WRONG
 * ACCOUNT. Restricting to the MAIN account and bucketing by that account's own
 * posts-that-day reproduces it: ~1,354 views at "one post/day" against ~587 at
 * six. But the one-post arm is n=1 to 3 posts, and the main account's Instagram
 * is the one destination the pipeline deliberately never posts to —
 * mainBrandSkipIG withholds it so Peter posts natively. The cadence dial does
 * not move that account. So the headline evidence for changing cadence is a
 * single-post arm measured on the account the change cannot affect.
 *
 * THIS REPO'S OWN DATA SHOWS THE OPPOSITE SIGN. Over 57 days,
 * Spearman r(posts/day, views-per-post) = +0.235 — weakly POSITIVE. Holding
 * maturity constant at age 7 days it is +0.223, and log(daily views) against
 * log(posts) has slope 1.26 (95% CI 0.96-1.55): at least linear, with no sign
 * of a per-day audience ceiling anywhere between 8 and 27 posts/day.
 *
 * NOISE IS THE BINDING CONSTRAINT. SD of log(views-per-post) at fixed age is
 * 0.410, lag-1 autocorrelation 0.304. Bootstrapping random 14-vs-14 day splits
 * of a SINGLE UNCHANGED regime, the halves differ by >=1.30x 21% of the time
 * and >=1.50x only 1.8%. A threshold below 1.5x fires on noise roughly one
 * comparison in five.
 *
 * WHY NO EFFECT-SIZE TEST IS IMPLEMENTED HERE. Computing one honestly needs the
 * daily series, and that series has two defects this module will not paper
 * over: `views` on a daily row is cumulative-to-snapshot rather than same-day,
 * and the trailing edge silently shrinks (2026-08-10 fell from 18 posts/3,819
 * views to 4/500 as the window slid, because the fetch starts mid-day while the
 * merge treats that whole calendar day as authoritative). Those shrunken rows
 * ARE the low-posts-per-day bucket — which is exactly how a spurious
 * "fewer posts, more views each" signal gets manufactured. A statistical gate
 * reading corrupted rows is worse than no gate, so this module gates on what it
 * can verify — dwell, level stability, range, direction — and HOLDS otherwise.
 */
export const MIN_DAYS_AT_LEVEL = 14;
export const MIN_DAYS_BETWEEN_CHANGES = 14;

/**
 * A decrease must clear a higher bar than an increase.
 *
 * log(daily views) ~ log(posts) has slope 1.26 at age 7 and 1.46 at age 14 —
 * at least linear in this data. Cutting cadence should therefore be presumed to
 * cost reach until an effect beats that prior, not assumed to protect it.
 */
export const DECREASE_REQUIRES_EXPLICIT_EVIDENCE = true;

/** Load cadence state, tolerating every way the file can be unusable. */
export function loadCadence(path = CADENCE_PATH) {
  const fresh = () => ({
    schema_version: CADENCE_SCHEMA_VERSION,
    target: DEFAULT_TARGET,
    floor: DEFAULT_FLOOR,
    ceiling: DEFAULT_CEILING,
    changed_at: null,
    history: [],
    holds: [],
  });
  if (!existsSync(path)) return fresh();
  try {
    const p = JSON.parse(readFileSync(path, "utf-8"));
    if (!p || typeof p !== "object" || Array.isArray(p)) return fresh();
    const base = fresh();
    return {
      ...base,
      ...p,
      history: Array.isArray(p.history) ? p.history : [],
      holds: Array.isArray(p.holds) ? p.holds : [],
      target: Number.isInteger(p.target) ? p.target : base.target,
      floor: Number.isInteger(p.floor) ? p.floor : base.floor,
      ceiling: Number.isInteger(p.ceiling) ? p.ceiling : base.ceiling,
    };
  } catch {
    return fresh();
  }
}

export function saveCadence(state, path = CADENCE_PATH) {
  writeFileSync(path, JSON.stringify(state, null, 2));
}

/** Chicago calendar day for a timestamp. Matches brands.js chicagoDayOf. */
export function chicagoDay(dateLike) {
  const d = dateLike instanceof Date ? dateLike : new Date(dateLike);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

/**
 * Is this posted-log row a realty main-lane publish?
 *
 * The discriminator is a NON-EMPTY platforms array plus the absence of a `type`
 * tag. Every other lane is excluded by one of those two: trial_variant,
 * linkedin and the ldt_* lanes all set `type`, and trial_variant additionally
 * sets platforms: []. manual_confirm rows carry neither `platforms` nor `type`,
 * so they are excluded explicitly by source/platform rather than by accident.
 */
export function isRealtyPublish(row) {
  if (!row || row.success === false) return false;
  if (row.type) return false;
  if (row.brand && row.brand !== "realty") return false;
  if (row.source === "manual_confirm" || row.platform === "instagram_main_native") return false;
  return Array.isArray(row.platforms) && row.platforms.length > 0;
}

/** Realty publishes recorded during the Chicago day containing `now`. */
export function countPublishesToday(log, now = new Date()) {
  const today = chicagoDay(now);
  return (log?.posts || []).filter(
    (p) => isRealtyPublish(p) && chicagoDay(p.timestamp) === today
  ).length;
}

/** Publishes per Chicago day over the trailing `days` days, newest first. */
export function dailyPublishSeries(log, now = new Date(), days = 30) {
  const counts = new Map();
  for (const p of log?.posts || []) {
    if (!isRealtyPublish(p)) continue;
    const d = chicagoDay(p.timestamp);
    if (d) counts.set(d, (counts.get(d) || 0) + 1);
  }
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = chicagoDay(new Date(now.getTime() - i * 86400000));
    out.push({ date: d, posts: counts.get(d) || 0 });
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// THE MARKET ROTATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The markets, in rotation order. San Antonio → Austin → Dallas, repeat.
 *
 * These are the CITY values main.js runs under and the keys of
 * CITY_FOLDER_IDS in drive.js — the rotation hands the workflow a city name
 * it can run as-is.
 */
export const MARKETS = ["san_antonio", "austin", "dallas"];

/** The short labels merge-log-push.mjs puts in commit messages. */
export const MARKET_LABELS = { san_antonio: "SA", austin: "ATX", dallas: "DFW" };

/**
 * The day the rotation started, and who had it: San Antonio on 2026-09-24
 * ("San Antonio today, Austin tomorrow, Dallas next, repeat" — the operator's
 * words, the day this shipped). Every later day is derived from this anchor,
 * so the sequence is auditable from the constant alone.
 */
export const MARKET_ROTATION_ANCHOR = "2026-09-24";

/**
 * The one slot that publishes. Every other slot value is retired and stands
 * down at the gate. "am" rather than a new name because it IS the morning slot
 * the log already knows — hasRecentPost's 20h guard is keyed on city + slot and
 * needs no migration, and the debut lane (promote-ahead.js) runs on am slots.
 */
export const DAILY_SLOT = "am";

/**
 * Spellings of the three markets that reach us from outside — the decision
 * file is written by a Claude task in prose-adjacent JSON and the dispatch
 * form is typed by a person. Lower-cased, letters only, so "San Antonio",
 * "san_antonio", "SA" and "SATX" all land on the same id. Anything else is
 * null, never a guess: an unknown market falls back to the rotation and says so.
 */
const MARKET_ALIASES = {
  sanantonio: "san_antonio", sa: "san_antonio", satx: "san_antonio",
  austin: "austin", atx: "austin",
  dallas: "dallas", dfw: "dallas", dallasfortworth: "dallas", fortworth: "dallas",
};

/** Canonical market id for a spelling, or null when it names no market. */
export function normalizeMarket(value) {
  if (typeof value !== "string") return null;
  const key = value.toLowerCase().replace(/[^a-z]/g, "");
  return MARKET_ALIASES[key] ?? null;
}

/** Day number (days since the epoch) of a "YYYY-MM-DD" string, or null. */
function dayNumberOf(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day ?? ""));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (!y || !mo || !d) return null;
  const n = Math.floor(Date.UTC(y, mo - 1, d) / 86400000);
  return Number.isFinite(n) ? n : null;
}

/**
 * The market the ROTATION gives a Chicago calendar day. Pure, cursorless:
 * anchor + (days since anchor) mod 3. A malformed day is null rather than a
 * default market — a gate that cannot tell what day it is must refuse, not
 * pick San Antonio.
 */
export function marketForDay(day) {
  const n = dayNumberOf(day);
  const a = dayNumberOf(MARKET_ROTATION_ANCHOR);
  if (n === null || a === null) return null;
  const idx = (((n - a) % MARKETS.length) + MARKETS.length) % MARKETS.length;
  return MARKETS[idx];
}

/**
 * Today's market, all things considered.
 *
 * `namedMarket` is what the decision file named FOR TODAY — drive-decision.js
 * has already day-scoped it, so a block written for another day never reaches
 * here as a name. It wins when it names a real market; the rotation otherwise.
 */
export function resolveMarket({ day, namedMarket = null } = {}) {
  const named = normalizeMarket(namedMarket);
  if (named) return { market: named, source: "decision_file" };
  return { market: marketForDay(day), source: "rotation" };
}

/** The next `days` days of the rotation, for logs — [{ day, market }]. */
export function rotationPreview(fromDay, days = 3) {
  const n = dayNumberOf(fromDay);
  if (n === null) return [];
  const out = [];
  for (let i = 0; i < days; i++) {
    const day = new Date((n + i) * 86400000).toISOString().slice(0, 10);
    out.push({ day, market: marketForDay(day) });
  }
  return out;
}

/**
 * THE GATE. Called at the top of a run, before Drive is listed.
 *
 * Returns { allowed, used, target, day, market, marketSource, standDown,
 * reason }. `allowed: false` means the run should exit cleanly having posted
 * nothing — not fail. `standDown` names WHY, because the three reasons have
 * three different owners:
 *
 *   "off_market"    this city is not today's market. Routine on a dispatch —
 *                   the retired slots are still fired from outside this repo.
 *   "retired_slot"  right city, wrong slot. Same.
 *   "cap"           today's one publish has already happened.
 *
 * Checked in that order, and the market and slot are checked BEFORE the count:
 * a run for the wrong city must stand down even when the budget is untouched,
 * because it is holding that budget for the market whose day it is.
 *
 * With no city or slot supplied only the count governs — the gate cannot
 * refuse a slot it cannot identify. main.js always supplies both.
 */
export function cadenceGate(log, {
  now = new Date(), state = null, path = CADENCE_PATH, city = null, slot = null, namedMarket = null,
} = {}) {
  const s = state || loadCadence(path);
  const target = clampTarget(s.target, s);
  const used = countPublishesToday(log, now);
  const day = chicagoDay(now);
  const { market, source } = resolveMarket({ day, namedMarket });
  const base = { used, target, day, market, marketSource: source };
  const who = source === "decision_file" ? "named by today's decision file" : "SA → ATX → DFW by Chicago date";

  if (city && market && city !== market) {
    return {
      ...base,
      allowed: false,
      standDown: "off_market",
      reason: `not today's market — ${day} belongs to ${market} (${who}); ${city} stands down, whoever dispatched it`,
    };
  }

  if (slot && slot !== DAILY_SLOT) {
    return {
      ...base,
      allowed: false,
      standDown: "retired_slot",
      reason: `retired slot — only the ${DAILY_SLOT} slot publishes now, one a day; ${city ?? "this run"} ${slot} stands down, whoever dispatched it`,
    };
  }

  if (used >= target) {
    return {
      ...base,
      allowed: false,
      standDown: "cap",
      reason: `daily cap reached — ${used}/${target} publishes already made today (CT)`,
    };
  }

  return { ...base, allowed: true, standDown: null, reason: `${used}/${target} publishes used today` };
}

/** Clamp a target into the configured range and the code ceiling. */
export function clampTarget(value, { floor = DEFAULT_FLOOR, ceiling = DEFAULT_CEILING } = {}) {
  const hardCeiling = Math.min(Number.isInteger(ceiling) ? ceiling : DEFAULT_CEILING, CADENCE_HARD_CEILING);
  const lo = Math.max(1, Number.isInteger(floor) ? floor : DEFAULT_FLOOR);
  const n = Number.isInteger(value) ? value : DEFAULT_TARGET;
  return Math.min(Math.max(n, lo), Math.max(lo, hardCeiling));
}

/**
 * Decide whether to move the target, given the decision file's advice.
 *
 * Rules, in order — each one can only HOLD, never enlarge a move:
 *   1. No proposal (no decision file, or no how_many.posts_per_day) -> hold.
 *   2. Proposal equals the current target -> hold, nothing to do.
 *   3. Not enough days since the last change -> hold. A level that has not been
 *      held for MIN_DAYS_AT_LEVEL has not produced a comparison worth acting on.
 *   4. Not enough observed days at the current level -> hold.
 *   5. Otherwise move exactly ONE step toward the proposal, clamped to
 *      [floor, ceiling] and to CADENCE_HARD_CEILING.
 *
 * Never jumps: a proposal of 6 against a target of 2 moves to 3, not 6.
 *
 * The one-step rule governs THE LOOP. It is not a limit on a deliberate
 * operator decision, which is written to cadence.json directly with an
 * `actor: "operator"` history entry — 4 -> 2 on 2026-09-10, 2 -> 1 on
 * 2026-09-24.
 */
export function proposeCadence({
  state,
  proposed = null,
  rationale = null,
  log = null,
  now = new Date(),
  minDaysAtLevel = MIN_DAYS_AT_LEVEL,
  minDaysBetweenChanges = MIN_DAYS_BETWEEN_CHANGES,
}) {
  const current = clampTarget(state.target, state);
  const hold = (reason) => ({ change: false, from: current, to: current, reason });

  if (!Number.isInteger(proposed)) return hold("no posts_per_day in the decision file");
  if (proposed === current) return hold(`decision file agrees with the current target (${current}/day)`);

  if (state.changed_at) {
    const days = (now.getTime() - Date.parse(state.changed_at)) / 86400000;
    if (Number.isFinite(days) && days < minDaysBetweenChanges) {
      return hold(
        `only ${days.toFixed(1)} days since the last change (need ${minDaysBetweenChanges}) — ` +
        `holding at ${current}/day rather than moving on noise`
      );
    }
  }

  if (log) {
    const series = dailyPublishSeries(log, now, minDaysAtLevel);
    const observed = series.filter((d) => d.posts > 0).length;
    if (observed < Math.ceil(minDaysAtLevel / 2)) {
      return hold(
        `only ${observed} of the last ${minDaysAtLevel} days have publishes — ` +
        `too little at ${current}/day to justify a move`
      );
    }
  }

  const step = proposed > current ? 1 : -1;

  // DIRECTION VETO. Reach scales at least linearly with posts/day in this
  // data, so a decrease has to be argued for, not merely proposed. The
  // decision file argues for it in `rationale`; requiring that string to exist
  // is a low bar, but it is the difference between "the task thought about
  // this" and "a number moved".
  if (step < 0 && DECREASE_REQUIRES_EXPLICIT_EVIDENCE && !hasStatedRationale(rationale)) {
    return hold(
      `decision file proposes a DECREASE to ${proposed}/day with no stated rationale — ` +
      `holding at ${current}/day. Reach scales at least linearly with posts/day here ` +
      `(log-log slope 1.26, 95% CI 0.96-1.55), so a cut is presumed to cost reach.`
    );
  }

  const to = clampTarget(current + step, state);
  if (to === current) {
    return hold(
      `${proposed}/day is outside the configured range [${state.floor}, ${state.ceiling}] — ` +
      `already at the ${step > 0 ? "ceiling" : "floor"} (${current}/day)`
    );
  }
  return {
    change: true,
    from: current,
    to,
    reason: `decision file proposes ${proposed}/day; moving one step ${step > 0 ? "up" : "down"} to ${to}/day`,
  };
}

/** A rationale must be a non-trivial sentence, not an empty string or "n/a". */
function hasStatedRationale(text) {
  if (typeof text !== "string") return false;
  const t = text.trim();
  return t.length >= 20 && !/^(n\/?a|none|tbd|unknown)$/i.test(t);
}

/**
 * Apply a decided change and append it to the audit history.
 *
 * Every change records old value, new value, the evidence that drove it, and
 * the date — the four things that let someone six weeks later reconstruct why
 * the channel is posting what it is posting.
 */
export function recordCadenceChange(state, { from, to, proposed = null, evidence = null, now = new Date(), runId = null }) {
  const entry = {
    at: now.toISOString(),
    day: chicagoDay(now),
    from,
    to,
    proposed,
    evidence: evidence ?? null,
    run_id: runId,
  };
  return {
    ...state,
    schema_version: CADENCE_SCHEMA_VERSION,
    target: to,
    changed_at: entry.at,
    history: [...(state.history || []), entry].slice(-200),
  };
}

/**
 * Record a HOLD.
 *
 * A refusal is as auditable as an action. Without this, "the loop did nothing"
 * and "the loop was never asked" look identical six weeks later, and the first
 * question anyone asks about a self-adjusting system is why it did not adjust.
 * Holds are capped separately from changes so a long run of them cannot push
 * the change history out of the file.
 */
export function recordCadenceHold(state, { at = new Date(), proposed = null, reason, runId = null }) {
  const entry = {
    at: at.toISOString(),
    day: chicagoDay(at),
    target: clampTarget(state.target, state),
    proposed,
    reason,
    run_id: runId,
  };
  return {
    ...state,
    schema_version: CADENCE_SCHEMA_VERSION,
    holds: [...(state.holds || []), entry].slice(-50),
  };
}

export { CADENCE_PATH };
