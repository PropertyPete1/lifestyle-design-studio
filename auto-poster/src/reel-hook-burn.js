/**
 * reel-hook-burn.js — the chosen hook, burned onto the reel's first 3 seconds.
 *
 * The variation engine (PR #114) chooses a hook style and the caption opens
 * with the hook line — but until now the line lived only in the caption text,
 * where a scroller who never reads captions never sees it. This puts the same
 * line ON the video for its first three seconds, using the SAME plate the
 * trial-variant path already renders (reel-variant.js: sharp SVG, brand gold
 * rule, upper-third placement clear of burned captions and the UI rail), so
 * the daily path cannot drift into a second type system.
 *
 * ONE TEXT, TWO SURFACES. The plate text IS the caption's first line — the
 * line that already passed the caption prompt's honesty rules and the
 * price-consistency check. Nothing is written here that the caption does not
 * already say, which is what keeps the honesty story unchanged.
 *
 * ─── THE GATES, in order, all loud ──────────────────────────────────────────
 *
 *   caption_scan unavailable → SKIP. The scan is the only thing that can tell
 *       us the source is clean, and "a check that cannot run refuses to add
 *       captions rather than adding them unverified" (burned-captions.js).
 *   source has burned text   → SKIP. Text over the seller's own text is the
 *       caption-over-captions class this repo already refuses.
 *   hook line unfit          → SKIP. A plate is read in a second and a half;
 *       past MAX_PLATE_WORDS it is a poster, not a hook. Emoji are stripped
 *       (the SVG's sans stack cannot draw them), words are kept verbatim.
 *   probe fails              → SKIP. The plate must be rendered at the
 *       video's OWN dimensions — a 1080×1920 plate overlaid on a 4K source
 *       covers a quadrant, renders fine, and is wrong.
 *
 * ─── SELF-QC BEFORE CLAIMING SUCCESS ────────────────────────────────────────
 *
 * The burn re-probes its own output (video stream present, duration within
 * tolerance of the input, non-trivial size) before returning burned:true. An
 * overlay job that quietly produced garbage must degrade to the un-plated
 * video, never to a lost slot — this module NEVER throws.
 *
 * Encoding matches the caption burn (libx264 veryfast CRF 18, audio COPIED),
 * and deliberately does NOT force a frame rate: the daily sources arrive at
 * whatever fps they were shot at, and resampling them is not this feature.
 */

import { writeFileSync, existsSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";

import { renderHookPlatePng } from "./reel-variant.js";
import { HOOK_HOLD_SECONDS } from "./reel-hooks.js";
import { ffmpeg } from "./yt-assemble.js";

/** Past this many words the plate is a wall of text, not a hook. */
export const MAX_PLATE_WORDS = 12;
export const MIN_PLATE_WORDS = 2;

/** |output duration − input duration| beyond this means the burn mangled the file. */
export const DURATION_TOLERANCE_SECONDS = 0.75;

/**
 * The plate text from a caption: its first line, emoji stripped.
 *
 * Emoji go because the plate's SVG sans stack cannot draw them (they would
 * render as tofu boxes); the words are kept verbatim — this derives a display
 * form, it never rewrites the claim.
 */
export function plateTextFromCaption(caption) {
  const firstLine = String(caption ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  if (!firstLine) return { text: null, reason: "caption has no first line" };

  const text = firstLine
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\u200d\ufe0f]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return { text: null, reason: "hook line is only emoji" };

  const words = text.split(/\s+/).length;
  if (words < MIN_PLATE_WORDS) return { text: null, reason: `hook line too short for a plate (${words} word)` };
  if (words > MAX_PLATE_WORDS) return { text: null, reason: `hook line too long for a plate (${words} words, max ${MAX_PLATE_WORDS})` };
  return { text, reason: null };
}

/** Width, height and duration of a video, or null when unreadable. */
export function probeVideo(videoPath) {
  try {
    const raw = execSync(
      `ffprobe -v quiet -print_format json -show_streams -show_format "${videoPath}"`,
      { encoding: "utf-8", timeout: 30000 }
    );
    const probe = JSON.parse(raw);
    const stream = probe.streams?.find((s) => s.codec_type === "video");
    if (!stream) return null;
    const width = parseInt(stream.width);
    const height = parseInt(stream.height);
    const duration = parseFloat(probe.format?.duration || stream.duration || "0");
    if (!width || !height || !Number.isFinite(duration)) return null;
    return { width, height, duration };
  } catch {
    return null;
  }
}

/**
 * The ffmpeg arguments for the plate burn.
 *
 * Modeled on reel-variant.js overlayArgs with three deliberate differences,
 * each matching the daily path's rules rather than the trial path's:
 *   - NO -r flag: the source keeps its own frame rate.
 *   - CRF 18, the caption burn's quality bar (the trial path uses 20).
 *   - audio COPIED, exactly as the caption burn does — the plate has no
 *     business re-encoding sound.
 */
export function plateBurnArgs(videoIn, plateIn, output, { hold = HOOK_HOLD_SECONDS } = {}) {
  const fade = 0.25;
  const round3 = (n) => Math.round(n * 1000) / 1000;
  return [
    "-y", "-i", videoIn, "-i", plateIn,
    "-filter_complex",
    `[1:v]format=rgba,fade=t=out:st=${round3(hold - fade)}:d=${fade}:alpha=1[plate];` +
      `[0:v][plate]overlay=0:0:enable='between(t,0,${hold})'[v]`,
    "-map", "[v]", "-map", "0:a?",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
    "-c:a", "copy",
    "-movflags", "+faststart",
    output,
  ];
}

/**
 * Burn the caption's hook line onto the first HOOK_HOLD_SECONDS of the video.
 *
 * Returns { burned, videoPath, reason, text, hold_seconds }. burned:false
 * always carries a reason a human can act on; burned:true means the output
 * ALSO passed the structural self-check. Never throws.
 */
export async function burnHookPlate(videoPath, caption, {
  captionScan = null,
  hold = HOOK_HOLD_SECONDS,
  outputDir = tmpdir(),
  runFfmpeg = ffmpeg,
  probe = probeVideo,
  renderPlate = renderHookPlatePng,
} = {}) {
  const skip = (reason, text = null) => ({ burned: false, videoPath: null, reason, text, hold_seconds: hold });

  try {
    if (captionScan?.ocrUnavailable) {
      return skip("caption scan could not run — cannot verify the source is clean, so no plate is added unverified");
    }
    if (captionScan?.detected) {
      return skip("source already carries burned-in text — a plate over it is the caption-over-captions class");
    }

    const { text, reason } = plateTextFromCaption(caption);
    if (!text) return skip(reason);

    const dims = probe(videoPath);
    if (!dims) return skip("could not probe the video's dimensions — a plate at guessed dimensions lands wrong");

    const stamp = Date.now();
    const platePath = join(outputDir, `hookplate_${stamp}.png`);
    const outputPath = join(outputDir, `hookplate_${stamp}.mp4`);

    try {
      writeFileSync(platePath, await renderPlate(text, { w: dims.width, h: dims.height }));
      runFfmpeg(plateBurnArgs(videoPath, platePath, outputPath, { hold }));
    } catch (err) {
      try { if (existsSync(outputPath)) unlinkSync(outputPath); } catch { /* best effort */ }
      return skip(`render failed: ${String(err.message || err).slice(0, 160)}`);
    } finally {
      try { if (existsSync(platePath)) unlinkSync(platePath); } catch { /* best effort */ }
    }

    // ── self-QC: never claim a burn the file cannot back up ──────────────────
    if (!existsSync(outputPath) || statSync(outputPath).size < 10 * 1024) {
      try { if (existsSync(outputPath)) unlinkSync(outputPath); } catch { /* best effort */ }
      return skip("burn produced no usable output file");
    }
    const outDims = probe(outputPath);
    if (!outDims || Math.abs(outDims.duration - dims.duration) > DURATION_TOLERANCE_SECONDS) {
      try { unlinkSync(outputPath); } catch { /* best effort */ }
      return skip(
        `burned output failed the structural check (in ${dims.duration.toFixed(2)}s → out ${outDims ? outDims.duration.toFixed(2) + "s" : "unreadable"})`
      );
    }

    return { burned: true, videoPath: outputPath, reason: null, text, hold_seconds: hold };
  } catch (err) {
    return skip(`unexpected failure: ${String(err.message || err).slice(0, 160)}`);
  }
}
