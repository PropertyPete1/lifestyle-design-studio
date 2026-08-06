/**
 * yt-thumbnail.js — the 1280x720 gold-on-black thumbnail.
 *
 * Reuses the carousel's brand tokens and text metrics, but composes its own
 * canvas: carousel-render.js is built around a 1080x1350 portrait frame with
 * WIDTH/HEIGHT baked into its grid and frame helpers, and parameterising those
 * would mean touching the renderer that ships a live post every morning.
 * Sharing the BRAND file and the measurement functions gets the reuse that
 * matters — one palette, one text-fitting rule — without that risk.
 *
 * WHAT A THUMBNAIL HAS TO DO, which is not what a carousel slide does:
 * It is seen at about 210x118 pixels in a search result, next to eleven others.
 * That drives every decision here:
 *   - three or four words, not a sentence. A carousel slide is read; a
 *     thumbnail is glanced at.
 *   - type large enough to survive the shrink, which is why the size is fitted
 *     to the text rather than fixed.
 *   - Peter's face on one side, because a face is what separates a thumbnail
 *     from a title card, and the text kept clear of it.
 *   - gold on black, which is the brand and also happens to be the highest
 *     contrast pair available on a white search page.
 */

import sharp from "sharp";
import { BRAND, measure, wrapText, BOLD_SERIF } from "./carousel-render.js";

export const WIDTH = 1280;
export const HEIGHT = 720;

const C = BRAND.colors;
const BG = "#000000";
const INK = C.ink;
const ACCENT = C.accent;
const ACCENT_DIM = C.accentDim;
const SERIF = "Georgia, 'DejaVu Serif', 'Liberation Serif', 'Times New Roman', serif";
const SANS = "'Helvetica Neue', Helvetica, 'DejaVu Sans', 'Liberation Sans', Arial, sans-serif";

const MARGIN = 64;
/** The right third is reserved for Peter. Text lives in the remaining width. */
const PORTRAIT_SHARE = 0.36;
const TEXT_W = Math.round(WIDTH * (1 - PORTRAIT_SHARE)) - MARGIN * 2;

/** At search-result size, more than this is unreadable. Hard cap, not a hint. */
export const MAX_WORDS = 5;
export const MAX_LINES = 3;

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/**
 * Cut a title down to thumbnail length.
 *
 * A thumbnail is not a title — it is the two or three words that make someone
 * stop. Dropping the city and the filler leaves the part that carries meaning.
 */
export function thumbnailText(raw, { maxWords = MAX_WORDS } = {}) {
  let text = String(raw || "").trim();
  // Everything before a colon is usually the topic label ("Moving to San
  // Antonio: what $300k gets you") and the payload is after it.
  if (text.includes(":")) {
    const after = text.split(":").slice(1).join(":").trim();
    if (after.split(/\s+/).length >= 3) text = after;
  }
  const filler = new Set(["the", "a", "an", "of", "in", "to", "for", "and", "is", "are", "what", "that", "you"]);
  let words = text.split(/\s+/).filter(Boolean);
  if (words.length > maxWords) {
    const trimmed = words.filter((w) => !filler.has(w.toLowerCase().replace(/[^a-z]/gi, "")));
    words = (trimmed.length >= 2 ? trimmed : words).slice(0, maxWords);
  }
  return words.join(" ").toUpperCase();
}

/**
 * Largest size at which the text fits the box in at most MAX_LINES.
 *
 * Fitted rather than fixed because a two-word thumbnail and a five-word one
 * need very different type to look deliberate at the same scale.
 */
export function fitSize(text, { maxWidth = TEXT_W, maxLines = MAX_LINES, start = 132, min = 54 } = {}) {
  for (let size = start; size >= min; size -= 2) {
    const lines = wrapText(text, size, maxWidth, BOLD_SERIF);
    if (lines.length <= maxLines && lines.every((l) => measure(l, size, BOLD_SERIF) <= maxWidth)) {
      return { size, lines };
    }
  }
  return { size: min, lines: wrapText(text, min, maxWidth, BOLD_SERIF).slice(0, maxLines) };
}

function grid(width) {
  const { step, opacity } = BRAND.grid;
  const parts = [];
  for (let x = step; x < width; x += step) {
    parts.push(`<line x1="${x}" y1="0" x2="${x}" y2="${HEIGHT}" stroke="${INK}" stroke-opacity="${opacity}" stroke-width="1"/>`);
  }
  for (let y = step; y < HEIGHT; y += step) {
    parts.push(`<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="${INK}" stroke-opacity="${opacity}" stroke-width="1"/>`);
  }
  return parts.join("");
}

/**
 * The thumbnail SVG.
 *
 * `hasPortrait` shifts nothing about the text box — the layout reserves the
 * right third either way, so a thumbnail rendered without a frame of Peter has
 * the same composition as one with him, just emptier. That keeps the two
 * versions comparable rather than producing a different design when a frame
 * cannot be extracted.
 */
export function thumbnailSvg(title, { kicker = null, hasPortrait = true } = {}) {
  const text = thumbnailText(title);
  const { size, lines } = fitSize(text);
  const lineHeight = Math.round(size * 1.06);

  // Vertical centring has to use the CAP HEIGHT, not the font size. An
  // uppercase serif occupies roughly 0.72em above the baseline and almost
  // nothing below it, so centring on the em box leaves the block visibly high —
  // which is exactly what the first render did.
  const capHeight = size * 0.72;
  const visualHeight = (lines.length - 1) * lineHeight + capHeight;
  const firstBaseline = Math.round((HEIGHT - visualHeight) / 2 + capHeight);

  const textLines = lines
    .map((line, i) =>
      `<text x="${MARGIN}" y="${firstBaseline + i * lineHeight}" font-family="${SERIF}" font-size="${size}" ` +
      `font-weight="bold" fill="${INK}">${esc(line)}</text>`
    )
    .join("\n  ");

  // The kicker belongs to the headline, so it sits a fixed gap above the cap
  // line rather than floating at a position derived from the block height.
  const KICKER_SIZE = 30;
  const kickerBlock = kicker
    ? `<text x="${MARGIN}" y="${Math.round(firstBaseline - capHeight - 30)}" font-family="${SANS}" font-size="${KICKER_SIZE}" ` +
      `font-weight="bold" letter-spacing="4" fill="${ACCENT}">${esc(String(kicker).toUpperCase())}</text>`
    : "";

  const ruleY = firstBaseline + (lines.length - 1) * lineHeight + Math.round(size * 0.26);
  const ruleW = Math.round(TEXT_W * 0.42);

  // THE BACKGROUND MUST NOT COVER THE PORTRAIT.
  //
  // The first version painted a full-canvas black rect as the SVG's first
  // element and composited that over the photo — producing a thumbnail with no
  // face on it, which is the one thing a thumbnail needs. When a portrait is
  // present the opaque background and the grid stop short of the portrait
  // column, and a gradient bridges the seam so a bright frame of Peter does not
  // fight the type at search-result size.
  const seam = Math.round(WIDTH * (1 - PORTRAIT_SHARE));
  const opaqueW = hasPortrait ? seam : WIDTH;
  const scrim = hasPortrait
    ? `<defs><linearGradient id="scrim" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${BG}" stop-opacity="1"/>
      <stop offset="100%" stop-color="${BG}" stop-opacity="0"/>
    </linearGradient></defs>
  <rect x="${seam}" y="0" width="200" height="${HEIGHT}" fill="url(#scrim)"/>`
    : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  ${scrim}
  <rect x="0" y="0" width="${opaqueW}" height="${HEIGHT}" fill="${BG}"/>
  ${grid(opaqueW)}
  ${kickerBlock}
  ${textLines}
  <rect x="${MARGIN}" y="${ruleY}" width="${ruleW}" height="6" rx="3" fill="${ACCENT}"/>
  <rect x="0" y="${HEIGHT - 10}" width="${WIDTH}" height="10" fill="${ACCENT_DIM}" fill-opacity="0.8"/>
</svg>`;
}

/**
 * Render the finished PNG, compositing a frame of Peter when one is supplied.
 *
 * The portrait is cropped to the reserved column and composited UNDER the SVG,
 * so the scrim and the type always sit on top of it — the alternative, drawing
 * the SVG first, puts the grid lines over his face.
 */
export async function renderThumbnail(title, { kicker = null, portraitPng = null } = {}) {
  const columnW = Math.round(WIDTH * PORTRAIT_SHARE);
  const svg = Buffer.from(thumbnailSvg(title, { kicker, hasPortrait: Boolean(portraitPng) }));

  if (!portraitPng) {
    return sharp(svg).png({ compressionLevel: 9 }).toBuffer();
  }

  const portrait = await sharp(portraitPng)
    .resize(columnW, HEIGHT, { fit: "cover", position: "attention" })
    .toBuffer();

  return sharp({ create: { width: WIDTH, height: HEIGHT, channels: 4, background: BG } })
    .composite([
      { input: portrait, left: WIDTH - columnW, top: 0 },
      { input: svg, left: 0, top: 0 },
    ])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/** YouTube rejects a custom thumbnail over 2MB. */
export const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;

/**
 * Keep the PNG under YouTube's 2MB ceiling.
 *
 * A gold-on-black graphic compresses to well under that, but a composited
 * photo of Peter can push it over — and YouTube rejects the thumbnail rather
 * than resizing it, which would leave the video with an auto-generated frame
 * grab nobody chose.
 */
export async function fitUnderLimit(pngBuffer, limit = MAX_THUMBNAIL_BYTES) {
  if (pngBuffer.length <= limit) return { buffer: pngBuffer, converted: false };
  for (const quality of [92, 85, 78, 70]) {
    const jpeg = await sharp(pngBuffer).jpeg({ quality, chromaSubsampling: "4:4:4", mozjpeg: true }).toBuffer();
    if (jpeg.length <= limit) {
      console.log(`[YTThumbnail] ${(pngBuffer.length / 1024).toFixed(0)}KB PNG -> ${(jpeg.length / 1024).toFixed(0)}KB JPEG q${quality}`);
      return { buffer: jpeg, converted: true, quality };
    }
  }
  throw new Error(`thumbnail will not fit under ${limit} bytes`);
}

/**
 * Pull a frame of Peter out of one of his own recorded takes.
 *
 * Deliberately takes a frame from an ON_CAMERA take rather than from B-roll:
 * the point of a face on a thumbnail is that it is the person talking. Which
 * frame is a judgement call the caller makes — this just extracts it.
 */
export function framePngPath(workDir, index = 0) {
  return `${workDir}/thumb-frame-${index}.png`;
}
