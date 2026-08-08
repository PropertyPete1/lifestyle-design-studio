/**
 * yt-opening.js — the first fifteen seconds, composed rather than allocated.
 *
 * Everything else in this pipeline treats a segment as a segment. The opening
 * is not one. Retention is won or lost in the first fifteen seconds, and what
 * earns three seconds of a stranger's attention is a face making a claim — not
 * a drone shot, and not a map, which is a thing you have to already care about
 * before it is interesting.
 *
 * FOUR RULES, IN THE ORDER THEY MATTER
 *
 * 1. The video opens on Peter's face. His first ON_CAMERA take, first on the
 *    timeline, no B-roll and no graphic over it. If that take is missing this
 *    module says so and the build stops, because a video that opens on
 *    somebody else's drone footage is a different product.
 *
 * 2. A short line of text burns over it inside the first second — the hook's
 *    claim in four to eight words, for the large share of viewers who arrive
 *    with the sound off and decide from what they can read.
 *
 * 3. One CALLOUT is permitted as punctuation, AFTER his first sentence, for a
 *    second. Never before it, and never as the opener.
 *
 * 4. Nothing else draws for fifteen seconds.
 *
 * The overlay text is generated and critic-gated exactly like the thumbnail
 * hook, and for the same reason: it is a stopping-power problem, not a summary
 * problem, and the failure mode is a line that restates what he is already
 * saying. That check is mechanical here rather than left to the critic, because
 * word overlap is a question about words, not taste.
 */

import { BRAND, SERIF, measure, wrapText, BOLD_SERIF } from "./carousel-render.js";
import { contentWords, callModel as hookModelCall } from "./yt-thumbnail-hook.js";
import sharp from "sharp";

/** How long the opening is protected from every other graphic. */
export const PROTECTED_SECONDS = 15;

/** The overlay's word budget. Eight is a hard ceiling — it is read, not studied. */
export const MIN_OVERLAY_WORDS = 4;
export const MAX_OVERLAY_WORDS = 8;

/** Both critic axes must clear this. */
export const PASS_MARK = 8;

/**
 * The longest run of consecutive words the overlay may share with the hook.
 *
 * MEASURED AS A PHRASE, NOT A WORD SET, and the first version got this wrong.
 * It compared content-word overlap the way the thumbnail gate does, and
 * rejected "The trade nobody explains" against a hook containing "that is the
 * trade, and nobody explains the other half of it" — 100% overlap, and a good
 * line. Any overlay worth burning reuses the topic's nouns; demanding different
 * nouns forces synonym-hunting and produces worse copy.
 *
 * What the brief actually asks is that it not duplicate the hook WORD FOR WORD,
 * which is a question about phrases. Four consecutive words is the point where
 * a viewer reading and a viewer listening are receiving the same sentence
 * twice. Whether it merely says the same THING is a matter of judgement, and
 * that is what the critic's `complement` axis is for.
 */
export const MAX_SHARED_RUN = 4;

/**
 * There is deliberately NO word-overlap ceiling to go with the run check.
 *
 * One was tried at 0.9 and removed: a four-word overlay has about three content
 * words, so a line that reuses the topic's nouns at all scores 100% overlap and
 * is indistinguishable from a reordering. It rejected "The trade nobody
 * explains" — which is the kind of line this feature exists to produce.
 * Verbatim runs are caught above; whether it says the same THING is judgement,
 * and the critic's `complement` axis is where judgement belongs.
 */

/** When the overlay appears and how long it holds. */
export const OVERLAY_START = 0.4;
export const OVERLAY_HOLD = 3.6;
export const OVERLAY_FADE = 0.4;

/** The punctuation CALLOUT, if one is used at all. */
export const PUNCTUATION_SECONDS = 1;

// ─── validation ─────────────────────────────────────────────────────────────

export function overlayWordCount(text) {
  return String(text || "").trim().split(/\s+/).filter(Boolean).length;
}

const words = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);

/** Longest run of consecutive words the overlay shares with the hook. */
export function longestSharedRun(overlay, hook) {
  const a = words(overlay);
  const b = words(hook);
  let best = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      let n = 0;
      while (i + n < a.length && j + n < b.length && a[i + n] === b[j + n]) n++;
      if (n > best) best = n;
    }
  }
  return best;
}

/** Share of the overlay's content words that also appear in the spoken hook. */
export function wordOverlap(overlay, hook) {
  const a = contentWords(overlay);
  const b = new Set(contentWords(hook));
  if (a.length === 0) return 1;
  return a.filter((w) => b.has(w)).length / a.length;
}

export function validateOverlay(overlay, hook) {
  const failures = [];
  const text = String(overlay || "").trim();
  if (!text) return ["overlay is empty"];

  const words = overlayWordCount(text);
  if (words < MIN_OVERLAY_WORDS) failures.push(`${words} words, needs at least ${MIN_OVERLAY_WORDS}`);
  if (words > MAX_OVERLAY_WORDS) failures.push(`${words} words, the ceiling is ${MAX_OVERLAY_WORDS}`);
  if (/["""]/.test(text)) failures.push("contains a quote mark");
  if (/[.!?]$/.test(text)) failures.push("ends with punctuation");

  const run = longestSharedRun(text, hook);
  if (run >= MAX_SHARED_RUN) {
    failures.push(`repeats ${run} consecutive words of the spoken hook`);
  }
  return failures;
}

// ─── the critic ─────────────────────────────────────────────────────────────

const CRITIC_SYSTEM = `You score ONE line of text that burns over the opening seconds of a long-form YouTube video, while the presenter is on camera saying his opening line.

The viewer has not chosen this video. It is autoplaying in a feed, probably muted. This line is what they read before deciding whether to stay. You are not scoring whether it is accurate or well written — you are scoring whether it stops someone.

Score two axes 1-10.

"stopping_power" — does this make a stranger stay? A line that states a fact scores low; a line that opens a gap between what they assume and what is true scores high. "Property taxes are high in Texas" is a fact everyone has heard. "The tax nobody warns you about" is a gap. Penalise anything that reads like a chapter heading, a category, or a summary. Ask: would a person who does not care about real estate read this and want the next sentence?

"complement" — does it work WITH the words being spoken rather than repeating them? The presenter is talking. If this line says the same thing he is saying, the viewer gets one idea delivered twice and learns nothing from reading. High scores go to a line that adds the stake, sharpens the claim, or names the thing he is about to explain. Low scores go to a caption of his sentence.

Return ONLY valid JSON, no preamble and no code fences:
{"stopping_power": 0, "complement": 0, "worst_thing_about_it": "one sentence, be specific and harsh"}`;

const WRITER_SYSTEM = `You write ONE line of text to burn over the opening seconds of a long-form YouTube video by a San Antonio realtor.

It appears within the first second, over his face, while he says his opening line. Most people who see it have the sound off.

RULES:
- 4 to 8 words. No more.
- Do NOT restate what he is saying. It runs at the same time as his sentence, so repeating it wastes both.
- Add the stake, sharpen the claim, or name what he is about to explain.
- No quote marks. No trailing period.
- Plain spoken English. No colons, no "here's why", no clickbait cadence.

Return ONLY valid JSON, no preamble and no code fences:
{"overlay": "your line"}`;

export const writerSystem = () => WRITER_SYSTEM;
export const criticSystem = () => CRITIC_SYSTEM;

export function scoresPass(scores, mark = PASS_MARK) {
  return Boolean(scores) && scores.stopping_power >= mark && scores.complement >= mark;
}

function parseJson(raw) {
  const t = String(raw || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON object in model output");
  return JSON.parse(t.slice(start, end + 1));
}

export async function scoreOverlay(overlay, { hook, modelCall = hookModelCall } = {}) {
  const scores = parseJson(
    await modelCall(CRITIC_SYSTEM, `SPOKEN OPENING LINE: ${hook}\n\nOVERLAY TO SCORE: ${overlay}\n\nScore it.`)
  );
  return {
    stopping_power: Number(scores.stopping_power) || 0,
    complement: Number(scores.complement) || 0,
    worst_thing_about_it: String(scores.worst_thing_about_it || ""),
  };
}

/**
 * Generate the overlay line, or report why there is none.
 *
 * Returns `{ overlay: null }` rather than throwing when it cannot clear the
 * gates. A video with no overlay is a worse video; a video with a limp overlay
 * burned into its first frames is a worse video that also cannot be fixed
 * without a re-render, so the bar stays high and failure is a clean absence.
 */
export async function generateOpeningOverlay({ hook, candidate = null, maxRetries = 2, modelCall = hookModelCall } = {}) {
  if (!hook || !String(hook).trim()) return { overlay: null, attempts: [], reason: "no hook to work from" };

  const attempts = [];
  let feedback = "";

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let text;
    if (attempt === 0 && candidate && validateOverlay(candidate, hook).length === 0) {
      // The writer already proposed one in the script. Score it before spending
      // a call rewriting something that may already be good.
      text = String(candidate).trim();
    } else {
      try {
        text = String(parseJson(await modelCall(WRITER_SYSTEM, `HIS SPOKEN OPENING LINE: ${hook}\n\nWrite the overlay.${feedback}`)).overlay || "").trim();
      } catch (err) {
        attempts.push({ overlay: null, error: err.message });
        continue;
      }
    }

    const structural = validateOverlay(text, hook);
    if (structural.length > 0) {
      attempts.push({ overlay: text, failures: structural });
      feedback = `\n\nYour last attempt was rejected: ${structural.join("; ")}. Fix it.`;
      continue;
    }

    const scores = await scoreOverlay(text, { hook, modelCall });
    attempts.push({ overlay: text, scores });
    if (scoresPass(scores)) return { overlay: text, scores, attempts };

    feedback = `\n\nYour last attempt "${text}" scored stopping_power ${scores.stopping_power}, complement ${scores.complement}. The critic said: ${scores.worst_thing_about_it}. Write a better one.`;
  }

  return { overlay: null, attempts, reason: "no candidate cleared the gates" };
}

// ─── the overlay image ──────────────────────────────────────────────────────

/**
 * Render the overlay as a transparent PNG for ffmpeg to composite.
 *
 * A PNG rather than drawtext because drawtext resolves fonts through
 * fontconfig on the runner and silently substitutes when it cannot find one —
 * which is how you end up with the brand's serif quietly replaced by DejaVu in
 * the most-watched three seconds of the video. Rendering through the same sharp
 * path as every other card means it either looks right or fails the QC check.
 */
export function overlaySvg(text, { width = 1920, height = 1080 } = {}) {
  const C = BRAND.colors;
  const accent = BRAND.accentRotation[0];
  const maxWidth = width * 0.82;

  let size = Math.round(width * 0.058);
  let lines = wrapText(text, size, maxWidth, BOLD_SERIF);
  while (lines.length > 2 && size > Math.round(width * 0.032)) {
    size -= 3;
    lines = wrapText(text, size, maxWidth, BOLD_SERIF);
  }

  const lineHeight = size * 1.2;
  const blockH = lines.length * lineHeight;
  // Lower third, clear of the face and clear of the caption band beneath.
  const top = Math.round(height * 0.68);
  const padX = size * 0.7;
  const padY = size * 0.44;
  const widest = Math.min(Math.max(...lines.map((l) => measure(l, size, BOLD_SERIF))), maxWidth);
  const boxW = widest + padX * 2;
  const boxX = (width - boxW) / 2;

  const body = lines
    .map((l, i) => `<text x="${width / 2}" y="${(top + i * lineHeight).toFixed(1)}" font-family="${SERIF}" font-size="${size}" font-weight="bold" fill="${C.ink}" text-anchor="middle">${esc(l)}</text>`)
    .join("\n  ");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect x="${boxX.toFixed(1)}" y="${(top - size - padY).toFixed(1)}" width="${boxW.toFixed(1)}" height="${(blockH + padY * 2).toFixed(1)}" rx="${(size * 0.16).toFixed(1)}" fill="#000000" fill-opacity="0.82"/>
  <rect x="${boxX.toFixed(1)}" y="${(top - size - padY).toFixed(1)}" width="6" height="${(blockH + padY * 2).toFixed(1)}" rx="3" fill="${accent}"/>
  ${body}
</svg>`;
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export async function renderOverlayPng(text, dim) {
  return sharp(Buffer.from(overlaySvg(text, dim))).png({ compressionLevel: 9 }).toBuffer();
}

/**
 * ffmpeg arguments to burn the overlay onto the opening segment.
 *
 * The fade is on the overlay's own alpha, not the video's, so the picture
 * underneath is untouched. `enable` bounds the composite to the window rather
 * than leaving a transparent PNG stretched across the whole segment.
 */
export function burnOverlayArgs(videoIn, pngIn, output, { start = OVERLAY_START, hold = OVERLAY_HOLD, fade = OVERLAY_FADE } = {}) {
  const end = start + hold;
  return [
    "-y", "-i", videoIn, "-i", pngIn,
    "-filter_complex",
    `[1:v]format=rgba,fade=t=in:st=${start}:d=${fade}:alpha=1,fade=t=out:st=${(end - fade).toFixed(2)}:d=${fade}:alpha=1[ov];` +
      `[0:v][ov]overlay=0:0:enable='between(t,${start},${end})'[v]`,
    "-map", "[v]", "-map", "0:a?",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "copy",
    output,
  ];
}

// ─── composition ────────────────────────────────────────────────────────────

/**
 * Decide and describe the opening, without changing anything.
 *
 * Pure, so the composition can be asserted in a test and printed in the build
 * summary without rendering twelve minutes of video first.
 *
 * @returns {{ ok, failures, composition }}
 */
export function planOpening(segments, { overlay = null, protectedSeconds = PROTECTED_SECONDS } = {}) {
  const failures = [];
  const first = segments?.[0];

  if (!first) {
    return { ok: false, failures: ["the timeline is empty"], composition: null };
  }

  // RULE 1. The face, first, or not at all.
  if (first.kind !== "on_camera") {
    failures.push(
      `the video opens on ${first.kind === "voiceover" ? "B-roll" : first.kind} (take ${first.takeId}) — it must open on an on-camera take`
    );
  }
  if (first.kind === "on_camera" && !first.source) {
    failures.push(`the opening on-camera take (${first.takeId}) has no recording`);
  }

  let elapsed = 0;
  const window = [];
  for (const seg of segments) {
    if (elapsed >= protectedSeconds) break;
    window.push({ takeId: seg.takeId, kind: seg.kind, startsAt: round(elapsed), seconds: seg.seconds });
    elapsed += seg.seconds || 0;
  }

  // RULE 3/4. Nothing else draws inside the window.
  const graphicsInWindow = window
    .map((w) => segments.find((s) => s.takeId === w.takeId))
    .filter((s) => s && s.generatedSeconds > 0 && !s.isOpeningPunctuation);
  for (const g of graphicsInWindow) {
    failures.push(`a ${g.visual} graphic is scheduled inside the protected opening (take ${g.takeId})`);
  }

  return {
    ok: failures.length === 0,
    failures,
    composition: {
      opensOn: first.kind === "on_camera" ? `on-camera take ${first.takeId}` : `${first.kind} take ${first.takeId}`,
      openingTakeSeconds: first.seconds,
      overlay: overlay || null,
      overlayWindow: overlay ? `${OVERLAY_START}s to ${round(OVERLAY_START + OVERLAY_HOLD)}s` : null,
      punctuation: segments.find((s) => s.isOpeningPunctuation)
        ? `1s CALLOUT after the first sentence (take ${segments.find((s) => s.isOpeningPunctuation).takeId})`
        : "none",
      protectedSeconds,
      takesInWindow: window,
      graphicsSuppressed: window.length,
    },
  };
}

function round(n) {
  return Math.round(n * 100) / 100;
}
