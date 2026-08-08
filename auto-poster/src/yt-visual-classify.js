/**
 * yt-visual-classify.js — which narration deserves a drawing instead of footage.
 *
 * Some sentences cannot be filmed. "Loop 410 is the inner ring and 1604 is the
 * outer one, eight or nine miles further out" is a shape, and no drive-by clip
 * of a highway shows a viewer a ring. The same is true of "your exemption wipes
 * out the school line and the assessment just sits there" — that is a number
 * next to another number, and B-roll of a mailbox is decoration, not
 * explanation.
 *
 * This module finds those sentences. It is deliberately PURE and deliberately
 * NOT a model call: a classifier that decides differently on Tuesday than it
 * did on Monday cannot be argued with in a test, and every rule here is the
 * kind of thing that should be arguable in a test.
 *
 * BIAS IS TOWARD FOOTAGE, ON PURPOSE.
 * The channel's whole appeal is that a real person drove these roads. A video
 * that cuts to a generated graphic every thirty seconds reads as a slide deck
 * with a voiceover, which is the thing we are trying not to make. So the rules
 * below demand real evidence, and anything ambiguous stays FOOTAGE. Precision
 * matters far more than recall here — a missed map costs nothing, because the
 * fallback is the footage that would have played anyway.
 *
 * The 30% runtime cap in yt-timeline.js is a SECOND, independent guard. This
 * module returns a score alongside the verdict so that when the cap bites, the
 * segments it keeps are the strongest candidates rather than the earliest ones.
 */

export const FOOTAGE = "FOOTAGE";
export const MAP = "MAP";
export const INFOGRAPHIC = "INFOGRAPHIC";

/**
 * Named routes, as people say them out loud.
 *
 * The script says "1604" and "Loop 410" and "281", never "State Loop 1604" —
 * these match the spoken form, and map to the ids in the vendored geometry.
 */
const ROUTES = [
  { id: "loop410", re: /\bloop\s*410\b|\b410\b/i },
  { id: "loop1604", re: /\b1604\b/i },
  { id: "us281", re: /\b(?:us\s*)?281\b/i },
  { id: "i35", re: /\b(?:i[-\s]*35|interstate\s*35|highway\s*35|up\s*35)\b/i },
  { id: "i10", re: /\b(?:i[-\s]*10|interstate\s*10)\b/i },
  { id: "i37", re: /\b(?:i[-\s]*37|interstate\s*37)\b/i },
  { id: "mopac", re: /\bmopac\b/i },
  { id: "loop360", re: /\bloop\s*360\b/i },
  { id: "us183", re: /\b(?:us\s*)?183\b/i },
  { id: "sh130", re: /\b(?:sh\s*|highway\s*)?130\b/i },
];

/**
 * Language that places one thing relative to another.
 *
 * This is the signal that separates "a map would help" from "a highway is
 * mentioned". A take can name 1604 twice and still be about kitchen finishes;
 * a take that says something sits INSIDE it is describing geography.
 */
const RELATIONAL = [
  /\b(?:just\s+)?inside\b/i,
  /\b(?:just\s+)?outside\b/i,
  /\bpast\b/i,
  /\b(?:north|south|east|west|northeast|northwest|southeast|southwest)\s+(?:of|side)\b/i,
  /\bbetween\b.+\band\b/i,
  /\bfurther\s+(?:out|north|south|east|west)\b/i,
  /\bup\s+against\b/i,
  /\bjust\s+off\b/i,
  /\bruns\s+(?:up|down|north|south|east|west|along|parallel|straight|toward)\b/i,
  /\btoward\b/i,
  /\bparallel\b/i,
  /\bring\b/i,
  /\bouter\s+loop\b|\binner\s+loop\b|\bthe\s+loop\b/i,
  /\bcorridor\b/i,
  /\bfront\s+gate\b/i,
  /\bcity\s+limits\b/i,
  /\bnext\s+(?:two\s+)?out\b/i,
  /\bclimbs?\s+(?:north|south|up)\b/i,
  /\breaches?\s+(?:down|into|south|north)\b/i,
];

/** Commute language. A drive is a route, and a route is a map. */
const COMMUTE = [
  /\bcommute\b/i,
  /\bthe\s+drive\b|\bdrive\s+(?:over\s+)?to\b|\bdrive\s+\d+\b/i,
  /\bminutes\s+(?:from|to|away)\b/i,
  /\brush\s+hour\b/i,
  /\bshort\s+drive\b/i,
];

/**
 * Money, counts and rates.
 *
 * Counted by OCCURRENCE, not by pattern — density is the signal. A take that
 * says "MUD" twice and "PID" twice is itemising two things against each other,
 * which is a card; a take that mentions an exemption once in passing is not.
 */
const NUMERIC = [
  /\$\s?[\d,]+(?:\s*(?:k|thousand|million))?/gi,
  /\b\d+\s*percent\b/gi,
  /\b(?:one\s+)?hundred\s+percent\b/gi,
  /\bproperty\s+tax(?:es)?\b/gi,
  /\btax(?:es)?\s+(?:bill|rate|statement|line)?\b/gi,
  /\bexemption\b/gi,
  /\bassessments?\b/gi,
  /\b(?:mud|pid)s?\b/g,
  /\b(?:school|county|city)\s+line\b/gi,
  /\bhomestead\b/gi,
  /\bper\s+(?:year|month)\b/gi,
  /\bevery\s+year\b/gi,
  /\bcosts?\s+(?:you\s+)?more\b/gi,
];

/**
 * Definitional language — "a MUD is a municipal utility district".
 *
 * A definition is the single most card-shaped thing narration does. It is two
 * labelled boxes, and footage of a subdivision entrance explains none of it.
 */
const DEFINITIONAL = [
  /\bis\s+a\s+(?:municipal|public|state|county|school)\b/i,
  /\bstands\s+for\b/i,
  /\bdifferent\s+setups?\b/i,
  /\bapplies\s+to\b/i,
  /\bdoes\s+not\s+apply\b/i,
  /\bthe\s+difference\s+is\b/i,
];

/** Explicit comparison — two things held against each other. */
const COMPARATIVE = [
  /\bversus\b|\bvs\.?\b/i,
  /\bcompared\s+to\b/i,
  /\bthe\s+difference\s+between\b/i,
  /\bmore\s+than\b|\bless\s+than\b/i,
  /\bcheaper\b|\bpricier\b|\bhigher\b|\blower\b/i,
  /\bone\s+of\s+them\b/i,
];

/** School districts, which arrive as lists and belong on a card. */
const DISTRICT = /\b(?:[A-Z][A-Za-z]*\s+)?ISD\b|\bschool\s+district\b|\bscuc\b/i;

/** How many of these patterns appear at all. */
function countMatches(text, patterns) {
  return patterns.reduce((n, re) => (new RegExp(re.source, re.flags.replace("g", "")).test(text) ? n + 1 : n), 0);
}

/** How many times these patterns appear in total. Density, not presence. */
function countOccurrences(text, patterns) {
  return patterns.reduce((n, re) => n + (text.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g")) || []).length, 0);
}

function routesIn(text) {
  return ROUTES.filter((r) => r.re.test(text)).map((r) => r.id);
}

function placesIn(text, gazetteer) {
  const found = [];
  for (const p of gazetteer) {
    // Word-boundary match on the label so "Selma" does not fire inside
    // "Lockhill Selma", which is a road, not the town.
    const re = new RegExp(`\\b${p.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(text)) found.push(p.id);
  }
  return found;
}

/**
 * Score one take.
 *
 * Both scores are computed every time and compared, rather than testing for MAP
 * and falling through to INFOGRAPHIC. A take like "a newer house north of 1604
 * with an assessment can cost you more every year than an older house inside
 * the loop" fires BOTH sets hard — and the honest answer there is that we do
 * not know which visual serves it better, so it stays FOOTAGE. Requiring a
 * clear winner is what makes that fall out automatically instead of being
 * decided by rule order.
 */
export function classifyTake(text, { places = [] } = {}) {
  const t = String(text || "");
  if (!t.trim()) return { kind: FOOTAGE, score: 0, signals: [], spec: null };

  const routes = routesIn(t);
  const foundPlaces = placesIn(t, places);
  const relational = countMatches(t, RELATIONAL);
  const commute = countMatches(t, COMMUTE);

  const numeric = countOccurrences(t, NUMERIC);
  const definitional = countMatches(t, DEFINITIONAL);
  const comparative = countMatches(t, COMPARATIVE);
  const districts = (t.match(new RegExp(DISTRICT.source, "gi")) || []).length;

  const signals = [];

  // ── MAP ──────────────────────────────────────────────────────────────────
  // A named route or two named places is the ANCHOR; relational or commute
  // language is the JUSTIFICATION. Both are required. A take that names 1604
  // while talking about roof tiles has an anchor and no justification, and
  // correctly scores zero.
  const anchors = routes.length + (foundPlaces.length >= 2 ? 1 : 0);
  const justification = relational + commute;
  let mapScore = 0;
  if (anchors > 0 && justification > 0) {
    mapScore = anchors * 2 + Math.min(justification, 3) + foundPlaces.length;
    signals.push(`map: ${routes.length} route(s), ${foundPlaces.length} place(s), ${justification} relational`);
  }

  // ── INFOGRAPHIC ──────────────────────────────────────────────────────────
  // Numbers alone are not enough — "houses from the sixties and seventies" is
  // numeric and is plainly footage. What earns a card is a number being
  // compared, itemised, or named as a line on a bill.
  let infoScore = 0;
  if (numeric >= 2 || (numeric >= 1 && comparative >= 1) || districts >= 2) {
    // Districts weigh heavily because naming two of them is never incidental —
    // "SCUC covers those three towns, Judson covers the Live Oak side" is a
    // comparison table read aloud, and there is no footage of a boundary.
    infoScore = numeric * 2 + definitional * 2 + comparative + districts * 4;
    signals.push(`infographic: ${numeric} numeric, ${definitional} definitional, ${comparative} comparative, ${districts} district(s)`);
  }

  // ── the verdict ──────────────────────────────────────────────────────────
  // MIN_SCORE is set where it is because of what sits just under it: takes that
  // name one road and place a neighbourhood against it ("Shavano Park is a
  // couple miles further out, right up against 1604") score 5, and those are
  // takes where a drive-through clip of the neighbourhood is genuinely the
  // better picture. The bar is set to keep them as footage.
  const MIN_SCORE = 7;
  const MARGIN = 2;

  if (mapScore < MIN_SCORE && infoScore < MIN_SCORE) {
    return { kind: FOOTAGE, score: Math.max(mapScore, infoScore), signals, spec: null };
  }
  if (Math.abs(mapScore - infoScore) < MARGIN) {
    // Both fit. That is not a tie to be broken, it is a signal that we do not
    // know — and the fallback is the footage that would have played anyway.
    signals.push(`ambiguous (map ${mapScore} vs infographic ${infoScore}) — staying with footage`);
    return { kind: FOOTAGE, score: 0, signals, spec: null };
  }

  if (mapScore > infoScore) {
    return {
      kind: MAP,
      score: mapScore,
      signals,
      spec: { routes, places: foundPlaces, emphasis: routes.length >= 2 ? "rings" : "area" },
    };
  }
  return {
    kind: INFOGRAPHIC,
    score: infoScore,
    signals,
    spec: { numeric, comparative, districts },
  };
}

/**
 * Classify every voiceover take in a plan.
 *
 * ON_CAMERA is never touched. Those segments are Peter on screen saying the
 * words — there is no picture to replace, and replacing it would remove the one
 * thing that makes the channel his.
 */
export function classifySegments(segments, { places = [] } = {}) {
  return (segments || []).map((seg) => {
    if (seg.kind !== "voiceover") return { ...seg, visual: FOOTAGE };
    const { kind, score, signals, spec } = classifyTake(seg.text, { places });
    return { ...seg, visual: kind, visualScore: score, visualSignals: signals, visualSpec: spec };
  });
}
