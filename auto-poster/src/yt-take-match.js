/**
 * yt-take-match.js — matching Peter's phone recordings to the script's takes.
 *
 * This is the step that replaced HeyGen, and it fails in a completely different
 * way. Avatar generation failed loudly, in an API call. Human recording fails
 * quietly: a take gets skipped, or recorded twice, or ad-libbed into something
 * that no longer reads like the script, or recorded in whatever order made
 * sense while walking around a neighbourhood.
 *
 * So the matcher assumes nothing about order, tolerates extra words, expects
 * retakes, and — the important part — REPORTS what it could not match instead
 * of guessing. A wrong guess here puts the wrong words on the timeline and the
 * first person to notice is a viewer.
 *
 * WHY LCS RATHER THAN WORD OVERLAP
 * Bag-of-words similarity is dominated by "the", "you", "that", "is" — every
 * take shares those with every other take, so a bag-of-words score cannot
 * separate a real match from a coincidence. Longest common SUBSEQUENCE is
 * order-sensitive: matching filler words only helps if they appear in the same
 * order, which is exactly what reading the same sentence produces and what two
 * unrelated takes do not.
 *
 * Recall (how much of the take the clip covers) is scored separately from
 * precision (how much of the clip is the take), because they fail differently:
 *   - low recall  = he did not say most of this take. Not a match.
 *   - low precision, high recall = he said the take plus a lot else — an ad-lib,
 *     or one clip covering several takes. Still a match for this take.
 * Requiring both to be high would reject exactly the ad-libs the spec says to
 * tolerate.
 */

/**
 * How much of the take must appear, in order, in the clip.
 * Set from how Whisper behaves: a correct read lands well above 0.7 even with
 * transcription errors, and an unrelated take rarely clears 0.35.
 */
export const MIN_RECALL = 0.55;

/** Guards against a clip matching everything because it is enormous. */
export const MIN_F1 = 0.35;

/** Below this the match is reported for review rather than used silently. */
export const CONFIDENT_RECALL = 0.75;

/**
 * Words to tokens: lowercase, strip punctuation, keep order.
 *
 * Numbers are normalised to a marker rather than dropped. Whisper writes "four
 * thirty-nine" or "$439,000" unpredictably for the same spoken words, so
 * comparing the digits themselves creates false mismatches on exactly the takes
 * that talk about money — which is most of them.
 */
export function normalizeTokens(text) {
  if (typeof text !== "string") return [];
  return text
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => (/^\d+$/.test(t) ? "#num" : t));
}

/** Length of the longest common subsequence. Two-row DP — O(n*m) time, O(m) space. */
export function lcsLength(a, b) {
  if (!a.length || !b.length) return 0;
  let prev = new Uint32Array(b.length + 1);
  let cur = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    const ai = a[i - 1];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = ai === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    [prev, cur] = [cur, prev];
    cur.fill(0);
  }
  return prev[b.length];
}

/** How well one clip transcript covers one take's text. */
export function similarity(takeText, clipText) {
  const a = normalizeTokens(takeText);
  const b = normalizeTokens(clipText);
  if (!a.length || !b.length) return { lcs: 0, recall: 0, precision: 0, f1: 0 };
  const lcs = lcsLength(a, b);
  const recall = lcs / a.length;
  const precision = lcs / b.length;
  const f1 = recall + precision > 0 ? (2 * recall * precision) / (recall + precision) : 0;
  return { lcs, recall, precision, f1 };
}

/**
 * Assign clips to takes.
 *
 * Two-stage, and the order matters:
 *
 *   1. Every clip picks the take it matches BEST. A clip belongs to one take,
 *      so a good recording cannot be stolen by a take it merely resembles.
 *   2. Each take then takes the LAST-RECORDED of the clips that chose it.
 *      That is retake semantics: when Peter records a line three times, the
 *      third one is the keeper, and picking by score instead would sometimes
 *      keep the fluffed first attempt because it happened to match the written
 *      words more literally.
 *
 * @param {Array} takes  [{ id, text, mode, ... }]
 * @param {Array} clips  [{ id, name, transcript, recordedAt }]
 * @returns {{
 *   matches: Array,        one per matched take, superseded retakes listed
 *   missingTakes: Array,   takes nothing was recorded for — Peter must reshoot
 *   strayClips: Array,     clips that matched no take — misfires, or a take that drifted too far
 *   lowConfidence: Array,  matched but worth a human look
 *   complete: boolean
 * }}
 */
export function matchTakesToClips(takes, clips, { minRecall = MIN_RECALL, minF1 = MIN_F1 } = {}) {
  const takeList = (takes || []).filter((t) => t && typeof t.text === "string" && t.text.trim());
  const clipList = (clips || []).filter((c) => c && typeof c.transcript === "string" && c.transcript.trim());

  // Stage 1 — each clip picks its best take.
  const claimsByTake = new Map();
  const strayClips = [];

  for (const clip of clipList) {
    let best = null;
    for (const take of takeList) {
      const score = similarity(take.text, clip.transcript);
      if (score.recall < minRecall || score.f1 < minF1) continue;
      if (!best || score.f1 > best.score.f1) best = { take, score };
    }
    if (!best) {
      strayClips.push({
        clipId: clip.id,
        name: clip.name,
        recordedAt: clip.recordedAt || null,
        // The closest thing it resembled, so a human can see whether this was a
        // misfire or a take that drifted past the threshold.
        closest: closestTake(takeList, clip),
      });
      continue;
    }
    if (!claimsByTake.has(best.take.id)) claimsByTake.set(best.take.id, []);
    claimsByTake.get(best.take.id).push({ clip, score: best.score });
  }

  // Stage 2 — each take keeps the last-recorded claim.
  const matches = [];
  const missingTakes = [];
  const lowConfidence = [];

  for (const take of takeList) {
    const claims = claimsByTake.get(take.id) || [];
    if (claims.length === 0) {
      // An OPTIONAL take that nobody recorded is not missing — it is absent,
      // which its consumers handle with a fallback (the thumbnail generator
      // harvests a frame from the on-camera takes). Listing it in
      // missingTakes would hold the whole build hostage to a ten-second
      // nice-to-have, and would retroactively block every kit shot before
      // the take existed.
      if (!take.optional) {
        missingTakes.push({ takeId: take.id, mode: take.mode, section: take.section, text: take.text });
      }
      continue;
    }
    const ordered = [...claims].sort(byRecordedAtThenScore);
    const keeper = ordered[0];
    const match = {
      takeId: take.id,
      mode: take.mode,
      section: take.section,
      clipId: keeper.clip.id,
      clipName: keeper.clip.name,
      recordedAt: keeper.clip.recordedAt || null,
      recall: round(keeper.score.recall),
      precision: round(keeper.score.precision),
      f1: round(keeper.score.f1),
      supersededClipIds: ordered.slice(1).map((c) => c.clip.id),
    };
    matches.push(match);
    if (keeper.score.recall < CONFIDENT_RECALL) lowConfidence.push(match);
  }

  return {
    matches,
    missingTakes,
    strayClips,
    lowConfidence,
    complete: missingTakes.length === 0,
  };
}

/** Latest recording first; equal timestamps fall back to the better score. */
function byRecordedAtThenScore(a, b) {
  const at = String(a.clip.recordedAt || "");
  const bt = String(b.clip.recordedAt || "");
  if (at !== bt) return bt.localeCompare(at);
  return b.score.f1 - a.score.f1;
}

function closestTake(takeList, clip) {
  let best = null;
  for (const take of takeList) {
    const score = similarity(take.text, clip.transcript);
    if (!best || score.f1 > best.f1) best = { takeId: take.id, ...score };
  }
  return best ? { takeId: best.takeId, recall: round(best.recall), f1: round(best.f1) } : null;
}

function round(n) {
  return Math.round(n * 100) / 100;
}

/**
 * A human-readable account of what is missing, for the dashboard and the email.
 *
 * Written to be actionable rather than complete: Peter needs to know what to
 * re-record, not to read a similarity report.
 */
export function describeMatchResult(result, { requestId = "" } = {}) {
  const lines = [];
  if (result.complete) {
    lines.push(`All ${result.matches.length} takes matched.`);
  } else {
    lines.push(`${result.matches.length} takes matched, ${result.missingTakes.length} still needed.`);
    lines.push("");
    lines.push("STILL NEEDED — record these and upload them to the same folder:");
    for (const m of result.missingTakes) {
      lines.push(`  [${m.takeId}] ${m.mode} — ${m.section || ""}`);
      lines.push(`      "${truncate(m.text, 120)}"`);
    }
  }

  const retakes = result.matches.filter((m) => m.supersededClipIds.length > 0);
  if (retakes.length) {
    lines.push("");
    lines.push(`Used the latest recording for ${retakes.length} take(s) that were shot more than once.`);
  }

  if (result.lowConfidence.length) {
    lines.push("");
    lines.push("MATCHED BUT WORTH A LOOK — these drifted from the script:");
    for (const m of result.lowConfidence) {
      lines.push(`  [${m.takeId}] ${m.clipName} (${Math.round(m.recall * 100)}% of the written words)`);
    }
  }

  if (result.strayClips.length) {
    lines.push("");
    lines.push("UNUSED CLIPS — nothing in the script matched these:");
    for (const c of result.strayClips) {
      const near = c.closest ? ` (closest: ${c.closest.takeId} at ${Math.round(c.closest.recall * 100)}%)` : "";
      lines.push(`  ${c.name}${near}`);
    }
  }

  if (requestId) {
    lines.push("");
    lines.push(`Request: ${requestId}`);
  }
  return lines.join("\n");
}

function truncate(s, n) {
  const t = String(s || "");
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
