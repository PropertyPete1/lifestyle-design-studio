/**
 * drive-decision.js — read the twice-weekly performance decision file.
 *
 * A scheduled Claude task writes ig_posting_decision_latest.json to Drive on
 * Sundays and Thursdays, overwriting a stable filename. This module reads it
 * before a posting run and turns it into advice the selector can act on.
 *
 * THE FILE EXISTS AS OF 2026-09-10. The first real run landed
 * ig_posting_decision_latest.json (schema 1.1, 213 posts analysed,
 * 2026-04-29 to 2026-09-09) with safe_to_act: false and
 * how_many.posts_per_day: 2. The no-file path is still fully tested, because a
 * missed writer run puts us back on it.
 *
 * ADVICE, NOT LAW. The 30-day no-repeat rule and every other Step 3 filter run
 * before this module sees a candidate, and nothing here can put back something
 * they excluded — `applyDecision` reorders and removes, never inserts. A
 * decision file cannot cause a repost inside 30 days no matter what it says.
 *
 * CADENCE IS READ HERE AND ENFORCED IN cadence.js. `how_many.posts_per_day` is
 * parsed and exposed on the plan; the daily cap, the one-step rule and the
 * floor/ceiling live in cadence.js, which consumes it. This module still does
 * not act on it — it only reports it faithfully.
 */

import { getAccessToken, downloadFileById } from "./drive.js";

export const DECISION_FILENAME = "ig_posting_decision_latest.json";

/** Schema versions this reader understands. Anything else is refused. */
export const SUPPORTED_SCHEMA_VERSIONS = ["1.1"];

/**
 * How old a decision may be before it is ignored.
 *
 * The writer runs twice a week, so a file older than seven days means a run
 * was missed. Acting on stale rankings is worse than acting on none: the
 * 30-day rule will have moved the eligible pool underneath them.
 */
export const MAX_AGE_DAYS = 7;

/** Locate the decision file by name. Returns { id, modifiedTime } or null. */
export async function findDecisionFile({ folderId = process.env.DECISION_FOLDER_ID || null, fetchImpl = fetch } = {}) {
  const token = await getAccessToken();
  const clauses = [`name = '${DECISION_FILENAME}'`, "trashed = false"];
  if (folderId) clauses.push(`'${folderId}' in parents`);
  const params = new URLSearchParams({
    q: clauses.join(" and "),
    fields: "files(id,name,modifiedTime)",
    orderBy: "modifiedTime desc",
    pageSize: "1",
  });
  const res = await fetchImpl(`https://www.googleapis.com/drive/v3/files?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Drive search failed (${res.status})`);
  const data = await res.json();
  const file = data.files?.[0];
  return file ? { id: file.id, modifiedTime: file.modifiedTime } : null;
}

/**
 * Validate a decision payload. PURE — no clock beyond what is passed in.
 *
 * Returns { usable, reason, decision }. `usable: false` is a normal outcome,
 * not an error: the caller logs the reason and runs exactly as it does today.
 */
export function parseDecision(text, { now = Date.now(), modifiedTime = null } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { usable: false, reason: `unreadable JSON (${err.message.slice(0, 80)})`, decision: null };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { usable: false, reason: "payload is not an object", decision: null };
  }

  const version = String(parsed.schema_version ?? "");
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(version)) {
    // Refusing an unknown version is the point: a future writer may change what
    // post[] MEANS, and a reader that guessed would act on a misread ranking.
    return {
      usable: false,
      reason: `unrecognised schema_version ${JSON.stringify(parsed.schema_version)} (understood: ${SUPPORTED_SCHEMA_VERSIONS.join(", ")})`,
      decision: null,
    };
  }

  const stamp = modifiedTime ? Date.parse(modifiedTime) : NaN;
  if (!Number.isNaN(stamp)) {
    const ageDays = (now - stamp) / 86400000;
    if (ageDays > MAX_AGE_DAYS) {
      return { usable: false, reason: `stale — ${ageDays.toFixed(1)} days old (limit ${MAX_AGE_DAYS})`, decision: null };
    }
  }

  // safe_to_act SCOPES TO THE QUEUE, NOT THE WHOLE FILE.
  //
  // This was widened deliberately on 2026-09-10, and the 2026-09-10 run is why.
  // That file carries safe_to_act: false for a specific, narrow reason — no
  // publish manifest maps Instagram posts to source videos, so every post[] row
  // has drive_file_id: null and confidence "low". Its own summary says it: "The
  // thinking below is still good; the file matching is not."
  //
  // The queue is genuinely unusable there. But how_many is a separate analysis
  // over 213 posts across the full window Metricool exposes, and nothing about
  // the missing manifest touches it. Refusing the whole file would have thrown
  // away the only real frequency evidence this system has ever had, and left
  // cadence changeable only by editing code — which is the thing the decision
  // file exists to avoid.
  //
  // So: safe_to_act false suppresses post[] and dont_post[], and nothing else.
  // The original contract said "never act on a false run's post[] list", and
  // post[] is what stays barred. The suppression is applied in
  // planFromDecision(), so a caller cannot get a ranked queue out of an unsafe
  // file by reaching past this function.
  const safeToAct = parsed.safe_to_act === true;

  return {
    usable: true,
    safeToAct,
    reason: safeToAct
      ? "ok"
      : `safe_to_act is ${JSON.stringify(parsed.safe_to_act)} — queue suppressed, cadence still read. ${parsed.safe_to_act_reason || "no reason given"}`,
    decision: parsed,
  };
}

/**
 * Caps on `hooks_that_work[]`. See sanitizeHooks for why they exist.
 */
export const MAX_HOOK_ENTRIES = 3;
export const MAX_HOOK_CHARS = 120;

/**
 * The hook-style ids that are ENGINE VOCABULARY rather than ordinary English.
 *
 * NOT all of HOOK_STYLE_IDS, and the omission is the point. `question` and
 * `stat` are words a legitimate finding uses about itself — the 2026-09-10 run
 * named "a binary choice question" as a winning shape, and banning the word
 * would have thrown away one of the three findings this wiring exists to carry.
 * The three snake_case ids and `pov` are jargon tokens that appear in prose
 * only when something is addressing the engine, so those are refused.
 *
 * The residual risk — a guidance line reading "ask a question" while the
 * variation engine picked `stat` — is handled in the prompt, not here: the
 * advisory block states that the style instruction above wins any conflict.
 */
export const ENGINE_STYLE_TOKENS = ["bold_claim", "story_open", "pattern_interrupt", "pov"];

/**
 * Bound `hooks_that_work[]` before anything downstream can read it.
 *
 * THIS IS THE ONLY EXTERNALLY-AUTHORED TEXT THAT REACHES THE CAPTION PROMPT.
 * Everything else interpolated at caption.js's fresh-caption prompt is either a
 * repo constant or the Claude-Vision read of the video's own overlays. This
 * field is written by a scheduled task OUTSIDE this repository (see the module
 * header), so it is bounded HERE — at the reader, where the schema contract
 * already lives — rather than at the prompt, where a second caller could skip
 * it.
 *
 * The rules, and the failure each one prevents:
 *
 *   - non-strings dropped, entries trimmed        a number or object would
 *                                                 render as "[object Object]"
 *   - newlines/controls collapsed to a space      a multi-line entry could
 *                                                 forge a new prompt section
 *   - backticks and braces stripped               they close the template
 *                                                 literal the block sits in
 *   - entries naming ENGINE VOCABULARY dropped     a guidance line that says
 *     entirely                                    "use a POV hook" would
 *                                                 silently compete with the
 *                                                 variation engine's tagged
 *                                                 pick and corrupt learn.js's
 *                                                 provenance
 *   - entries carrying the caption's own          "comment", "DM" and the
 *     control vocabulary dropped entirely         signature line are counted
 *                                                 by caption-validator.js; an
 *                                                 external string containing
 *                                                 one can fail every attempt
 *   - MAX_HOOK_CHARS per entry, MAX_HOOK_ENTRIES  a bounded, predictable
 *     entries                                     prompt suffix
 *
 * A dropped entry is dropped silently on purpose: this is advice, and advice
 * that fails the bounds is simply not taken. The COUNT that survives is tagged
 * onto the posted-log entry, so a systematically-empty list is visible there.
 */
export function sanitizeHooks(raw, { styleIds = ENGINE_STYLE_TOKENS } = {}) {
  if (!Array.isArray(raw)) return [];
  const banned = [...styleIds, "comment", "dm", "lifestyle design realty"];
  const out = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const flat = entry
      // Control characters and newlines become a single space. \p{C} covers
      // the format/unassigned classes too, so a zero-width joiner cannot hide
      // a banned word from the check below.
      .replace(/[\p{C}\s]+/gu, " ")
      .replace(/[`{}]/g, "")
      .trim();
    if (!flat) continue;
    const haystack = flat.toLowerCase();
    // Word-boundary match, so "recommend" does not trip on "comment" and a
    // hook mentioning "statistics" does not trip on the `stat` style id.
    if (banned.some((word) => new RegExp(`\\b${word}\\b`, "i").test(haystack))) continue;
    out.push(flat.length > MAX_HOOK_CHARS ? flat.slice(0, MAX_HOOK_CHARS).trimEnd() : flat);
    if (out.length >= MAX_HOOK_ENTRIES) break;
  }
  return out;
}

/**
 * Turn a validated decision into a plan the selector can apply.
 *
 * A post[] row with a null drive_file_id is NOT actionable. It is dropped and
 * named in `skipped` — never resolved by guessing at a filename, because the
 * library's filenames are 124 iPhone UUIDs out of 142 and a guess would land
 * on the wrong video silently.
 */
export function planFromDecision(decision, { safeToAct = true, modifiedTime = null } = {}) {
  // The suppression lives HERE, not at the call site, so no caller can obtain a
  // ranked queue from an unsafe file by constructing the plan itself.
  const post = safeToAct && Array.isArray(decision?.post) ? decision.post : [];
  const dontPost = safeToAct && Array.isArray(decision?.dont_post) ? decision.dont_post : [];

  const ranked = [];
  const skipped = [];
  for (const row of post) {
    const id = row?.drive_file_id;
    if (typeof id !== "string" || !id) {
      skipped.push({
        rank: row?.rank ?? null,
        source_file: row?.source_file ?? null,
        why: "null drive_file_id — not actionable",
      });
      continue;
    }
    ranked.push({
      driveFileId: id,
      rank: Number.isFinite(row?.rank) ? row.rank : ranked.length + 1,
      confidence: row?.confidence ?? null,
      reason: row?.reason ?? null,
    });
  }
  ranked.sort((a, b) => a.rank - b.rank);

  const exclude = new Set(
    dontPost.map((r) => (typeof r === "string" ? r : r?.drive_file_id)).filter((id) => typeof id === "string" && id)
  );

  return {
    // True when safe_to_act was false: the queue halves are empty BY DESIGN,
    // not because the file had nothing in them.
    queueSuppressed: !safeToAct,
    ranked,
    rankIndex: new Map(ranked.map((r, i) => [r.driveFileId, i])),
    exclude,
    skipped,
    // Read and surfaced; enforcement is a separate change. See the header.
    postsPerDay: Number.isFinite(decision?.how_many?.posts_per_day) ? decision.how_many.posts_per_day : null,
    postsPerDayRationale: decision?.how_many?.rationale ?? null,
    // NOT gated on safeToAct, and that is deliberate — the same reasoning the
    // header gives for how_many. The 2026-09-10 file's false flag is about a
    // missing publish manifest breaking post-to-source matching; the hook
    // analysis is over the caption text of 213 posts and nothing about the
    // missing manifest touches it. Bounded by sanitizeHooks because this is the
    // only externally-authored text that reaches an LLM prompt.
    hooks: sanitizeHooks(decision?.hooks_that_work),
    // RAW vs SURVIVING, kept separate on purpose. "The writer stopped emitting
    // hooks" and "our own bounds refused every one" are different faults with
    // different owners, and a single count cannot tell them apart. The first
    // live read (2026-09-10) reported zero hooks, and without this pair there
    // was no way to know whether the file was empty or whether sanitizeHooks
    // was eating a shape it did not expect — e.g. rows emitted as objects
    // rather than strings, which is how post[] is shaped in the same file.
    hooksRaw: Array.isArray(decision?.hooks_that_work) ? decision.hooks_that_work.length : 0,
    hooksShape: Array.isArray(decision?.hooks_that_work)
      ? [...new Set(decision.hooks_that_work.map((h) => (h === null ? "null" : Array.isArray(h) ? "array" : typeof h)))].sort().join("|") || "empty"
      : decision?.hooks_that_work === undefined ? "absent" : typeof decision.hooks_that_work,
    dataGaps: Array.isArray(decision?.data_gaps) ? decision.data_gaps : [],
    // The Drive modifiedTime the staleness gate already read, carried through
    // so the posted-log entry can record WHICH decision file shaped a caption.
    // Nothing in this repo currently proves the Drive read succeeds on a
    // runner; this is what buys that evidence.
    decisionFileAt: modifiedTime || null,
  };
}

/**
 * Apply a plan to the already-filtered candidate list.
 *
 * Reorders and removes. Never inserts — so a candidate excluded by the 30-day
 * rule cannot be reintroduced, whatever post[] names.
 *
 * IF THE EXCLUSIONS WOULD EMPTY THE POOL the original list is kept and a loud
 * warning is logged. The file is advice; advice that silences the channel for a
 * slot has overreached, and a bad or overzealous decision run must not be able
 * to take the account dark.
 */
export function applyDecision(candidates, plan) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (!plan) return { candidates: list, stats: { applied: false, reason: "no plan" } };

  const kept = list.filter((v) => !plan.exclude.has(v.id));
  const excluded = list.length - kept.length;

  if (kept.length === 0 && list.length > 0) {
    return {
      candidates: list,
      stats: { applied: false, excluded: 0, promoted: 0, reason: `dont_post[] would exclude all ${list.length} candidates — ignoring the exclusions` },
    };
  }

  // Stable: ranked candidates lead in rank order, everything else keeps the
  // rotation order it arrived in.
  const ranked = [];
  const rest = [];
  for (const v of kept) (plan.rankIndex.has(v.id) ? ranked : rest).push(v);
  ranked.sort((a, b) => plan.rankIndex.get(a.id) - plan.rankIndex.get(b.id));

  return {
    candidates: [...ranked, ...rest],
    stats: { applied: true, excluded, promoted: ranked.length, reason: `${ranked.length} ranked, ${excluded} excluded` },
  };
}

/**
 * Read and validate the decision file. Never throws.
 *
 * Every failure — absent, unreachable, malformed, stale, unknown schema,
 * safe_to_act false — returns { usable: false } with a reason. A posting run
 * must not die because an advisory file is missing or wrong.
 */
export async function loadDecision({ now = Date.now(), deps = {} } = {}) {
  const find = deps.findDecisionFile || findDecisionFile;
  const download = deps.downloadFileById || downloadFileById;
  try {
    const file = await find();
    if (!file) {
      return { usable: false, reason: `no ${DECISION_FILENAME} in Drive`, decision: null, plan: null };
    }
    const buf = await download(file.id);
    const result = parseDecision(buf.toString("utf-8"), { now, modifiedTime: file.modifiedTime });
    return {
      ...result,
      plan: result.usable
        ? planFromDecision(result.decision, { safeToAct: result.safeToAct, modifiedTime: file.modifiedTime })
        : null,
    };
  } catch (err) {
    return { usable: false, reason: `read failed: ${err.message?.slice(0, 120)}`, decision: null, plan: null };
  }
}
