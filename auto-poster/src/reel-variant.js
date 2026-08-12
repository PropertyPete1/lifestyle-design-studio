/**
 * reel-variant.js — putting the hook on the front of the master.
 *
 * One variant = the edited master, optionally started a beat later, with a line
 * of text held over its first three seconds. That is the whole difference
 * between A, B and C, and keeping it that small is what makes the A/B readable:
 * if the variants differed in the cut, the music and the caption as well, a
 * winner would tell Peter nothing about which change won.
 *
 * TWO FFMPEG PASSES, NOT ONE, and the reason is the cold open. Trimming and
 * overlaying in a single filter graph means the overlay's `enable=between(t,..)`
 * window is expressed in pre-trim time, which is the kind of off-by-a-cut error
 * that renders fine and is wrong — the plate would appear three seconds into a
 * variant that was supposed to open with it. Trimming first makes the overlay
 * window mean exactly what it says: the first three seconds of the file being
 * written.
 *
 * The plate is drawn with sharp from an SVG, the same way every other piece of
 * on-screen type in this repo is drawn, using the same brand gold and the same
 * sans stack — so a hook plate cannot drift into being a second type system.
 */

import { writeFileSync } from "fs";
import { join } from "path";
import sharp from "sharp";

import { BRAND, SANS } from "./carousel-render.js";
import { ffmpeg } from "./yt-assemble.js";
import { REEL_DIM, REEL_FPS } from "./reel-edit.js";
import { HOOK_HOLD_SECONDS } from "./reel-hooks.js";

/**
 * How wide the plate is allowed to run, as a share of the frame.
 *
 * Reels are watched with a UI over them — captions, the account name, the
 * action rail up the right-hand side. Type that runs to the frame edge is type
 * that sits under a button.
 */
export const PLATE_WIDTH_SHARE = 0.84;

/** The plate sits in the upper third, clear of burned captions and the UI rail. */
export const PLATE_CENTER_SHARE = 0.3;

/** Characters per line before wrapping. Tuned to the width share above, not to a font metric. */
const CHARS_PER_LINE = 22;

/**
 * Wrap a hook line into display lines.
 *
 * Greedy by words. A hook is three to ten words, so the naive algorithm is the
 * right one — there is no case where a smarter break changes the outcome, and a
 * word is never split, which is what would actually look wrong.
 */
export function wrapHook(text, perLine = CHARS_PER_LINE) {
  const out = [];
  let line = "";
  for (const word of String(text ?? "").trim().split(/\s+/).filter(Boolean)) {
    if (!line) line = word;
    else if (line.length + 1 + word.length <= perLine) line += ` ${word}`;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line) out.push(line);
  return out;
}

/**
 * The hook plate as an SVG.
 *
 * White type on a gold-edged dark scrim rather than gold type: a hook line is
 * up to ten words, and ten words of gold on video is a poster. The gold stays
 * as the rule under it, which is the brand cue at a glance without costing
 * legibility over whatever the footage happens to be.
 *
 * Sized to the BOX rather than measured against the glyphs, exactly as
 * punchSvg does — the plate is centred, so the exact advance width does not
 * change where anything lands.
 */
export function hookPlateSvg(text, dim = REEL_DIM) {
  const lines = wrapHook(text);
  const gold = BRAND.colors.accent;
  const width = Math.round(dim.w * PLATE_WIDTH_SHARE);
  const size = Math.round(Math.min(dim.w / 11, (width * 1.9) / Math.max(12, longest(lines))));
  const lineHeight = Math.round(size * 1.24);
  const padY = Math.round(size * 0.8);
  const boxH = lines.length * lineHeight + padY * 2;
  const boxY = Math.round(dim.h * PLATE_CENTER_SHARE - boxH / 2);
  const boxX = Math.round((dim.w - width) / 2);
  const firstBaseline = boxY + padY + Math.round(lineHeight * 0.75);

  const tspans = lines
    .map((l, i) => `<tspan x="${Math.round(dim.w / 2)}" y="${firstBaseline + i * lineHeight}">${escapeXml(l)}</tspan>`)
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${dim.w}" height="${dim.h}" viewBox="0 0 ${dim.w} ${dim.h}">
  <rect x="${boxX}" y="${boxY}" width="${width}" height="${boxH}" rx="${Math.round(size * 0.28)}" fill="#000000" fill-opacity="0.66"/>
  <rect x="${boxX}" y="${boxY + boxH - Math.max(3, Math.round(size * 0.09))}" width="${width}" height="${Math.max(3, Math.round(size * 0.09))}" fill="${gold}"/>
  <text text-anchor="middle" font-family="${SANS}" font-size="${size}" font-weight="700"
        letter-spacing="${Math.round(size * 0.01)}" fill="#FFFFFF">${tspans}</text>
</svg>`;
}

export async function renderHookPlatePng(text, dim = REEL_DIM) {
  return sharp(Buffer.from(hookPlateSvg(text, dim))).png({ compressionLevel: 9 }).toBuffer();
}

/**
 * The ffmpeg arguments that put a plate over the first N seconds of a video.
 *
 * `enable='between(t,0,hold)'` is what makes the plate a hook rather than a
 * watermark. The short fade at the tail stops it snapping off mid-word — a hard
 * cut on type reads as a dropped frame.
 *
 * Pure, and exported, because an argument list is the cheapest thing in this
 * pipeline to get wrong and the most expensive to notice: an overlay that never
 * enables renders perfectly and silently produces a variant identical to the
 * master, which is an A/B with nothing in it.
 */
export function overlayArgs(videoIn, plateIn, output, { hold = HOOK_HOLD_SECONDS, fps = REEL_FPS } = {}) {
  const fade = 0.25;
  return [
    "-y", "-i", videoIn, "-i", plateIn,
    "-filter_complex",
    `[1:v]format=rgba,fade=t=out:st=${round(hold - fade)}:d=${fade}:alpha=1[plate];` +
      `[0:v][plate]overlay=0:0:enable='between(t,0,${hold})'[v]`,
    "-map", "[v]", "-map", "0:a?",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    "-r", String(fps),
    "-movflags", "+faststart",
    output,
  ];
}

/** Trim the front off the master so a variant opens on a later cut. */
export function coldOpenArgs(videoIn, output, startSeconds) {
  return [
    "-y", "-i", videoIn, "-ss", String(startSeconds),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    output,
  ];
}

/**
 * Render one variant from the master.
 *
 * Returns the path and the plan that produced it, so the review card can say
 * what was done rather than only showing the result.
 */
export async function renderVariant(masterPath, outputDir, variant, {
  dim = REEL_DIM,
  fps = REEL_FPS,
  runFfmpeg = ffmpeg,
} = {}) {
  const label = variant.label;
  let source = masterPath;

  if (variant.coldOpenAt > 0) {
    const trimmed = join(outputDir, `variant-${label}-coldopen.mp4`);
    runFfmpeg(coldOpenArgs(masterPath, trimmed, variant.coldOpenAt));
    source = trimmed;
  }

  const platePath = join(outputDir, `variant-${label}-plate.png`);
  writeFileSync(platePath, await renderHookPlatePng(variant.hookLine, dim));

  const outputPath = join(outputDir, `variant-${label}.mp4`);
  runFfmpeg(overlayArgs(source, platePath, outputPath, { hold: variant.holdSeconds ?? HOOK_HOLD_SECONDS, fps }));

  return { ...variant, outputPath, platePath };
}

function longest(lines) {
  return lines.reduce((n, l) => Math.max(n, l.length), 0);
}

function escapeXml(s) {
  return String(s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}
