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

/**
 * FOOTAGE is a CHOICE now, not the absence of one.
 *
 * The default flipped: a twelve-minute explainer that cuts to reel B-roll every
 * few seconds is using the visual language of a 15-second hype clip, and under
 * a teaching sentence that reads as filler. So the writer is asked to reach for
 * a graphic that teaches the sentence, and to name FOOTAGE explicitly when the
 * point genuinely IS what a place looks and feels like.
 *
 * Keeping it as a type rather than a null matters for reporting. "The writer
 * chose footage for this line" and "the writer said nothing" look identical in
 * the finished video and mean completely different things — one is an editorial
 * decision, the other is a prompt that is not landing.
 */
export const FOOTAGE = "FOOTAGE";

/**
 * TYPOGRAPHY — the narration itself, set in the brand system, arriving word by
 * word on the beat it is spoken.
 *
 * TWO ROLES, and the second one is why it exists.
 *
 * The writer can ASK for it, for the lines where the words are the point: the
 * assertion, the reframe, the "here is what that actually costs you". Those
 * sentences have no table in them and no place to point a camera at.
 *
 * And it is the FLOOR. Every other layer is allowed to decline — a graphic
 * needs a spec that survives validation, stock needs a keyword and a clip that
 * passes inspection, owned footage needs Peter to have filmed something. When
 * all of them decline, revision 2 had a segment with no picture, and
 * `renderTimeline` threw. Typography cannot decline, because its input is the
 * narration and there is always narration. That is what makes "no segment ever
 * falls back to nothing" a property of the system rather than a hope.
 */
export const TYPOGRAPHY = "TYPOGRAPHY";

/** Types that produce a rendered graphic. FOOTAGE deliberately is not one. */
export const GRAPHIC_TYPES = [MAP, COMPARISON, NUMBER_BREAKDOWN, LIST, TIMELINE, CALLOUT];

/**
 * Types the generated-visual renderer can produce. TYPOGRAPHY is drawn like a
 * graphic but is not a CARD — it has its own renderer and its own reveal unit
 * (a word, not a row) — so it is listed separately rather than folded into
 * GRAPHIC_TYPES, which several callers use to mean "goes through yt-card-render".
 */
export const DRAWN_TYPES = [...GRAPHIC_TYPES, TYPOGRAPHY];

export const VISUAL_TYPES = [...GRAPHIC_TYPES, TYPOGRAPHY, FOOTAGE];

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

/**
 * FOOTAGE now carries SEARCH KEYWORDS, and that is the whole change.
 *
 * It used to mean "play whatever the allocator has", which was fine when the
 * library was a folder of city clips and is meaningless now that the long-form
 * folder starts empty. A FOOTAGE intent is a request for a specific picture of
 * the real world — "aerial suburban neighborhood texas", "family moving boxes
 * into house" — and the keywords are what makes it satisfiable from stock.
 *
 * STILL VALID WITH NO KEYWORDS. A bare {"type":"FOOTAGE"} means "show the
 * place" with nothing to search on: owned footage can serve it, stock cannot,
 * and typography catches it if neither does. Rejecting it would turn an
 * editorial choice into an error, and the writer has been told for two
 * revisions that the bare form is legal.
 */
function normaliseFootage(spec) {
  const keywords = stringList(spec?.keywords ?? spec?.search ?? spec?.query ?? spec?.terms, {
    labelKeys: ["term", "text", "query"],
  });
  return {
    ok: true,
    spec: {
      note: str(spec?.note) || str(spec?.reason) || null,
      // Joined into one query per entry; the stock layer tries them in order.
      keywords: keywords.slice(0, 4),
      orientation: str(spec?.orientation) || "landscape",
    },
  };
}

/**
 * TYPOGRAPHY validates almost nothing, on purpose.
 *
 * The default source of the words is the narration for that take, which the
 * renderer already has and which is always present. A writer who wants to
 * override it can pass `phrases`, but the common case — and the fallback case,
 * which is the important one — supplies no spec at all. A normaliser that could
 * reject would put a hole back in the floor.
 */
function normaliseTypography(spec) {
  const phrases = stringList(spec?.phrases ?? spec?.lines ?? spec?.text, { labelKeys: ["text", "line", "phrase"] });
  return {
    ok: true,
    spec: {
      phrases: phrases.slice(0, 8),
      eyebrow: str(spec?.eyebrow) || null,
    },
  };
}

const NORMALISERS = {
  [FOOTAGE]: normaliseFootage,
  [TYPOGRAPHY]: normaliseTypography,
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
  // STRING SHORTHAND: "visualIntent": "FOOTAGE".
  //
  // Not a convenience. Every voiceover take now carries an intent, and a
  // twelve-minute script is around 38 takes — so the object form adds 38 nested
  // objects to a JSON payload the writer already struggles to close. The first
  // live run failed all three topics, twice on malformed JSON. FOOTAGE is the
  // one type with nothing to describe and will be a large share of those takes,
  // so letting it be a bare string removes most of that nesting outright.
  if (typeof intent === "string") {
    const bare = intent.trim().toUpperCase().replace(/[\s-]+/g, "_");
    if (!bare) return { ok: false, reason: REJECTED.NONE };
    if (!VISUAL_TYPES.includes(bare)) return { ok: false, reason: REJECTED.UNKNOWN_TYPE, type: intent };
    // FOOTAGE and TYPOGRAPHY are the two types that mean something with no spec
    // at all: one says "show the place", the other says "put the words up", and
    // both have everything they need without the writer describing it. The card
    // types have nothing to draw and are rejected.
    if (bare === FOOTAGE) return { ok: true, type: FOOTAGE, spec: { note: null, keywords: [], orientation: "landscape" } };
    if (bare === TYPOGRAPHY) return { ok: true, type: TYPOGRAPHY, spec: { phrases: [], eyebrow: null } };
    return { ok: false, reason: REJECTED.EMPTY, type: bare };
  }

  if (!intent || typeof intent !== "object") return { ok: false, reason: REJECTED.NONE };

  // Models write "number_breakdown", "Number Breakdown" and "numberBreakdown"
  // for the same thing. None of those is worth losing a visual over.
  const type = String(intent.type || "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (!VISUAL_TYPES.includes(type)) return { ok: false, reason: REJECTED.UNKNOWN_TYPE, type: intent.type || null };

  const spec = intent.spec;
  // FOOTAGE and TYPOGRAPHY have nothing that must be described, so a bare
  // {"type":"FOOTAGE"} is valid and is what the writer will usually send.
  if (type !== FOOTAGE && type !== TYPOGRAPHY && (!spec || typeof spec !== "object" || Array.isArray(spec))) {
    return { ok: false, reason: REJECTED.MALFORMED, type };
  }

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

  const voiceover = out.filter((s) => s.kind === "voiceover");
  const graphics = voiceover.filter((s) => GRAPHIC_TYPES.includes(s.visual));
  const chosenFootage = voiceover.filter((s) => s.visual === FOOTAGE);
  const chosenTypography = voiceover.filter((s) => s.visual === TYPOGRAPHY);
  const silent = voiceover.filter((s) => !s.visual);

  return {
    segments: out,
    report: {
      requested: graphics.length,
      // A take the writer explicitly set to TYPOGRAPHY and a take that fell
      // back to it are the same picture and completely different signals. This
      // counts only the deliberate ones; the fallbacks are counted where they
      // happen, in the visual planner.
      typographyTakes: chosenTypography.length,
      // Three distinct populations, and collapsing any two of them hides
      // something worth seeing: a graphic, a deliberate "show the place", and a
      // take the writer said nothing about. The last one is the prompt failing.
      graphicTakes: graphics.length,
      footageTakes: chosenFootage.length,
      unspecifiedTakes: silent.length,
      voiceoverTakes: voiceover.length,
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
