/**
 * yt-typography-render.js — the words themselves, as the picture.
 *
 * WHY THIS IS THE FALLBACK RATHER THAN BLACK
 * Every other visual layer can decline. A graphic needs the writer to have asked
 * for one and a spec the renderer can satisfy; stock needs a keyword, a working
 * API and a clip that survives inspection; owned footage needs Peter to have
 * filmed something. When all three decline, revision 2 had nothing — and
 * `renderTimeline` threw, which at least failed loudly, but a build that dies
 * because one sentence had no picture is a build that cannot run unattended.
 *
 * Typography can never decline, because its input is the narration, and there is
 * always narration. That is the whole argument for it being the floor: it is the
 * one visual whose source material is guaranteed to exist.
 *
 * It is also, on its own merits, the right treatment for the sentences that tend
 * to fall through — the assertions, the "here is what that actually means to
 * you" lines. Those are exactly the lines that want the words on screen.
 *
 * THE LOOK: gold serif on black, centred, one phrase at a time, words landing as
 * they are spoken. The same type system as the cards and the carousel, so a
 * typography segment sits in the same world as the graphic either side of it.
 */

import sharp from "sharp";
import { BRAND, SERIF, SANS, measure, wrapText, BOLD_SERIF } from "./carousel-render.js";
import { normaliseWord } from "./yt-reveal-timing.js";

export const TYPO_WIDTH = 2560;
export const TYPO_HEIGHT = 1440;

const C = BRAND.colors;
const BG = "#000000";
const ACCENT = BRAND.accentRotation[0];
const MARGIN = 260;
const CONTENT_W = TYPO_WIDTH - MARGIN * 2;

/** Longest a single phrase card may be. Beyond this it stops being a phrase. */
const MAX_PHRASE_WORDS = 9;
/** Shorter than this and a card flashes past before it can be read. */
const MIN_PHRASE_SECONDS = 1.1;

/** Words that should never be the last word on a card — they dangle. */
const DANGLING = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "at", "for",
  "with", "is", "are", "was", "were", "be", "your", "our", "their", "its",
  "this", "that", "if", "than", "then", "into", "from", "by", "as",
]);

/**
 * Words it is GOOD to start a new card on.
 *
 * Breaking a long clause on word count alone splits whatever happens to be
 * there, and what is usually there is a noun phrase: the first version cut
 * "Most people think the tax | rate is the whole story" straight through "tax
 * rate". When the words ARE the picture, a compound noun torn across two cards
 * is not a small blemish — it is the one thing the viewer is looking at.
 *
 * These are the words that reliably begin a new grammatical unit, so breaking
 * immediately before one lands the cut on a joint instead of through a bone.
 * It is a heuristic, not a parser, and it does not need to be more than that:
 * the cost of a miss is an ungainly break, and the cost of a parser is a
 * dependency and a class of failure this layer is not allowed to have.
 */
const BREAK_BEFORE = new Set([
  "is", "are", "was", "were", "and", "but", "or", "so", "because", "that",
  "which", "who", "when", "while", "if", "then", "than", "to", "for", "with",
  "in", "on", "at", "from", "by", "into", "about", "after", "before", "can",
  "will", "would", "could", "should", "does", "do", "did", "has", "have", "had",
]);

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/**
 * Split narration into phrase cards.
 *
 * Punctuation first, because the writer's commas and full stops are a better
 * guide to where a thought ends than any word count. Only when a clause is still
 * too long to read at a glance is it broken further, and then on a word that
 * does not leave an article stranded at the end of a line.
 *
 * Works from TEXT ALONE. Word timings refine WHEN each card appears; they are
 * not needed to decide WHAT the cards are, which is what keeps this usable as
 * the fallback when there is no transcript at all.
 */
export function splitPhrases(text, { maxWords = MAX_PHRASE_WORDS } = {}) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return [];

  const clauses = clean.split(/(?<=[.!?,;:—])\s+/).filter((c) => c.trim());
  const out = [];

  for (const clause of clauses) {
    const words = clause.split(/\s+/).filter(Boolean);
    if (words.length <= maxWords) {
      out.push(words);
      continue;
    }
    // Break the long clause into near-equal parts rather than maxWords-sized
    // chunks with a two-word orphan at the end.
    const parts = Math.ceil(words.length / maxWords);
    const per = Math.ceil(words.length / parts);
    let i = 0;
    while (i < words.length) {
      const target = Math.min(words.length, i + per);
      const end = bestBreak(words, i, target, maxWords);
      out.push(words.slice(i, end));
      i = end;
    }
  }

  return out.filter((p) => p.length > 0);
}

/**
 * Where to actually cut, given where the word count wanted to.
 *
 * Searches a small window either side of the target and scores each candidate:
 * starting the next card on a word that begins a grammatical unit is worth a
 * lot, ending this one on a dangling article costs a lot, and drifting from the
 * target costs a little. The window is deliberately narrow — the point is to
 * nudge the cut onto a joint, not to re-balance the cards.
 */
function bestBreak(words, start, target, maxWords) {
  const hardMax = Math.min(words.length, start + maxWords);
  const lo = Math.max(start + 2, target - 2);
  const hi = Math.min(hardMax, target + 2);
  if (lo >= hi) return Math.min(hardMax, Math.max(target, start + 1));

  let best = target;
  let bestScore = -Infinity;
  for (let end = lo; end <= hi; end++) {
    if (end >= words.length) {
      // Taking the rest of the clause is fine and often best.
      const score = 3 - Math.abs(end - target) * 0.5;
      if (score > bestScore) { bestScore = score; best = end; }
      continue;
    }
    let score = -Math.abs(end - target) * 0.6;
    if (BREAK_BEFORE.has(normaliseWord(words[end]))) score += 4;
    if (DANGLING.has(normaliseWord(words[end - 1]))) score -= 5;
    if (/[,;:.!?—]$/.test(words[end - 1])) score += 3;
    if (score > bestScore) { bestScore = score; best = end; }
  }
  return Math.min(hardMax, Math.max(start + 1, best));
}

/**
 * Which words in a phrase get the accent colour.
 *
 * The same three classes the zoom pulses fire on — figures, negations, names —
 * so the emphasis in the type agrees with the emphasis in the edit. A phrase
 * where everything is emphasised is a phrase where nothing is, so this caps out.
 */
export function accentWords(words) {
  const NEGATIONS = new Set(["not", "no", "never", "isnt", "wasnt", "dont", "doesnt", "cant", "wont"]);
  // Narration says figures aloud, so the transcript and the script both carry
  // "four thousand dollars" rather than "$4,000". Matching only on digits meant
  // the one phrase in the sentence that most wants the accent — the money —
  // rendered in plain ink.
  const NUMBER_WORDS = new Set([
    "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
    "eleven", "twelve", "fifteen", "twenty", "thirty", "forty", "fifty", "sixty",
    "seventy", "eighty", "ninety", "hundred", "thousand", "million", "billion",
    "half", "double", "triple", "percent",
  ]);
  const marked = words.map((w, i) => {
    const norm = normaliseWord(w);
    if (/[0-9]/.test(norm)) return i;
    if (NUMBER_WORDS.has(norm)) return i;
    if (NEGATIONS.has(norm)) return i;
    if (/^[A-Z][a-z]{2,}/.test(w) && i > 0) return i;
    return -1;
  }).filter((i) => i >= 0);
  // A phrase where everything is emphasised is a phrase where nothing is, but
  // "four thousand dollars" is one idea and clipping it mid-figure looks like a
  // bug — so adjacent runs count once against the cap.
  const runs = [];
  for (const i of marked) {
    const last = runs[runs.length - 1];
    if (last && i === last[last.length - 1] + 1) last.push(i);
    else runs.push([i]);
  }
  return new Set(runs.slice(0, 2).flat());
}

/**
 * Lay a phrase out and render it at a given reveal state.
 *
 * `visible` is a word count, not an item count: the words arrive one at a time,
 * which is what makes this kinetic rather than a caption.
 *
 * AS WITH THE CARDS, the layout is measured from the FULL phrase and only
 * visibility changes. Laying out the visible words alone would re-centre the
 * block on every word, so the line would crawl sideways as it filled — the
 * single most common way kinetic typography is done badly.
 */
export function typographySvg({ words = [], eyebrow = null }, reveal = {}) {
  const visible = reveal.visible ?? Infinity;
  const current = reveal.current ?? -1;
  const pulse = Math.max(0, Math.min(1, reveal.pulse ?? 0));

  const phrase = words.join(" ");
  const accents = accentWords(words);

  // Big. This is the only thing on screen and it should feel like a statement.
  let size = 150;
  let lines = wrapText(phrase, size, CONTENT_W, BOLD_SERIF);
  while (lines.length > 3 && size > 62) {
    size -= 6;
    lines = wrapText(phrase, size, CONTENT_W, BOLD_SERIF);
  }
  lines = lines.slice(0, 3);

  // VERTICAL CENTRING IS ON THE INK, not on the line boxes.
  //
  // `top` is a BASELINE, and the visible block runs from one cap-height above
  // the first baseline to one descender below the last. Centring
  // `lines.length * lineHeight` instead counts a full line's leading below the
  // final row, which pushed a two-line phrase visibly into the upper half of
  // the frame — fine on a slide with other furniture, wrong when the type is
  // the only thing on screen and the eye has nothing else to balance it
  // against.
  const lineHeight = size * 1.22;
  const CAP = 0.70;
  const DESC = 0.22;
  const top = (TYPO_HEIGHT + (CAP - DESC) * size - (lines.length - 1) * lineHeight) / 2;
  const blockH = (lines.length - 1) * lineHeight + DESC * size;

  // ONE <text> PER LINE, CENTRED, WITH ONE <tspan> PER WORD.
  //
  // The first version positioned every word itself, advancing x by
  // `measure(word + " ")`. That cannot work, and the reason is worth keeping:
  // `measure` is a character-width ESTIMATE tuned to OVER-estimate, because
  // everywhere else it is used to shrink type until it fits and erring wide is
  // the safe direction. Used as a layout advance it puts each word further
  // right than its real glyphs need, so the rendered line came out with gaping
  // word spaces and starting from a centre computed for a narrower line — text
  // that was neither centred nor evenly spaced, on the one layer whose entire
  // job is to look like the words matter.
  //
  // Letting the SVG renderer lay out the line fixes both: it has the real font
  // metrics, and `text-anchor="middle"` centres against the real width.
  //
  // HIDDEN WORDS ARE DRAWN AT ZERO OPACITY rather than omitted. A centred line
  // that only contains the words revealed so far re-centres on every reveal,
  // and the phrase crawls sideways as it fills. Keeping the full line present
  // and invisible reserves the exact final geometry from the first frame.
  let wordIndex = 0;
  const drawn = lines.map((line, li) => {
    const lineWords = line.split(/\s+/).filter(Boolean);
    const y = top + li * lineHeight;
    const startIndex = wordIndex;

    const spans = lineWords.map((w, wi) => {
      const idx = wordIndex++;
      const shown = idx < visible;
      const isCurrent = idx === current;
      const isAccent = accents.has(idx);
      const fill = isAccent ? ACCENT : C.ink;
      const opacity = !shown ? 0 : isCurrent ? 1 : 0.82;
      const tail = wi < lineWords.length - 1 ? " " : "";
      return `<tspan xml:space="preserve" fill="${fill}" fill-opacity="${opacity.toFixed(3)}">${esc(w)}${tail}</tspan>`;
    }).join("");

    // The line pops as a word lands on it. Scaling the LINE rather than the
    // word keeps the type metrics untouched — a per-word font-size change would
    // re-flow and re-centre the line under the very word that just arrived.
    const currentOnThisLine = current >= startIndex && current < wordIndex;
    const scale = currentOnThisLine ? 1 + 0.028 * pulse : 1;
    const cx = TYPO_WIDTH / 2;
    const open = scale !== 1
      ? `<g transform="translate(${cx} ${y.toFixed(1)}) scale(${scale.toFixed(4)}) translate(${-cx} ${(-y).toFixed(1)})">`
      : "<g>";

    return `${open}<text x="${cx}" y="${y.toFixed(1)}" font-family="${SERIF}" font-size="${size}" font-weight="bold" text-anchor="middle">${spans}</text></g>`;
  }).join("\n  ");

  // Clear of the deepest descender on the last line, not of the baseline. At
  // +26 the rule sat on the tail of a "y" and read as an underline that had
  // slipped.
  const rule = `<rect x="${(TYPO_WIDTH / 2 - 90).toFixed(1)}" y="${(top + blockH + size * 0.46).toFixed(1)}" width="180" height="4" rx="2" fill="${ACCENT}" fill-opacity="0.5"/>`;
  const eyebrowSvg = eyebrow
    ? `<text x="${TYPO_WIDTH / 2}" y="180" font-family="${SANS}" font-size="38" fill="${C.muted}" text-anchor="middle" letter-spacing="6">${esc(String(eyebrow).toUpperCase())}</text>`
    : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${TYPO_WIDTH}" height="${TYPO_HEIGHT}" viewBox="0 0 ${TYPO_WIDTH} ${TYPO_HEIGHT}">
  <rect width="${TYPO_WIDTH}" height="${TYPO_HEIGHT}" fill="${BG}"/>
  ${eyebrowSvg}
  ${drawn}
  ${rule}
</svg>`;
}

export async function typographyPng(spec, reveal) {
  return sharp(Buffer.from(typographySvg(spec, reveal))).png({ compressionLevel: 9 }).toBuffer();
}

/**
 * Allocate phrase cards across the segment's runtime.
 *
 * With word timings, each card runs from its first word to the last word of the
 * phrase — so the type tracks the voice exactly, including the pauses. Without
 * them, the cards divide the runtime in proportion to their word counts, which
 * is a decent approximation of speech and much better than equal shares (a
 * two-word card does not deserve the same screen time as an eight-word one).
 *
 * @returns {{ cards, synced, source }}
 */
export function planTypography({ text, words = null, seconds, eyebrow = null }) {
  const phrases = splitPhrases(text);
  if (phrases.length === 0) return { cards: [], synced: false, source: "none" };

  const usable = Array.isArray(words) && words.length > 0;
  const cards = [];

  if (usable) {
    // Walk the transcript alongside the phrases. Whisper's tokens will not
    // match the script's words exactly — it drops punctuation, splits
    // contractions, mishears — so this advances a cursor and takes the best
    // available match rather than requiring alignment.
    let cursor = 0;
    for (const phrase of phrases) {
      const wordTimes = [];
      for (const w of phrase) {
        const target = normaliseWord(w);
        let found = null;
        for (let i = cursor; i < words.length && i < cursor + 12; i++) {
          const cand = normaliseWord(words[i].word);
          if (!cand) continue;
          if (cand === target || cand.startsWith(target) || target.startsWith(cand)) {
            found = words[i];
            cursor = i + 1;
            break;
          }
        }
        wordTimes.push(found ? found.start : null);
      }
      const anchored = wordTimes.filter((t) => t !== null);
      cards.push({
        words: phrase,
        wordTimes,
        start: anchored.length ? anchored[0] : null,
        anchoredCount: anchored.length,
      });
    }

    // Fill the gaps left by unmatched phrases, then clamp into the runtime.
    fillMissingStarts(cards, seconds);
    const synced = cards.some((c) => c.anchoredCount > 0);
    return { cards: finalise(cards, seconds, eyebrow), synced, source: synced ? "word-timing" : "even-pacing" };
  }

  // No transcript: divide by word count.
  const totalWords = phrases.reduce((n, p) => n + p.length, 0);
  let at = 0;
  for (const phrase of phrases) {
    const share = (phrase.length / totalWords) * seconds;
    cards.push({ words: phrase, wordTimes: phrase.map(() => null), start: at, anchoredCount: 0 });
    at += share;
  }
  return { cards: finalise(cards, seconds, eyebrow), synced: false, source: "even-pacing" };
}

function fillMissingStarts(cards, seconds) {
  // Anything with no anchor is placed between its anchored neighbours.
  for (let i = 0; i < cards.length; i++) {
    if (cards[i].start !== null) continue;
    let prev = i - 1;
    while (prev >= 0 && cards[prev].start === null) prev--;
    let next = i + 1;
    while (next < cards.length && cards[next].start === null) next++;
    const before = prev >= 0 ? cards[prev].start : 0;
    const after = next < cards.length ? cards[next].start : seconds;
    cards[i].start = before + ((after - before) * (i - prev)) / (next - prev);
  }
  // Monotonic, always. A card that starts before the one in front of it makes
  // the concat list non-increasing and ffmpeg silently drops the overlap.
  for (let i = 1; i < cards.length; i++) {
    if (cards[i].start <= cards[i - 1].start) cards[i].start = cards[i - 1].start + 0.3;
  }
}

/**
 * Give every card an end, merge any that are too brief to read, and distribute
 * word arrival times inside each one.
 */
function finalise(cards, seconds, eyebrow) {
  const out = [];
  for (let i = 0; i < cards.length; i++) {
    const start = Math.max(0, Math.min(seconds, cards[i].start ?? 0));
    const end = i + 1 < cards.length ? Math.min(seconds, cards[i + 1].start) : seconds;
    out.push({ ...cards[i], start, end });
  }

  // A card too short to read is folded into its predecessor rather than shown.
  // Two words flashing for 300ms is worse than a slightly longer card.
  const merged = [];
  for (const card of out) {
    const prev = merged[merged.length - 1];
    if (prev && card.end - card.start < MIN_PHRASE_SECONDS) {
      prev.words = [...prev.words, ...card.words];
      prev.wordTimes = [...prev.wordTimes, ...card.wordTimes];
      prev.end = card.end;
      continue;
    }
    merged.push({ ...card });
  }
  if (merged.length === 0) return [];

  // The last card always runs to the end of the segment. Anything else leaves a
  // hole at the tail, and a hole is a black frame.
  merged[merged.length - 1].end = seconds;

  return merged.map((card) => {
    const span = Math.max(0.2, card.end - card.start);
    const n = card.words.length;
    // Words with a real timestamp use it; the rest are spread across whatever
    // room is left, so a partly-matched phrase still arrives word by word.
    const times = card.wordTimes.map((t, i) => {
      if (t !== null && t >= card.start - 0.3 && t <= card.end) return Math.max(card.start, t);
      return card.start + (span * 0.62 * i) / Math.max(1, n - 1 || 1);
    });
    for (let i = 1; i < times.length; i++) if (times[i] <= times[i - 1]) times[i] = times[i - 1] + 0.06;
    return {
      words: card.words,
      times: times.map((t) => Math.min(t, card.end - 0.05)),
      start: round(card.start),
      end: round(card.end),
      seconds: round(card.end - card.start),
      anchoredCount: card.anchoredCount,
      eyebrow,
    };
  });
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}
