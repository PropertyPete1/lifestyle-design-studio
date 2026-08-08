/**
 * yt-card-render.js — the five non-map visual types, in the carousel's system.
 *
 * COMPARISON, NUMBER_BREAKDOWN, LIST, TIMELINE and CALLOUT. The palette, the
 * serif/sans pairing, the measurement table and the shrink-to-fit all come from
 * carousel-render.js rather than being restated, so a brand change lands in
 * both and the slides and the video cannot drift apart.
 *
 * WHAT THESE LAYOUTS ARE FOR
 * Nothing here knows anything about San Antonio, highways, or property taxes.
 * A NUMBER_BREAKDOWN draws a figure split into parts, whether those parts are
 * tax lines, closing costs, or a renovation budget. That is the point: the
 * previous version of this file had a builder that looked for the word "MUD",
 * which worked for exactly one video.
 *
 * EVERY LAYOUT IS DEFENSIVE ABOUT LENGTH. The content comes from a language
 * model writing free-form JSON, so a "short label" arrives as forty words
 * sooner or later. Every string is wrapped and every block is capped; nothing
 * assumes the writer respected the brief.
 */

import sharp from "sharp";
import { BRAND, SERIF, SANS, measure, wrapText, BOLD_SERIF, SANS_BODY } from "./carousel-render.js";

/** Oversized for ken-burns, 16:9 to match the video canvas. */
export const CARD_WIDTH = 2560;
export const CARD_HEIGHT = 1440;

const C = BRAND.colors;
const BG = "#000000";
const ACCENT = BRAND.accentRotation[0];
const ACCENT_DIM = C.accentDim;
const MARGIN = 200;
const CONTENT_W = CARD_WIDTH - MARGIN * 2;

/**
 * Nothing may be drawn inside this band at the edge of the frame.
 *
 * It is both a design rule and the thing the clipping check measures: ink in
 * the outer band means something overflowed, and the check reads the rendered
 * pixels rather than trusting the layout maths.
 */
export const SAFE_MARGIN = 90;

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function grid() {
  const step = BRAND.grid.step * (CARD_WIDTH / 1080);
  const parts = [];
  for (let x = step; x < CARD_WIDTH; x += step) parts.push(`<line x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${CARD_HEIGHT}" stroke="${C.ink}" stroke-opacity="${BRAND.grid.opacity}" stroke-width="1"/>`);
  for (let y = step; y < CARD_HEIGHT; y += step) parts.push(`<line x1="0" y1="${y.toFixed(1)}" x2="${CARD_WIDTH}" y2="${y.toFixed(1)}" stroke="${C.ink}" stroke-opacity="${BRAND.grid.opacity}" stroke-width="1"/>`);
  return parts.join("");
}

function text(x, y, content, { size, fill = C.ink, family = SERIF, weight = "normal", anchor = "start", style = "normal", opacity = 1 }) {
  return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="${family}" font-size="${size}" font-weight="${weight}" font-style="${style}" fill="${fill}" fill-opacity="${opacity}" text-anchor="${anchor}">${esc(content)}</text>`;
}

function rule(x, y, w, color = ACCENT, h = 4) {
  return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(0, w).toFixed(1)}" height="${h}" rx="${h / 2}" fill="${color}"/>`;
}

function frame(inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">
  <rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="${BG}"/>
  ${grid()}
  ${inner}
</svg>`;
}

/**
 * Shrink text until it fits a width and a line budget.
 *
 * Returns the size it settled on, so callers can lay out beneath it. Model
 * output makes this mandatory rather than nice — the difference between "1.24%"
 * and "roughly one point two four percent of assessed value" is a label that
 * fits and one that runs off the canvas.
 */
function fit(content, { start, min, maxWidth, maxLines, factor }) {
  let size = start;
  let lines = wrapText(content, size, maxWidth, factor);
  while (lines.length > maxLines && size > min) {
    size -= 3;
    lines = wrapText(content, size, maxWidth, factor);
  }
  return { size, lines: lines.slice(0, maxLines) };
}

/** Header, returning its own bottom edge so no layout has to guess it. */
function header(eyebrow, title) {
  if (!title && !eyebrow) return { svg: "", bottom: 200 };
  const top = eyebrow ? 252 : 190;
  if (!title) return { svg: `${text(MARGIN, 140, eyebrow, { size: 38, family: SANS, fill: C.muted })}\n  ${rule(MARGIN, 170, 130)}`, bottom: 230 };

  const { size, lines } = fit(title, { start: 76, min: 46, maxWidth: CONTENT_W, maxLines: 2, factor: BOLD_SERIF });
  const body = lines.map((l, i) => text(MARGIN, top + i * size * 1.18, l, { size, weight: "bold" })).join("\n  ");
  const ruleY = top + (lines.length - 1) * size * 1.18 + 34;
  return {
    svg: `${eyebrow ? text(MARGIN, 140, eyebrow, { size: 38, family: SANS, fill: C.muted }) : ""}
  ${eyebrow ? rule(MARGIN, 170, 130) : ""}
  ${body}
  ${rule(MARGIN, ruleY, Math.min(measure(lines[lines.length - 1], size, BOLD_SERIF), CONTENT_W))}`,
    bottom: ruleY + 40,
  };
}

function footnoteSvg(footnote) {
  if (!footnote) return "";
  const { size, lines } = fit(footnote, { start: 40, min: 28, maxWidth: CONTENT_W, maxLines: 2, factor: SANS_BODY });
  return lines
    .map((l, i) => text(MARGIN, CARD_HEIGHT - 150 + i * size * 1.2, l, { size, style: "italic", fill: ACCENT }))
    .join("\n  ");
}

/** Vertical centre for a stack of rows between the header and the footnote. */
function region(head, footnote) {
  return { top: head.bottom + 60, bottom: CARD_HEIGHT - (footnote ? 240 : 140) };
}

// ─── layouts ────────────────────────────────────────────────────────────────

/** NUMBER_BREAKDOWN — a figure split into its parts, with an optional total. */
export function breakdownSvg({ eyebrow, title, rows = [], total, footnote }) {
  const head = header(eyebrow, title);
  const { top: rTop, bottom: rBottom } = region(head, footnote);
  const items = rows.slice(0, 5);
  const totalH = total ? 130 : 0;
  const gap = Math.min(150, Math.max(96, (rBottom - rTop - totalH) / Math.max(items.length, 1)));
  const blockH = (items.length - 1) * gap;
  const top = rTop + Math.max(0, (rBottom - rTop - totalH - blockH) / 2);

  const valueW = 520;
  const labelW = CONTENT_W - valueW - 80;

  const body = items.map((r, i) => {
    const y = top + i * gap;
    const dim = r.struck ? 0.45 : 1;
    const label = fit(r.label, { start: 52, min: 32, maxWidth: labelW, maxLines: 1, factor: SANS_BODY });
    const value = r.value ? fit(r.value, { start: 52, min: 30, maxWidth: valueW, maxLines: 1, factor: BOLD_SERIF }) : null;
    const strikeW = measure(label.lines[0] || "", label.size, 1.0);
    return `
  <circle cx="${MARGIN + 10}" cy="${(y - 16).toFixed(1)}" r="8" fill="${r.struck ? C.muted : ACCENT}" fill-opacity="${dim}"/>
  ${text(MARGIN + 46, y, label.lines[0] || "", { size: label.size, family: SANS, opacity: dim })}
  ${r.struck ? `<line x1="${MARGIN + 42}" y1="${(y - 16).toFixed(1)}" x2="${(MARGIN + 56 + strikeW).toFixed(1)}" y2="${(y - 16).toFixed(1)}" stroke="${C.muted}" stroke-width="3" stroke-opacity="0.8"/>` : ""}
  ${value ? text(CARD_WIDTH - MARGIN, y, value.lines[0], { size: value.size, family: SERIF, weight: "bold", fill: r.struck ? C.muted : ACCENT, anchor: "end" }) : ""}
  <line x1="${MARGIN}" y1="${(y + 34).toFixed(1)}" x2="${CARD_WIDTH - MARGIN}" y2="${(y + 34).toFixed(1)}" stroke="${C.border}" stroke-width="2"/>`;
  }).join("");

  const totalY = top + blockH + 116;
  const totalFit = total ? fit(total, { start: 60, min: 36, maxWidth: CONTENT_W - 200, maxLines: 1, factor: BOLD_SERIF }) : null;

  return frame(`
  ${head.svg}
  ${body}
  ${totalFit ? `${text(MARGIN + 46, totalY, "All in", { size: 44, family: SANS, fill: C.muted })}
  ${text(CARD_WIDTH - MARGIN, totalY, totalFit.lines[0], { size: totalFit.size, family: SERIF, weight: "bold", fill: ACCENT, anchor: "end" })}` : ""}
  ${footnoteSvg(footnote)}
`);
}

/** COMPARISON — two or three columns held against each other. */
export function comparisonSvg({ eyebrow, title, columns = [], footnote }) {
  const head = header(eyebrow, title);
  const cols = columns.slice(0, 3);
  const gutter = 100;
  const colW = (CONTENT_W - gutter * (cols.length - 1)) / cols.length;

  // Measure before drawing so the block can be centred. Laying columns out from
  // a fixed offset left a two-point comparison sitting in the top third with
  // half the frame empty under it.
  const measured = cols.map((col) => {
    const name = fit(col.name, { start: 54, min: 34, maxWidth: colW, maxLines: 2, factor: BOLD_SERIF });
    const points = (col.points || []).slice(0, 4).map((p) => fit(p, { start: 38, min: 26, maxWidth: colW - 44, maxLines: 2, factor: SANS_BODY }));
    const height = name.lines.length * name.size * 1.16 + 78 + points.reduce((n, p) => n + p.lines.length * p.size * 1.3 + 34, 0);
    return { name, points, height };
  });

  const { top: rTop, bottom: rBottom } = region(head, footnote);
  const tallest = Math.max(...measured.map((m) => m.height), 0);
  const top = rTop + Math.max(0, (rBottom - rTop - tallest) / 2);

  const drawn = cols.map((col, ci) => {
    const x = MARGIN + ci * (colW + gutter);
    const { name, points: measuredPoints } = measured[ci];
    const names = name.lines.map((l, i) => text(x, top + i * name.size * 1.16, l, { size: name.size, weight: "bold", fill: ACCENT })).join("\n  ");
    const underlineY = top + (name.lines.length - 1) * name.size * 1.16 + 30;

    let cursor = underlineY + 78;
    const points = measuredPoints.map((pf) => {
      const lines = pf.lines.map((l, i) => text(x + 38, cursor + i * pf.size * 1.3, l, { size: pf.size, family: SANS, opacity: 0.9 })).join("\n  ");
      const dot = `<circle cx="${(x + 12).toFixed(1)}" cy="${(cursor - 12).toFixed(1)}" r="6" fill="${ACCENT_DIM}"/>`;
      cursor += pf.lines.length * pf.size * 1.3 + 34;
      return `${dot}\n  ${lines}`;
    }).join("\n  ");

    return `${names}
  ${rule(x, underlineY, Math.min(measure(name.lines[0], name.size, BOLD_SERIF), colW), ACCENT_DIM, 3)}
  ${points}`;
  }).join("\n  ");

  // Dividers span the drawn block, not the whole frame — a rule running past
  // the last bullet into empty space reads as a layout that lost its content.
  const dividers = cols.slice(1).map((_, i) => {
    const x = MARGIN + (i + 1) * (colW + gutter) - gutter / 2;
    return `<line x1="${x.toFixed(1)}" y1="${(top - 56).toFixed(1)}" x2="${x.toFixed(1)}" y2="${(top + tallest - 20).toFixed(1)}" stroke="${C.border}" stroke-width="2"/>`;
  }).join("\n  ");

  return frame(`
  ${head.svg}
  ${dividers}
  ${drawn}
  ${footnoteSvg(footnote)}
`);
}

/** LIST — enumerated items, numbered in gold. */
export function listSvg({ eyebrow, title, items = [], footnote }) {
  const head = header(eyebrow, title);
  const { top: rTop, bottom: rBottom } = region(head, footnote);
  const picked = items.slice(0, 6);
  const gap = Math.min(140, Math.max(90, (rBottom - rTop) / Math.max(picked.length, 1)));
  const blockH = (picked.length - 1) * gap;
  const top = rTop + Math.max(0, (rBottom - rTop - blockH) / 2);

  const body = picked.map((item, i) => {
    const y = top + i * gap;
    const f = fit(item, { start: 48, min: 30, maxWidth: CONTENT_W - 150, maxLines: 2, factor: SANS_BODY });
    const lines = f.lines.map((l, li) => text(MARGIN + 130, y + li * f.size * 1.24, l, { size: f.size, family: SANS, opacity: 0.92 })).join("\n  ");
    return `
  ${text(MARGIN, y, String(i + 1).padStart(2, "0"), { size: 52, family: SERIF, weight: "bold", fill: ACCENT, opacity: 0.85 })}
  ${lines}`;
  }).join("");

  return frame(`
  ${head.svg}
  ${body}
  ${footnoteSvg(footnote)}
`);
}

/**
 * TIMELINE — a sequence along a spine.
 *
 * Vertical rather than horizontal: five horizontal stops on a 16:9 frame gives
 * each label about 400px, which forces the type down to a size nobody reads on
 * a phone. Vertical gives each step the full content width.
 */
export function timelineSvg({ eyebrow, title, steps = [], footnote }) {
  const head = header(eyebrow, title);
  const { top: rTop, bottom: rBottom } = region(head, footnote);
  const picked = steps.slice(0, 5);
  const gap = Math.min(160, Math.max(100, (rBottom - rTop) / Math.max(picked.length, 1)));
  const blockH = (picked.length - 1) * gap;
  const top = rTop + Math.max(0, (rBottom - rTop - blockH) / 2);
  const spineX = MARGIN + 16;

  const nodes = picked.map((s, i) => {
    const y = top + i * gap;
    const whenW = 320;
    const label = fit(s.label, { start: 46, min: 30, maxWidth: CONTENT_W - 120 - whenW, maxLines: 2, factor: SANS_BODY });
    const lines = label.lines.map((l, li) => text(spineX + 90, y + li * label.size * 1.24, l, { size: label.size, family: SANS, opacity: 0.92 })).join("\n  ");
    const when = s.when ? fit(s.when, { start: 40, min: 26, maxWidth: whenW, maxLines: 1, factor: BOLD_SERIF }) : null;
    return `
  <circle cx="${spineX}" cy="${(y - 14).toFixed(1)}" r="14" fill="${ACCENT}"/>
  <circle cx="${spineX}" cy="${(y - 14).toFixed(1)}" r="26" fill="none" stroke="${ACCENT}" stroke-opacity="0.3" stroke-width="2"/>
  ${lines}
  ${when ? text(CARD_WIDTH - MARGIN, y, when.lines[0], { size: when.size, family: SERIF, weight: "bold", fill: ACCENT, anchor: "end" }) : ""}`;
  }).join("");

  const spine = picked.length > 1
    ? `<line x1="${spineX}" y1="${(top - 14).toFixed(1)}" x2="${spineX}" y2="${(top + blockH - 14).toFixed(1)}" stroke="${ACCENT}" stroke-width="3" stroke-opacity="0.35"/>`
    : "";

  return frame(`
  ${head.svg}
  ${spine}
  ${nodes}
  ${footnoteSvg(footnote)}
`);
}

/** CALLOUT — one number, given the screen. */
export function calloutSvg({ eyebrow, value, label, footnote }) {
  const head = header(eyebrow, null);
  const v = fit(value, { start: 300, min: 90, maxWidth: CONTENT_W, maxLines: 1, factor: BOLD_SERIF });
  const l = label ? fit(label, { start: 60, min: 34, maxWidth: CONTENT_W, maxLines: 2, factor: SANS_BODY }) : null;

  const blockH = v.size + (l ? 60 + l.lines.length * l.size * 1.24 : 0);
  const top = (CARD_HEIGHT - blockH) / 2 + v.size * 0.34;
  const valueW = Math.min(measure(v.lines[0], v.size, BOLD_SERIF), CONTENT_W);

  const labelLines = l
    ? l.lines.map((line, i) => text(CARD_WIDTH / 2, top + 108 + i * l.size * 1.24, line, { size: l.size, family: SANS, fill: C.muted, anchor: "middle" })).join("\n  ")
    : "";

  return frame(`
  ${head.svg}
  ${text(CARD_WIDTH / 2, top, v.lines[0], { size: v.size, family: SERIF, weight: "bold", fill: ACCENT, anchor: "middle" })}
  ${rule(CARD_WIDTH / 2 - valueW / 2, top + 42, valueW, ACCENT_DIM, 4)}
  ${labelLines}
  ${footnoteSvg(footnote)}
`);
}

const LAYOUTS = {
  NUMBER_BREAKDOWN: breakdownSvg,
  COMPARISON: comparisonSvg,
  LIST: listSvg,
  TIMELINE: timelineSvg,
  CALLOUT: calloutSvg,
};

export function renderCardSvg(type, spec) {
  const layout = LAYOUTS[type];
  if (!layout) throw new Error(`no card layout for type "${type}"`);
  return layout(spec);
}

export async function renderCardPng(type, spec) {
  return sharp(Buffer.from(renderCardSvg(type, spec))).png({ compressionLevel: 9 }).toBuffer();
}

export const CARD_TYPES = Object.keys(LAYOUTS);
