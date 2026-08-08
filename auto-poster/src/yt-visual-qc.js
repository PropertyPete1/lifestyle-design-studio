/**
 * yt-visual-qc.js — proving a render is actually a picture.
 *
 * A renderer that returns a 240KB PNG has proved nothing. sharp will happily
 * hand back a large, valid, entirely black image; librsvg will drop a <text>
 * element whose font it cannot resolve and report no error; a label thirty
 * characters longer than the design assumed runs off the canvas and the file
 * still writes. Every one of those is a success return with no effect, which is
 * the failure mode this project keeps paying for.
 *
 * So these checks read the PIXELS, at the size the viewer sees them.
 *
 * WHY 1080p AND NOT THE 2560px MASTER
 * The brief is "legible at 1080p", and that is a real constraint rather than a
 * formality: cards are authored on a 2560px canvas and every render is
 * downscaled before it reaches the video. Type that is comfortable at 2560 can
 * lose its thin strokes at 1920. Checking the master would pass things the
 * audience cannot read, so the master is downscaled first and every measurement
 * below is taken on the frame that actually ships.
 */

import sharp from "sharp";

export const CHECK_WIDTH = 1920;
export const CHECK_HEIGHT = 1080;

/**
 * Ink is any pixel meaningfully brighter than the near-black canvas.
 *
 * 28/255 sits above the faint background grid (which renders at about 4%
 * opacity, or ~10) and below any real type or rule. Counting the grid as ink
 * would make an otherwise blank card look populated — which is exactly the
 * result a blank-detector must not produce.
 */
const INK_THRESHOLD = 28;

/**
 * A card with less ink than this is empty in all but file size.
 *
 * Set from measurement, not taste, and RAISED once after a measurement that
 * contradicted the first choice.
 *
 * Real content renders between 0.89% (TIMELINE) and 2.79% (CALLOUT). Chrome
 * alone — the header rule, the row dividers, the bullet dots, with every label
 * blank — renders between 0.12% and 0.31%, and NUMBER_BREAKDOWN's dividers put
 * it at 0.31%, which cleared the original 0.25% floor. A card of pure furniture
 * with nothing readable on it passed QC.
 *
 * 0.55% sits in the empty band between the two populations: 78% above the
 * worst chrome-only card, 38% below the sparsest real one. Both margins are
 * wide enough that neither a slightly busier chrome nor a slightly sparser card
 * crosses it.
 *
 * The spec normaliser rejects blank content before it can ever be drawn, so
 * this is defence in depth rather than the primary guard — but it is the LAST
 * thing between a render and the screen, and it should not be the layer that
 * waves through an empty rectangle.
 */
const MIN_INK_RATIO = 0.0055;

/** More than this and something has filled the frame — a solid block, not type. */
const MAX_INK_RATIO = 0.55;

/**
 * How far in from the edge nothing may be drawn, at 1080p.
 *
 * Scaled from the card renderer's SAFE_MARGIN (90px on a 2560 canvas), minus a
 * couple of pixels of tolerance for resampling bleed on antialiased glyph
 * edges near the boundary.
 */
const EDGE_BAND = Math.round((90 * CHECK_WIDTH) / 2560) - 4;

/**
 * Inspect a rendered PNG.
 *
 * Never throws on a bad picture — returns a verdict. The caller's correct
 * response to a failed visual is to play footage, not to stop the build, and a
 * function that threw would make that harder to get right.
 *
 * @returns {{ ok: boolean, failures: string[], metrics: object }}
 */
export async function inspectRender(png, { label = "render", edgeCheck = true } = {}) {
  const failures = [];
  const metrics = {};

  let data, info;
  try {
    // Downscale to what ships, then read greyscale bytes.
    ({ data, info } = await sharp(png)
      .resize(CHECK_WIDTH, CHECK_HEIGHT, { fit: "fill" })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true }));
  } catch (err) {
    return { ok: false, failures: [`unreadable image: ${err.message}`], metrics };
  }

  const { width, height } = info;
  let ink = 0;
  let edgeInk = 0;
  let min = 255;
  let max = 0;

  for (let y = 0; y < height; y++) {
    const inEdgeRow = y < EDGE_BAND || y >= height - EDGE_BAND;
    for (let x = 0; x < width; x++) {
      const v = data[y * width + x];
      if (v < min) min = v;
      if (v > max) max = v;
      if (v < INK_THRESHOLD) continue;
      ink++;
      if (inEdgeRow || x < EDGE_BAND || x >= width - EDGE_BAND) edgeInk++;
    }
  }

  const total = width * height;
  metrics.inkRatio = round(ink / total);
  metrics.edgeInkPixels = edgeInk;
  metrics.range = max - min;

  // 1. Non-blank. A single flat colour has no range at all.
  if (metrics.range <= 8) failures.push(`blank: pixel range is ${metrics.range}`);

  // 2. Populated, but not flooded.
  if (metrics.inkRatio < MIN_INK_RATIO) {
    failures.push(`almost empty: ${(metrics.inkRatio * 100).toFixed(2)}% ink, expected at least ${(MIN_INK_RATIO * 100).toFixed(2)}%`);
  }
  if (metrics.inkRatio > MAX_INK_RATIO) {
    failures.push(`flooded: ${(metrics.inkRatio * 100).toFixed(1)}% ink`);
  }

  // 3. Nothing in the safe margin. Ink at the edge means something overflowed —
  //    a long label, an underline sized from a mis-measured string, a value
  //    that pushed past the frame. This is the check that catches clipping
  //    without needing to know what was supposed to be drawn.
  //    A handful of pixels is antialiasing; a run of them is a clipped word.
  //
  //    OFF for maps. A map is supposed to bleed: Loop 410 does not stop at the
  //    frame, and roads running off the edge is what makes it read as a map
  //    rather than a diagram floating in a box. Maps are still checked for
  //    clipped TEXT by findOverflowingText, which is the part that matters.
  if (edgeCheck && edgeInk > 400) {
    failures.push(`content in the safe margin: ${edgeInk} ink pixels within ${EDGE_BAND}px of the edge`);
  }

  return { ok: failures.length === 0, failures: failures.map((f) => `${label}: ${f}`), metrics };
}

/**
 * A layout-time check that no text was asked to draw outside the content box.
 *
 * Complements the pixel check rather than duplicating it. The pixel check knows
 * something overflowed but not what; this reads the SVG source and names the
 * string, which is the difference between a diagnosable failure and a
 * mysterious one. It is also the only one of the two that can run before an
 * expensive rasterise.
 */
export function findOverflowingText(svg, { width = 2560, safeMargin = 90 } = {}) {
  const offenders = [];
  const re = /<text\s+x="([\d.-]+)"[^>]*font-size="([\d.]+)"[^>]*text-anchor="(\w+)"[^>]*>([^<]*)<\/text>/g;
  let m;
  while ((m = re.exec(svg))) {
    const x = parseFloat(m[1]);
    const size = parseFloat(m[2]);
    const anchor = m[3];
    const content = m[4];
    if (!content.trim()) continue;

    // A generous per-character estimate. The point is to catch a label that is
    // wildly out, not to re-derive the metrics table.
    const w = content.length * size * 0.52;
    const left = anchor === "middle" ? x - w / 2 : anchor === "end" ? x - w : x;
    const right = left + w;
    if (left < safeMargin - 20 || right > width - safeMargin + 20) {
      offenders.push({ text: content.slice(0, 48), left: Math.round(left), right: Math.round(right) });
    }
  }
  return offenders;
}

/**
 * Mean absolute greyscale difference between two images, 0-255.
 *
 * Exported because it is the only honest way to prove a moving picture MOVES.
 * ffmpeg will accept a zoom expression that is a constant, produce a clip of
 * exactly the right size and duration, and fill it with identical frames — and
 * every check short of comparing pixels reports success. Lives here rather than
 * in a probe so callers outside auto-poster/ can use it without resolving sharp
 * from their own directory, which is a real problem for longform/probe/.
 */
export async function frameDifference(pngA, pngB) {
  const [a, b] = await Promise.all([
    sharp(pngA).greyscale().raw().toBuffer(),
    sharp(pngB).greyscale().raw().toBuffer(),
  ]);
  if (a.length !== b.length) throw new Error(`frames differ in size: ${a.length} vs ${b.length} bytes`);
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

/** A flat single-colour PNG of the given size. Used to prove blank detection works. */
export async function solidPng(width, height, background = "#000") {
  return sharp({ create: { width, height, channels: 3, background } }).png().toBuffer();
}

function round(n) {
  return Math.round(n * 10000) / 10000;
}
