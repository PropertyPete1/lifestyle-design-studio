/**
 * yt-voice.js — making the scripts sound like Peter instead of like an AI.
 *
 * Two mechanisms, deliberately different in kind:
 *
 *   PULL — show the writer how Peter actually talks, by feeding it real
 *          transcripts of his own hand-recorded narration.
 *   PUSH — ban the specific phrases that mark copy as machine-written, and
 *          detect them deterministically so a violation forces a regeneration
 *          rather than depending on the critic noticing.
 *
 * The push half is a hard gate because the critic is a model too, and a model
 * asked "does this sound like AI wrote it?" will miss its own idioms. A string
 * match will not.
 *
 * ─── ON THE VOICE-REFERENCE CORPUS, READ THIS BEFORE TRUSTING IT ───
 *
 * posted-log.json entries with `voiceover: false` are Whisper captures of
 * Peter's own narration, which is exactly the right source. But main.js stores
 * them truncated to the first TEN WORDS — they were added as an audit
 * fingerprint, not as writing samples. Every one of the 32 entries on record is
 * a 10-word fragment, several of them mistranscribed ("Quit payment math
 * prices 5.79.99").
 *
 * Feeding those to a writer as "match this voice" would teach it to imitate a
 * truncated transcription error. So samples are quality-gated below, and when
 * nothing clears the bar the writer gets NO voice block at all — a writer with
 * no reference writes generically, which the authenticity axis then catches,
 * and that is a much better failure than a writer confidently imitating noise.
 *
 * The fix is upstream and has two halves: main.js now stores the full
 * transcript going forward, and the recording-kit ingest produces full Whisper
 * transcripts of Peter reading his own takes — a far better corpus than the
 * narration fragments ever were. Both feed the same gate.
 */

import { validPosts } from "./state.js";

/** A sample shorter than this is a fragment, not a voice. */
export const MIN_SAMPLE_WORDS = 25;

/** How many samples the writer sees. Two to three, per the spec. */
export const VOICE_SAMPLE_COUNT = 3;

/**
 * The AI tells, banned outright.
 *
 * Only phrases that can be matched deterministically live here. Adjective
 * triads and "summary paragraphs that restate what was just said" are real
 * tells too, but catching them needs judgement rather than a regex — those are
 * the critic's job, on the authenticity axis. Splitting them this way is
 * deliberate: everything that CAN be caught mechanically is, so the critic's
 * attention goes to the things only judgement can catch.
 */
export const BANNED_TELLS = [
  // Real-estate-copy tells
  { pattern: /\bnestled\b/i, label: "nestled" },
  { pattern: /\bboasts?\b/i, label: "boasts" },
  { pattern: /\bstunning\b/i, label: "stunning" },
  { pattern: /\bbreathtaking\b/i, label: "breathtaking" },
  { pattern: /\bcharming\b/i, label: "charming" },
  { pattern: /\bluxurious\b/i, label: "luxurious" },
  { pattern: /\boasis\b/i, label: "oasis" },
  { pattern: /\bhidden gem\b/i, label: "hidden gem" },
  { pattern: /\blook no further\b/i, label: "look no further" },
  { pattern: /\bdream home\b/i, label: "dream home" },
  // Generic LLM tells
  { pattern: /\bwhether you(?:'re| are)\b[^.!?]*\bor\b/i, label: "whether you're X or Y" },
  { pattern: /\bin today's market\b/i, label: "in today's market" },
  { pattern: /\bin today's (?:fast-paced|ever-changing|competitive)\b/i, label: "in today's <adjective> ..." },
  { pattern: /\blet(?:'s| us) dive in\b/i, label: "let's dive in" },
  { pattern: /\blet(?:'s| us) (?:dive|jump) into\b/i, label: "let's dive into" },
  { pattern: /\bdelve into\b/i, label: "delve into" },
  { pattern: /\bwhen it comes to\b/i, label: "when it comes to" },
  { pattern: /\bat the end of the day\b/i, label: "at the end of the day" },
  { pattern: /\bthat being said\b/i, label: "that being said" },
  { pattern: /\bit(?:'s| is) important to (?:note|remember|understand)\b/i, label: "it's important to note" },
  { pattern: /\bin conclusion\b/i, label: "in conclusion" },
  { pattern: /\bto sum (?:up|it up)\b/i, label: "to sum up" },
  { pattern: /\bgame[- ]chang(?:er|ing)\b/i, label: "game-changer" },
  { pattern: /\bunlock the (?:secret|potential|power)\b/i, label: "unlock the ..." },
  { pattern: /\bnavigate the\b/i, label: "navigate the ..." },
  { pattern: /\bwe(?:'ve| have) got you covered\b/i, label: "we've got you covered" },
  { pattern: /\bthe perfect blend of\b/i, label: "the perfect blend of" },
  { pattern: /\bmore than just\b/i, label: "more than just" },
];

/**
 * Every banned tell present in a piece of text.
 * Returns [] for clean copy, so the caller can treat truthiness as "violation".
 */
export function findBannedTells(text) {
  if (!text || typeof text !== "string") return [];
  const hits = [];
  for (const { pattern, label } of BANNED_TELLS) {
    const m = text.match(pattern);
    if (m) hits.push({ label, match: m[0] });
  }
  return hits;
}

/** Scan many strings at once — a whole script's worth of copy. */
export function findBannedTellsIn(texts) {
  const seen = new Map();
  for (const t of texts || []) {
    for (const hit of findBannedTells(t)) {
      if (!seen.has(hit.label)) seen.set(hit.label, hit);
    }
  }
  return [...seen.values()];
}

/**
 * Is this transcript usable as a writing sample?
 *
 * Length is the main filter — see the header. The digit-density check catches
 * the payment-math narrations, which are almost entirely numbers and would
 * teach the writer to open every script by reciting a price.
 */
export function isUsableSample(text, minWords = MIN_SAMPLE_WORDS) {
  if (!text || typeof text !== "string") return false;
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length < minWords) return false;
  const digitWords = words.filter((w) => /\d/.test(w)).length;
  if (digitWords / words.length > 0.25) return false;
  return true;
}

/**
 * Peter's own narration, newest first, filtered to what is actually usable.
 *
 * `voiceover === false` means the video already had his voice on it and Whisper
 * transcribed HIM — the opposite of the entries voiceover-style.js uses as
 * "do not resemble" anti-examples, which are the machine's own past output.
 */
export function getVoiceSamples(log, { limit = VOICE_SAMPLE_COUNT, minWords = MIN_SAMPLE_WORDS } = {}) {
  const posts = validPosts(log);
  const out = [];
  for (let i = posts.length - 1; i >= 0 && out.length < limit; i--) {
    const p = posts[i];
    if (p.voiceover !== false) continue;
    const t = typeof p.voiceover_transcript === "string" ? p.voiceover_transcript.trim() : "";
    if (!isUsableSample(t, minWords)) continue;
    if (out.includes(t)) continue; // the same tour gets reposted; don't show it twice
    out.push(t);
  }
  return out;
}

/**
 * Extra voice samples harvested from Peter's recorded takes.
 *
 * These are full Whisper transcripts of him reading a script aloud, so they are
 * the best corpus available once any recording has been ingested — longer and
 * cleaner than the narration fragments, and captured in the exact register the
 * scripts are written for.
 */
export function samplesFromTakes(takes, { limit = VOICE_SAMPLE_COUNT, minWords = MIN_SAMPLE_WORDS } = {}) {
  const out = [];
  for (const take of takes || []) {
    const t = typeof take?.transcript === "string" ? take.transcript.trim() : "";
    if (!isUsableSample(t, minWords)) continue;
    if (out.includes(t)) continue;
    out.push(t);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * The voice-reference block for the writer prompt.
 *
 * Returns "" when there is nothing usable. That is a real outcome, not an edge
 * case — see the header. An empty block is strictly better than a block full of
 * 10-word fragments.
 */
export function buildVoiceBlock(samples) {
  if (!samples?.length) return "";
  const lines = samples.map((s, i) => `${i + 1}. "${s.replace(/\s+/g, " ").trim()}"`).join("\n");
  return (
    `\nHOW PETER ACTUALLY TALKS. These are real transcripts of him narrating his own videos. ` +
    `Match the sentence length, the word choices, and the energy. Do not match the subject matter, ` +
    `and do not copy phrases out of them:\n${lines}\n`
  );
}

/** The banned-tell block for the writer prompt. */
export function buildBannedBlock() {
  const labels = BANNED_TELLS.map((b) => b.label);
  return (
    `\nBANNED — these mark copy as machine-written and are checked automatically. ` +
    `Using any of them forces a full rewrite:\n` +
    labels.map((l) => `  - "${l}"`).join("\n") +
    `\nAlso banned, and judged rather than matched:\n` +
    `  - three adjectives in a row ("spacious, modern, and inviting")\n` +
    `  - any paragraph that restates what the previous paragraph just said\n` +
    `  - summary sentences that add nothing ("So as you can see, there is a lot to consider.")\n`
  );
}
