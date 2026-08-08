/**
 * yt-pip.js — keeping Peter on screen while the visuals play.
 *
 * Today he is visible for the on-camera takes and absent for everything else,
 * which on a twelve-minute explainer is most of it. A cutout of him in the
 * corner over the maps and footage keeps a person in the frame.
 *
 * THIS FEATURE REFUSES ITSELF MORE OFTEN THAN IT RUNS, BY DESIGN.
 * A floating head with ragged hair, a hole through the shirt, or a rectangle of
 * background around it is worse than no floating head — it is the one element
 * on screen that says "made by a script". So every cutout is scored and the PIP
 * is dropped unless the matte is clean. Falling back costs nothing: the visual
 * plays full-screen exactly as it would have.
 *
 * WHERE IT CAN APPEAR
 * Only over a voiceover segment whose narration PETER RECORDED. If the cloned
 * voice is speaking there is no footage of him saying those words, and putting
 * an unrelated clip of his face over it would be lip-sync that does not match.
 * That is a real constraint on how often this fires — see NARRATION_MODE in
 * yt-config.js, whose default is the clone.
 */

import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Where the vendored model lands. Fetched by scripts/fetch-segmentation-model.sh. */
export const MODEL_PATH = process.env.YT_SEGMENTATION_MODEL || join(HERE, "..", "assets", "models", "selfie_segmenter.tflite");

/** The python that has mediapipe. A venv on the runner; overridable locally. */
export const PYTHON = process.env.YT_SEGMENTATION_PYTHON || "python3";

export const SEGMENT_SCRIPT = join(HERE, "..", "scripts", "segment-take.py");

/** Bubble height as a share of frame height. */
export const PIP_HEIGHT_MIN = 0.22;
export const PIP_HEIGHT_MAX = 0.28;
export const PIP_HEIGHT = 0.25;

/** Distance from the frame edge, as a share of frame width. */
export const PIP_INSET = 0.04;

/**
 * How far up from the bottom the burned captions reach.
 *
 * yt-assemble.js sets the caption MarginV to 8% of frame height and the font to
 * 5.5%, so a two-line caption occupies roughly the bottom 20%. A bubble sitting
 * in that band collides with the words. This is the number that keeps them
 * apart, and it is derived from those constants rather than guessed — if the
 * caption style changes, this has to change with it.
 */
export const CAPTION_SAFE_BOTTOM = 0.21;

// ─── the quality gate ───────────────────────────────────────────────────────

/**
 * A person should occupy a plausible share of the frame.
 *
 * Below the floor the model found a hand or nothing; above the ceiling it
 * decided the wall was a person, which is what a blown-out background does.
 */
export const MIN_COVERAGE = 0.06;
export const MAX_COVERAGE = 0.72;

/** Holes through the silhouette — a shirt lost against the wall. */
export const MAX_HOLE_RATIO = 0.06;

/** Boundary raggedness, normalised. Hair failing shows up here first. */
export const MAX_EDGE_ROUGHNESS = 0.55;

/**
 * Decide whether a matte is good enough to put on screen.
 *
 * Returns reasons rather than a boolean, because "PIP was skipped" is not a
 * useful thing to read in a build summary and "PIP was skipped: the mask
 * covered 3% of the frame" is.
 */
export function gateCutout(metrics) {
  const reasons = [];
  if (!metrics || typeof metrics !== "object") return { ok: false, reasons: ["no metrics were produced"] };

  const { coverage, holeRatio, edgeRoughness, frames } = metrics;
  if (!Number.isFinite(coverage)) return { ok: false, reasons: ["metrics were unreadable"] };
  if (!frames) reasons.push("no frames were segmented");

  if (coverage < MIN_COVERAGE) reasons.push(`the cutout covers ${pct(coverage)} of the frame — too little to be a person`);
  if (coverage > MAX_COVERAGE) reasons.push(`the cutout covers ${pct(coverage)} of the frame — the background was probably included`);
  if (holeRatio > MAX_HOLE_RATIO) reasons.push(`the silhouette is ${pct(holeRatio)} holes`);
  if (edgeRoughness > MAX_EDGE_ROUGHNESS) reasons.push(`the edges are ragged (roughness ${edgeRoughness.toFixed(2)})`);

  return { ok: reasons.length === 0, reasons };
}

function pct(n) {
  return `${Math.round((Number(n) || 0) * 100)}%`;
}

// ─── placement ──────────────────────────────────────────────────────────────

/**
 * Where the bubble sits, and what it must not overlap.
 *
 * Corners alternate across segments so the eye is not parked in one place for
 * twelve minutes — that alternation is itself one of the pattern interrupts the
 * cadence audit counts.
 *
 * The vertical position is clamped ABOVE the caption band. A bubble that
 * overlaps burned captions makes both unreadable, and captions win because they
 * carry the words.
 */
export function pipPlacement(dim, { index = 0, heightShare = PIP_HEIGHT, captionSafe = CAPTION_SAFE_BOTTOM } = {}) {
  const share = Math.min(PIP_HEIGHT_MAX, Math.max(PIP_HEIGHT_MIN, heightShare));
  const h = Math.round(dim.h * share);
  // The cutout keeps the take's aspect ratio; 16:9 source gives a wide bubble,
  // which is why width is derived rather than assumed square.
  const w = Math.round((h * 16) / 9);

  const inset = Math.round(dim.w * PIP_INSET);
  const bottomLimit = Math.round(dim.h * (1 - captionSafe));
  const y = Math.max(inset, bottomLimit - h);

  const corner = index % 2 === 0 ? "right" : "left";
  const x = corner === "right" ? dim.w - w - inset : inset;

  return { x, y, w, h, corner, collidesWithCaptions: y + h > bottomLimit };
}

/**
 * ffmpeg arguments to composite the cutout over a visual.
 *
 * The shadow is a blurred black copy of the alpha drawn underneath and offset —
 * cheaper than a real drop shadow filter and indistinguishable at this size. It
 * matters more than it sounds: without it the cutout sits ON the picture rather
 * than IN it, which is the difference between a floating head and a sticker.
 */
export function pipCompositeArgs(visualIn, cutoutIn, output, placement, { seconds = null, fps = 30 } = {}) {
  const { x, y, w, h } = placement;
  const shadowDx = Math.round(w * 0.012);
  const shadowDy = Math.round(h * 0.018);

  const filter =
    `[1:v]scale=${w}:${h}[cut];` +
    `[cut]split=2[cut1][cut2];` +
    // The shadow: take the alpha, blacken the colour, blur, and lay it first.
    `[cut1]format=rgba,colorchannelmixer=rr=0:gg=0:bb=0,boxblur=luma_radius=8:luma_power=1:alpha_radius=8[shadow];` +
    `[0:v][shadow]overlay=${x + shadowDx}:${y + shadowDy}:format=auto[withshadow];` +
    `[withshadow][cut2]overlay=${x}:${y}:format=auto[v]`;

  const args = ["-y", "-i", visualIn, "-i", cutoutIn, "-filter_complex", filter, "-map", "[v]", "-map", "0:a?"];
  if (seconds) args.push("-t", String(seconds));
  args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "copy", output);
  return args;
}

// ─── running the segmenter ──────────────────────────────────────────────────

/** Is the segmentation stack actually present? Checked before anything promises a PIP. */
export function segmentationAvailable() {
  if (!existsSync(MODEL_PATH)) return { ok: false, reason: `model not found at ${MODEL_PATH}` };
  if (!existsSync(SEGMENT_SCRIPT)) return { ok: false, reason: `segment script not found at ${SEGMENT_SCRIPT}` };
  const probe = spawnSync(PYTHON, ["-c", "import mediapipe, cv2"], { encoding: "utf-8", timeout: 120_000 });
  if (probe.status !== 0) return { ok: false, reason: `python cannot import mediapipe/cv2 (${PYTHON})` };
  return { ok: true };
}

/**
 * Segment one take, returning the cutout path and its quality metrics.
 *
 * Never throws: a missing dependency, a crashed model or an unreadable take all
 * resolve to `{ ok: false, reason }`, because every one of them has the same
 * correct response — play the visual without a bubble over it.
 */
export function segmentTake(input, output, { python = PYTHON, model = MODEL_PATH, timeoutMs = 30 * 60_000 } = {}) {
  const available = segmentationAvailable();
  if (!available.ok) return { ok: false, reason: available.reason };

  const res = spawnSync(python, [SEGMENT_SCRIPT, "--input", input, "--output", output, "--model", model], {
    encoding: "utf-8",
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });

  if (res.status !== 0) {
    const detail = String(res.stderr || res.error?.message || "no detail").trim().split("\n").slice(-2).join(" ");
    return { ok: false, reason: `segmentation failed: ${detail}` };
  }

  let metrics;
  try {
    metrics = JSON.parse(String(res.stdout || "").trim().split("\n").pop());
  } catch {
    return { ok: false, reason: "segmentation produced no readable metrics" };
  }

  // A zero-status run that wrote no file is exactly the silent success this
  // project keeps paying for, so the file is checked rather than assumed.
  if (!existsSync(output)) return { ok: false, reason: "segmentation reported success but wrote no file" };

  const gate = gateCutout(metrics);
  if (!gate.ok) return { ok: false, reason: gate.reasons.join("; "), metrics, rejectedByGate: true };

  return { ok: true, path: output, metrics };
}

/**
 * Decide which segments get a bubble.
 *
 * Only voiceover segments he narrated himself, only when the visual is
 * full-screen, and only when the config allows it at all.
 */
export function planPip(segments = [], { enabled = true } = {}) {
  const plan = [];
  const skipped = [];
  let index = 0;

  for (const seg of segments) {
    if (seg.kind !== "voiceover") continue;

    if (!enabled) {
      skipped.push({ takeId: seg.takeId, reason: "PIP disabled for this video" });
      continue;
    }
    if (!seg.narrationSource) {
      // The clone is speaking. There is no recording of him saying these words.
      skipped.push({ takeId: seg.takeId, reason: "narration is the cloned voice — no footage of him saying it" });
      continue;
    }
    plan.push({ takeId: seg.takeId, source: seg.narrationSource, index: index++ });
  }

  return { plan, skipped };
}
