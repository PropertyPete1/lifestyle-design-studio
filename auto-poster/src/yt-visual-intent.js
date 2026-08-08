/**
 * yt-visual-intent.js — the contract between the writer and the renderers.
 *
 * WHY THIS REPLACED A KEYWORD CLASSIFIER
 * The first version scanned narration for highway numbers and relational
 * phrases. It scored well on the video it was tuned against and would have
 * fired on almost nothing else: a script about property taxes, or school
 * ratings, or what $400K buys, contains no ring roads and no "just past 1604",
 * so every take would have come back FOOTAGE and the feature would have looked
 * like it worked while doing nothing. That is the exact failure mode this
 * codebase keeps paying for — a thing that returns success and has no effect.
 *
 * So the judgement moved to the only party that actually knows what a sentence
 * is doing: the writer, while it is writing it. A take may carry
 *
 *   "visualIntent": { "type": "NUMBER_BREAKDOWN", "spec": { ... } }
 *
 * and this module is what validates it. Nothing here reads the narration text.
 *
 * EVERYTHING IS OPTIONAL AND EVERY FAILURE IS SILENT.
 * A missing intent, an unknown type, a spec the renderer cannot satisfy, a
 * malformed object where a string was expected — all of them resolve to "play
 * the footage that would have played anyway". A model writing free-form JSON
 * will get this wrong sometimes, and a wrong graphic on screen is far worse
 * than no graphic, so the bar to render is high and nothing here throws.
 */

export const MAP = "MAP";
export const COMPARISON = "COMPARISON";
export const NUMBER_BREAKDOWN = "NUMBER_BREAKDOWN";
export const LIST = "LIST";
export const TIMELINE = "TIMELINE";
export const CALLOUT = "CALLOUT";

export const VISUAL_TYPES = [MAP, COMPARISON, NUMBER_BREAKDOWN, LIST, TIMELINE, CALLOUT];

/** Why an intent was dropped. Reported, never thrown. */
export const REJECTED = {
  NONE: "no intent supplied",
  UNKNOWN_TYPE: "unknown type",
  MALFORMED: "spec is not an object",
  EMPTY: "spec has no usable content",
  TOO_FEW: "not enough items to be worth drawing",
};

const str = (v) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");

/**
 * Coerce whatever the model produced into a list of strings.
 *
 * The writer is told to send an array of strings and will sometimes send an
 * array of objects, a single string, or an array with nulls in it. All of
 * those are recoverable, and recovering them is cheaper than losing the visual.
 */
function stringList(v, { labelKeys = ["label", "text", "name", "title", "item"] } = {}) {
  const raw = Array.isArray(v) ? v : v == null ? [] : [v];
  return raw
    .map((item) => {
      if (item && typeof item === "object") {
        for (const k of labelKeys) if (str(item[k])) return str(item[k]);
        return "";
      }
      return str(item);
    })
    .filter(Boolean);
}

/** Rows of label + value, however the model chose to express them. */
function rowList(v) {
  const raw = Array.isArray(v) ? v : [];
  return raw
    .map((item) => {
      if (!item || typeof item !== "object") {
        // "Schools: 1.2%" is a row the model wrote as a string.
        const s = str(item);
        const m = /^(.+?)\s*[:—–-]\s*(.+)$/.exec(s);
        return m ? { label: m[1].trim(), value: m[2].trim() } : null;
      }
      const label = str(item.label) || str(item.name) || str(item.item);
      const value = str(item.value) || str(item.amount) || str(item.figure);
      return label ? { label, value, struck: Boolean(item.struck ?? item.removed) } : null;
    })
    .filter(Boolean);
}

// ─── per-type normalisation ─────────────────────────────────────────────────
//
// Each returns a spec the renderer can draw, or a rejection reason. They are
// separate functions rather than one switch because each type has its own idea
// of "enough to be worth drawing", and that threshold is the whole point.

function normaliseMap(spec) {
  const places = stringList(spec.places ?? spec.locations ?? spec.labels, { labelKeys: ["id", "name", "label"] });
  const lines = stringList(spec.lines ?? spec.routes ?? spec.roads, { labelKeys: ["id", "name", "label"] });
  if (places.length === 0 && lines.length === 0) return { ok: false, reason: REJECTED.EMPTY };
  return {
    ok: true,
    spec: {
      places,
      lines,
      title: str(spec.title) || null,
      eyebrow: str(spec.eyebrow) || null,
    },
  };
}

function normaliseComparison(spec) {
  // Accept either {columns:[...]} or {left, right}, since both are natural
  // things for a model to write and neither is wrong.
  let columns = Array.isArray(spec.columns) ? spec.columns : [spec.left, spec.right].filter(Boolean);
  columns = columns
    .map((c) => {
      if (!c || typeof c !== "object") return null;
      const name = str(c.name) || str(c.label) || str(c.title);
      const points = stringList(c.points ?? c.items ?? c.bullets ?? c.values);
      return name ? { name, points } : null;
    })
    .filter(Boolean);
  if (columns.length < 2) return { ok: false, reason: REJECTED.TOO_FEW };
  return {
    ok: true,
    spec: { columns: columns.slice(0, 3), title: str(spec.title) || null, eyebrow: str(spec.eyebrow) || null, footnote: str(spec.footnote) || null },
  };
}

function normaliseBreakdown(spec) {
  const rows = rowList(spec.rows ?? spec.parts ?? spec.items ?? spec.lines);
  if (rows.length < 2) return { ok: false, reason: REJECTED.TOO_FEW };
  return {
    ok: true,
    spec: {
      rows: rows.slice(0, 5),
      total: str(spec.total) || null,
      title: str(spec.title) || null,
      eyebrow: str(spec.eyebrow) || null,
      footnote: str(spec.footnote) || null,
    },
  };
}

function normaliseList(spec) {
  const items = stringList(spec.items ?? spec.list ?? spec.rows ?? spec.points);
  if (items.length < 2) return { ok: false, reason: REJECTED.TOO_FEW };
  return {
    ok: true,
    spec: { items: items.slice(0, 6), title: str(spec.title) || null, eyebrow: str(spec.eyebrow) || null, footnote: str(spec.footnote) || null },
  };
}

function normaliseTimeline(spec) {
  const raw = Array.isArray(spec.steps ?? spec.stages ?? spec.items) ? (spec.steps ?? spec.stages ?? spec.items) : [];
  const steps = raw
    .map((s) => {
      if (!s || typeof s !== "object") {
        const t = str(s);
        return t ? { label: t, when: "" } : null;
      }
      const label = str(s.label) || str(s.name) || str(s.step) || str(s.title);
      return label ? { label, when: str(s.when) || str(s.time) || str(s.duration) || "" } : null;
    })
    .filter(Boolean);
  if (steps.length < 2) return { ok: false, reason: REJECTED.TOO_FEW };
  return {
    ok: true,
    spec: { steps: steps.slice(0, 5), title: str(spec.title) || null, eyebrow: str(spec.eyebrow) || null, footnote: str(spec.footnote) || null },
  };
}

function normaliseCallout(spec) {
  const value = str(spec.value) || str(spec.figure) || str(spec.number) || str(spec.text);
  if (!value) return { ok: false, reason: REJECTED.EMPTY };
  return {
    ok: true,
    spec: { value, label: str(spec.label) || str(spec.caption) || null, eyebrow: str(spec.eyebrow) || null, footnote: str(spec.footnote) || null },
  };
}

const NORMALISERS = {
  [MAP]: normaliseMap,
  [COMPARISON]: normaliseComparison,
  [NUMBER_BREAKDOWN]: normaliseBreakdown,
  [LIST]: normaliseList,
  [TIMELINE]: normaliseTimeline,
  [CALLOUT]: normaliseCallout,
};

/**
 * Validate one writer-supplied intent.
 *
 * @returns {{ ok: true, type, spec } | { ok: false, reason }}
 */
export function normaliseIntent(intent) {
  if (!intent || typeof intent !== "object") return { ok: false, reason: REJECTED.NONE };

  // Models write "number_breakdown", "Number Breakdown" and "numberBreakdown"
  // for the same thing. None of those is worth losing a visual over.
  const type = String(intent.type || "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (!VISUAL_TYPES.includes(type)) return { ok: false, reason: REJECTED.UNKNOWN_TYPE, type: intent.type || null };

  const spec = intent.spec;
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return { ok: false, reason: REJECTED.MALFORMED, type };

  const result = NORMALISERS[type](spec);
  if (!result.ok) return { ok: false, reason: result.reason, type };
  return { ok: true, type, spec: result.spec };
}

/**
 * Attach validated intents to planned segments.
 *
 * ON_CAMERA is skipped outright: those segments are Peter on screen, and there
 * is no picture to replace. Returns a per-segment report so a script whose
 * intents were all rejected is visible rather than looking like a script that
 * asked for nothing — the difference matters, and only one of them is a bug.
 */
export function attachIntents(segments) {
  const rejections = [];
  const out = (segments || []).map((seg) => {
    if (seg.kind !== "voiceover") return seg;
    const result = normaliseIntent(seg.visualIntent);
    if (!result.ok) {
      if (result.reason !== REJECTED.NONE) {
        rejections.push({ takeId: seg.takeId, type: result.type || null, reason: result.reason });
      }
      return { ...seg, visual: null };
    }
    return { ...seg, visual: result.type, visualSpec: result.spec };
  });

  const requested = out.filter((s) => s.visual).length;
  return {
    segments: out,
    report: {
      requested,
      rejected: rejections.length,
      rejections,
      byType: VISUAL_TYPES.reduce((acc, t) => {
        const n = out.filter((s) => s.visual === t).length;
        if (n) acc[t] = n;
        return acc;
      }, {}),
    },
  };
}
