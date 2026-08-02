/**
 * carousel-render.js — slide deck to 1080x1350 PNGs, and PNGs to a PDF.
 *
 * Slides are composed as SVG and rasterised with sharp (already a dependency).
 * Four layouts: hook, mind-map, numbered point, CTA.
 *
 * SVG has no text wrapping, so lines are broken here using an approximate
 * per-character advance table. It does not need to be exact — the design uses
 * generous whitespace and short lines specifically so that a few percent of
 * metric error never reaches the edge of the canvas.
 *
 * Font: librsvg resolves against system fonts, and a GitHub runner is not
 * guaranteed to have Georgia. The stack degrades through DejaVu and Liberation,
 * both of which ship on ubuntu-latest, before falling back to generic serif.
 */

import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

export const WIDTH = 1080;
export const HEIGHT = 1350;

/**
 * Slide colours come from carousel-brand.json, which carries the palette
 * extracted from the live site. Nothing below hardcodes a brand colour — a
 * palette change is one edit to that file, not template surgery.
 */
const BRAND_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "carousel-brand.json");
export const BRAND = JSON.parse(readFileSync(BRAND_PATH, "utf-8"));

const C = BRAND.colors;

// The canvas is pure black rather than the brand's #0A0A0C: feeds composite
// thumbnails against #000, and a near-black that is a few percent off reads as
// a visible grey card. See _adapted in carousel-brand.json.
const BG = "#000000";
const INK = C.ink;
const MUTED = C.muted;
const SERIF = "Georgia, 'DejaVu Serif', 'Liberation Serif', 'Times New Roman', serif";
const SANS = "'Helvetica Neue', Helvetica, 'DejaVu Sans', 'Liberation Sans', Arial, sans-serif";

/** Accents in rotation. The brand resolves to a single gold, so this is one entry. */
export const ACCENTS = BRAND.accentRotation;

/** Supporting tone for secondary rules — a support colour on the site, not an accent. */
export const ACCENT_DIM = C.accentDim;

export function accentFor(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dayNumber = Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
  return ACCENTS[((dayNumber % ACCENTS.length) + ACCENTS.length) % ACCENTS.length];
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// ─── Text measurement ───────────────────────────────────────────────────────

const NARROW = new Set("ijlt.,;:'\"!|()[]{}/\\`".split(""));
const WIDE = new Set("WMQ@%mw".split(""));

/**
 * Per-style width multipliers correcting the character table below.
 *
 * These are FONT-SPECIFIC and calibrated for the CI runner, where the font
 * stack resolves to DejaVu. They were originally fitted on macOS, where it
 * resolves to Helvetica and Georgia — which are enough narrower that real
 * headlines and body lines clipped at the canvas edge once rendered on ubuntu.
 *
 * Values are the worst measured ratio plus 5% margin, from
 * scripts/calibrate-text-metrics.mjs run on the runner:
 *   bold serif   worst 1.315
 *   sans body    worst 1.176
 *   italic serif worst 1.190
 *
 * Re-run that script and update these if the layouts or the runner image
 * change. Over-estimating only costs a slightly smaller font; under-estimating
 * pushes text off the slide.
 */
export const BOLD_SERIF = 1.38;
export const SANS_BODY = 1.24;
export const ITALIC_SERIF = 1.25;

/** Approximate advance width of a string at a given font size. */
export function measure(text, fontSize, factor = 1) {
  let units = 0;
  for (const ch of String(text)) {
    if (ch === " ") units += 0.27;
    else if (NARROW.has(ch)) units += 0.30;
    else if (WIDE.has(ch)) units += 0.88;
    else if (ch >= "A" && ch <= "Z") units += 0.68;
    else if (ch >= "0" && ch <= "9") units += 0.55;
    else units += 0.50;
  }
  return units * fontSize * factor;
}

/** Greedy word wrap to a pixel width. Long single words are left intact. */
export function wrapText(text, fontSize, maxWidth, factor = 1) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines = [];
  let line = words[0];
  for (const word of words.slice(1)) {
    const candidate = `${line} ${word}`;
    if (measure(candidate, fontSize, factor) <= maxWidth) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
    }
  }
  lines.push(line);
  return lines;
}

/**
 * Shrink the font until the wrapped block fits a line budget.
 * Keeps long hooks on-canvas instead of letting them overflow.
 */
function fitText(text, { start, min, maxWidth, maxLines, factor = 1 }) {
  let size = start;
  let lines = wrapText(text, size, maxWidth, factor);
  while (lines.length > maxLines && size > min) {
    size -= 4;
    lines = wrapText(text, size, maxWidth, factor);
  }
  return { size, lines, factor };
}

// ─── Chrome ─────────────────────────────────────────────────────────────────

/** Faint grid, drawn once per slide behind everything else. */
function grid() {
  const { step, opacity } = BRAND.grid;
  const parts = [];
  for (let x = step; x < WIDTH; x += step) {
    parts.push(`<line x1="${x}" y1="0" x2="${x}" y2="${HEIGHT}" stroke="${INK}" stroke-opacity="${opacity}" stroke-width="1"/>`);
  }
  for (let y = step; y < HEIGHT; y += step) {
    parts.push(`<line x1="0" y1="${y}" x2="${WIDTH}" y2="${y}" stroke="${INK}" stroke-opacity="${opacity}" stroke-width="1"/>`);
  }
  return parts.join("");
}

function frame(inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${BG}"/>
  ${grid()}
  ${inner}
</svg>`;
}

/** A thin accent rule, used under headlines and as a divider. */
function rule(x, y, w, accent, opacity = 1) {
  return `<rect x="${x}" y="${y}" width="${w}" height="3" rx="1.5" fill="${accent}" fill-opacity="${opacity}"/>`;
}

function textLine(x, y, content, { size, fill = INK, family = SERIF, weight = "normal", anchor = "start", style = "normal", opacity = 1 }) {
  return `<text x="${x}" y="${y}" font-family="${family}" font-size="${size}" font-weight="${weight}" font-style="${style}" fill="${fill}" fill-opacity="${opacity}" text-anchor="${anchor}">${esc(content)}</text>`;
}

const MARGIN = 96;
const CONTENT_W = WIDTH - MARGIN * 2;

// ─── Layouts ────────────────────────────────────────────────────────────────

/** Layout 1 — the hook. Oversized serif, accent rule under the final line. */
export function hookSvg(hook, accent) {
  const { size, lines } = fitText(hook, { start: 92, min: 56, maxWidth: CONTENT_W, maxLines: 5, factor: BOLD_SERIF });
  const lineHeight = size * 1.22;
  const blockH = lines.length * lineHeight;
  const startY = (HEIGHT - blockH) / 2 + size * 0.78;

  const body = lines
    .map((l, i) => textLine(MARGIN, startY + i * lineHeight, l, { size, weight: "bold" }))
    .join("\n  ");

  const lastWidth = Math.min(measure(lines[lines.length - 1], size, BOLD_SERIF), CONTENT_W);
  const underlineY = startY + (lines.length - 1) * lineHeight + size * 0.30;

  return frame(`
  ${body}
  ${rule(MARGIN, underlineY, lastWidth, accent)}
  ${textLine(MARGIN, HEIGHT - 84, "swipe", { size: 30, family: SANS, fill: MUTED })}
  ${rule(MARGIN + 92, HEIGHT - 94, 46, ACCENT_DIM)}
`);
}

/** Layout 2 — the mind map. Fragments hang off a vertical spine. */
export function mapSvg(fragments, accent) {
  const items = fragments.slice(0, 6);
  // Centre the node stack in the space below the header rather than starting at
  // a fixed offset — a 4-item map and a 6-item map should both sit balanced.
  const regionTop = 300;
  const regionBottom = HEIGHT - 200;
  const gap = Math.min(150, (regionBottom - regionTop) / Math.max(items.length, 1));
  const stackH = (items.length - 1) * gap;
  const top = regionTop + (regionBottom - regionTop - stackH) / 2;
  const spineX = MARGIN + 26;

  const nodes = items.map((fragment, i) => {
    const y = top + i * gap;
    const { size, lines } = fitText(fragment, { start: 46, min: 32, maxWidth: CONTENT_W - 120, maxLines: 2, factor: BOLD_SERIF });
    const text = lines
      .map((l, li) => textLine(spineX + 78, y + li * size * 1.18, l, { size, weight: "bold" }))
      .join("\n  ");
    return `
  <line x1="${spineX}" y1="${y - size * 0.32}" x2="${spineX + 54}" y2="${y - size * 0.32}" stroke="${accent}" stroke-width="2" stroke-opacity="0.75"/>
  <circle cx="${spineX}" cy="${y - size * 0.32}" r="7" fill="${accent}"/>
  ${text}`;
  }).join("");

  const spineTop = top - 30;
  const spineBottom = top + (items.length - 1) * gap - 10;

  return frame(`
  ${textLine(MARGIN, 168, "What's inside", { size: 40, family: SANS, fill: MUTED })}
  ${rule(MARGIN, 196, 120, accent)}
  <line x1="${spineX}" y1="${spineTop}" x2="${spineX}" y2="${spineBottom}" stroke="${accent}" stroke-width="2" stroke-opacity="0.35"/>
  ${nodes}
`);
}

/** Layout 3 — a numbered point. Counter, title with rule, body, loop at the foot. */
export function pointSvg(point, index, total, accent) {
  const counter = `${index} of ${total}`;
  const title = fitText(point.title, { start: 76, min: 50, maxWidth: CONTENT_W, maxLines: 3, factor: BOLD_SERIF });
  const titleLH = title.size * 1.20;

  const loop = fitText(point.loop, { start: 40, min: 30, maxWidth: CONTENT_W, maxLines: 2, factor: ITALIC_SERIF });
  const loopY = HEIGHT - 150 - (loop.lines.length - 1) * loop.size * 1.2;

  // Pre-wrap the body so the title+body block can be centred as one unit in the
  // space between the header and the pinned loop. Laying it out top-down from a
  // fixed y leaves short slides bottom-heavy with dead space.
  const bodyLines = [];
  for (const line of point.body || []) {
    const { size, lines } = fitText(line, { start: 42, min: 32, maxWidth: CONTENT_W, maxLines: 3, factor: SANS_BODY });
    for (const l of lines) bodyLines.push({ text: l, size });
    if (lines.length) bodyLines[bodyLines.length - 1].trailing = 14;
  }

  const titleH = (title.lines.length - 1) * titleLH;
  const ruleToBody = 106;
  const bodyH = bodyLines.reduce((sum, b) => sum + b.size * 1.42 + (b.trailing || 0), 0);
  const blockH = titleH + ruleToBody + bodyH;

  const regionTop = 268;
  const regionBottom = loopY - 90;
  const titleY = regionTop + Math.max(0, (regionBottom - regionTop - blockH) / 2) + title.size * 0.6;

  const titleBlock = title.lines
    .map((l, i) => textLine(MARGIN, titleY + i * titleLH, l, { size: title.size, weight: "bold" }))
    .join("\n  ");

  const titleEndY = titleY + titleH;
  const lastTitleW = Math.min(measure(title.lines[title.lines.length - 1], title.size, BOLD_SERIF), CONTENT_W);

  let cursor = titleEndY + ruleToBody;
  const bodyParts = [];
  for (const b of bodyLines) {
    bodyParts.push(textLine(MARGIN, cursor, b.text, { size: b.size, family: SANS, fill: INK, opacity: 0.88 }));
    cursor += b.size * 1.42 + (b.trailing || 0);
  }
  const loopBlock = loop.lines
    .map((l, i) => textLine(MARGIN, loopY + i * loop.size * 1.2, l, { size: loop.size, style: "italic", fill: accent }))
    .join("\n  ");

  return frame(`
  ${textLine(MARGIN, 168, counter, { size: 34, family: SANS, fill: MUTED })}
  ${rule(MARGIN, 196, 74, accent)}
  ${titleBlock}
  ${rule(MARGIN, titleEndY + 30, lastTitleW, accent)}
  ${bodyParts.join("\n  ")}
  ${loopBlock}
`);
}

/** Layout 4 — the CTA. Keyword is the visual anchor. */
export function ctaSvg(keyword, payoff, accent) {
  const payoffFit = fitText(payoff, { start: 50, min: 36, maxWidth: CONTENT_W, maxLines: 3, factor: SANS_BODY });
  const kwSize = 132;
  const kwWidth = Math.min(measure(keyword, kwSize, BOLD_SERIF), CONTENT_W);

  // Centre the whole CTA stack between the top of the canvas and the pinned
  // "Save this for later." footer, so a long payoff doesn't crowd the footer and
  // a short one doesn't leave a hole.
  const payoffH = payoffFit.lines.length * payoffFit.size * 1.35;
  const blockH = 150 + kwSize + 116 + payoffH;
  const regionTop = 200;
  const regionBottom = HEIGHT - 260;
  const blockTop = regionTop + Math.max(0, (regionBottom - regionTop - blockH) / 2);

  const commentY = blockTop + 56;
  const kwY = commentY + 150;
  const dmY = kwY + 116;
  const payoffY = dmY + 64;

  const payoffBlock = payoffFit.lines
    .map((l, i) => textLine(MARGIN, payoffY + i * payoffFit.size * 1.35, l, { size: payoffFit.size, family: SANS, opacity: 0.9 }))
    .join("\n  ");

  return frame(`
  ${textLine(MARGIN, commentY, "Comment", { size: 56, fill: INK, opacity: 0.85 })}
  ${textLine(MARGIN, kwY, keyword, { size: kwSize, weight: "bold", fill: accent })}
  ${rule(MARGIN, kwY + 34, kwWidth, accent)}
  ${textLine(MARGIN, dmY, "and I'll DM you", { size: 46, fill: INK, opacity: 0.75 })}
  ${payoffBlock}
  ${rule(MARGIN, HEIGHT - 214, 120, ACCENT_DIM)}
  ${textLine(MARGIN, HEIGHT - 150, "Save this for later.", { size: 42, family: SANS, fill: MUTED })}
`);
}

// ─── Deck assembly ──────────────────────────────────────────────────────────

/** Build the SVG source for every slide in a deck, in order. */
export function deckToSvgs(deck, keyword, accent) {
  const svgs = [hookSvg(deck.hook, accent), mapSvg(deck.map, accent)];
  const total = deck.points.length;
  deck.points.forEach((p, i) => svgs.push(pointSvg(p, i + 1, total, accent)));
  svgs.push(ctaSvg(keyword, deck.cta.payoff, accent));
  return svgs;
}

/** Rasterise SVG sources to PNG buffers at 1080x1350. */
export async function renderSvgs(svgs) {
  const out = [];
  for (const svg of svgs) {
    out.push(await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer());
  }
  return out;
}

export async function renderDeck(deck, keyword, accent) {
  return renderSvgs(deckToSvgs(deck, keyword, accent));
}

/**
 * Assemble PNG slides into a PDF, one full-bleed page per slide.
 * This is what LinkedIn publishes as a document post.
 */
export async function buildPdf(pngBuffers, title = "Carousel") {
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  for (const png of pngBuffers) {
    const image = await pdf.embedPng(png);
    const page = pdf.addPage([WIDTH, HEIGHT]);
    page.drawImage(image, { x: 0, y: 0, width: WIDTH, height: HEIGHT });
  }
  return Buffer.from(await pdf.save());
}

/** True when a PNG has more than one distinct colour — i.e. it isn't blank. */
export async function isNonBlank(pngBuffer) {
  const stats = await sharp(pngBuffer).stats();
  return stats.channels.some((c) => c.max - c.min > 8);
}
