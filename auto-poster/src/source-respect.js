/**
 * source-respect.js — three gates that stop the pipeline talking over its source.
 *
 * Born from the 2026-08-26 San Antonio post (003001B1-0C39-4A31-82EE-FD86C942D049.mp4):
 * a presenter was talking on camera, her clip already carried burned-in captions,
 * and the on-screen price was $2,500. The pipeline paved an AI voiceover of
 * Peter's voice over her speech (`hallucination_override_add_voiceover`), burned
 * a second caption layer over her captions, and the voiceover said a price the
 * video never shows. Three separate failures, one root cause: nothing treated
 * the source clip as the content.
 *
 *   GATE 1 — NO VOICEOVER OVER EXISTING SPEECH. If the source audio transcribes
 *   to more than incidental words, someone is talking, and a person talking in
 *   their own video is the content, not a bed to pave over. The verdict is
 *   MECHANICAL — a word count — because the failure above was precisely a model
 *   (the Haiku "coherence check") being allowed to overrule the transcript. A
 *   transcript with twelve words in it is someone talking no matter how odd the
 *   words read; oddness is Whisper mishearing, and mishearing is evidence OF
 *   speech, not against it.
 *
 *   GATE 2 — NO CAPTIONS OVER CAPTIONS. Frames sampled across the whole clip,
 *   read with the same tesseract tooling the long-form artifact QC uses. Text
 *   that CHANGES across the clip is a subtitle track; text that stays put is a
 *   price/location overlay, which nearly every listing clip has and which must
 *   not disable our captions. So the verdict counts DISTINCT texts, not text.
 *
 *   GATE 3 — NUMBER HONESTY. Every figure the generated voiceover or its burned
 *   captions state must equal a figure that actually appears in the source
 *   (spoken in its audio or visible on its frames). Same discipline as the reel
 *   hook honesty gate (reel-hooks.js): equality on the whole figure, never
 *   substring — 2,500 is not 2,500,000, and a figure is only "said" if it is
 *   not part of a longer one. A number that cannot be verified is a number that
 *   does not get spoken.
 *
 * Every gate skips LOUDLY. The posted-log entry and the run log both say what
 * was skipped and why, in words a human can act on. Silence is how the August
 * incident shipped.
 */

import { spawnSync, execFileSync } from "child_process";
import { rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ─── GATE 1: speech verdict ─────────────────────────────────────────────────

/**
 * More words than this in the source transcript = someone is talking.
 *
 * Five words absorbs incidental audio — a "wow", an off-camera "look at this" —
 * without letting a single sentence of real speech through. Deliberately low:
 * the cost of a false positive is a clip posting with its own audio and no
 * voiceover (fine), the cost of a false negative is paving over a person (the
 * incident).
 */
export const INCIDENTAL_WORD_MAX = 5;

/**
 * Decide whether the source clip contains someone talking.
 *
 * Input is the detectSpeech() result. The verdict is word count over the
 * transcript, NOT `hasSpeech`: detect-speech.py's hallucination heuristics can
 * flip `hasSpeech` off while the transcript still carries a person's words, and
 * the coherence check that used to arbitrate this is exactly the judge that
 * approved the August paving. No model opinion can turn transcribed words into
 * not-speech.
 *
 * A Whisper ERROR is treated as speech (fail-safe, unchanged from the old
 * policy): an unheard clip must never get a voiceover.
 */
export function speechVerdict(detection = {}) {
  if (detection.error) {
    return {
      sourceHasSpeech: true,
      wordCount: null,
      reason: "whisper_error_failsafe",
      say: "voiceover skipped: the source audio could not be transcribed, so it is assumed to contain speech (fail-safe)",
    };
  }
  const transcript = String(detection.transcript || "").trim();
  const wordCount = Number.isFinite(detection.wordCount)
    ? detection.wordCount
    : (transcript ? transcript.split(/\s+/).length : 0);

  if (wordCount > INCIDENTAL_WORD_MAX) {
    return {
      sourceHasSpeech: true,
      wordCount,
      reason: "source_has_speech",
      say: `voiceover skipped: source has speech (${wordCount} words transcribed) — the person talking is the content`,
    };
  }
  return {
    sourceHasSpeech: false,
    wordCount,
    reason: wordCount > 0 ? "incidental_words_only" : "no_speech",
    say: null,
  };
}

// ─── GATE 2: burned-in caption detection ────────────────────────────────────

/** Is tesseract on this machine? A check that cannot run is not a check that passed. */
export function ocrAvailable(run = spawnSync) {
  const res = run("tesseract", ["--version"], { encoding: "utf-8" });
  return !res.error && res.status === 0;
}

/**
 * Where to look. Evenly spaced across the middle 90% of the clip: subtitles
 * live wherever the talking is, and the first/last moments are titles and
 * fade-outs that would read as extra "novel" texts.
 */
export function captionSampleTimestamps(durationSec, count = 8) {
  const dur = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 30;
  const start = dur * 0.05;
  const span = dur * 0.9;
  const n = Math.max(2, count);
  return Array.from({ length: n }, (_, i) => +(start + (span * i) / (n - 1)).toFixed(2));
}

/** Letters and digits only, upper-cased — what survives OCR across fonts. */
export function ocrNormaliseTokens(s) {
  return String(s || "")
    .toUpperCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^A-Z0-9]/g, ""))
    .filter((t) => t.length >= 2);
}

/** Token-set Jaccard similarity — how much two OCR readings are the same text. */
export function tokenSimilarity(aTokens, bTokens) {
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared || 1);
}

/**
 * Count how many DISTINCT texts the sampled frames carry.
 *
 * A static price overlay reads as (roughly) the same tokens on every frame —
 * one novel text however many frames it appears on, however badly OCR fuzzes
 * it, because fuzzy readings of one overlay still share most of their tokens.
 * A subtitle track reads as a different text every few seconds. The 0.5
 * similarity threshold is the line between "the same overlay, misread" and
 * "a different sentence".
 */
export function countNovelTexts(frameTexts) {
  const kept = [];
  let textFrames = 0;
  for (const raw of frameTexts) {
    const tokens = ocrNormaliseTokens(raw);
    // Fewer than two real tokens is OCR noise, not text.
    if (tokens.length < 2) continue;
    textFrames++;
    const isNovel = kept.every((seen) => tokenSimilarity(tokens, seen) < 0.5);
    if (isNovel) kept.push(tokens);
  }
  return { textFrames, novelTexts: kept.length };
}

function defaultExtract(args) {
  execFileSync("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"], timeout: 30000 });
}

function defaultOcr(pngPath, run = spawnSync) {
  const res = run("tesseract", [pngPath, "stdout", "--psm", "6"], {
    encoding: "utf-8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (res.error || res.status !== 0) return null;
  return String(res.stdout || "");
}

function probeDuration(videoPath, run = spawnSync) {
  const res = run(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", videoPath],
    { encoding: "utf-8" }
  );
  const d = parseFloat(String(res.stdout || "").trim());
  return Number.isFinite(d) && d > 0 ? d : 30;
}

/**
 * Does the source clip already carry burned-in captions?
 *
 * Returns { detected, ocrUnavailable, textFrames, novelTexts, frameTexts, say }.
 *
 * DETECTED requires at least three frames bearing text AND at least three
 * DISTINCT texts among them. One overlay held for the whole clip is one novel
 * text; an opening title plus a persistent price plate is two. Only text that
 * keeps changing — a subtitle track — reaches three. The cost of a miss is a
 * second caption layer over someone's captions; the cost of a false hit is one
 * clip going out voiceover-only. Sampling every ~3.5s of a 30s clip sees a
 * subtitle track many times over.
 *
 * When tesseract is missing the answer is "cannot verify", never "no captions"
 * — the caller must treat that as its own loud skip, per the artifact-QC
 * doctrine that a check that cannot run is not a check that passed.
 */
export function detectBurnedCaptions(videoPath, opts = {}) {
  const {
    run = spawnSync,
    ocr = defaultOcr,
    extract = defaultExtract,
    frameCount = 8,
    durationSec = null,
    workDir = tmpdir(),
  } = opts;

  if (!ocrAvailable(run)) {
    return {
      detected: false,
      ocrUnavailable: true,
      textFrames: 0,
      novelTexts: 0,
      frameTexts: [],
      say: "caption check could not run: tesseract is not installed — refusing to add captions to a clip nobody could read",
    };
  }

  const duration = durationSec ?? probeDuration(videoPath, run);
  const stamps = captionSampleTimestamps(duration, frameCount);
  const frameTexts = [];

  for (let i = 0; i < stamps.length; i++) {
    const png = join(workDir, `caption-scan-${Date.now()}-${String(i).padStart(2, "0")}.png`);
    try {
      extract(["-y", "-v", "error", "-ss", String(stamps[i]), "-i", videoPath, "-frames:v", "1", "-q:v", "2", png]);
      const text = ocr(png, run);
      if (text !== null) frameTexts.push(text);
    } catch {
      // An unreadable frame is a frame with no evidence either way.
    } finally {
      rmSync(png, { force: true });
    }
  }

  const { textFrames, novelTexts } = countNovelTexts(frameTexts);
  const detected = textFrames >= 3 && novelTexts >= 3;
  return {
    detected,
    ocrUnavailable: false,
    textFrames,
    novelTexts,
    frameTexts,
    say: detected
      ? `captions skipped: source already has burned-in captions (${novelTexts} distinct texts across ${textFrames} text-bearing frames)`
      : null,
  };
}

// ─── GATE 3: number honesty ─────────────────────────────────────────────────

const ONES_WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19,
};
const TENS_WORDS = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90,
};
const SCALE_WORDS = { hundred: 100, thousand: 1_000, million: 1_000_000, billion: 1_000_000_000 };

/** Words that legitimately sit inside a spoken number without ending it. */
const NUMBER_GLUE = new Set(["and", "point", "a"]);

/**
 * Units that make a small spoken number a CLAIM rather than a figure of speech.
 * "this one surprises people" is a pronoun; "one bedroom" is a fact about the
 * property and gets verified like any other.
 */
const UNIT_WORDS = new Set([
  "dollar", "dollars", "percent", "bed", "beds", "bedroom", "bedrooms",
  "bath", "baths", "bathroom", "bathrooms", "car", "garage", "garages",
  "square", "feet", "foot", "acre", "acres", "story", "stories", "k",
]);

function wordValue(w) {
  if (w in ONES_WORDS) return { kind: "ones", value: ONES_WORDS[w] };
  if (w in TENS_WORDS) return { kind: "tens", value: TENS_WORDS[w] };
  if (w in SCALE_WORDS) return { kind: "scale", value: SCALE_WORDS[w] };
  return null;
}

/** Is a unit word within two words of this digit match? */
function nearUnit(src, index, len) {
  const after = src.slice(index + len).trimStart().split(/\s+/).slice(0, 2);
  const before = src.slice(0, index).trimEnd().split(/\s+/).slice(-2);
  return [...after, ...before].some((w) =>
    UNIT_WORDS.has(String(w).toLowerCase().replace(/[^a-z]/g, ""))
  );
}

/**
 * Parse every number a piece of generated text SAYS — spelled out or in digits.
 *
 * Returns [{ raw, value, enforceable }]. `raw` is the exact phrase, for the
 * record and the log. Handles the shapes sanitizeForTTS produces ("two million
 * five hundred thousand dollars", "four point nine nine percent", "two and a
 * half baths") plus digit forms the model leaks ("$2,500", "440,000", "507K").
 *
 * ENFORCEABLE is where figure-of-speech noise is kept out: a value under ten
 * with no magnitude word and no unit nearby ("this one", "two of them") is not
 * a claim about the property and is not checked. Everything else is.
 */
export function parseStatedFigures(text) {
  const figures = [];
  const src = String(text || "");

  // ── digit forms ──────────────────────────────────────────────────────────
  const digitRe = /\$?\d[\d,]*(?:\.\d+)?\s?(?:%|[kKmM]\b)?/g;
  let m;
  while ((m = digitRe.exec(src)) !== null) {
    const raw = m[0].trim();
    const stripped = raw.replace(/[$,\s]/g, "");
    let value = parseFloat(stripped);
    if (!Number.isFinite(value)) continue;
    if (/[kK]$/.test(stripped)) value *= 1_000;
    else if (/[mM]$/.test(stripped)) value *= 1_000_000;
    const hasUnit = /[$%kKmM]/.test(raw) || nearUnit(src, m.index, raw.length);
    figures.push({ raw, value, enforceable: value >= 10 || hasUnit });
  }

  // ── spelled-out forms ────────────────────────────────────────────────────
  const tokens = src.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter(Boolean);
  // Split hyphenated pairs ("forty-five") into their parts.
  const flat = [];
  for (const t of tokens) {
    if (t.includes("-")) flat.push(...t.split("-").filter(Boolean));
    else flat.push(t);
  }

  let i = 0;
  while (i < flat.length) {
    if (!wordValue(flat[i])) { i++; continue; }

    // Consume one spoken-number phrase.
    const start = i;
    let total = 0;       // completed scale groups ("two million" so far)
    let current = 0;     // the group being built
    let frac = "";       // digits after "point"
    let inFrac = false;
    let sawScale = false;
    let extraFrac = 0;   // "and a half" / "and a quarter" forms

    while (i < flat.length) {
      const w = flat[i];
      const v = wordValue(w);
      if (v) {
        if (inFrac) {
          if (v.kind === "ones" && v.value <= 9) { frac += String(v.value); i++; continue; }
          break; // "point" fractions are read digit by digit; anything else ends the phrase
        }
        if (v.kind === "scale") {
          sawScale = true;
          const group = (current || 1) + (frac ? parseFloat(`0.${frac}`) : 0);
          frac = "";
          if (v.value === 100) {
            current = group * 100;
          } else {
            total += group * v.value;
            current = 0;
          }
          i++;
          continue;
        }
        current += v.value;
        i++;
        continue;
      }
      if (NUMBER_GLUE.has(w)) {
        if (w === "point") { inFrac = true; i++; continue; }
        // "and a half" / "and a quarter" / "and three quarters"
        const ahead = flat.slice(i, i + 3).join(" ");
        if (/^and a half/.test(ahead)) { extraFrac = 0.5; i += 3; break; }
        if (/^and a quarter/.test(ahead)) { extraFrac = 0.25; i += 3; break; }
        if (/^and three quarters?/.test(ahead)) { extraFrac = 0.75; i += 3; break; }
        if (w === "and" && wordValue(flat[i + 1] || "")) { i++; continue; }
        break;
      }
      break;
    }

    const value = total + current + (frac ? parseFloat(`0.${frac}`) : 0) + extraFrac;
    const raw = flat.slice(start, i).join(" ");
    const after = flat.slice(i, i + 2);
    const before = flat.slice(Math.max(0, start - 2), start);
    const hasUnit = [...after, ...before].some((w) => UNIT_WORDS.has(w));
    figures.push({ raw, value, enforceable: value >= 10 || sawScale || hasUnit });
  }

  return figures;
}

/**
 * Every figure value a source text supports.
 *
 * Digits are matched as MAXIMAL runs, so "340,000" yields 340000 and nothing
 * shorter — a figure is only "said" if it is not part of a longer one, the
 * reel-hooks lesson applied here. Suffixed forms add their expansion alongside
 * the literal read: "$507K" supports 507000 (and 507, the literal token, so a
 * spoken "five oh seven K" matches too); "$400s" supports the 400,000 range
 * anchor the same way price-check normalises it. Spelled-out numbers in a
 * transcript are parsed with the same parser the generated side uses.
 */
export function sourceFigureValues(texts) {
  const values = new Set();
  for (const textRaw of texts) {
    const text = String(textRaw || "");
    if (!text) continue;

    const digitRe = /\$?\d[\d,]*(?:\.\d+)?\s?(?:%|[kKmMsS]\b)?/g;
    let m;
    while ((m = digitRe.exec(text)) !== null) {
      const raw = m[0].trim();
      const stripped = raw.replace(/[$,\s%]/g, "");
      const base = parseFloat(stripped);
      if (!Number.isFinite(base)) continue;
      values.add(base);
      if (/[kK]$/.test(stripped)) values.add(parseFloat(stripped) * 1_000);
      else if (/[mM]$/.test(stripped)) values.add(parseFloat(stripped) * 1_000_000);
      else if (/[sS]$/.test(stripped) && base < 10_000) values.add(base * 1_000);
    }

    for (const fig of parseStatedFigures(text)) {
      if (Number.isFinite(fig.value)) values.add(fig.value);
    }
  }
  values.delete(NaN);
  return values;
}

/**
 * Check generated text against the source's figures.
 *
 * EQUALITY, figure by figure. 2,500 in the source does not authorise
 * 2,500,000 in the read — that is the exact August failure — and 340,000 does
 * not authorise 40,000. Returns { ok, violations: [{ raw, value }] } with raw
 * phrases fit for a log line a human can act on.
 */
export function checkNumberHonesty(generatedText, allowedValues) {
  const violations = [];
  for (const fig of parseStatedFigures(generatedText)) {
    if (!fig.enforceable) continue;
    if (!allowedValues.has(fig.value)) {
      violations.push({ raw: fig.raw, value: fig.value });
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Assemble the source figure pool for one clip.
 *
 * `transcript` — what the source audio says (Whisper).
 * `overlays`   — what the vision pass read off the frames (price, rates, beds).
 * `ocrTexts`   — what tesseract read on the caption-scan frames (whole clip).
 * `extraTexts` — deliberately injected inputs that count as ground truth: the
 *                overlay price handed to the script prompt, and the community-KB
 *                rate the payment-angle feature quotes on purpose.
 */
export function buildSourceFigures({ transcript = "", overlays = null, ocrTexts = [], extraTexts = [] } = {}) {
  const texts = [transcript, ...ocrTexts, ...extraTexts];
  if (overlays) {
    for (const key of ["price", "raw_text", "beds_baths", "community", "city"]) {
      if (overlays[key]) texts.push(String(overlays[key]));
    }
  }
  return sourceFigureValues(texts);
}
