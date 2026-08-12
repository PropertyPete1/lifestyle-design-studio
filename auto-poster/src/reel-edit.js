/**
 * reel-edit.js — the retention edit, pointed at one vertical video.
 *
 * THERE IS NO EDITING LOGIC IN THIS FILE. That is the point of it.
 *
 * The long-form pipeline already cuts dead air, hides the seam with a framing
 * change, and fades 15ms at every join — and it does so in a module that has
 * been argued with in tests over a dozen real failures: the silencedetect
 * output that went to stderr and read as "no pauses", the 20-second take that
 * trimmed down to 0.575 seconds with no warning, the zoom expression ffmpeg
 * accepted as a constant. Every one of those is a bug this feature would have
 * shipped again if it had its own copy.
 *
 * So this module composes yt-oncamera-edit.js and adds exactly three things a
 * reel needs that a long-form take does not:
 *
 *   1. A VERTICAL CANVAS and a plain fit — no blur-fill. The long-form
 *      treatment composes a vertical phone take into a 16:9 frame by putting a
 *      blurred copy of itself behind it. A vertical video going into a vertical
 *      frame needs none of that, and applying it would put a blurred border
 *      around footage that already fills the screen.
 *   2. A FASTER CADENCE. Peter asked for a framing change every two to three
 *      seconds; long-form runs at three. The interval is a parameter of
 *      buildEditList already, so this is a number rather than a fork.
 *   3. THE CONCAT. editOnCameraTake renders the pieces and stops, because the
 *      long-form assembler concatenates them alongside everything else. Nothing
 *      else is coming for a reel, so it is finished here.
 *
 * And one guarantee that is checked rather than assumed — see `speechSafe`.
 */

import { writeFileSync } from "fs";
import { join } from "path";

import {
  detectSilences,
  buildEditList,
  editOnCameraTake,
  MIN_SILENCE_SECONDS,
  KEEP_SILENCE_SECONDS,
  PIECE_DECLICK_SECONDS,
  MIN_RETAINED_SHARE,
  pieceExtension,
} from "./yt-oncamera-edit.js";
import { ffmpeg, mediaDuration, concatArgs } from "./yt-assemble.js";

/** A reel is 1080x1920. Stated here rather than read from the long-form canvas table. */
export const REEL_DIM = { w: 1080, h: 1920 };

export const REEL_FPS = 30;

/**
 * The framing changes every two to three seconds.
 *
 * `punchBounds` spreads the interval by 22% of itself, so 2.5 walks between
 * 1.95s and 3.05s — which is the "every 2-3 seconds" Peter asked for, arrived
 * at by the same walk the long-form cadence uses rather than by a second
 * mechanism. Long-form's 3.0 is untouched; this is an argument, not an edit.
 */
export const REEL_PUNCH_INTERVAL = 2.5;

/**
 * No blur-fill. A vertical source in a vertical frame is already full-bleed.
 *
 * `mode` is anything other than "blur-fill", which selects pieceArgs' plain
 * scale-and-pad branch. The remaining fields are read only by the blur-fill
 * branch and are present so the object is complete rather than partially
 * defined — a treatment with missing keys would produce `NaN` in a filter
 * string if the branch ever changed.
 */
export const REEL_TREATMENT = { mode: "fit", blur: 0, darken: 0, bgZoom: 1, vignette: 0 };

/** Re-exported so the card, the email and the tests all quote one set of numbers. */
export const EDIT_SPEC = {
  minSilenceSeconds: MIN_SILENCE_SECONDS,
  keepSilenceSeconds: KEEP_SILENCE_SECONDS,
  declickSeconds: PIECE_DECLICK_SECONDS,
  minRetainedShare: MIN_RETAINED_SHARE,
  punchInterval: REEL_PUNCH_INTERVAL,
};

// ─── the guarantee ──────────────────────────────────────────────────────────

/**
 * What the edit took out, as intervals of the ORIGINAL video.
 *
 * Derived from the pieces rather than from the silence list, because the
 * pieces are what actually gets rendered. Anything not covered by a piece is
 * gone from the finished video, whatever the plan intended.
 */
export function removedIntervals(pieces, totalSeconds) {
  const out = [];
  let cursor = 0;
  for (const p of pieces || []) {
    if (p.srcStart > cursor + 1e-6) out.push({ start: cursor, end: p.srcStart });
    cursor = Math.max(cursor, p.srcEnd);
  }
  if (totalSeconds > cursor + 1e-6) out.push({ start: cursor, end: totalSeconds });
  return out;
}

/**
 * NEVER MID-WORD, checked rather than promised.
 *
 * The claim the whole edit rests on is that it only ever removes silence. It
 * follows from how buildEditList works — spans are cut at
 * `silence.start + keep` and `silence.end - keep`, both strictly inside a
 * detected silence — but "it follows from" is how the 0.575-second take
 * shipped, and a property that matters this much is worth a function that
 * answers it about the actual output.
 *
 * So every interval the pieces do not cover is checked for containment in a
 * silence ffmpeg reported. A removal that is not inside one is a removal that
 * ate audio, and the caller fails the edit rather than uploading a video that
 * clips his words.
 *
 * NOTE the punch-in cuts are invisible here on purpose: a framing change splits
 * one span into two pieces that share a boundary exactly, so it removes an
 * interval of length zero and cannot clip anything. That is what makes it safe
 * to cut mid-sentence for cadence and never mid-word for dead air.
 *
 * `tolerance` absorbs the millisecond rounding buildEditList applies. It is far
 * below a syllable, so it cannot hide a clipped word.
 */
export function speechSafe(pieces, silences, totalSeconds, { tolerance = 0.02 } = {}) {
  const violations = [];
  for (const gap of removedIntervals(pieces, totalSeconds)) {
    if (gap.end - gap.start <= tolerance) continue;
    const covered = (silences || []).some((s) => gap.start >= s.start - tolerance && gap.end <= s.end + tolerance);
    if (!covered) {
      violations.push({
        start: round(gap.start),
        end: round(gap.end),
        why: "this stretch was removed but ffmpeg never reported it as silence — it may contain speech",
      });
    }
  }
  return { safe: violations.length === 0, violations };
}

// ─── the edit ───────────────────────────────────────────────────────────────

/**
 * Plan the edit for one reel without rendering anything.
 *
 * Split from the render so the plan can be argued with in a test, and so the
 * caller can refuse a bad plan before spending a render on it. Returns the
 * long-form edit report plus the silences it was built from and the safety
 * verdict.
 */
export function planReelEdit(inputPath, { interval = REEL_PUNCH_INTERVAL, duration = null } = {}) {
  const total = duration ?? mediaDuration(inputPath);
  if (!(total > 0)) throw new Error(`could not read a duration from ${inputPath} — the file is unreadable or not a video`);

  const silences = detectSilences(inputPath, { duration: total });
  const plan = buildEditList(total, silences, {
    // A reel has no "opening take" in the long-form sense: the hook treatment
    // is applied per variant, downstream, so the master gets the ordinary
    // punch-in cadence from its first frame.
    isOpening: false,
    punchIns: true,
    interval,
    // No narration budget exists for a video nobody scripted. The share guard
    // (MIN_RETAINED_SHARE) is what protects a dead-mic recording here, and it
    // needs no caller input — which is exactly why it was added.
    minKeep: 0,
  });

  const safety = speechSafe(plan.pieces, silences, total);
  return { ...plan, silences, silenceCount: silences.length, safety };
}

/**
 * Cut one reel: plan, render every piece, concatenate.
 *
 * The piece rendering is `editOnCameraTake` — the long-form function, called
 * with the reel's canvas, cadence and treatment. Nothing about the cut,
 * the framing walk or the declick is re-implemented here.
 *
 * Throws when the plan is not speech-safe. That is the one condition worth
 * refusing on rather than warning about: every other degradation (a take too
 * quiet to find pauses in, a video with no silence at all) produces a longer
 * video than intended, and this one produces a video missing words.
 */
export function renderReelEdit(inputPath, outputDir, {
  interval = REEL_PUNCH_INTERVAL,
  dim = REEL_DIM,
  fps = REEL_FPS,
  duration = null,
  runFfmpeg = ffmpeg,
} = {}) {
  const plan = planReelEdit(inputPath, { interval, duration });
  if (!plan.safety.safe) {
    throw new Error(
      `the edit would remove ${plan.safety.violations.length} stretch(es) ffmpeg did not report as silence — ` +
        `refusing to render a video that may be missing words. First: ` +
        `${plan.safety.violations[0].start}s-${plan.safety.violations[0].end}s`
    );
  }

  // THE PLAN THAT WAS CHECKED IS THE PLAN THAT RENDERS. `silences` and
  // `duration` are handed over rather than re-detected, so the edit list built
  // inside editOnCameraTake is built from byte-identical inputs to the one
  // `speechSafe` just cleared. Letting it detect again would mean the safety
  // check ran against a different plan than the renderer used — and the two
  // genuinely differ, because a bare detectSilences drops a trailing silence
  // that never terminates while a duration-aware one keeps it.
  const report = editOnCameraTake(inputPath, outputDir, {
    dim,
    index: 0,
    isOpening: false,
    minKeep: 0,
    fps,
    interval,
    treatment: REEL_TREATMENT,
    silences: plan.silences,
    duration: plan.originalSeconds,
    ffmpeg: runFfmpeg,
    writeFileSync,
    join,
    mediaDuration,
  });

  if (report.files.length === 0) {
    throw new Error("the edit produced no pieces — nothing to concatenate");
  }

  const listFile = join(outputDir, "reel-concat.txt");
  writeFileSync(listFile, report.files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n") + "\n");
  const outputPath = join(outputDir, "reel-master.mp4");
  // ONE AAC ENCODE FOR THE WHOLE REEL, not one per piece. The pieces carry PCM
  // (see PIECE_AUDIO in yt-oncamera-edit.js) precisely so this join is
  // sample-exact: an AAC encode per piece prepends a 21.3 ms priming frame to
  // each one, the concat demuxer stacks them, and the audio walks behind the
  // picture at 29.3 ms per cut. A reel is short enough that a handful of cuts
  // is only a tenth of a second — but it is the same editor as the long-form
  // path by design, and half a fix would be exactly the drift that sharing it
  // was supposed to prevent.
  const jointed = join(outputDir, `reel-joined.${pieceExtension()}`);
  runFfmpeg(concatArgs(listFile, jointed));
  runFfmpeg(["-y", "-i", jointed, "-c:v", "copy",
             "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", outputPath]);

  return {
    outputPath,
    pieces: report.pieces,
    silences: plan.silences,
    silenceCount: plan.silenceCount,
    originalSeconds: report.originalSeconds,
    editedSeconds: report.editedSeconds,
    removedSeconds: report.removedSeconds,
    warnings: report.warnings,
    cadence: report.cadence,
    safety: plan.safety,
  };
}

/**
 * Where a cold open could start, in EDITED time.
 *
 * A variant that opens later has to open ON A CUT, or it starts mid-syllable —
 * which is the one thing a hook treatment cannot survive. The pieces already
 * carry every legal cut, so the candidates are their cumulative boundaries.
 *
 * Bounded above by `maxSeconds` because a cold open is a different first three
 * seconds, not a different video: skipping twelve seconds in would be a re-cut,
 * and Peter asked for a hook variation.
 */
export function coldOpenPoints(pieces, { maxSeconds = 3.5, minSeconds = 0.4 } = {}) {
  const points = [];
  let elapsed = 0;
  for (const p of pieces || []) {
    elapsed = round(elapsed + (p.seconds ?? p.srcEnd - p.srcStart));
    if (elapsed > maxSeconds) break;
    if (elapsed >= minSeconds) points.push(elapsed);
  }
  return points;
}

/** A human sentence about what the edit did, for the card and the email. */
export function describeEdit(result) {
  const pct = result.originalSeconds > 0 ? Math.round((result.removedSeconds / result.originalSeconds) * 100) : 0;
  return (
    `${fmt(result.originalSeconds)}s in, ${fmt(result.editedSeconds)}s out — ` +
    `${fmt(result.removedSeconds)}s of dead air removed (${pct}%), ` +
    `${result.silenceCount} pause(s) found, ${result.pieces.length} piece(s), ` +
    `framing change every ~${REEL_PUNCH_INTERVAL}s`
  );
}

function fmt(n) {
  return (Math.round(n * 10) / 10).toFixed(1);
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}
