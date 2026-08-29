/**
 * ldt-card-gen.js — single promo cards: the story-ad format, posted to feed.
 *
 * One 1080x1350 image in the story-ad anatomy — big hook up top, one pinned
 * proof line, the price chip, the comment CTA — same navy-gradient design
 * pack as the carousels. A card is what fills a slot when a full deck was
 * posted recently: lighter, one idea, same brand.
 *
 * Copy rules are the carousel's exactly: the hook comes from the angle
 * table in the variation engine's chosen style, the proof line is a pinned
 * claim verbatim, the price is the pinned Solo line. cardText() exposes
 * every visible line for the claims gate.
 */

import { carouselAngles, hookLineFor } from "./ldt-carousel-gen.js";
import {
  FEED_W, FEED_H, ldtFrame, bigType, accentRule, resolvePalette, renderLdtSlides, esc, fitSize,
} from "./ldt-design.js";
import { SANS, measure } from "./carousel-render.js";

const MARGIN = Math.round(FEED_W * 0.11);
export const PRICE_LINE = "Solo starts at $99/mo. $0 setup.";

/**
 * A card takes one angle's hook and that angle's FIRST solution claim as its
 * proof line — one idea per card, and always a pinned sentence.
 */
export function cardCopy(angle, hookStyle, { brand = null }) {
  const keyword = brand?.cta?.keyword || "PRIMARY";
  return {
    hook: hookLineFor(angle, hookStyle),
    proof: angle.solution[0],
    price: PRICE_LINE,
    cta: `Comment ${keyword} and we'll send you the demo.`,
  };
}

/** Every visible line, for the claims gate. */
export function cardText(angle, hookStyle, { claims, brand = null }) {
  const copy = cardCopy(angle, hookStyle, { brand });
  return [copy.hook, copy.proof, copy.price, copy.cta, claims.product, claims.site].join("\n");
}

/** The card as SVG. */
export function cardSvg(angle, hookStyle, { claims, brand = null }) {
  const palette = resolvePalette(brand?.palette);
  const copy = cardCopy(angle, hookStyle, { brand });
  const maxW = FEED_W - MARGIN * 2;

  const hookSize = copy.hook.length > 60 ? 72 : 84;
  const hookTop = Math.round(FEED_H * 0.22);
  const hook = bigType({ text: copy.hook, x: MARGIN, startY: hookTop, size: hookSize, palette, w: FEED_W });
  const proofY = hookTop + hook.height + 90;
  const proof = bigType({ text: copy.proof, x: MARGIN, startY: proofY, size: 46, palette, w: FEED_W, weight: "normal" });

  // The price chip: sized FROM the measured text, never the other way round —
  // a pill whose label overflows it reads as broken on every phone at once.
  // Generous padding on the measured width: measure() is an approximation
  // (a few percent under on $-and-digit strings), and a pill must never crop
  // its own label.
  const priceSize = fitSize(copy.price, 40, maxW - 120, { factor: 1 });
  const chipTextW = Math.ceil(measure(copy.price, priceSize, 1.06));
  const chipW = Math.min(maxW, chipTextW + 108);
  const priceY = proofY + proof.height + 100;

  // The CTA wraps — it is a sentence, not a lockup.
  const ctaY = priceY + 120;
  const cta = bigType({ text: copy.cta, x: MARGIN, startY: ctaY, size: 46, palette, w: FEED_W });

  return ldtFrame({
    w: FEED_W, h: FEED_H, palette, product: claims.product, site: claims.site,
    inner:
      accentRule({ x: MARGIN, y: hookTop - hookSize - 40, palette }) + "\n  " +
      hook.svg + "\n  " +
      `<rect x="${MARGIN - 24}" y="${proofY - 62}" width="10" height="${proof.height + 34}" rx="5" fill="${palette.accent}" fill-opacity="0.9"/>\n  ` +
      proof.svg + "\n  " +
      `<rect x="${MARGIN}" y="${priceY - 52}" width="${chipW}" height="78" rx="39" fill="${palette.accent}" fill-opacity="0.14" stroke="${palette.accent}" stroke-width="2"/>\n  ` +
      `<text x="${MARGIN + 36}" y="${priceY}" font-family="${SANS}" font-size="${priceSize}" font-weight="bold" fill="${palette.accent}">${esc(copy.price)}</text>\n  ` +
      cta.svg,
  });
}

/** Render the card to PNG + JPEG with the pack's self-QC. */
export async function renderCard(angle, hookStyle, { claims, brand = null }) {
  const rendered = await renderLdtSlides([cardSvg(angle, hookStyle, { claims, brand })], { w: FEED_W, h: FEED_H });
  return { ...rendered, hookLine: hookLineFor(angle, hookStyle) };
}

export { carouselAngles };
