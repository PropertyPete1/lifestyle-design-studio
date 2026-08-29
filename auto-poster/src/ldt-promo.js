/**
 * ldt-promo.js — generated promo carousels for the LDT brand ($99/mo positioning).
 *
 * Three 1080x1350 slides — hook, substance, price+CTA — composed as SVG and
 * rasterised with sharp, reusing the carousel renderer's text metrics so the
 * two systems wrap text identically. Every line of copy on every slide is a
 * pinned claim or built from one; the assembled text of each deck is run
 * through the claims gate in tests, so a copy edit that drifts from the
 * claims list fails CI before it ever renders.
 *
 * Angle rotation is deterministic by Chicago date (same trick as the carousel
 * accent rotation): no state to persist, no two consecutive days on one angle.
 */
import sharp from "sharp";
import { WIDTH, HEIGHT, SERIF, SANS, wrapText, renderSvgs } from "./carousel-render.js";
import { loadLdtClaims } from "./ldt-claims-gate.js";

/** The rotation. hook/body lines must stay claim-backed — tests enforce it. */
export function promoAngles(claims = loadLdtClaims()) {
  return [
    {
      key: "price",
      hook: "Your business's brain. $99 a month.",
      body: [
        "PRIMARY watches your pipeline, runs your follow-up, and briefs you every morning at 7:05.",
        "Solo is $99/mo with $0 setup. Cancel anytime, no contracts.",
      ],
    },
    {
      key: "briefing",
      hook: "7:05 AM. The briefing is already on your phone.",
      body: [
        "PRIMARY briefs you every morning at 7:05, watches your pipeline, and answers to its name.",
        "Born inside a working Texas brokerage. Running live today.",
      ],
    },
    {
      key: "speed",
      hook: "New leads contacted in under five minutes.",
      body: [
        "Around the clock, weekends included, with instant human handoff the moment a lead replies.",
        "Nothing goes out until you approve it.",
      ],
    },
    {
      key: "honesty",
      hook: "0 numbers invented. Ever.",
      body: [
        "If PRIMARY can't verify a number, it says so. Every claim carries its evidence.",
        "That is the whole doctrine, and it runs a working brokerage every day.",
      ],
    },
    {
      key: "voice",
      hook: "Say 'Hey Primary'. It talks back.",
      body: [
        "A voice-operated AI command center. Calendar invites by voice, sent only after you approve.",
        "Yes, it can talk. British accent included.",
      ],
    },
    {
      key: "meta",
      hook: "This post was scheduled and captioned by our own automation.",
      body: [
        "PRIMARY watches our pipeline, runs our follow-up, and briefs us every morning at 7:05 — for our own business, every day.",
        "Works for any business that books customers.",
      ],
    },
  ];
}

/** Deterministic angle for a Chicago date string ("YYYY-MM-DD"). */
export function angleForDate(dateStr, claims = loadLdtClaims()) {
  const angles = promoAngles(claims);
  const [y, m, d] = String(dateStr).split("-").map(Number);
  const dayNumber = Math.floor(Date.UTC(y || 0, (m || 1) - 1, d || 1) / 86_400_000);
  return angles[((dayNumber % angles.length) + angles.length) % angles.length];
}

const esc = (s) => String(s ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&apos;");

function slideFrame(palette, inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${palette.bg}"/>
  ${inner}
</svg>`;
}

function textBlock(lines, { x, startY, size, lineHeight, fill, family, weight = "normal" }) {
  return lines.map((line, i) =>
    `<text x="${x}" y="${startY + i * lineHeight}" font-family="${family}" font-size="${size}" font-weight="${weight}" fill="${fill}">${esc(line)}</text>`
  ).join("\n  ");
}

/** Slide 1: the hook, huge. */
export function promoHookSvg(angle, palette, claims = loadLdtClaims()) {
  const lines = wrapText(angle.hook, 88, WIDTH - 240, 1.38);
  const startY = HEIGHT / 2 - ((lines.length - 1) * 108) / 2;
  return slideFrame(palette, `
  <text x="120" y="180" font-family="${SANS}" font-size="34" letter-spacing="6" fill="${palette.muted}">${esc(claims.product)}</text>
  <rect x="120" y="210" width="72" height="5" fill="${palette.accent}"/>
  ${textBlock(lines, { x: 120, startY, size: 88, lineHeight: 108, fill: palette.ink, family: SERIF, weight: "bold" })}
  <text x="120" y="${HEIGHT - 130}" font-family="${SANS}" font-size="30" fill="${palette.muted}">${esc(claims.site)}</text>`);
}

/** Slide 2: the substance lines. */
export function promoBodySvg(angle, palette, claims = loadLdtClaims()) {
  let y = 340;
  const blocks = [];
  for (const para of angle.body) {
    const lines = wrapText(para, 54, WIDTH - 240, 1.24);
    blocks.push(`<rect x="120" y="${y - 56}" width="44" height="5" fill="${palette.accent}"/>`);
    blocks.push(textBlock(lines, { x: 120, startY: y, size: 54, lineHeight: 74, fill: palette.ink, family: SANS }));
    y += lines.length * 74 + 120;
  }
  return slideFrame(palette, `
  <text x="120" y="180" font-family="${SANS}" font-size="34" letter-spacing="6" fill="${palette.muted}">${esc(claims.product)}</text>
  ${blocks.join("\n  ")}
  <text x="120" y="${HEIGHT - 130}" font-family="${SANS}" font-size="30" fill="${palette.muted}">${esc(claims.site)}</text>`);
}

/** Slide 3: price + CTA. */
export function promoCtaSvg(palette, brand, claims = loadLdtClaims()) {
  const keyword = brand?.cta?.keyword || "PRIMARY";
  const priceLines = wrapText("Solo starts at $99/mo. $0 setup. Cancel anytime, no contracts.", 54, WIDTH - 240, 1.24);
  return slideFrame(palette, `
  <text x="120" y="180" font-family="${SANS}" font-size="34" letter-spacing="6" fill="${palette.muted}">${esc(claims.product)}</text>
  <text x="120" y="${HEIGHT / 2 - 190}" font-family="${SERIF}" font-size="150" font-weight="bold" fill="${palette.ink}">$99/mo</text>
  ${textBlock(priceLines, { x: 120, startY: HEIGHT / 2 - 60, size: 54, lineHeight: 74, fill: palette.ink, family: SANS })}
  <rect x="120" y="${HEIGHT / 2 + 120}" width="72" height="5" fill="${palette.accent}"/>
  <text x="120" y="${HEIGHT / 2 + 210}" font-family="${SANS}" font-size="58" font-weight="bold" fill="${palette.accent}">Comment ${esc(keyword)}</text>
  <text x="120" y="${HEIGHT / 2 + 285}" font-family="${SANS}" font-size="44" fill="${palette.ink}">and we'll send you the demo.</text>
  <text x="120" y="${HEIGHT - 130}" font-family="${SANS}" font-size="30" fill="${palette.muted}">${esc(claims.site)}</text>`);
}

/** The full deck for an angle, as SVG strings. */
export function promoDeckSvgs(angle, brand, claims = loadLdtClaims()) {
  const palette = {
    bg: brand?.palette?.bg || "#000000",
    ink: brand?.palette?.ink || "#F2F2F2",
    muted: brand?.palette?.muted || "#9A9A9A",
    accent: brand?.palette?.accent || "#5EE0A0",
  };
  return [
    promoHookSvg(angle, palette, claims),
    promoBodySvg(angle, palette, claims),
    promoCtaSvg(palette, brand, claims),
  ];
}

/** All visible copy of a deck, for the claims gate (tests + runtime check). */
export function promoDeckText(angle, brand, claims = loadLdtClaims()) {
  return [
    angle.hook,
    ...angle.body,
    "Solo starts at $99/mo. $0 setup. Cancel anytime, no contracts.",
    `Comment ${brand?.cta?.keyword || "PRIMARY"} and we'll send you the demo.`,
    claims.product,
    claims.site,
  ].join("\n");
}

/**
 * Render an angle's deck to PNG (Instagram) and JPEG (TikTok rejects PNG at
 * publish time — same rule the daily carousel learned), then SELF-QC the
 * rendered files: dimensions must be exactly 1080x1350 and no slide may be
 * suspiciously small. A deck that fails its own measurement never uploads.
 */
export async function renderPromoDeck(angle, brand, claims = loadLdtClaims()) {
  const svgs = promoDeckSvgs(angle, brand, claims);
  const pngs = await renderSvgs(svgs);
  const jpegs = [];
  for (const png of pngs) {
    jpegs.push(await sharp(png).jpeg({ quality: 92 }).toBuffer());
  }
  for (const [i, buf] of pngs.entries()) {
    const meta = await sharp(buf).metadata();
    if (meta.width !== WIDTH || meta.height !== HEIGHT) {
      throw new Error(`[LDT Promo] Slide ${i + 1} rendered ${meta.width}x${meta.height}, expected ${WIDTH}x${HEIGHT}`);
    }
    if (buf.length < 5000) {
      throw new Error(`[LDT Promo] Slide ${i + 1} is ${buf.length} bytes — render likely produced a blank frame`);
    }
  }
  return { pngs, jpegs };
}
