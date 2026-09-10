/**
 * cadence.js — a real daily cap on the realty lane, and a loop that moves it.
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
 *     13:15Z cron fires before the first realty slot at 16:00Z.
 *   - manual_confirm is EXCLUDED — it is the main-Instagram leg of a publish
 *     already counted. 78 of 81 such rows pair with a same-day, same-city
 *     main-lane row; they carry the DELIVERED file's Drive id rather than the
 *     source's, which is why a naive driveFileId join shows zero overlap.
 *   - linkedin and the ldt_* lanes are EXCLUDED — different networks, and LDT
 *     is paused.
 *
 * MEASURED BASELINE (2026-09-09, last 14 Chicago days): 2.36 publishes/day,
 * min 2, max 3 — against five cron slots. Slots routinely find nothing
 * eligible, so the gate binds far less often than the schedule suggests.
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
 * Operating range and target.
 *
 * SET FROM REAL EVIDENCE ON 2026-09-10, replacing the deliberately-inert
 * defaults (target 4 against a measured max of 3) that shipped when the only
 * frequency evidence available was an artifact.
 *
 * The 2026-09-10 decision run analysed 213 posts on the flagship account over
 * 2026-04-29 to 2026-09-09 — the full window Metricool exposes, not a sample:
 *
 *     posts/day   median views/post   sample
 *         1            1,555            47
 *         2            1,470            54
 *         3              852            27
 *         4              961            12
 *         5            1,462             5
 *         6              894            24
 *
 * TARGET 2. Going 1 -> 2 costs 5% of median views per post and nearly doubles
 * daily reach. Going to 3 costs 42%. Median day total is 1,555 at 1/day, 3,015
 * at 2/day, 3,934 at 3/day — half again the content for a third more reach.
 * Two is the last point where per-post quality holds.
 *
 * FLOOR 1, because 1/day is the best per-post row in the data and the loop
 * should be able to reach it if the evidence ever supports that. Zero is not a
 * cadence.
 *
 * CEILING 3, because above 2 the evidence collapses AND thins at the same time:
 * the 4, 5 and 6 rows rest on 12, 5 and 24 posts across three or four clustered
 * days, and the decision file says of its own 5/day row that it "is one day and
 * should be ignored". A ceiling of 3 lets the loop step back up one notch if 2
 * proves too quiet, without climbing into the range its own evidence distrusts.
 * CADENCE_HARD_CEILING stays the backstop that config cannot raise.
 *
 * WHAT THIS CAP DOES NOT DO. The recommendation was measured on the flagship
 * account, @lifestyledesignrealtytexas — which this pipeline never posts to,
 * because mainBrandSkipIG withholds it so Peter posts natively. Capping here
 * cuts the three satellite Instagram accounts, the main TikTok and the main
 * YouTube Short, and reduces the supply of Drive deliveries from ~3.1 to 2 a
 * day. The flagship runs ~3.1 posts/day of which only ~1.2 arrive through the
 * pipeline; closing the rest is a manual-posting change. Nobody should read
 * this cap as having implemented the 2/day finding on the account it was
 * measured on.
 */
export const DEFAULT_FLOOR = 1;
export const DEFAULT_CEILING = 3;
export const DEFAULT_TARGET = 2;

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

/**
 * The posting slots the rotation arbitrates between, in the order they fire.
 *
 * Kept in sync with the live crons in .github/workflows/post.yml. Order is
 * chronological because that is what makes the unfairness this fixes visible:
 * a plain first-come cap always feeds the earliest slot and always starves the
 * latest one.
 */
export const ROTATION_SLOTS = [
  { city: "san_antonio", slot: "am" },
  { city: "austin", slot: "am" },
  { city: "dallas", slot: "pm" },
];

/**
 * Which slots stand down today so the others can use the cap.
 *
 * WHY THIS EXISTS. Three slots against a target of two means one must yield
 * every day. Left to a plain first-come cap, the loser is always whoever fires
 * last — measured over the 30 days to 2026-09-10, a cap of 2 would have let
 * san_antonio am publish on 29 of 29 days while dallas pm published on 1 of 9.
 * Dallas would have gone dark by accident of clock order rather than on merit.
 *
 * So the yielder rotates by Chicago date. With three slots and a target of two,
 * each slot yields one day in three and publishes the other two. The rotation
 * is derived from the date alone — no stored cursor, nothing to drift, and two
 * runs on the same day always agree about who is yielding.
 *
 * It generalises: n = slots - target slots yield, taken consecutively from a
 * date-derived offset. At target 3 nobody yields; at target 1 two of the three
 * do.
 *
 * A slot not in the rotation (a manual workflow_dispatch, or a retired cron
 * someone re-enables) never yields — the plain cap governs it. Refusing to run
 * a slot we do not model would be a worse failure than letting the count decide.
 */
export function yieldingSlotsFor(day, { slots = ROTATION_SLOTS, target = DEFAULT_TARGET } = {}) {
  const n = slots.length - target;
  if (!Number.isFinite(n) || n <= 0) return [];
  if (n >= slots.length) return [...slots];
  // Days since the epoch, from the Chicago calendar date — stable for the whole
  // Chicago day regardless of when in it a slot fires.
  const [y, m, d] = String(day).split("-").map(Number);
  if (!y || !m || !d) return [];
  const dayNumber = Math.floor(Date.UTC(y, m - 1, d) / 86400000);
  const offset = ((dayNumber % slots.length) + slots.length) % slots.length;
  const out = [];
  for (let i = 0; i < n; i++) out.push(slots[(offset + i) % slots.length]);
  return out;
}

/** Is this city+slot standing down today? */
export function isYieldingToday(city, slot, day, opts = {}) {
  const inRotation = (opts.slots || ROTATION_SLOTS).some((s) => s.city === city && s.slot === slot);
  if (!inRotation) return false;
  return yieldingSlotsFor(day, opts).some((s) => s.city === city && s.slot === slot);
}

/**
 * THE GATE. Called at the top of a run, before Drive is listed.
 *
 * Returns { allowed, used, target, reason }. `allowed: false` means the run
 * should exit cleanly having posted nothing — not fail.
 */
export function cadenceGate(log, { now = new Date(), state = null, path = CADENCE_PATH, city = null, slot = null } = {}) {
  const s = state || loadCadence(path);
  const target = clampTarget(s.target, s);
  const used = countPublishesToday(log, now);
  const day = chicagoDay(now);

  // The rotation is checked BEFORE the count. A yielding slot stands down even
  // when the budget is untouched — that is the whole point: it is holding the
  // budget open for a slot that fires later in the day and would otherwise
  // never reach it.
  if (city && slot && isYieldingToday(city, slot, day, { target })) {
    const takers = ROTATION_SLOTS
      .filter((r) => !isYieldingToday(r.city, r.slot, day, { target }))
      .map((r) => `${r.city} ${r.slot}`)
      .join(", ");
    return {
      allowed: false,
      used,
      target,
      day,
      yielded: true,
      reason: `yielding today so ${takers} can use the ${target}/day cap (rotates by date; this slot posts 2 days in 3)`,
    };
  }

  return {
    allowed: used < target,
    used,
    target,
    day,
    yielded: false,
    reason: used < target
      ? `${used}/${target} publishes used today`
      : `daily cap reached — ${used}/${target} publishes already made today (CT)`,
  };
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
