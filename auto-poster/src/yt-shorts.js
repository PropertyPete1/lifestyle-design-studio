/**
 * yt-shorts.js — three vertical cutdowns from an approved long-form video.
 *
 * CUT FROM THE SOURCES, NOT FROM THE MASTER. This is the decision that matters
 * and it is easy to get backwards.
 *
 * The finished long-form video is 1920x1080 with everything pillarboxed into
 * it, because the format is 16:9. Cropping a 9:16 Short out of that means
 * taking a 607-pixel-wide slice of an already-downscaled frame and blowing it
 * back up — the result looks like what it is.
 *
 * But every source is ALREADY VERTICAL. Peter records on his phone, and the
 * Drive library is 4K portrait. So a Short is cut from the original clip at
 * full resolution and never passes through the 16:9 master at all. The only
 * thing taken from the master is the timing.
 *
 * WHICH MOMENTS. Not "the strongest" by some vague measure — the script already
 * marks them. The hook is written to stop someone in the first fifteen seconds,
 * and every boundaryPull is written to be the reason a viewer stays through a
 * section change. Those are the lines that were engineered to grip, and they
 * are the ones worth cutting. Picking them is a lookup, not a judgement call.
 */

import { execFileSync } from "child_process";
import { existsSync, mkdirSync, statSync } from "fs";
import { join } from "path";
import { ON_CAMERA } from "./yt-script.js";

/** Shorts must be under 3 minutes; these are cut far shorter than that. */
export const MIN_SECONDS = 15;
export const MAX_SECONDS = 55;

/** How many to cut per video. */
export const SHORTS_PER_VIDEO = 3;

export const VERTICAL = { w: 1080, h: 1920 };

/**
 * Pick the moments worth cutting.
 *
 * Ranked, because three is a budget:
 *   1. the hook take            — written to stop a scroll, which is the job
 *   2. on-camera boundary takes — a face plus a reason to stay
 *   3. any other on-camera take — Peter talking beats B-roll for a Short
 *
 * A moment shorter than MIN_SECONDS is padded from the take that follows it,
 * rather than shipped as an eight-second clip that ends mid-sentence.
 */
export function pickMoments(plan, { count = SHORTS_PER_VIDEO, minSeconds = MIN_SECONDS, maxSeconds = MAX_SECONDS } = {}) {
  const segments = plan?.segments || [];
  if (segments.length === 0) return [];

  const withStarts = [];
  let elapsed = 0;
  for (const seg of segments) {
    withStarts.push({ ...seg, startsAt: elapsed });
    elapsed += seg.seconds || 0;
  }

  const scored = withStarts.map((seg, i) => {
    let rank = 3;
    if (i === 0) rank = 0;                                  // the hook
    else if (seg.kind === "on_camera" && isBoundary(withStarts, i)) rank = 1;
    else if (seg.kind === "on_camera") rank = 2;
    else rank = 4;                                          // voiceover over B-roll
    return { seg, i, rank };
  });

  scored.sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.i - b.i));

  const moments = [];
  const usedIndexes = new Set();
  for (const { seg, i } of scored) {
    if (moments.length >= count) break;
    if (usedIndexes.has(i)) continue;

    let seconds = seg.seconds || 0;
    const parts = [{ index: i, seg }];
    // Too short to stand alone — extend into the next segment rather than
    // shipping a clip that stops mid-thought.
    let j = i + 1;
    while (seconds < minSeconds && j < withStarts.length && !usedIndexes.has(j)) {
      parts.push({ index: j, seg: withStarts[j] });
      seconds += withStarts[j].seconds || 0;
      j++;
    }
    if (seconds < minSeconds) continue; // nothing left to pad with

    for (const p of parts) usedIndexes.add(p.index);
    moments.push({
      takeId: seg.takeId,
      kind: seg.kind,
      section: seg.section,
      startsAt: round(seg.startsAt),
      seconds: round(Math.min(seconds, maxSeconds)),
      text: parts.map((p) => p.seg.text).filter(Boolean).join(" "),
      // Where the pixels come from — the ORIGINAL, not the 16:9 master.
      source: seg.kind === "on_camera" ? seg.source : (seg.broll || [])[0] || null,
      parts: parts.map((p) => p.index),
    });
  }
  return moments;
}

/** A take that opens or closes a section is where the retention writing lives. */
function isBoundary(segments, i) {
  const prev = segments[i - 1];
  const next = segments[i + 1];
  return (prev && prev.section !== segments[i].section) || (next && next.section !== segments[i].section);
}

/**
 * ffmpeg arguments for one vertical cut.
 *
 * The source is portrait already, so this is a scale-and-pad to the exact
 * canvas rather than a crop — nothing of the frame is thrown away, and a clip
 * that happens to be landscape gets pillarboxed instead of having its subject
 * sliced out of frame.
 */
export function cutArgs(source, output, { startAt = 0, seconds, dim = VERTICAL }) {
  return [
    "-y",
    ...(startAt > 0 ? ["-ss", String(startAt)] : []),
    "-i", source,
    "-t", String(seconds),
    "-vf",
    `scale=${dim.w}:${dim.h}:force_original_aspect_ratio=decrease,` +
      `pad=${dim.w}:${dim.h}:(ow-iw)/2:(oh-ih)/2:color=black,fps=30,setsar=1`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    "-movflags", "+faststart",
    output,
  ];
}

/**
 * Cut the Shorts.
 *
 * Returns descriptors, not posts. These become CANDIDATES for the existing
 * posting pipeline — they are not scheduled here, and nothing about cutting one
 * publishes anything.
 */
export function cutShorts(moments, { workDir, resolveSourcePath }) {
  if (!existsSync(workDir)) mkdirSync(workDir, { recursive: true });
  const out = [];

  for (let i = 0; i < moments.length; i++) {
    const m = moments[i];
    const source = resolveSourcePath(m);
    if (!source) {
      console.warn(`[YTShorts] no source for ${m.takeId} — skipping`);
      continue;
    }
    const dest = join(workDir, `short-${i + 1}-${m.takeId}.mp4`);
    try {
      // An on-camera moment starts at the top of its own recording; a B-roll
      // moment starts wherever the plan put it in that clip.
      execFileSync("ffmpeg", cutArgs(source, dest, { startAt: 0, seconds: m.seconds }), {
        timeout: 20 * 60_000,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      console.warn(`[YTShorts] cut failed for ${m.takeId}: ${String(err.stderr || err.message).slice(-200)}`);
      continue;
    }
    out.push({
      index: i + 1,
      takeId: m.takeId,
      section: m.section,
      seconds: m.seconds,
      path: dest,
      bytes: statSync(dest).size,
      text: m.text,
    });
  }
  console.log(`[YTShorts] cut ${out.length}/${moments.length} vertical clip(s)`);
  return out;
}

/**
 * Turn a cut into a caption for the posting pipeline.
 *
 * Deliberately plain. The Short's job is to send someone to the long-form
 * video, so the caption points at it rather than re-explaining the content.
 */
export function shortCaption(short, { videoTitle, keyword = "MATH" }) {
  const first = String(short.text || "").split(/(?<=[.!?])\s/)[0] || videoTitle;
  return [
    first.trim(),
    "",
    `Full breakdown in "${videoTitle}" — link in bio.`,
    `Comment ${keyword} and I'll send you the numbers for a specific house.`,
  ].join("\n");
}

function round(n) {
  return Math.round(n * 100) / 100;
}
