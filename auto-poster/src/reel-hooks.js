/**
 * reel-hooks.js — the first three seconds, three different ways.
 *
 * A variant here differs from the master in ONE thing: how it opens. A line of
 * text over the first three seconds, and optionally a cold open that starts the
 * video a beat later so it lands on a cut instead of a breath. Everything after
 * second three is the same edited master, which is what makes an A/B between
 * them mean something — if the variants differed in five ways, a winner would
 * tell you nothing about which one mattered.
 *
 * ─── WHERE THE LINES COME FROM ──────────────────────────────────────────────
 *
 * The video's own transcript, via Whisper. Not the filename, not a topic, not a
 * model asked to imagine what a property video might say. That constraint is
 * what makes the honesty gate below possible at all: a hook can only be checked
 * against the video when the video has said something to check it against.
 *
 * ─── THE HONESTY GATE, AND WHY IT IS MECHANICAL ─────────────────────────────
 *
 * Peter's rule: no hook promising something the video does not contain. That is
 * a rule a model will follow most of the time, and "most of the time" is not a
 * property — it is a defect rate. yt-punch.js learned this expensively: it
 * claimed its text was built from the captions' own tokens, believed it for
 * months, and one branch quietly joined two stripped tokens into a phrase the
 * captions never said. The fix there was to filter on the property where the
 * strings are made. Same answer here.
 *
 * So three gates run over every candidate, all deterministic, all universal —
 * no vocabulary of this market, this business, or this kind of video:
 *
 *   FIGURES     Every number-bearing token in the line must appear in the
 *               transcript. A hook that invents "$340,000" over a video that
 *               never says a price is the single most damaging thing this
 *               feature could ship, and it is a set membership test.
 *   SUPERLATIVES  "best", "only", "never", "guaranteed" and their kin are
 *               rejected unless the transcript says that word itself. These are
 *               the claims that turn a hook into a promise, and a model reaches
 *               for them precisely because they stop the scroll.
 *   ABOUTNESS   The line must share at least one content word with the
 *               transcript. A line that shares nothing is not a hook for this
 *               video; it is a hook for some video.
 *
 * ─── AND THE STOPPING-POWER RULES ARE THE ONES WE ALREADY HAVE ──────────────
 *
 * `hookOpensQualified` and `findPreamble` are imported from yt-script.js
 * unchanged. They are the mechanical half of the long-form hook standard — no
 * greeting, no channel name, no first clause spent defining the audience, the
 * claim inside the first six words — and they are pure functions over a string,
 * so there is nothing about them that is long-form-specific except where they
 * happen to live. The critic in yt-thumbnail-hook.js scores what survives, and
 * degrades to unscored without an API key rather than blocking a render.
 */

import { callModel } from "./yt-thumbnail-hook.js";
import { hookOpensQualified, findPreamble } from "./yt-script.js";
import { stripDashes } from "./sanitize.js";

/** How many variants a video gets. Peter asked for two or three. */
export const MIN_VARIANTS = 2;
export const MAX_VARIANTS = 3;

/** A hook line is read in about a second and a half. */
export const MIN_HOOK_WORDS = 3;
export const MAX_HOOK_WORDS = 10;

/** The first six words are the whole fight — the long-form standard, applied here. */
export const HOOK_PUNCH_WORDS = 6;

/** How long the hook plate holds. Peter asked for a first-three-seconds treatment. */
export const HOOK_HOLD_SECONDS = 3;

export const VARIANT_LABELS = ["A", "B", "C"];

/**
 * Claim words that turn a hook into a promise.
 *
 * A CLOSED LIST ON PURPOSE, and short. Every entry is a word that asserts
 * something absolute about the thing on screen, so using one the video never
 * said is the definition of a hook the video does not pay off. It is not a
 * style filter: "beautiful" and "stunning" are not here, because they are
 * opinions rather than claims and the caption layer already scrubs listing
 * vocabulary.
 */
export const SUPERLATIVES = new Set([
  "best", "worst", "cheapest", "biggest", "largest", "smallest", "lowest", "highest",
  "only", "never", "always", "every", "guaranteed", "perfect", "unbeatable",
  "first", "last", "must", "cannot", "impossible", "free",
]);

/**
 * Words too common to prove a line is about this video.
 *
 * The same job STOPWORDS does in yt-thumbnail-hook.js, and deliberately a
 * separate list: that one exists to measure redundancy against a title, and
 * widening it there would change how thumbnails are scored on the long-form
 * pipeline. Two small lists that each do one job beat one shared list that
 * couples two features.
 */
const FUNCTION_WORDS = new Set([
  "the", "a", "an", "of", "in", "on", "to", "for", "and", "or", "but", "is", "are",
  "was", "were", "be", "been", "it", "its", "this", "that", "these", "those", "your",
  "you", "my", "our", "their", "his", "her", "with", "from", "at", "by", "as", "if",
  "what", "which", "who", "how", "why", "when", "where", "not", "no", "yes", "do",
  "does", "did", "can", "will", "just", "than", "then", "so", "up", "out", "about",
  "here", "there", "they", "we", "i", "me", "him", "them", "get", "got", "got",
  "one", "two", "like", "look", "see", "now", "all", "more", "most", "some",
]);

/** Lowercased, punctuation-stripped words. */
export function words(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9$%.\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Words that carry meaning. */
export function contentWords(text) {
  return words(text).filter((w) => !FUNCTION_WORDS.has(w) && !/^[\d$%.]+$/.test(w));
}

/**
 * Every token in a line that carries a figure.
 *
 * Matched on SHAPE rather than against a list, exactly as yt-punch.js
 * recognises emphasis: a currency amount, a percentage or a bare number is a
 * property of English, not of any one script. Trailing punctuation is stripped
 * because "$340,000." and "$340,000" are the same claim.
 */
export function figureTokens(text) {
  return String(text ?? "")
    .split(/\s+/)
    .map((t) => t.replace(/^[^\w$]+|[^\w%]+$/g, ""))
    .filter((t) => /\d/.test(t));
}

/**
 * Does the transcript contain this figure?
 *
 * Compared on DIGITS ALONE, because a transcript and a written hook spell the
 * same number differently as a matter of course: Whisper writes "340,000" or
 * "340000" or "three hundred forty thousand" for the same spoken amount, and a
 * string comparison would reject an honest hook most of the time. Digits are
 * the part that cannot be re-spelled, so a hook saying 340000 over a video that
 * says 340,000 passes, and one saying 450000 does not.
 *
 * The spelled-out case is handled by the caller giving the model a transcript
 * to draw from; a hook whose figure appears nowhere in digits AND is not a word
 * the transcript used is rejected, which is the safe direction.
 */
export function figureSupported(token, transcript) {
  const digits = String(token).replace(/[^\d]/g, "");
  if (!digits) return true;
  const haystack = String(transcript ?? "");
  if (haystack.replace(/[^\d]/g, "").includes(digits)) return true;
  // A percentage or a small count often survives as a word. Accept it only when
  // the WHOLE token appears in the transcript, which is a stricter test than
  // the digit one and cannot match a coincidence of digits.
  return haystack.toLowerCase().includes(String(token).toLowerCase());
}

/**
 * Check one candidate against the video. Returns the reasons it fails.
 *
 * Every reason is a sentence a human can act on, because they end up in the
 * run log and, when nothing survives, in the failure card.
 */
export function validateHookLine(line, transcript) {
  const failures = [];
  const text = String(line ?? "").trim();
  if (!text) return { valid: false, failures: ["empty"] };

  const w = text.split(/\s+/).filter(Boolean);
  if (w.length < MIN_HOOK_WORDS) failures.push(`${w.length} word(s), need at least ${MIN_HOOK_WORDS}`);
  if (w.length > MAX_HOOK_WORDS) failures.push(`${w.length} words, max ${MAX_HOOK_WORDS} for an on-screen hook`);

  // The long-form hook standard, unchanged and imported.
  const qualified = hookOpensQualified(text);
  if (qualified) failures.push(qualified);
  failures.push(...findPreamble({ hook: text }));

  // ── honesty ──────────────────────────────────────────────────────────────
  for (const token of figureTokens(text)) {
    if (!figureSupported(token, transcript)) {
      failures.push(`"${token}" is a figure the video never says — a hook may not invent a number`);
    }
  }

  const said = new Set(words(transcript));
  for (const word of words(text)) {
    if (SUPERLATIVES.has(word) && !said.has(word)) {
      failures.push(`"${word}" claims something absolute that the video never claims`);
    }
  }

  const shared = contentWords(text).filter((x) => said.has(x));
  if (contentWords(text).length > 0 && shared.length === 0) {
    failures.push("shares no content word with the transcript — this is a hook for some other video");
  }

  return { valid: failures.length === 0, failures, sharedWords: shared };
}

/** The first six words, which is what a scroller actually reads. */
export function firstSix(line, n = HOOK_PUNCH_WORDS) {
  return String(line ?? "").trim().split(/\s+/).filter(Boolean).slice(0, n).join(" ");
}

/**
 * Rank surviving candidates without a model.
 *
 * Deterministic, so the same transcript produces the same ordering on a re-run
 * and a rejected re-edit does not silently reshuffle which line is A. Three
 * signals, all mechanical:
 *
 *   - a figure or a concrete noun INSIDE the first six words, because that is
 *     where the stopping power has to be
 *   - brevity, because a long line is read after the moment has passed
 *   - it is grounded: how much of the line the video actually supports
 *
 * The model critic scores on top of this when one is reachable; this is what
 * decides the order when it is not, and what breaks its ties when it is.
 */
export function rankScore(line, transcript) {
  const six = firstSix(line);
  const sixWords = words(six);
  let score = 0;
  if (sixWords.some((w) => /\d/.test(w))) score += 3;
  if (contentWords(six).length >= 2) score += 2;
  const total = String(line).trim().split(/\s+/).filter(Boolean).length;
  if (total <= 7) score += 2;
  else if (total <= 9) score += 1;
  const said = new Set(words(transcript));
  const grounded = contentWords(line).filter((w) => said.has(w)).length;
  score += Math.min(3, grounded);
  return score;
}

const WRITER_SYSTEM = `You write the line of text that appears over the first three seconds of a short vertical video.

YOU ARE GIVEN THE VIDEO'S OWN TRANSCRIPT. Everything you write must be true of THAT video. You are not writing an ad; you are writing the reason someone stops scrolling on the thing they are about to watch.

THE RULES, all of them load-bearing:
- THE FIRST SIX WORDS ARE THE WHOLE FIGHT. Put the claim there. A line whose first clause defines the audience ("If you're looking for...", "For anyone who...") has wasted the only part that gets read.
- No greeting, no introduction, no "in this video". Cold open.
- THREE TO TEN WORDS TOTAL. It is read in a second and a half on a phone.
- NEVER state a number the transcript does not state. Not a price, not a square footage, not a rate, not a count. If the transcript has no figure, write a line with no figure.
- NEVER claim something is the best, the only, the cheapest, guaranteed, or free unless the transcript says so in those words.
- Open a loop: something surprising, something that costs, something the viewer would not guess. Not a label, not a summary, not a category.
- Plain spoken words. It should sound like what a person says right before they show you the thing.

WRITE THREE CANDIDATES, genuinely different from each other — different angle each, not three drafts of one idea. They compete; the scorer picks.

Return ONLY valid JSON, no preamble and no code fences:
{"candidates": ["FIRST LINE", "A DIFFERENT ANGLE", "A THIRD ANGLE"]}`;

export const writerSystem = () => WRITER_SYSTEM;

function parseJson(raw) {
  let t = String(raw || "").trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON object in model output");
  return JSON.parse(t.slice(start, end + 1));
}

/**
 * Write and gate the hook lines for one video.
 *
 * Returns { lines, rejected, attemptsUsed }. NEVER throws for a content reason:
 * a video whose hooks all failed still has an edited master worth reviewing, and
 * the caller decides whether two lines are enough rather than having a render
 * thrown away here. `rejected` carries every candidate and why it died, because
 * a run where the model produced three dishonest lines is worth seeing.
 */
export async function generateHookLines({
  transcript,
  want = MAX_VARIANTS,
  maxRetries = 2,
  modelCall = callModel,
} = {}) {
  const text = String(transcript ?? "").trim();
  if (!text) {
    return { lines: [], rejected: [], attemptsUsed: 0, reason: "the video has no transcript to write a hook from" };
  }

  const seen = new Set();
  const kept = [];
  const rejected = [];
  let feedback = "";
  let attempt = 0;

  for (; attempt <= maxRetries && kept.length < want; attempt++) {
    let candidates;
    try {
      const raw = await modelCall(
        WRITER_SYSTEM,
        `THE VIDEO'S TRANSCRIPT:\n${text.slice(0, 6000)}\n\nWrite the hook lines.${feedback}`
      );
      const parsed = parseJson(raw);
      const list = Array.isArray(parsed.candidates) ? parsed.candidates : [parsed.hook];
      candidates = list.map((c) => stripDashes(String(c || "")).trim()).filter(Boolean);
    } catch (err) {
      console.warn(`[ReelHooks] attempt ${attempt + 1}: unparseable output (${err.message})`);
      feedback = `\n\nYour previous output could not be parsed as JSON: ${err.message}. Return ONLY the JSON object.`;
      continue;
    }

    for (const line of candidates) {
      const key = line.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const check = validateHookLine(line, text);
      if (!check.valid) {
        console.warn(`[ReelHooks] rejected "${line}" — ${check.failures.join("; ")}`);
        rejected.push({ line, failures: check.failures });
        continue;
      }
      kept.push({ line, score: rankScore(line, text), sharedWords: check.sharedWords });
    }

    if (kept.length < want) {
      const why = rejected.slice(-4).map((r) => `"${r.line}": ${r.failures.join("; ")}`).join("\n");
      feedback =
        `\n\nThese were rejected:\n${why || "(none parsed)"}\n` +
        `Write ${want} NEW lines. Every number must appear in the transcript. Put the claim in the first six words.`;
    }
  }

  kept.sort((a, b) => b.score - a.score || a.line.localeCompare(b.line));
  return { lines: kept.slice(0, want), rejected, attemptsUsed: attempt };
}

/**
 * Turn the surviving lines into the variant plan.
 *
 * ONE AXIS OF DIFFERENCE AT A TIME. The first variant is the master with a hook
 * plate over it. The second and third also move the cold open to the next
 * available cut, so an A/B says something about the opening treatment rather
 * than about six things at once. A video with only one legal cut point in its
 * first three seconds produces variants that differ in the line alone, which is
 * still a valid A/B and is reported as such.
 */
export function planVariants(lines, coldOpenCandidates = []) {
  const points = [0, ...coldOpenCandidates.filter((p) => p > 0)];
  return lines.slice(0, MAX_VARIANTS).map((entry, i) => ({
    label: VARIANT_LABELS[i],
    hookLine: entry.line,
    score: entry.score,
    // Variant A always opens where the master does, so there is a control.
    coldOpenAt: i === 0 ? 0 : points[Math.min(i, points.length - 1)] || 0,
    holdSeconds: HOOK_HOLD_SECONDS,
    treatment: i === 0 || !points[Math.min(i, points.length - 1)]
      ? "hook plate over the master's own opening"
      : `hook plate, cold open ${points[Math.min(i, points.length - 1)]}s in (on a cut)`,
  }));
}
