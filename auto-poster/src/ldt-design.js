/**
 * ldt-design.js — the LDT self-made design system, in one place.
 *
 * The reference is the posted 8-slide "leads going cold" carousel: a deep
 * NAVY GRADIENT ground, the GREEN DOT mark with the product name beside it,
 * and big clean sans type with room to breathe. Every self-made surface —
 * narrative carousels, single promo cards, text-motion reel plates — draws
 * from this pack, so the three formats read as one brand rather than three
 * experiments.
 *
 * Same discipline as carousel-render.js on the realty side: slides are SVG
 * strings rasterised with sharp, text is wrapped with the SAME measure()
 * metrics the realty carousel uses (two wrapping systems on one repo is how
 * type starts overflowing on exactly one surface), and nothing here talks to
 * a network or a model — pure functions in, image buffers out.
 *
 * PALETTE. The navy gradient is the design's own (it IS the established
 * look); ink/muted/accent accept overrides from brands.json's palette so a
 * brand-level accent change propagates without template surgery. The accent
 * default matches the green already pinned there (#5EE0A0).
 */

import sharp from "sharp";
import { WIDTH as FEED_W, HEIGHT as FEED_H, SANS, wrapText, measure } from "./carousel-render.js";

export { FEED_W, FEED_H };

/** Reel/story canvas. */
export const REEL_W = 1080;
export const REEL_H = 1920;

export const LDT_PALETTE = {
  navyTop: "#0A1626",
  navyBottom: "#14304F",
  ink: "#F4F7FB",
  muted: "#8FA3BC",
  accent: "#5EE0A0",
};

/** Merge a brands.json palette over the defaults (navy stops stay the pack's). */
export function resolvePalette(brandPalette = null) {
  return {
    ...LDT_PALETTE,
    ...(brandPalette?.ink ? { ink: brandPalette.ink } : {}),
    ...(brandPalette?.muted ? { muted: brandPalette.muted } : {}),
    ...(brandPalette?.accent ? { accent: brandPalette.accent } : {}),
  };
}

export const esc = (s) => String(s ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&apos;");

/**
 * The shared frame: navy gradient ground, dot mark + product name top-left,
 * site footer bottom-left. `inner` is the slide's own content.
 */
export function ldtFrame({ w, h, palette, product, site, inner, footerExtra = "" }) {
  const margin = Math.round(w * 0.11);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="ldtNavy" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${palette.navyTop}"/>
      <stop offset="1" stop-color="${palette.navyBottom}"/>
    </linearGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#ldtNavy)"/>
  <circle cx="${margin + 16}" cy="${Math.round(h * 0.085)}" r="16" fill="${palette.accent}"/>
  <text x="${margin + 52}" y="${Math.round(h * 0.085) + 12}" font-family="${SANS}" font-size="34" font-weight="bold" letter-spacing="7" fill="${palette.ink}">${esc(product)}</text>
  ${inner}
  <text x="${margin}" y="${h - Math.round(h * 0.06)}" font-family="${SANS}" font-size="30" fill="${palette.muted}">${esc(site)}</text>${footerExtra}
</svg>`;
}

/** Progress dots for a deck (slide i of n), sitting above the footer. */
export function progressDots({ w, h, palette, index, total }) {
  const margin = Math.round(w * 0.11);
  const y = h - Math.round(h * 0.06) - 64;
  const dots = [];
  for (let i = 0; i < total; i++) {
    dots.push(`<circle cx="${margin + i * 34}" cy="${y}" r="8" fill="${i === index ? palette.accent : palette.muted}" fill-opacity="${i === index ? 1 : 0.45}"/>`);
  }
  return dots.join("");
}

/**
 * A big-type text block, wrapped with the carousel's own metrics. Returns
 * the SVG and the height consumed, so slides can stack blocks without
 * measuring twice.
 */
export function bigType({ text, x, startY, size, palette, w, weight = "bold", fill = null, lineFactor = 1.24 }) {
  const lines = wrapText(String(text), size, w - x * 2, lineFactor);
  const lineHeight = Math.round(size * 1.22);
  const svg = lines.map((line, i) =>
    `<text x="${x}" y="${startY + i * lineHeight}" font-family="${SANS}" font-size="${size}" font-weight="${weight}" fill="${fill || palette.ink}">${esc(line)}</text>`
  ).join("\n  ");
  return { svg, height: lines.length * lineHeight, lines };
}

/** Green accent rule — the pack's underline mark. */
export function accentRule({ x, y, palette, width = 84 }) {
  return `<rect x="${x}" y="${y}" width="${width}" height="6" rx="3" fill="${palette.accent}"/>`;
}

/**
 * The font size at which ONE line of text fits maxWidth — the preferred size
 * when it already fits, shrunk proportionally when it does not. For lines
 * that must stay single ("Comment PRIMARY" on a CTA): a keyword change in
 * brands.json must resize the type, never walk it off the canvas.
 */
export function fitSize(text, preferredSize, maxWidth, { factor = 1, minSize = 24 } = {}) {
  const width = measure(String(text), preferredSize, factor);
  if (width <= maxWidth) return preferredSize;
  return Math.max(minSize, Math.floor(preferredSize * (maxWidth / width)));
}

/**
 * Rasterise SVG slides to PNG and JPEG (TikTok rejects PNG at publish time —
 * the daily carousel's lesson), then SELF-QC every rendered file: exact
 * expected dimensions and a non-blank size. A deck that fails its own
 * measurement never leaves this function.
 */
export async function renderLdtSlides(svgs, { w, h }) {
  const pngs = [];
  const jpegs = [];
  for (const [i, svg] of svgs.entries()) {
    const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
    const meta = await sharp(png).metadata();
    if (meta.width !== w || meta.height !== h) {
      throw new Error(`[LDT Design] Slide ${i + 1} rendered ${meta.width}x${meta.height}, expected ${w}x${h}`);
    }
    if (png.length < 5000) {
      throw new Error(`[LDT Design] Slide ${i + 1} is ${png.length} bytes — render likely produced a blank frame`);
    }
    pngs.push(png);
    jpegs.push(await sharp(png).jpeg({ quality: 92 }).toBuffer());
  }
  return { pngs, jpegs };
}
