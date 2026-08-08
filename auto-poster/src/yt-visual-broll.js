/**
 * yt-visual-broll.js — generated stills become B-roll, under a hard cap.
 *
 * Two jobs, and the second one is the important one.
 *
 * 1. Turn a PNG into a moving clip. A still held for eight seconds in the
 *    middle of a video that is otherwise drone footage reads as a bug. A slow
 *    push across the frame reads as a motion graphic.
 *
 * 2. STOP. The classifier is generous by design and the renderers will happily
 *    draw every segment they are handed. Left alone that produces a slide deck
 *    with a voiceover, which is the opposite of why anyone watches this
 *    channel. `applyGeneratedVisuals` spends a fixed budget of B-roll runtime
 *    on the highest-scoring candidates and leaves everything else as footage.
 */

import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { MAP, INFOGRAPHIC } from "./yt-visual-classify.js";

/**
 * Share of B-roll runtime that may be a generated visual.
 *
 * The brief said ~30% and 30% is right: it is enough for the two or three
 * moments in a twelve-minute video that genuinely cannot be filmed, and not
 * enough to change what the video feels like.
 */
export const GENERATED_SHARE_CAP = 0.3;

/** Below this a graphic is a flash, above it a still starts to feel stuck. */
export const MIN_VISUAL_SECONDS = 4;
export const MAX_VISUAL_SECONDS = 9;

/**
 * Ken-burns arguments for one generated still.
 *
 * `zoompan` rather than a scale+crop animation because it is one filter, it is
 * frame-accurate, and the probe already timed this class of graph. The source
 * is rendered at 2560x1440 for a 1920x1080 canvas, so the move lives inside
 * real pixels instead of upscaling — a 1.0→1.12 push on an oversized still
 * never resolves softer than the footage either side of it.
 *
 * `d` is in FRAMES, not seconds, and `s` must be the OUTPUT size. Getting
 * either wrong yields a clip of the right duration that is silently the wrong
 * size, which concat then reinterprets rather than rejecting.
 *
 * THE ZOOM EXPRESSION MUST REFERENCE `on`. The first version of this function
 * shipped `z='1.0+0.12/180'`, which reads like a per-frame step and is in fact
 * the constant 1.000666 — ffmpeg accepted it, produced a clip of exactly the
 * right size and duration, and every frame was identical. Nothing failed. It
 * was caught by diffing the first and last frame, which is why the test below
 * asserts the expression is a function of the frame counter rather than
 * asserting the clip merely exists.
 */
export function kenBurnsArgs(pngPath, output, { seconds, dim, fps = 30, direction = "in" } = {}) {
  const frames = Math.max(1, Math.round(seconds * fps));
  const TRAVEL = 0.12;
  const z =
    direction === "out"
      ? `${(1 + TRAVEL).toFixed(2)}-${TRAVEL}*on/${frames}`
      : `1+${TRAVEL}*on/${frames}`;

  // Held at the centre: a generated frame has its subject in the middle by
  // construction, unlike a photograph, so drifting off-centre only crops the
  // thing the shot exists to show.
  const expr =
    `zoompan=z='${z}':d=${frames}` +
    `:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${dim.w}x${dim.h}:fps=${fps}`;

  return [
    "-y", "-loop", "1", "-i", pngPath,
    "-t", String(seconds),
    "-vf", `${expr},format=yuv420p,setsar=1`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-an",
    output,
  ];
}

/**
 * Choose which classified segments actually get a generated visual.
 *
 * Ranked by the classifier's score rather than taken in script order, because
 * when the cap bites — and on a twelve-minute video it always bites — the
 * segments it keeps should be the ones the classifier was most sure about, not
 * whichever happened to come first.
 *
 * Returns the plan unmodified except for a `generated` marker on the chosen
 * segments, plus a report the caller can log or surface.
 */
export function selectGeneratedVisuals(segments, { cap = GENERATED_SHARE_CAP } = {}) {
  const brollSeconds = segments
    .filter((s) => s.kind === "voiceover")
    .reduce((n, s) => n + (s.seconds || 0), 0);
  const budget = brollSeconds * cap;

  const candidates = segments
    .map((seg, index) => ({ seg, index }))
    .filter(({ seg }) => seg.kind === "voiceover" && (seg.visual === MAP || seg.visual === INFOGRAPHIC))
    .sort((a, b) => (b.seg.visualScore || 0) - (a.seg.visualScore || 0));

  const chosen = new Map();
  let spent = 0;
  for (const { seg, index } of candidates) {
    // A generated visual covers PART of a take, not all of it. Holding one
    // graphic for a 30-second take is the slideshow failure in miniature.
    const want = Math.min(MAX_VISUAL_SECONDS, Math.max(MIN_VISUAL_SECONDS, (seg.seconds || 0) * 0.5));
    if (want < MIN_VISUAL_SECONDS) continue;
    if (spent + want > budget) continue;
    chosen.set(index, want);
    spent += want;
  }

  const out = segments.map((seg, index) =>
    chosen.has(index) ? { ...seg, generatedSeconds: round(chosen.get(index)) } : { ...seg, generatedSeconds: 0 }
  );

  return {
    segments: out,
    report: {
      brollSeconds: round(brollSeconds),
      budgetSeconds: round(budget),
      usedSeconds: round(spent),
      share: brollSeconds > 0 ? round(spent / brollSeconds) : 0,
      candidateCount: candidates.length,
      chosenCount: chosen.size,
      skippedForCap: candidates.length - chosen.size,
    },
  };
}

/**
 * Render the chosen visuals and splice them into each segment's B-roll list.
 *
 * The generated clip goes FIRST in the segment. The narration explains the
 * shape while it is on screen, then the picture returns to real footage for the
 * rest of the take — which is what keeps this feeling like a video with
 * diagrams in it rather than a diagram with a video around it.
 *
 * A render that fails, or a spec that cannot be built, is not fatal: the
 * segment keeps its footage and the failure is reported. There is always a
 * fallback, so there is never a reason to stop the build over a graphic.
 */
export async function applyGeneratedVisuals(plan, { workDir, market = "san_antonio", cap = GENERATED_SHARE_CAP } = {}) {
  const { mapSpecForSegment, renderMapPng } = await import("./yt-map-render.js");
  const { infographicSpecForSegment, renderInfographicPng } = await import("./yt-infographic-render.js");
  const { writeFileSync } = await import("fs");
  const { isNonBlank } = await import("./carousel-render.js");

  const dir = workDir || join(process.env.TMPDIR || "/tmp", `yt-visuals-${Date.now()}`);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const { segments, report } = selectGeneratedVisuals(plan.segments || [], { cap });
  const rendered = [];
  const failures = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg.generatedSeconds) continue;

    try {
      let png = null;
      let kind = null;
      if (seg.visual === MAP) {
        const spec = mapSpecForSegment(seg, { market });
        if (spec) { png = await renderMapPng({ ...spec, title: null }); kind = "map"; }
      } else if (seg.visual === INFOGRAPHIC) {
        const spec = infographicSpecForSegment(seg, { section: seg.section });
        if (spec) { png = await renderInfographicPng(spec); kind = "infographic"; }
      }

      // A builder that declines is the designed path, not an error — prose does
      // not always decompose into a card, and footage is a fine answer.
      if (!png) { seg.generatedSeconds = 0; continue; }

      // Vision check before it can reach the timeline. A blank graphic is worse
      // than no graphic: it looks like the render broke, on camera.
      if (!(await isNonBlank(png))) {
        failures.push({ takeId: seg.takeId, reason: "rendered blank" });
        seg.generatedSeconds = 0;
        continue;
      }

      const path = join(dir, `visual-${String(i).padStart(3, "0")}-${kind}.png`);
      writeFileSync(path, png);

      // Spliced at the head of the segment's B-roll, and the footage that
      // follows is shortened by the same amount so the take's total is
      // unchanged — the narration length is authoritative, not the picture.
      seg.broll = spliceGenerated(seg.broll || [], { path, seconds: seg.generatedSeconds, kind });
      rendered.push({ takeId: seg.takeId, kind, seconds: seg.generatedSeconds, path });
    } catch (err) {
      failures.push({ takeId: seg.takeId, reason: err.message });
      seg.generatedSeconds = 0;
    }
  }

  return {
    ...plan,
    segments,
    generated: { ...report, rendered, failures, renderedCount: rendered.length },
  };
}

/**
 * Put the generated clip at the front and take its time out of the footage.
 *
 * Trimming from the END of the footage list rather than proportionally across
 * it keeps every surviving clip at a readable length. Shaving 20% off six
 * three-second shots leaves six shots too short to register.
 */
export function spliceGenerated(broll, { path, seconds, kind }) {
  const generated = { generated: true, kind, sourcePath: path, seconds: round(seconds), fileName: `${kind}.png` };
  let toRemove = seconds;
  const kept = [];

  for (let i = broll.length - 1; i >= 0; i--) {
    const clip = broll[i];
    if (toRemove <= 0) { kept.unshift(clip); continue; }
    if (clip.seconds <= toRemove) {
      toRemove -= clip.seconds;
      continue;
    }
    kept.unshift({ ...clip, seconds: round(clip.seconds - toRemove) });
    toRemove = 0;
  }

  return [generated, ...kept];
}

function round(n) {
  return Math.round(n * 100) / 100;
}
