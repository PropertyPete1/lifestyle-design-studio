/**
 * yt-thumbnail-face.js — Peter's face becomes the thumbnail, chosen by contest.
 *
 * The text-only gold-on-black card was the launch design; Peter's call after
 * video 1 shipped is that thumbnails FEATURE HIS FACE, always. This module
 * turns one recorded source — the dedicated thumbnail take when it exists,
 * the best on-camera take otherwise — into THREE finished face+hook-text
 * composites, scores them the way the click actually happens (at search-result
 * size, on the emotional-trigger axis the text critic already uses), and
 * returns a winner.
 *
 * THREE CANDIDATES, NOT ONE, because the failure mode of automated thumbnails
 * is not "bad frame" — it is "defensible frame": eyes open, face sharp,
 * expression dead. Ranking three real alternatives against each other is what
 * surfaces the one with a live expression, and the losing candidates ride to
 * the diagnostics artifact so "why this one" is always answerable.
 *
 * EVERY FALLBACK IS RECORDED. A failed matte becomes a raw-frame composite
 * (the existing scrim treatment absorbs a rectangular crop); a failed scoring
 * call becomes "first candidate, reason attached". Nothing here may throw
 * past its boundary — a finished video without its best-possible thumbnail
 * still ships, with the gap named in the log and the evidence preserved.
 */

import { spawnSync } from "child_process";
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from "fs";
import { join } from "path";

import { sampleFrames, pickExpressiveFrame, renderThumbnail } from "./yt-thumbnail.js";
import { EMOTIONAL_TRIGGER_DEFINITION } from "./yt-thumbnail-hook.js";
import { MODEL_PATH, PYTHON, MIN_COVERAGE, MAX_COVERAGE, MAX_HOLE_RATIO } from "./yt-pip.js";

const HERE_SCRIPT = new URL("../scripts/segment-frame.py", import.meta.url).pathname;

/** How many frames to pull from the source before the expression contest. */
export const SAMPLE_COUNT = 9;

/** How many finished composites compete. */
export const CANDIDATE_COUNT = 3;

/**
 * Candidates must come from different MOMENTS of the take, not three
 * adjacent frames of one expression. The thumbnail take holds each
 * expression ~3s, so 1.5s of separation guarantees the contest spans
 * expressions rather than re-judging one.
 */
export const MIN_FRAME_SEPARATION_SECONDS = 1.5;

/**
 * Cut the person out of one frame, full resolution, alpha-matted.
 *
 * Gated exactly like the PIP: a coverage outside the person-shaped range or a
 * holey silhouette means the model misread the frame, and a bad cutout on a
 * thumbnail is worse than the honest rectangle — so the caller gets
 * { ok: false, reason } and composites the raw frame instead. Never throws.
 */
export function cutoutFace(framePath, outPath, { python = PYTHON, model = MODEL_PATH, script = HERE_SCRIPT } = {}) {
  const run = spawnSync(python, [script, "--input", framePath, "--output", outPath, "--model", model], {
    encoding: "utf-8",
    timeout: 120_000,
  });
  if (run.status !== 0) {
    return { ok: false, reason: `segment-frame failed: ${String(run.stderr || run.error || "").trim().slice(-200) || `exit ${run.status}`}` };
  }
  let metrics;
  try {
    metrics = JSON.parse(String(run.stdout).trim().split("\n").pop());
  } catch {
    return { ok: false, reason: "segment-frame printed no metrics" };
  }
  if (metrics.coverage < MIN_COVERAGE || metrics.coverage > MAX_COVERAGE) {
    return { ok: false, reason: `coverage ${metrics.coverage} outside [${MIN_COVERAGE}, ${MAX_COVERAGE}]`, metrics };
  }
  if (metrics.holeRatio > MAX_HOLE_RATIO) {
    return { ok: false, reason: `hole ratio ${metrics.holeRatio} above ${MAX_HOLE_RATIO}`, metrics };
  }
  if (!existsSync(outPath)) return { ok: false, reason: "matte file missing after a clean exit" };
  return { ok: true, path: outPath, metrics };
}

/**
 * The frames that will compete, picked by the existing expression critic.
 *
 * pickExpressiveFrame already ranks every sampled frame; this takes the top
 * CANDIDATE_COUNT that are far enough apart in time to be different
 * expressions. When scoring was unavailable the ranked list is null and the
 * spread is positional instead — first, middle, last of what was sampled —
 * which still spans the take.
 */
export function selectCandidateFrames(ranked, sampled, { count = CANDIDATE_COUNT, minSeparation = MIN_FRAME_SEPARATION_SECONDS } = {}) {
  const pool = ranked && ranked.length > 0 ? ranked : null;
  if (!pool) {
    const s = (sampled || []).filter(Boolean);
    if (s.length <= count) return s;
    const picks = [0, Math.floor(s.length / 2), s.length - 1].slice(0, count);
    return [...new Set(picks)].map((i) => s[i]);
  }
  const chosen = [];
  for (const cand of pool) {
    if (chosen.length >= count) break;
    if (chosen.some((c) => Math.abs(c.at - cand.at) < minSeparation)) continue;
    chosen.push(cand);
  }
  // Not enough separated moments (a very short source): fill from the top of
  // the ranking regardless of spacing rather than returning fewer than asked.
  for (const cand of pool) {
    if (chosen.length >= count) break;
    if (!chosen.includes(cand)) chosen.push(cand);
  }
  return chosen;
}

const COMPOSITE_CRITIC = `You are judging FINISHED YouTube thumbnails — an image of a person composited beside short hook text. They are variants of the same design: same text, different frame of the same person.

Judge each at the size it is actually seen: about 210x118 pixels, in a search result, beside eleven competitors. Score each variant on two axes out of 10:

${EMOTIONAL_TRIGGER_DEFINITION}

For a FACE, the trigger lives in the expression: a face mid-reaction — alarmed, warning, disbelieving — implicates the viewer ("what does he know that I don't?"). A pleasant neutral face scores like wallpaper, however well-lit.

"legibility" — at 210 pixels wide: is the text instantly readable, is the face large and clear, do the two stay out of each other's way? A face too small to read as an expression, or text crowded by the portrait, fails here.

Score the WORST case, not the average.

Return ONLY valid JSON, no preamble and no code fences:
{"scores": [{"index": 0, "emotional_trigger": 0, "legibility": 0, "why": "a few words"}]}`;

/**
 * Rank finished composites; the winner is the one that would get clicked.
 *
 * Emotional trigger decides, legibility breaks ties — the variants share one
 * text layout, so legibility differences are about the face, and a dead-heat
 * on trigger should go to the clearer face. Falls back to the first candidate
 * with the reason attached; a thumbnail contest must never cost a video.
 */
export async function pickWinningComposite(candidates, { visionCall = defaultCompositeVision } = {}) {
  const usable = (candidates || []).filter((c) => c?.path && existsSync(c.path));
  if (usable.length === 0) return { winner: null, reason: "no composites to judge" };
  if (usable.length === 1) return { winner: usable[0], ranked: usable, reason: "only one candidate" };

  try {
    const scores = await visionCall(usable, COMPOSITE_CRITIC);
    const ranked = (scores || [])
      .filter((s) => Number.isFinite(Number(s?.emotional_trigger)) && usable[s.index])
      .map((s) => ({
        ...usable[s.index],
        emotionalTrigger: Number(s.emotional_trigger),
        legibility: Number(s.legibility ?? 0),
        why: String(s.why || ""),
      }))
      .sort((a, b) => b.emotionalTrigger - a.emotionalTrigger || b.legibility - a.legibility);
    if (ranked.length === 0) throw new Error("no usable scores returned");
    return { winner: ranked[0], ranked };
  } catch (err) {
    return { winner: usable[0], ranked: usable, reason: `composite scoring failed: ${err.message}` };
  }
}

async function defaultCompositeVision(candidates, system) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const res = await anthropic.messages.create({
    model: "claude-opus-5",
    max_tokens: 1500,
    system,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: `Score these ${candidates.length} thumbnail variants, indexed 0 to ${candidates.length - 1}.` },
          ...candidates.map((c) => ({
            type: "image",
            source: { type: "base64", media_type: c.path.endsWith(".jpg") ? "image/jpeg" : "image/png", data: readFileSync(c.path).toString("base64") },
          })),
        ],
      },
    ],
  });
  const text = ((res.content || []).find((b) => b?.type === "text") || {}).text || "";
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON object in vision output");
  return JSON.parse(text.slice(start, end + 1)).scores;
}

/**
 * The whole contest: source clip -> three finished composites -> a winner.
 *
 * `source` is the thumbnail take when one was recorded, otherwise the best
 * on-camera take the caller could offer (the hook take — he is at his most
 * energised delivering the hook). The report says which path ran and what
 * fell back where; the caller logs it and preserves the losers as evidence.
 */
export async function buildFaceThumbnail({
  hookText,
  kicker,
  source,             // { path, seconds, takeId }
  workDir,
  visionCall,          // frame-expression scorer (injectable)
  compositeVision,     // composite scorer (injectable)
  cutout = cutoutFace, // injectable for tests
} = {}) {
  const report = { source: source?.takeId || null, frames: [], candidates: [], fallbacks: [] };
  if (!hookText) return { ...report, winner: null, reason: "no hook text" };
  if (!source?.path || !existsSync(source.path)) return { ...report, winner: null, reason: "no source clip" };

  const sampled = sampleFrames(source.path, source.seconds || 10, workDir, { count: SAMPLE_COUNT });
  if (sampled.length === 0) return { ...report, winner: null, reason: "no frames extracted" };

  const expression = await pickExpressiveFrame(sampled, visionCall ? { visionCall } : {});
  const frames = selectCandidateFrames(expression.scores, sampled);
  report.frames = frames.map((f) => ({ at: f.at, score: f.score ?? null, why: f.why || null }));

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const mattePath = join(workDir, `thumb-matte-${i}.png`);
    const matte = cutout(frame.path, mattePath);
    if (!matte.ok) report.fallbacks.push({ candidate: i, reason: matte.reason });

    try {
      const png = await renderThumbnail(hookText, { kicker, portraitPng: matte.ok ? mattePath : frame.path });
      const outPath = join(workDir, `thumb-candidate-${i}.png`);
      writeFileSync(outPath, png);
      report.candidates.push({
        index: i,
        path: outPath,
        frameAt: frame.at,
        cutout: matte.ok,
        bytes: statSync(outPath).size,
      });
    } catch (err) {
      report.fallbacks.push({ candidate: i, reason: `composite render failed: ${err.message}` });
    }
  }

  if (report.candidates.length === 0) return { ...report, winner: null, reason: "every composite failed" };

  const contest = await pickWinningComposite(report.candidates, compositeVision ? { visionCall: compositeVision } : {});
  if (contest.reason) report.contestNote = contest.reason;
  report.ranked = (contest.ranked || []).map((r) => ({
    index: r.index,
    frameAt: r.frameAt,
    emotionalTrigger: r.emotionalTrigger ?? null,
    legibility: r.legibility ?? null,
    why: r.why || null,
  }));
  return { ...report, winner: contest.winner };
}

/** Copy the losing candidates somewhere durable; "why this one" needs them. */
export function preserveCandidates(report, destDir) {
  const kept = [];
  const winnerIndex = report.winner?.index;
  for (const c of report.candidates || []) {
    if (!existsSync(c.path)) continue;
    const dest = join(destDir, `thumbnail-candidate-${c.index}${c.index === winnerIndex ? "-WINNER" : ""}.png`);
    try {
      copyFileSync(c.path, dest);
      kept.push(dest);
    } catch {
      // Evidence copying must never fail the build it is evidence for.
    }
  }
  return kept;
}
