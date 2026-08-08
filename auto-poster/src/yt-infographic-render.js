/**
 * yt-infographic-render.js — number and comparison cards, in the carousel's system.
 *
 * The carousel already solved "gold-on-black type that survives a phone
 * screen": the palette, the serif/sans pairing, the measurement table, the
 * shrink-to-fit. All of that is imported rather than restated, so a brand
 * change lands here for free and the slides and the video cannot drift apart.
 * What is new is the 16:9 canvas and three layouts the carousel has no use for.
 *
 * THE HARD PART IS NOT DRAWING, IT IS KNOWING WHAT TO DRAW.
 * Narration is prose. "Your exemption wipes out the school line and the county
 * line, and that assessment just sits there" is a card, but only if something
 * can reliably pull three rows out of that sentence. So every builder below is
 * allowed to REFUSE: `infographicSpecForSegment` returns null when it cannot
 * build a card it is confident in, and the segment quietly falls back to the
 * footage that would have played anyway. A wrong card is far worse than no
 * card — it is on screen for eight seconds with the brand's name on it.
 */

import sharp from "sharp";
import { BRAND, SERIF, SANS, measure, wrapText, BOLD_SERIF, SANS_BODY } from "./carousel-render.js";

/** Same oversized canvas as the map, for the same ken-burns reason. */
export const CARD_WIDTH = 2560;
export const CARD_HEIGHT = 1440;

const C = BRAND.colors;
const BG = "#000000";
const ACCENT = BRAND.accentRotation[0];
const ACCENT_DIM = C.accentDim;
const MARGIN = 200;
const CONTENT_W = CARD_WIDTH - MARGIN * 2;

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function grid() {
  const step = BRAND.grid.step * (CARD_WIDTH / 1080);
  const parts = [];
  for (let x = step; x < CARD_WIDTH; x += step) {
    parts.push(`<line x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${CARD_HEIGHT}" stroke="${C.ink}" stroke-opacity="${BRAND.grid.opacity}" stroke-width="1"/>`);
  }
  for (let y = step; y < CARD_HEIGHT; y += step) {
    parts.push(`<line x1="0" y1="${y.toFixed(1)}" x2="${CARD_WIDTH}" y2="${y.toFixed(1)}" stroke="${C.ink}" stroke-opacity="${BRAND.grid.opacity}" stroke-width="1"/>`);
  }
  return parts.join("");
}

function text(x, y, content, { size, fill = C.ink, family = SERIF, weight = "normal", anchor = "start", style = "normal", opacity = 1 }) {
  return `<text x="${x}" y="${y}" font-family="${family}" font-size="${size}" font-weight="${weight}" font-style="${style}" fill="${fill}" fill-opacity="${opacity}" text-anchor="${anchor}">${esc(content)}</text>`;
}

function rule(x, y, w, color = ACCENT, h = 4) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${color}"/>`;
}

function frame(inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">
  <rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="${BG}"/>
  ${grid()}
  ${inner}
</svg>`;
}

/**
 * The header, and where the body may start.
 *
 * Returns its own bottom edge rather than letting each layout guess. The first
 * version hardcoded a title baseline of 218 against an eyebrow rule at 168, and
 * a 76px serif cap-height reaches back up through it — the rule struck through
 * the title. Measuring once and passing the result down is what stops that from
 * being re-derived, and re-broken, in three layouts.
 */
function header(eyebrow, title) {
  const size = 76;
  const titleTop = eyebrow ? 252 : 180;
  const lines = wrapText(title, size, CONTENT_W, BOLD_SERIF).slice(0, 2);
  const body = lines.map((l, i) => text(MARGIN, titleTop + i * size * 1.18, l, { size, weight: "bold" })).join("\n  ");
  const lastW = Math.min(measure(lines[lines.length - 1] || "", size, BOLD_SERIF), CONTENT_W);
  const ruleY = titleTop + (lines.length - 1) * size * 1.18 + 34;
  return {
    svg: `${eyebrow ? text(MARGIN, 140, eyebrow, { size: 38, family: SANS, fill: C.muted }) : ""}
  ${eyebrow ? rule(MARGIN, 170, 130, ACCENT) : ""}
  ${body}
  ${rule(MARGIN, ruleY, lastW, ACCENT)}`,
    bottom: ruleY + 40,
  };
}

/** Centre a block of `count` rows in the space between the header and the footnote. */
function centreRows(head, count, gap, { footnote = false } = {}) {
  const regionTop = head.bottom + 60;
  const regionBottom = CARD_HEIGHT - (footnote ? 220 : 130);
  const blockH = Math.max(0, (count - 1) * gap);
  return regionTop + Math.max(0, (regionBottom - regionTop - blockH) / 2);
}

// ─── layouts ────────────────────────────────────────────────────────────────

/**
 * Layout A — the breakdown. Rows of label → verdict.
 *
 * Built for the one the brief named: which lines on a tax statement the
 * disabled-veteran exemption removes, and which one it does not. The struck
 * rows are what makes it land, so `struck` is a first-class field rather than
 * a styling afterthought.
 */
export function breakdownSvg({ eyebrow, title, rows, footnote }) {
  const items = rows.slice(0, 5);
  const head = header(eyebrow, title);
  const gap = 150;
  const top = centreRows(head, items.length, gap, { footnote: Boolean(footnote) });

  const body = items.map((r, i) => {
    const y = top + i * gap;
    const labelSize = 52;
    const valueSize = 52;
    const dim = r.struck ? 0.45 : 1;
    const valueColor = r.struck ? C.muted : ACCENT;
    // A tighter factor than SANS_BODY on purpose. That constant deliberately
    // OVER-estimates so wrapped text never reaches the canvas edge; used for a
    // strikethrough it draws a tail hanging off the end of the word.
    const labelW = measure(r.label, labelSize, 1.0);
    return `
  <circle cx="${MARGIN + 10}" cy="${y - 16}" r="8" fill="${r.struck ? C.muted : ACCENT}" fill-opacity="${dim}"/>
  ${text(MARGIN + 46, y, r.label, { size: labelSize, family: SANS, opacity: dim })}
  ${r.struck ? `<line x1="${MARGIN + 42}" y1="${y - 16}" x2="${MARGIN + 56 + labelW}" y2="${y - 16}" stroke="${C.muted}" stroke-width="3" stroke-opacity="0.8"/>` : ""}
  ${text(CARD_WIDTH - MARGIN, y, r.value, { size: valueSize, family: SERIF, weight: "bold", fill: valueColor, anchor: "end" })}
  <line x1="${MARGIN}" y1="${y + 34}" x2="${CARD_WIDTH - MARGIN}" y2="${y + 34}" stroke="${C.border}" stroke-width="2"/>`;
  }).join("");

  return frame(`
  ${head.svg}
  ${body}
  ${footnote ? text(MARGIN, CARD_HEIGHT - 110, footnote, { size: 40, family: SERIF, style: "italic", fill: ACCENT }) : ""}
`);
}

/** Layout B — two things held against each other, side by side. */
export function comparisonSvg({ eyebrow, title, left, right, footnote }) {
  const colW = (CONTENT_W - 120) / 2;
  const leftX = MARGIN;
  const rightX = MARGIN + colW + 120;
  const head = header(eyebrow, title);
  const top = head.bottom + 90;

  const column = (x, col) => {
    const nameLines = wrapText(col.name, 56, colW, BOLD_SERIF).slice(0, 2);
    const names = nameLines.map((l, i) => text(x, top + i * 66, l, { size: 56, weight: "bold", fill: ACCENT })).join("\n  ");
    let cursor = top + nameLines.length * 66 + 56;
    const points = (col.points || []).slice(0, 4).map((p) => {
      const lines = wrapText(p, 40, colW - 40, SANS_BODY).slice(0, 2);
      const out = lines.map((l, i) => text(x + 34, cursor + i * 52, l, { size: 40, family: SANS, opacity: 0.9 })).join("\n  ");
      const dot = `<circle cx="${x + 10}" cy="${cursor - 13}" r="6" fill="${ACCENT_DIM}"/>`;
      cursor += lines.length * 52 + 30;
      return `${dot}\n  ${out}`;
    }).join("\n  ");
    return `${names}\n  ${rule(x, top + nameLines.length * 66 - 26, Math.min(measure(nameLines[0], 56, BOLD_SERIF), colW), ACCENT_DIM, 3)}\n  ${points}`;
  };

  return frame(`
  ${head.svg}
  ${column(leftX, left)}
  <line x1="${MARGIN + colW + 60}" y1="${top - 60}" x2="${MARGIN + colW + 60}" y2="${CARD_HEIGHT - 220}" stroke="${C.border}" stroke-width="2"/>
  ${column(rightX, right)}
  ${footnote ? text(MARGIN, CARD_HEIGHT - 110, footnote, { size: 40, family: SERIF, style: "italic", fill: ACCENT }) : ""}
`);
}

/** Layout C — a term and what it actually means. Two or three at a time. */
export function definitionSvg({ eyebrow, title, terms, footnote }) {
  const items = terms.slice(0, 3);
  const head = header(eyebrow, title);
  const gap = 230;
  const top = centreRows(head, items.length, gap, { footnote: Boolean(footnote) });

  const body = items.map((t, i) => {
    const y = top + i * gap;
    const defLines = wrapText(t.definition, 44, CONTENT_W - 380, SANS_BODY).slice(0, 2);
    const defs = defLines.map((l, li) => text(MARGIN + 380, y + li * 56, l, { size: 44, family: SANS, opacity: 0.88 })).join("\n  ");
    return `
  ${text(MARGIN, y + 6, t.term, { size: 84, family: SERIF, weight: "bold", fill: ACCENT })}
  ${defs}
  <line x1="${MARGIN}" y1="${y + 92}" x2="${CARD_WIDTH - MARGIN}" y2="${y + 92}" stroke="${C.border}" stroke-width="2"/>`;
  }).join("");

  return frame(`
  ${head.svg}
  ${body}
  ${footnote ? text(MARGIN, CARD_HEIGHT - 110, footnote, { size: 40, family: SERIF, style: "italic", fill: ACCENT }) : ""}
`);
}

export function renderInfographicSvg(spec) {
  if (spec.layout === "comparison") return comparisonSvg(spec);
  if (spec.layout === "definition") return definitionSvg(spec);
  return breakdownSvg(spec);
}

export async function renderInfographicPng(spec) {
  return sharp(Buffer.from(renderInfographicSvg(spec))).png({ compressionLevel: 9 }).toBuffer();
}

// ─── deciding what the card says ────────────────────────────────────────────

/** "A MUD is a municipal utility district" → { term: "MUD", definition: "..." }. */
function definitionsIn(t) {
  const out = [];
  const re = /\b(?:an?\s+)?([A-Z]{2,5})\b\s+is\s+an?\s+([a-z][a-z\s]{6,44}?)(?=[.,;]|\s+and\b|$)/g;
  let m;
  while ((m = re.exec(t))) {
    if (out.some((d) => d.term === m[1])) continue;
    out.push({ term: m[1], definition: m[2].trim() });
  }
  return out;
}

/** Named school districts, deduped, in the order they are said. */
function districtsIn(t) {
  const out = [];
  const re = /\b((?:[A-Z][A-Za-z]+\s+){0,3}?ISD)\b/g;
  let m;
  while ((m = re.exec(t))) {
    const name = m[1].trim();
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * Build a card for one classified segment, or decline.
 *
 * Declining is the common case and the correct one. Prose does not reliably
 * decompose into rows, and the cost of getting it wrong is a confidently
 * formatted, confidently branded, wrong graphic in front of the audience.
 */
export function infographicSpecForSegment(segment, { section = "" } = {}) {
  const t = String(segment?.text || "");
  if (!t.trim()) return null;

  const defs = definitionsIn(t);
  if (defs.length >= 2) {
    return {
      layout: "definition",
      eyebrow: "The two you actually pay",
      title: "Same statement, different animal",
      terms: defs.slice(0, 3),
      footnote: /exempt/i.test(t) ? "The exemption does not touch either one." : null,
    };
  }

  const districts = districtsIn(t);
  if (districts.length >= 2) {
    // Deliberately NOT the section title. A section called "Northeast for
    // Randolph, Fort Sam Houston and BAMC" is a chapter heading, and putting it
    // over a list of school districts describes the wrong thing confidently.
    return {
      layout: "breakdown",
      eyebrow: "School districts",
      title: "They do not follow the subdivision",
      rows: districts.slice(0, 5).map((d) => ({ label: d, value: "verify by address" })),
      footnote: "One street can feed a different school than the next.",
    };
  }

  // The exemption breakdown: which lines it removes and which it does not.
  if (/exempt/i.test(t) && /\b(mud|pid|assessment)\b/i.test(t)) {
    const rows = [];
    if (/school\s+line|school\s+tax/i.test(t)) rows.push({ label: "School district tax", value: "exempt", struck: true });
    if (/county\s+line|county\s+tax/i.test(t)) rows.push({ label: "County tax", value: "exempt", struck: true });
    if (/\bcity\b/i.test(t)) rows.push({ label: "City tax", value: "exempt", struck: true });
    if (/\b(mud|pid|assessment)\b/i.test(t)) rows.push({ label: "MUD / PID assessment", value: "still due" });
    if (rows.length >= 2 && rows.some((r) => !r.struck)) {
      return {
        layout: "breakdown",
        eyebrow: "100% disabled veteran",
        title: "What the exemption does not touch",
        rows,
        footnote: "It is an assessment, not a tax.",
      };
    }
  }

  return null;
}
