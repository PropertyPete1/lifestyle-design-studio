/**
 * yt-retention-stage.js — the stage that attaches the retention edit to a plan.
 *
 * WHY THIS FILE EXISTS, bluntly: the retention systems were built, tested and
 * pixel-proved — and wired into assembler branches nothing fed. `seg.editPlan`
 * and `seg.pip` were consumed by yt-assemble.js and produced by NOTHING. Every
 * on-camera take fell to the unedited fallback, every voiceover played without
 * its bubble, and the whole feature set would have shipped as a silent no-op:
 * all machinery green, zero effect on the video. Same class as the thumbnail
 * that no stage generated, found the same day.
 *
 * IT IS ONE SHARED MODULE, NOT TWO WIRINGS, because the dry run exists to
 * predict the build. The dry-run chassis had already drifted from the pipeline
 * once (no visuals, no opening, no edit stages) — two copies of this stage
 * would drift the same way. Both callers run this exact function.
 *
 * WHAT IT DOES, in order, mutating the plan's segments in place:
 *   1. Every on-camera take gets its edit list: silences detected and cut,
 *      punch-in framing alternating at every seam, the opening take pushed.
 *      `seg.seconds` is updated to the EDITED length — chapters and caption
 *      timing are computed from seg.seconds downstream, and captions timed
 *      against the un-edited length would drift for twelve minutes.
 *   2. Voiceover takes Peter narrated get the floating head: segmentation,
 *      the matte quality gate, corner placement. A rejected matte is a
 *      reported fallback, never a bad bubble.
 *   3. The cadence audit runs over the finished plan and the report carries
 *      every violation with its remedy.
 */

import { join } from "path";
import { mkdirSync, existsSync } from "fs";
import { detectSilences, buildEditList } from "./yt-oncamera-edit.js";
import { findEmphasisWords } from "./yt-reveal-timing.js";
import { planPip, segmentTake, pipPlacement, segmentationAvailable } from "./yt-pip.js";
import { auditCadence } from "./yt-cadence.js";
import { mediaDuration } from "./yt-assemble.js";
import { JUMP_CUTS_ENABLED, PUNCH_INS_ENABLED, PIP_ENABLED } from "./yt-config.js";

/**
 * @param {object} plan     from planTimeline (segments are mutated)
 * @param {object} opts
 * @param {string} opts.workDir   where cutouts land
 * @param {object} opts.dim       canvas, e.g. { w: 1920, h: 1080 }
 * @param {object} [opts.flags]   overrides for the three config flags (tests)
 * @returns {{ edit, pip, cadence }} the per-video report Peter reads
 */
/**
 * Work out which words in each on-camera take deserve a zoom pulse.
 *
 * SEPARATE FROM applyRetentionStage, AND ASYNC, ON PURPOSE. Word timing means
 * running Whisper over the take's audio, which is I/O; the retention stage is
 * synchronous, pure apart from ffmpeg, and is tested by arguing with its edit
 * lists rather than by transcribing anything. Making it async to fetch this
 * would have spread `await` through every caller and every test for one input.
 *
 * So the timing is fetched here, once, and left on the segments as `emphasis`.
 * applyRetentionStage stays a function you can reason about.
 *
 * A take with no timing gets an empty list, which means the punch cadence still
 * runs and only the pulses are missing — the degradation is the feature being
 * absent, never the edit being wrong.
 */
export async function attachEmphasis(plan, { getWordTimestamps, existsSync: exists = existsSync } = {}) {
  let withTiming = 0;
  let without = 0;

  for (const seg of plan.segments || []) {
    if (seg.kind !== "on_camera") continue;
    const audio = seg.source;
    if (!audio || !exists(audio) || typeof getWordTimestamps !== "function") {
      seg.emphasis = [];
      without++;
      continue;
    }
    try {
      const words = await getWordTimestamps(audio);
      seg.emphasis = Array.isArray(words) && words.length ? findEmphasisWords(words) : [];
      if (seg.emphasis.length) withTiming++;
      else without++;
    } catch (err) {
      console.warn(`[Retention] no word timing for ${seg.takeId}: ${err.message} — no zoom pulses on this take`);
      seg.emphasis = [];
      without++;
    }
  }

  console.log(`[Retention] emphasis words found on ${withTiming} on-camera take(s); ${without} take(s) get cadence only`);
  return { withTiming, without };
}

export function applyRetentionStage(plan, { workDir, dim, flags = {} } = {}) {
  // The cutouts land here, and ffmpeg does NOT create parent directories — it
  // exits instantly and the segmenter reports a broken pipe. That is exactly
  // how the first full-chain run failed: the dry run passed a subdirectory
  // nothing had created, and the real error was invisible behind it.
  mkdirSync(workDir, { recursive: true });

  const jumpCuts = flags.jumpCuts ?? JUMP_CUTS_ENABLED;
  const punchIns = flags.punchIns ?? PUNCH_INS_ENABLED;
  const pipEnabled = flags.pip ?? PIP_ENABLED;

  // ── 1. the on-camera edit ─────────────────────────────────────────────────
  const edit = { takes: [], totalRemovedSeconds: 0, enabled: { jumpCuts, punchIns } };
  if (jumpCuts || punchIns) {
    let onCamIndex = 0;
    plan.segments.forEach((seg, i) => {
      if (seg.kind !== "on_camera" || !seg.source) return;

      const duration = mediaDuration(seg.source) || seg.seconds || 0;
      let silences = [];
      if (jumpCuts) {
        try {
          silences = detectSilences(seg.source, { duration });
        } catch (err) {
          // Detection failing is a reported degradation, not a dead build —
          // the take plays uncut, which is exactly what shipped last month.
          console.log(`::warning::${seg.takeId}: silence detection failed (${err.message}) — take plays uncut`);
        }
      }

      const listPlan = buildEditList(duration, silences, {
        isOpening: i === 0,
        // Cutting silence out of an on-camera take never cuts words — the
        // audio and picture move together — so there is no narration budget.
        // The bad-recording share guard inside buildEditList still applies.
        minKeep: 0,
        seed: onCamIndex++,
        punchIns,
        // THE PULSES. Built and proven, and for one revision not connected to
        // anything: the mechanism assigned pulses correctly whenever it was
        // handed emphasis words, and nothing ever handed it any, so revision 4
        // shipped with the opening beat as its only pulse. attachEmphasis fills
        // this in before we get here.
        emphasis: seg.emphasis || [],
      });

      seg.editPlan = listPlan;
      // The cadence audit reads editPieces; the assembler reads editPlan.
      // Alias rather than making one of them wrong.
      seg.editPieces = listPlan.pieces;
      if (listPlan.editedSeconds > 0 && Math.abs(listPlan.editedSeconds - seg.seconds) > 0.01) {
        seg.seconds = listPlan.editedSeconds;
      }

      edit.pulsesAssigned = (edit.pulsesAssigned || 0) + (listPlan.cadence?.pulsesAssigned || 0);
      edit.pulsesDropped = (edit.pulsesDropped || 0) + (listPlan.cadence?.pulsesDropped?.length || 0);
      edit.takes.push({
        takeId: seg.takeId,
        pulsesAssigned: listPlan.cadence?.pulsesAssigned || 0,
        originalSeconds: listPlan.originalSeconds,
        editedSeconds: listPlan.editedSeconds,
        removedSeconds: listPlan.removedSeconds,
        pieces: listPlan.pieces.length,
        isOpening: i === 0,
        warnings: listPlan.warnings,
      });
      edit.totalRemovedSeconds += listPlan.removedSeconds;
      for (const w of listPlan.warnings) console.log(`::warning::${seg.takeId}: ${w}`);
    });
    edit.totalRemovedSeconds = Math.round(edit.totalRemovedSeconds * 100) / 100;
  }

  // ── 2. the floating head ─────────────────────────────────────────────────
  const pip = { applied: [], rejected: [], skipped: [], enabled: pipEnabled };
  if (pipEnabled) {
    const avail = segmentationAvailable();
    if (!avail.ok) {
      pip.unavailable = avail.reason;
      console.log(`::warning::PIP unavailable — ${avail.reason}. Visuals play full-screen.`);
    } else {
      const { plan: pipPlan, skipped } = planPip(plan.segments, { enabled: true });
      pip.skipped = skipped;
      for (const p of pipPlan) {
        const seg = plan.segments.find((s) => s.takeId === p.takeId);
        if (!seg) continue;
        const cutout = join(workDir, `cutout-${p.takeId}.mov`);
        const result = segmentTake(p.source, cutout);
        if (!result.ok) {
          pip.rejected.push({ takeId: p.takeId, reason: result.reason, byGate: Boolean(result.rejectedByGate) });
          console.log(`::warning::PIP rejected for ${p.takeId} — ${result.reason}`);
          continue;
        }
        seg.pip = { cutoutPath: cutout, placement: pipPlacement(dim, { index: p.index }), metrics: result.metrics };
        pip.applied.push({ takeId: p.takeId, corner: seg.pip.placement.corner });
      }
    }
  }

  // ── 3. the cadence audit ──────────────────────────────────────────────────
  const cadence = auditCadence(plan.segments);
  for (const v of cadence.violations) {
    console.log(`::warning::cadence: ${v.kind} holds the screen ${v.seconds}s at ${v.at}s (take ${v.takeId}) — ${v.remedy}`);
  }

  return { edit, pip, cadence };
}

/** One block for the build summary — what Peter reads instead of scrubbing. */
export function renderRetentionSummary({ edit, pip, cadence }) {
  const lines = [];
  const edited = edit.takes.filter((t) => t.pieces > 1 || t.removedSeconds > 0);
  lines.push(
    `Retention edit: ${edited.length} of ${edit.takes.length} on-camera take(s) edited, ` +
      `${edit.totalRemovedSeconds}s of dead air removed` +
      `${edit.enabled.jumpCuts ? "" : " (jump cuts OFF)"}${edit.enabled.punchIns ? "" : " (punch-ins OFF)"}`
  );
  for (const t of edit.takes) {
    lines.push(`  ${t.takeId}: ${t.originalSeconds}s -> ${t.editedSeconds}s, ${t.pieces} piece(s)${t.isOpening ? ", opening push" : ""}`);
  }
  if (!pip.enabled) lines.push("PIP: disabled for this video");
  else if (pip.unavailable) lines.push(`PIP: unavailable — ${pip.unavailable}`);
  else {
    lines.push(`PIP: ${pip.applied.length} segment(s) with the bubble, ${pip.rejected.length} rejected by the matte gate, ${pip.skipped.length} skipped`);
    for (const r of pip.rejected) lines.push(`  rejected ${r.takeId}: ${r.reason}`);
  }
  lines.push(
    cadence.ok
      ? `Cadence: clean — longest state ${cadence.stats.longestStateSeconds}s across ${cadence.stats.stateCount} states`
      : `Cadence: ${cadence.violations.length} violation(s) — see warnings`
  );
  return lines.join("\n");
}
