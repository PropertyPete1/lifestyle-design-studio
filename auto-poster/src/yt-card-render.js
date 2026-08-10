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

// ─── reveal state ───────────────────────────────────────────────────────────
//
// Every layout can draw itself PARTIALLY, so a card can be rendered at a
// sequence of states and played as an animation rather than held as a slide.
//
// THE ORDERING CONTRACT: `revealLabels(type, spec)` returns the revealable units
// in draw order, and every layout below honours `visible` against that SAME
// order. If the two ever disagree the reveals still land on the beat and animate
// the wrong element, which is a failure that looks like a design choice — so the
// list is derived here, next to the layouts, and the animator is not allowed its
// own opinion about what a card contains.

/** A fully-drawn card. What every existing caller gets by not passing anything. */
export const FULL_REVEAL = { visible: Infinity, current: -1, pulse: 0 };

function rs(reveal) {
  if (!reveal) return { ...FULL_REVEAL, progress: 1 };
  return {
    visible: reveal.visible ?? Infinity,
    current: reveal.current ?? -1,
    pulse: Math.max(0, Math.min(1, reveal.pulse ?? 0)),
    // Continuous 0-1 within the current state. Only CALLOUT reads it, because
    // it is the only layout whose animation is a value rather than a sequence.
    progress: reveal.progress,
  };
}

/**
 * How an item at index `i` is drawn at this state.
 *
 * Not visible yet → skipped entirely. Just landed → drawn at full strength with
 * an emphasis rule. Already landed → drawn slightly held back, so the eye goes
 * to the new row rather than re-reading the whole table on every beat.
 */
function at(state, i) {
  if (i >= state.visible) return { shown: false, opacity: 0, emphasis: 0 };
  const isCurrent = i === state.current;
  return {
    shown: true,
    // Settled rows sit at 0.72 rather than 1.0. The contrast between "new" and
    // "already read" is what makes the reveal legible at a glance; without it a
    // five-row table reads as five identical rows appearing.
    opacity: isCurrent ? 1 : 0.72,
    emphasis: isCurrent ? 1 - state.pulse * 0.35 : 0,
  };
}

/**
 * The revealable units of a spec, in the order they are drawn.
 *
 * These strings are what the timing engine anchors against the narration, so
 * they must be the words a person would actually SAY for that element — the row
 * label, not "row 3".
 */
export function revealLabels(type, spec = {}) {
  switch (type) {
    case "NUMBER_BREAKDOWN": {
      const rows = (spec.rows || []).slice(0, 5).map((r) => r.label);
      return spec.total ? [...rows, String(spec.total)] : rows;
    }
    case "LIST":
      return (spec.items || []).slice(0, 6).map(String);
    case "TIMELINE":
      return (spec.steps || []).slice(0, 5).map((s) => s.label);
    case "COMPARISON":
      return (spec.columns || []).slice(0, 3).flatMap((c) => [c.name, ...(c.points || []).slice(0, 4)]);
    case "CALLOUT":
      // One unit. The animation is the figure counting up, which is continuous
      // rather than stepped, so there is nothing further to anchor.
      return [String(spec.value ?? "")];
    default:
      return [];
  }
}

/**
 * Partially count a figure up to `progress`.
 *
 * "$4,200" at 0.5 is "$2,100" — the digits move, the currency mark, separators
 * and suffix do not. A counting number is the single most reliable way to make a
 * CALLOUT feel like it is happening rather than being displayed, and it costs
 * one function because the formatting is preserved from the target string.
 */
export function countUp(value, progress) {
  const s = String(value ?? "");
  const m = /([0-9][0-9,.]*)/.exec(s);
  if (!m || progress >= 1) return s;
  const raw = m[1];
  const decimals = raw.includes(".") ? raw.split(".")[1].length : 0;
  const target = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(target)) return s;

  // Eased so it decelerates into the final figure instead of stopping dead.
  const eased = 1 - Math.pow(1 - Math.max(0, Math.min(1, progress)), 3);
  const now = target * eased;
  const grouped = raw.includes(",");
  let out = decimals > 0 ? now.toFixed(decimals) : String(Math.round(now));
  if (grouped) {
    const [i, d] = out.split(".");
    out = i.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (d ? `.${d}` : "");
  }
  return s.replace(raw, out);
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

/**
 * NUMBER_BREAKDOWN — a figure split into its parts, with an optional total.
 *
 * GEOMETRY IS COMPUTED FROM THE FULL SPEC AT EVERY STATE, and only visibility
 * changes. Laying out just the visible rows would recentre the block on every
 * reveal, so the table would creep up the frame as it filled — motion the viewer
 * reads as instability rather than as information arriving.
 */
export function breakdownSvg({ eyebrow, title, rows = [], total, footnote }, reveal) {
  const state = rs(reveal);
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
    const vis = at(state, i);
    const y = top + i * gap;
    // The divider is the row's slot in the table and is drawn from the first
    // frame. Rules appearing one at a time makes the card look like it is being
    // built; the rules standing empty makes it look like a table being filled
    // in, which is the read we want.
    const divider = `<line x1="${MARGIN}" y1="${(y + 34).toFixed(1)}" x2="${CARD_WIDTH - MARGIN}" y2="${(y + 34).toFixed(1)}" stroke="${C.border}" stroke-width="2"/>`;
    if (!vis.shown) return `\n  ${divider}`;

    const dim = (r.struck ? 0.45 : 1) * vis.opacity;
    const label = fit(r.label, { start: 52, min: 32, maxWidth: labelW, maxLines: 1, factor: SANS_BODY });
    const value = r.value ? fit(r.value, { start: 52, min: 30, maxWidth: valueW, maxLines: 1, factor: BOLD_SERIF }) : null;
    const strikeW = measure(label.lines[0] || "", label.size, 1.0);
    // The strike is drawn as the row lands, growing from the left, so "and this
    // one you do not pay" is a thing that HAPPENS on the word rather than a row
    // that was already crossed out before it was mentioned.
    const strikeGrow = i === state.current ? Math.max(0.08, 1 - state.pulse) : 1;
    return `
  ${divider}
  <circle cx="${MARGIN + 10}" cy="${(y - 16).toFixed(1)}" r="${vis.emphasis > 0 ? 11 : 8}" fill="${r.struck ? C.muted : ACCENT}" fill-opacity="${dim.toFixed(3)}"/>
  ${text(MARGIN + 46, y, label.lines[0] || "", { size: label.size, family: SANS, opacity: dim })}
  ${r.struck ? `<line x1="${MARGIN + 42}" y1="${(y - 16).toFixed(1)}" x2="${(MARGIN + 42 + (14 + strikeW) * strikeGrow).toFixed(1)}" y2="${(y - 16).toFixed(1)}" stroke="${C.muted}" stroke-width="3" stroke-opacity="${(0.8 * vis.opacity).toFixed(3)}"/>` : ""}
  ${value ? text(CARD_WIDTH - MARGIN, y, value.lines[0], { size: value.size, family: SERIF, weight: "bold", fill: r.struck ? C.muted : ACCENT, anchor: "end", opacity: vis.opacity }) : ""}`;
  }).join("");

  const totalY = top + blockH + 116;
  const totalFit = total ? fit(total, { start: 60, min: 36, maxWidth: CONTENT_W - 200, maxLines: 1, factor: BOLD_SERIF }) : null;
  const totalVis = at(state, items.length);

  return frame(`
  ${head.svg}
  ${body}
  ${totalFit && totalVis.shown ? `${text(MARGIN + 46, totalY, "All in", { size: 44, family: SANS, fill: C.muted, opacity: totalVis.opacity })}
  ${text(CARD_WIDTH - MARGIN, totalY, totalFit.lines[0], { size: totalFit.size, family: SERIF, weight: "bold", fill: ACCENT, anchor: "end", opacity: totalVis.opacity })}` : ""}
  ${footnoteSvg(footnote)}
`);
}

/** COMPARISON — two or three columns held against each other. */
export function comparisonSvg({ eyebrow, title, columns = [], footnote }, reveal) {
  const state = rs(reveal);
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

  // A flat index across columns, matching revealLabels: each column's name then
  // its points, column after column. The counter walks in the SAME order the
  // labels were emitted, which is the whole ordering contract.
  let unit = -1;
  const drawn = cols.map((col, ci) => {
    const x = MARGIN + ci * (colW + gutter);
    const { name, points: measuredPoints } = measured[ci];

    unit++;
    const nameVis = at(state, unit);
    const names = nameVis.shown
      ? name.lines.map((l, i) => text(x, top + i * name.size * 1.16, l, { size: name.size, weight: "bold", fill: ACCENT, opacity: nameVis.opacity })).join("\n  ")
      : "";
    const underlineY = top + (name.lines.length - 1) * name.size * 1.16 + 30;
    const ruleW = Math.min(measure(name.lines[0], name.size, BOLD_SERIF), colW);

    let cursor = underlineY + 78;
    const points = measuredPoints.map((pf) => {
      unit++;
      const pv = at(state, unit);
      const lines = pv.shown
        ? pf.lines.map((l, i) => text(x + 38, cursor + i * pf.size * 1.3, l, { size: pf.size, family: SANS, opacity: 0.9 * pv.opacity })).join("\n  ")
        : "";
      const dot = pv.shown
        ? `<circle cx="${(x + 12).toFixed(1)}" cy="${(cursor - 12).toFixed(1)}" r="${(6 + pv.emphasis * 3).toFixed(1)}" fill="${ACCENT_DIM}" fill-opacity="${pv.opacity.toFixed(3)}"/>`
        : "";
      cursor += pf.lines.length * pf.size * 1.3 + 34;
      return pv.shown ? `${dot}\n  ${lines}` : "";
    }).filter(Boolean).join("\n  ");

    return `${names}
  ${nameVis.shown ? rule(x, underlineY, ruleW * (nameVis.emphasis > 0 ? Math.max(0.15, 1 - state.pulse) : 1), ACCENT_DIM, 3) : ""}
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

/** LIST — enumerated items, numbered in gold, arriving one at a time. */
export function listSvg({ eyebrow, title, items = [], footnote }, reveal) {
  const state = rs(reveal);
  const head = header(eyebrow, title);
  const { top: rTop, bottom: rBottom } = region(head, footnote);
  const picked = items.slice(0, 6);
  const gap = Math.min(140, Math.max(90, (rBottom - rTop) / Math.max(picked.length, 1)));
  const blockH = (picked.length - 1) * gap;
  const top = rTop + Math.max(0, (rBottom - rTop - blockH) / 2);

  const body = picked.map((item, i) => {
    const vis = at(state, i);
    if (!vis.shown) return "";
    const y = top + i * gap;
    const f = fit(item, { start: 48, min: 30, maxWidth: CONTENT_W - 150, maxLines: 2, factor: SANS_BODY });
    const lines = f.lines.map((l, li) => text(MARGIN + 130, y + li * f.size * 1.24, l, { size: f.size, family: SANS, opacity: 0.92 * vis.opacity })).join("\n  ");
    // The numeral is the element that moves: it arrives a touch larger and
    // settles. A number that lands with weight is the whole grammar of this
    // channel's typography, and it costs one interpolated font size.
    const numSize = 52 + vis.emphasis * 10;
    return `
  ${text(MARGIN, y, String(i + 1).padStart(2, "0"), { size: numSize.toFixed(1), family: SERIF, weight: "bold", fill: ACCENT, opacity: 0.85 * vis.opacity })}
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
export function timelineSvg({ eyebrow, title, steps = [], footnote }, reveal) {
  const state = rs(reveal);
  const head = header(eyebrow, title);
  const { top: rTop, bottom: rBottom } = region(head, footnote);
  const picked = steps.slice(0, 5);
  const gap = Math.min(160, Math.max(100, (rBottom - rTop) / Math.max(picked.length, 1)));
  const blockH = (picked.length - 1) * gap;
  const top = rTop + Math.max(0, (rBottom - rTop - blockH) / 2);
  const spineX = MARGIN + 16;

  const nodes = picked.map((s, i) => {
    const vis = at(state, i);
    if (!vis.shown) return "";
    const y = top + i * gap;
    const whenW = 320;
    const label = fit(s.label, { start: 46, min: 30, maxWidth: CONTENT_W - 120 - whenW, maxLines: 2, factor: SANS_BODY });
    const lines = label.lines.map((l, li) => text(spineX + 90, y + li * label.size * 1.24, l, { size: label.size, family: SANS, opacity: 0.92 * vis.opacity })).join("\n  ");
    const when = s.when ? fit(s.when, { start: 40, min: 26, maxWidth: whenW, maxLines: 1, factor: BOLD_SERIF }) : null;
    // The halo ring pulses out on the step that just landed — the one element
    // that reads as "we are here now" on a spine of otherwise identical nodes.
    const halo = 26 + vis.emphasis * 14;
    return `
  <circle cx="${spineX}" cy="${(y - 14).toFixed(1)}" r="14" fill="${ACCENT}" fill-opacity="${vis.opacity.toFixed(3)}"/>
  <circle cx="${spineX}" cy="${(y - 14).toFixed(1)}" r="${halo.toFixed(1)}" fill="none" stroke="${ACCENT}" stroke-opacity="${(0.3 * vis.opacity).toFixed(3)}" stroke-width="2"/>
  ${lines}
  ${when ? text(CARD_WIDTH - MARGIN, y, when.lines[0], { size: when.size, family: SERIF, weight: "bold", fill: ACCENT, anchor: "end", opacity: vis.opacity }) : ""}`;
  }).join("");

  // The spine GROWS to the last revealed node rather than standing full height,
  // which is what makes a timeline read as a progression instead of a list with
  // a line next to it.
  const shownCount = Math.max(0, Math.min(picked.length, state.visible === Infinity ? picked.length : state.visible));
  const spineEnd = top + Math.max(0, shownCount - 1) * gap - 14;
  const spine = picked.length > 1 && shownCount > 1
    ? `<line x1="${spineX}" y1="${(top - 14).toFixed(1)}" x2="${spineX}" y2="${spineEnd.toFixed(1)}" stroke="${ACCENT}" stroke-width="3" stroke-opacity="0.35"/>`
    : "";

  return frame(`
  ${head.svg}
  ${spine}
  ${nodes}
  ${footnoteSvg(footnote)}
`);
}

/**
 * CALLOUT — one number, given the screen, counting up to itself.
 *
 * `progress` rather than a visible-count: there is only one element, so a
 * stepped reveal would be a single cut from nothing to everything. A figure that
 * spins up and settles is the one animation this layout wants, and it holds the
 * eye for the whole sentence instead of the first half-second of it.
 *
 * THE TYPE IS SIZED FROM THE FINAL STRING, always. Sizing from the current
 * count would make the digits grow and shrink as they roll — "9" and "412,000"
 * fit at wildly different sizes — and the number would visibly resize on the
 * last frame. The underline is measured the same way and for the same reason.
 */
export function calloutSvg({ eyebrow, value, label, footnote }, reveal) {
  const state = rs(reveal);
  const progress = state.visible === Infinity ? 1 : Math.max(0, Math.min(1, state.progress ?? (state.visible >= 1 ? 1 : 0)));
  const head = header(eyebrow, null);
  const v = fit(value, { start: 300, min: 90, maxWidth: CONTENT_W, maxLines: 1, factor: BOLD_SERIF });
  const l = label ? fit(label, { start: 60, min: 34, maxWidth: CONTENT_W, maxLines: 2, factor: SANS_BODY }) : null;

  const blockH = v.size + (l ? 60 + l.lines.length * l.size * 1.24 : 0);
  const top = (CARD_HEIGHT - blockH) / 2 + v.size * 0.34;
  const valueW = Math.min(measure(v.lines[0], v.size, BOLD_SERIF), CONTENT_W);
  const shown = countUp(v.lines[0], progress);

  // The label lands after the figure has finished counting — it names what the
  // number was, and naming it before it settles gives the answer away.
  const labelOpacity = Math.max(0, Math.min(1, (progress - 0.6) / 0.3));
  const labelLines = l
    ? l.lines.map((line, i) => text(CARD_WIDTH / 2, top + 108 + i * l.size * 1.24, line, { size: l.size, family: SANS, fill: C.muted, anchor: "middle", opacity: labelOpacity })).join("\n  ")
    : "";

  return frame(`
  ${head.svg}
  ${text(CARD_WIDTH / 2, top, shown, { size: v.size, family: SERIF, weight: "bold", fill: ACCENT, anchor: "middle" })}
  ${rule(CARD_WIDTH / 2 - valueW / 2, top + 42, valueW * Math.max(0.05, progress), ACCENT_DIM, 4)}
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

/**
 * @param {object} [reveal] partial-draw state. Omitted means the finished card,
 *                          which is what every pre-animation caller expects.
 */
export function renderCardSvg(type, spec, reveal) {
  const layout = LAYOUTS[type];
  if (!layout) throw new Error(`no card layout for type "${type}"`);
  return layout(spec, reveal);
}

export async function renderCardPng(type, spec, reveal) {
  return sharp(Buffer.from(renderCardSvg(type, spec, reveal))).png({ compressionLevel: 9 }).toBuffer();
}

export const CARD_TYPES = Object.keys(LAYOUTS);
