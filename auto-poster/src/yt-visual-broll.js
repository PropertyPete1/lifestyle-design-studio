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
import { MAP, FOOTAGE, GRAPHIC_TYPES, attachIntents } from "./yt-visual-intent.js";

/**
 * THERE IS NO RATIO CAP.
 *
 * There was one — 30% of B-roll runtime — and it was built on the assumption
 * that footage is the right default and graphics are the exception. That
 * assumption was wrong for this format. The B-roll library is cut for
 * 15-second hype reels, and under a twelve-minute explainer those clips are
 * filler: pretty, and teaching nothing. So the writer now decides per sentence,
 * a graphic is the default, and FOOTAGE is an explicit choice.
 *
 * What replaces the cap is REPORTING. The split is measured and surfaced per
 * video so it can be judged on the finished thing rather than constrained in
 * advance by a number nobody has tested against a real explainer.
 */

/** Graphics are suppressed entirely for this long. See yt-opening.js. */
export const OPENING_PROTECTED_SECONDS = 15;

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
 * Choose which requested visuals the video can actually afford.
 *
 * Spread EVENLY across the script rather than taken in order. The writer tends
 * to cluster intents — a section explaining a tax bill will ask for three
 * graphics in a row — and spending the whole budget on one section produces a
 * video that is a slideshow for ninety seconds and then never draws again.
 * Walking the candidates in stride order spends the budget across the runtime.
 *
 * Returns the plan unmodified except for a `generatedSeconds` marker on the
 * chosen segments, plus a report the caller can log or surface.
 */
export function selectGeneratedVisuals(segments, { protectedSeconds = OPENING_PROTECTED_SECONDS } = {}) {
  const brollSeconds = segments
    .filter((s) => s.kind === "voiceover")
    .reduce((n, s) => n + (s.seconds || 0), 0);

  // Elapsed position of each segment, so the opening can be protected by time
  // rather than by index — the first 15 seconds may be one take or three.
  let elapsed = 0;
  const starts = segments.map((s) => {
    const at = elapsed;
    elapsed += s.seconds || 0;
    return at;
  });

  const chosen = new Map();
  const suppressed = [];
  let spent = 0;

  segments.forEach((seg, index) => {
    if (seg.kind !== "voiceover" || !GRAPHIC_TYPES.includes(seg.visual)) return;

    // Nothing competes with the hook. A map is not charming to somebody who is
    // not invested yet, and the first fifteen seconds are where they decide.
    if (starts[index] < protectedSeconds) {
      suppressed.push({ takeId: seg.takeId, type: seg.visual, startsAt: round(starts[index]) });
      return;
    }

    // A segment with NO footage is one the B-roll allocator could not fill, and
    // renderTimeline throws on it — loudly, which is correct. Splicing a visual
    // in would make the concat succeed with a picture SHORTER than the
    // narration, and `-shortest` would quietly cut the narration to match. That
    // turns a build failure into a video missing a sentence.
    const footage = (seg.broll || []).reduce((n, c) => n + (c.seconds || 0), 0);
    if (footage <= 0) return;

    // The graphic now carries the WHOLE take by default. Under the old cap it
    // covered half and footage filled the rest; with footage demoted to a
    // deliberate choice, cutting away from a card mid-explanation just to show
    // a drone shot is the filler this change exists to remove.
    const want = Math.min(seg.seconds || 0, footage);
    if (want < MIN_VISUAL_SECONDS) return;

    chosen.set(index, round(want));
    spent += want;
  });

  const out = segments.map((seg, index) =>
    chosen.has(index) ? { ...seg, generatedSeconds: round(chosen.get(index)) } : { ...seg, generatedSeconds: 0 }
  );

  return {
    segments: out,
    report: {
      brollSeconds: round(brollSeconds),
      graphicSeconds: round(spent),
      footageSeconds: round(Math.max(0, brollSeconds - spent)),
      graphicShare: brollSeconds > 0 ? round(spent / brollSeconds) : 0,
      chosenCount: chosen.size,
      suppressedInOpening: suppressed,
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
export async function applyGeneratedVisuals(plan, { workDir, market = "san_antonio", protectedSeconds = OPENING_PROTECTED_SECONDS } = {}) {
  const { mapSpecForIntent, renderMapPng, renderMapSvg } = await import("./yt-map-render.js");
  const { renderCardPng, renderCardSvg } = await import("./yt-card-render.js");
  const { inspectRender, findOverflowingText } = await import("./yt-visual-qc.js");
  const { writeFileSync } = await import("fs");

  const dir = workDir || join(process.env.TMPDIR || "/tmp", `yt-visuals-${Date.now()}`);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  // Validate what the writer asked for before spending anything on it.
  const { segments: withIntents, report: intentReport } = attachIntents(plan.segments || []);
  const { segments, report } = selectGeneratedVisuals(withIntents, { protectedSeconds });

  const rendered = [];
  const failures = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg.generatedSeconds) continue;

    try {
      let svg = null;
      let png = null;

      if (seg.visual === MAP) {
        // The map is the one type that can fail for a reason the writer could
        // not have known: it names places we have no coordinates for.
        const spec = mapSpecForIntent(seg.visualSpec, { market });
        if (spec) {
          svg = renderMapSvg(spec);
          png = await renderMapPng(spec);
        }
      } else {
        svg = renderCardSvg(seg.visual, seg.visualSpec);
        png = await renderCardPng(seg.visual, seg.visualSpec);
      }

      if (!png) {
        // An intent the renderer cannot satisfy falls back silently. This is a
        // designed path, not an error.
        failures.push({ takeId: seg.takeId, type: seg.visual, reason: "renderer could not satisfy the spec" });
        seg.generatedSeconds = 0;
        continue;
      }

      // QC on the PIXELS, at 1080p, before anything reaches the timeline. A
      // render that returned a large valid PNG has proved nothing.
      const verdict = await inspectRender(png, {
        label: `${seg.visual} for ${seg.takeId}`,
        // Roads are meant to run off the frame; a card is not.
        edgeCheck: seg.visual !== MAP,
      });
      const overflow = svg ? findOverflowingText(svg) : [];
      if (!verdict.ok || overflow.length > 0) {
        failures.push({
          takeId: seg.takeId,
          type: seg.visual,
          reason: [...verdict.failures, ...overflow.map((o) => `text off-canvas: "${o.text}"`)].join("; "),
        });
        seg.generatedSeconds = 0;
        continue;
      }

      const path = join(dir, `visual-${String(i).padStart(3, "0")}-${seg.visual.toLowerCase()}.png`);
      writeFileSync(path, png);

      // Spliced at the head of the segment's B-roll, and the footage that
      // follows is shortened by the same amount so the take's total is
      // unchanged — the narration length is authoritative, not the picture.
      seg.broll = spliceGenerated(seg.broll || [], { path, seconds: seg.generatedSeconds, kind: seg.visual });
      rendered.push({ takeId: seg.takeId, kind: seg.visual, seconds: seg.generatedSeconds, path, metrics: verdict.metrics });
    } catch (err) {
      failures.push({ takeId: seg.takeId, type: seg.visual, reason: err.message });
      seg.generatedSeconds = 0;
    }
  }

  // The split is what replaces the cap: measured on the finished plan and
  // surfaced, rather than constrained in advance by a ratio nobody has tested
  // against a real explainer.
  const graphicSeconds = rendered.reduce((n, r) => n + r.seconds, 0);
  const brollSeconds = report.brollSeconds || 0;

  return {
    ...plan,
    segments,
    generated: {
      ...report,
      intents: intentReport,
      rendered,
      failures,
      renderedCount: rendered.length,
      mapsUsed: rendered.some((r) => r.kind === MAP),
      split: {
        graphicSeconds: round(graphicSeconds),
        footageSeconds: round(Math.max(0, brollSeconds - graphicSeconds)),
        graphicPct: brollSeconds > 0 ? Math.round((graphicSeconds / brollSeconds) * 100) : 0,
        footagePct: brollSeconds > 0 ? Math.round(((brollSeconds - graphicSeconds) / brollSeconds) * 100) : 0,
        brollSeconds: round(brollSeconds),
      },
    },
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
