/**
 * yt-punch.js — one word slammed over the picture on the beats that carry weight.
 *
 * THE CARD 7 FAILURE THIS IS BUILT AGAINST
 *
 * Revision 7 put text in the middle of the screen and burned captions along the
 * bottom, and the two spelled the same sentence differently. A viewer reading
 * the middle of the frame and a viewer reading the bottom of it received
 * different words from the same second of video. Typography was removed for
 * exactly that reason, and this feature puts text back on screen — so it has to
 * be impossible for the same failure to return, not merely unlikely.
 *
 * TWO INVARIANTS, BOTH STRUCTURAL RATHER THAN CAREFUL
 *
 * 1. A punch's text is BUILT FROM THE CAPTION'S OWN TOKENS, and every candidate
 *    is CHECKED AGAINST THE RENDERED CAPTION STRING BEFORE IT LEAVES THE
 *    SCANNER. Not from the script re-read, not from a model asked for a good
 *    word, not from a synonym. The scanner walks captionTokensFor(seg) — the
 *    same array captionTextFor joins and buildCaptionChunks walks — and a punch
 *    is a slice of it.
 *
 *    The check at the end of punchCandidatesFor is the part that makes this
 *    true rather than intended. This module claimed the property from the day
 *    it was written and did not hold it: the counted-noun branch joined two
 *    punctuation-stripped tokens with a space, so a take captioned "highway,
 *    ten minutes" yielded the punch "highway ten" — a string the captions never
 *    contain. It survived because the fixtures happened to have no punctuation
 *    mid-phrase, and it cost two 30-plus-minute builds at the pipeline's guard.
 *    A property that matters this much is filtered on, not commented about.
 *
 * 2. A punch is ON SCREEN WHILE ITS OWN WORDS ARE. Its time is not a guess and
 *    not a Whisper match — it is the start of the caption chunk that contains
 *    its first token, computed with the same arithmetic buildCaptionChunks uses.
 *    Word timing was considered and rejected: Whisper transcribes "$0" as "zero"
 *    or "oh", so matching a currency token against the audio is exactly the
 *    fuzzy step this feature cannot afford. Chunk arithmetic cannot drift from
 *    the captions because it IS the captions' arithmetic.
 *
 * Uppercase is the one transform applied, and it is a display treatment rather
 * than an edit: it changes the letterforms and cannot change which word is
 * there. `text` stays verbatim and is what the test checks; `display` is what
 * gets drawn.
 *
 * WHY VOICEOVER SEGMENTS ONLY
 *
 * On-camera takes are cut for dead air, so a word's position inside the take
 * moves when the edit lands and any timing derived before it is wrong. They are
 * also his face, and a word slamming over a talking head competes with the
 * opening overlay rather than punctuating it. Voiceover segments are B-roll with
 * narration whose length is fixed by the audio, which is both safe to time
 * against and the right place for the device.
 */

import sharp from "sharp";

import { BRAND, SANS } from "./carousel-render.js";
import { MICRO_PUNCHES_ENABLED, MICRO_PUNCH_MAX, MICRO_PUNCH_SECONDS } from "./yt-config.js";
import { PROTECTED_SECONDS } from "./yt-opening.js";
import { FUNCTION_WORDS } from "./yt-scene-keywords.js";

/** Must match buildCaptionChunks, and is imported nowhere so it cannot drift silently. */
const WORDS_PER_CHUNK = 4;

/** No two punches closer than this. The device works because it is rare. */
export const MIN_PUNCH_GAP_SECONDS = 20;

/**
 * What counts as an emphasis beat.
 *
 * ENTIRELY GENERIC, AND THAT IS A REQUIREMENT RATHER THAN A STYLE. There is no
 * list of words, no topic vocabulary and no market anywhere in this file: a
 * punch is recognised by the SHAPE of a token — a currency amount, a
 * percentage, a counted noun, a bare figure — which is a property of English
 * and not of any one script. The same scanner run over a script about property
 * taxes and a script about school zoning finds each one's numbers, because
 * numbers are what a script emphasises regardless of what it is about.
 */
export const PUNCH_CLASS = {
  CURRENCY: "currency",
  PERCENT: "percent",
  COUNTED: "counted",
  FIGURE: "figure",
};

const CURRENCY = /^\$\d[\d,]*(\.\d+)?[KMB]?$/i;
const PERCENT = /^\d+(\.\d+)?%$/;
const FIGURE = /^\d[\d,]*(\.\d+)?$/;
const NUMBER_WORD = /^(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)$/i;

/** Punctuation that hangs off a token and is never part of the emphasis. */
const EDGE_PUNCT = /^[("'‘“]+|[)"'.,;:!?’”]+$/g;

function bare(token) {
  return String(token || "").replace(EDGE_PUNCT, "");
}

/**
 * A clause or sentence boundary hanging off the end of a token.
 *
 * Two tokens either side of one are not a phrase. Whisper transcribed a take as
 * "…runs along highway, ten minutes from the loop", and "highway" + "ten" has
 * the exact shape of a counted noun while being a road name at the end of one
 * clause and a duration at the start of the next. Reading across the comma
 * built the punch "highway ten", which is not a thing the captions ever say.
 */
const TRAILING_BOUNDARY = /[.,;:!?…]["'’”)]*$/;

/**
 * An extreme figure hits harder than an ordinary one.
 *
 * Zero and one hundred percent are the values a script builds toward — "you pay
 * $0", "100% of the fee" — and a punch on the number that IS the point lands
 * differently from a punch on a number that merely appeared. Recognised
 * numerically rather than by matching the strings, so it holds for any currency
 * amount or percentage a script happens to contain.
 */
function isExtreme(value) {
  return value === 0 || value === 100;
}

function numericValue(token) {
  const n = Number(String(token).replace(/[$,%]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * Every punchable token in one segment, with the token index that dates it.
 *
 * PURE, and returns candidates rather than choices — the spacing and the ceiling
 * are video-wide decisions and cannot be made one segment at a time.
 */
export function punchCandidatesFor(seg) {
  const tokens = captionTokensFor(seg);
  const out = [];

  tokens.forEach((raw, i) => {
    const t = bare(raw);
    if (!t) return;

    if (CURRENCY.test(t)) {
      const v = numericValue(t);
      out.push({ text: t, index: i, span: 1, klass: PUNCH_CLASS.CURRENCY, score: 3 + (isExtreme(v) ? 2 : 0) });
      return;
    }
    if (PERCENT.test(t)) {
      const v = numericValue(t);
      out.push({ text: t, index: i, span: 1, klass: PUNCH_CLASS.PERCENT, score: 3 + (isExtreme(v) ? 2 : 0) });
      return;
    }

    // A COUNTED NOUN: an ordinary word followed by a figure — "month nine",
    // "year two", "grade 5". The leading word must be lower-case AS THE SCRIPT
    // WROTE IT, which is what keeps proper nouns out: a road name or a place
    // name followed by a number is a label, not an emphasis beat, and putting
    // one on screen would be the stock layer's mistake made in text.
    const next = bare(tokens[i + 1] || "");
    if (
      next &&
      /^[a-z]{3,10}$/.test(t) &&
      // NOT ACROSS A CLAUSE BOUNDARY. The two tokens have to be one phrase in
      // the captions, and a comma or a full stop on the lead says they are not.
      // This is what shipped "highway ten" over a take whose captions read
      // "highway, ten" — a punch the guard then had to catch at the very end of
      // a 33-minute build. See TRAILING_BOUNDARY.
      !TRAILING_BOUNDARY.test(String(tokens[i] || "")) &&
      // THE LEAD MUST CARRY MEANING, and revision 8 shipped six punches that
      // proved it does not follow from being lower-case. "the three", "other
      // two", "and eleven", "mostly one" — and "against 1604", which put a road
      // number mid-screen in gold. Every one matched "a lowercase word followed
      // by a figure", and not one of them was an emphasis beat.
      //
      // A counted noun is a NOUN and a count: "month nine", "day one". The same
      // closed-class list the stock layer uses decides it, so there is one
      // answer in the codebase to "is this word carrying meaning".
      !FUNCTION_WORDS.has(t.toLowerCase()) &&
      // An -ly adverb is not a counted noun either. "mostly one" got through a
      // closed-class list because "mostly" is open-class — there is always
      // another adverb, so this is a rule rather than another word. Nothing is
      // lost: English does not count in adverbs, so no real "<adverb> <number>"
      // phrase is an emphasis beat.
      !/ly$/.test(t.toLowerCase()) &&
      (FIGURE.test(next) || NUMBER_WORD.test(next))
    ) {
      out.push({ text: `${t} ${next}`, index: i, span: 2, klass: PUNCH_CLASS.COUNTED, score: 2 });
      return;
    }

    // A bare figure worth reading. Single digits are noise — a script says "one"
    // constantly and means nothing emphatic by it.
    if (FIGURE.test(t) && t.replace(/[^\d]/g, "").length >= 2) {
      out.push({ text: t, index: i, span: 1, klass: PUNCH_CLASS.FIGURE, score: 1 });
    }
  });

  // THE INVARIANT, ENFORCED HERE RATHER THAN ASSUMED.
  //
  // Every branch above builds `text` out of this segment's own caption tokens,
  // which is what is supposed to make a punch verbatim by construction. It was
  // supposed to before, too — and revision 8's counted-noun branch joined two
  // punctuation-stripped tokens with a space, so "highway," + "ten" became
  // "highway ten" and the captions said "highway, ten". The reasoning was
  // right and one branch quietly did not follow it.
  //
  // So the property is now checked where the strings are made, against the
  // exact string captionTextFor renders, and a candidate that fails is dropped
  // rather than carried to the end of a long build for the pipeline's guard to
  // reject. Any future branch gets the same treatment for free: to ship a punch
  // the captions do not contain, you would have to delete this filter.
  const captionText = captionTextFor(seg);
  return out.filter((c) => captionText.includes(c.text));
}

/**
 * The caption text of one segment, normalised exactly as the captions are.
 *
 * buildCaptionChunks splits on whitespace and joins with a single space, so a
 * script written with a double space or a newline produces caption text that is
 * not a substring of `seg.text`. Comparing a punch against the raw script would
 * therefore pass here and fail on screen. This is the string that is actually
 * rendered, and it is what the verbatim check must run against.
 */
export function captionTextFor(seg) {
  return captionTokensFor(seg).join(" ");
}

/**
 * The caption's own token array for a segment.
 *
 * ONE definition, and the candidate scanner and captionTextFor both go through
 * it. That is the whole mechanism behind "a punch is a slice of the captions":
 * the scanner cannot walk a different array from the one the rendered string is
 * joined out of, because there is only one array.
 */
export function captionTokensFor(seg) {
  return String(seg?.text || "").split(/\s+/).filter(Boolean);
}

/**
 * When the caption chunk holding `index` begins, relative to the segment.
 *
 * The arithmetic is buildCaptionChunks', repeated rather than imported to keep
 * this module free of a dependency on the assembler. The test asserts the two
 * agree on real plans, which is the check that matters — a copied constant that
 * drifts is caught by a failing assertion rather than by a comment asking
 * somebody to remember.
 */
export function chunkStartFor(index, tokenCount, seconds, { wordsPerChunk = WORDS_PER_CHUNK } = {}) {
  if (tokenCount <= 0 || seconds <= 0) return 0;
  const groups = Math.ceil(tokenCount / wordsPerChunk);
  const per = seconds / groups;
  return Math.min(seconds, Math.floor(index / wordsPerChunk) * per);
}

/**
 * Choose the punches for a whole video.
 *
 * Greedy by weight, then spaced. Taking the strongest beats first and rejecting
 * anything too near an accepted one produces a spread that follows the script's
 * own emphasis; slicing the timeline into equal windows and taking the best of
 * each would produce an even spread that follows nothing.
 *
 * @returns {{ punches, considered, rejected }} punches carry ABSOLUTE video time
 */
export function selectPunches(plan, {
  max = MICRO_PUNCH_MAX,
  minGap = MIN_PUNCH_GAP_SECONDS,
  protectedSeconds = PROTECTED_SECONDS,
  hold = MICRO_PUNCH_SECONDS,
  enabled = MICRO_PUNCHES_ENABLED,
} = {}) {
  if (!enabled || max <= 0) return { punches: [], considered: 0, rejected: [{ reason: "micro-punches are off" }] };

  const all = [];
  let elapsed = 0;
  const total = (plan?.segments || []).reduce((n, s) => n + (s.seconds || 0), 0);

  for (const seg of plan?.segments || []) {
    const seconds = seg.seconds || 0;
    if (seg.kind !== "voiceover") { elapsed += seconds; continue; }

    const tokens = String(seg.text || "").split(/\s+/).filter(Boolean);
    for (const c of punchCandidatesFor(seg)) {
      all.push({
        ...c,
        takeId: seg.takeId,
        at: round(elapsed + chunkStartFor(c.index, tokens.length, seconds)),
        seconds: hold,
      });
    }
    elapsed += seconds;
  }

  const considered = all.length;
  const rejected = [];
  const chosen = [];

  // THE OPENING IS PROTECTED. yt-opening.js reserves the first fifteen seconds
  // for his face and one line of text, and "nothing else draws" is a rule with
  // no exceptions rather than a default this feature gets to opt out of.
  const eligible = all.filter((p) => {
    if (p.at < protectedSeconds) { rejected.push({ ...p, reason: "inside the protected opening" }); return false; }
    // A punch that would still be on screen when the video ends is a punch the
    // viewer sees cut in half.
    if (total > 0 && p.at + p.seconds > total - 0.5) { rejected.push({ ...p, reason: "too close to the end" }); return false; }
    return true;
  });

  for (const p of [...eligible].sort((a, b) => b.score - a.score || a.at - b.at)) {
    if (chosen.length >= max) { rejected.push({ ...p, reason: "over the per-video ceiling" }); continue; }
    const clash = chosen.find((q) => Math.abs(q.at - p.at) < minGap);
    if (clash) { rejected.push({ ...p, reason: `within ${minGap}s of "${clash.text}"` }); continue; }
    // The same figure twice is a repeat, not a rhythm.
    if (chosen.some((q) => q.text.toLowerCase() === p.text.toLowerCase())) {
      rejected.push({ ...p, reason: "this figure was already punched" });
      continue;
    }
    chosen.push(p);
  }

  chosen.sort((a, b) => a.at - b.at);
  return {
    punches: chosen.map((p) => ({ ...p, display: punchDisplay(p.text) })),
    considered,
    rejected,
  };
}

/** The only transform between the caption's word and the drawn one. */
export function punchDisplay(text) {
  return String(text || "").toUpperCase();
}

// ─── rendering ──────────────────────────────────────────────────────────────

/**
 * One punch as an SVG plate.
 *
 * Gold on a scrim, centred, and sized to the frame rather than to a font stack —
 * a punch has one to three words in it, so the type can be enormous, and
 * enormous is the whole effect. The scrim is what makes it legible over stock
 * footage that might be a bright sky or a white kitchen; without it the gold
 * disappears against half the clips the stock layer returns.
 */
export function punchSvg(text, dim, { hold = MICRO_PUNCH_SECONDS } = {}) {
  const display = punchDisplay(text);
  // Long enough that a three-word punch still fits, tight enough that "$0" is
  // the size of the frame. Measured against the box rather than the glyphs
  // because the plate is centred and the exact advance width does not matter.
  const size = Math.round((dim.h * 1.05) / Math.max(3.2, display.length * 0.62));
  const gold = BRAND.colors.accent;
  const y = Math.round(dim.h / 2);
  const barH = Math.round(size * 1.5);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${dim.w}" height="${dim.h}" viewBox="0 0 ${dim.w} ${dim.h}">
  <defs>
    <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000000" stop-opacity="0"/>
      <stop offset="28%" stop-color="#000000" stop-opacity="0.72"/>
      <stop offset="72%" stop-color="#000000" stop-opacity="0.72"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect x="0" y="${y - Math.round(barH / 2)}" width="${dim.w}" height="${barH}" fill="url(#scrim)"/>
  <text x="${Math.round(dim.w / 2)}" y="${y}" text-anchor="middle" dominant-baseline="central"
        font-family="${SANS}" font-size="${size}" font-weight="700" letter-spacing="${Math.round(size * 0.02)}"
        fill="${gold}">${escapeXml(display)}</text>
</svg>`;
}

export async function renderPunchPng(text, dim, opts = {}) {
  return sharp(Buffer.from(punchSvg(text, dim, opts))).png({ compressionLevel: 9 }).toBuffer();
}

function escapeXml(s) {
  return String(s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
}

function round(n) {
  return Math.round(n * 100) / 100;
}
