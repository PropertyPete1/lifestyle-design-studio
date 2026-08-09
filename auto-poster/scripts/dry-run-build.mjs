#!/usr/bin/env node
/**
 * dry-run-build.mjs — run the whole build path, upload nothing.
 *
 * REQUIRED GATE before the first real Monday brief.
 *
 * The stages were built and tested one at a time, and every seam between them
 * is untested until something runs all of them in order. Two integration bugs
 * were already found that way while wiring PR 5 — the ingest deleting clips
 * before the assembler could use them, and a B-roll pool with no durations —
 * and both would only have failed on the runner, twenty minutes into a render.
 *
 * This runs:  transcribe -> match -> plan -> narrate -> render
 * It does NOT: upload, post, notify, or write any managed log.
 *
 * TWO MODES:
 *
 *   --recordings <dir>   real clips Peter recorded, already downloaded. This is
 *                        the mode that counts as the gate.
 *   --synthetic          speak the take text with the local TTS and use THAT as
 *                        the recordings. Not a substitute for the real gate —
 *                        it cannot tell you whether Peter's phone audio
 *                        transcribes well — but it exercises every seam, and it
 *                        can run today, before any recording exists.
 *
 * Narration is generated offline by default (a tone of the measured length)
 * so a dry run costs nothing at ElevenLabs. --real-narration overrides that.
 */

import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ON_CAMERA, VOICEOVER } from "../src/yt-script.js";
import { takesToRecord } from "../src/yt-recording-kit.js";
import { transcribeFile } from "../src/yt-ingest.js";
import { matchTakesToClips, describeMatchResult } from "../src/yt-take-match.js";
import { planTimeline, buildChapters } from "../src/yt-timeline.js";
import { applyGeneratedVisuals } from "../src/yt-visual-broll.js";
import { planOpening } from "../src/yt-opening.js";
import { applyRetentionStage, renderRetentionSummary } from "../src/yt-retention-stage.js";
import { canvasFor } from "../src/yt-assemble.js";
import { renderTimeline, generateNarration, mediaDuration } from "../src/yt-assemble.js";
import { pickMoments, cutShorts } from "../src/yt-shorts.js";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const SYNTHETIC = flag("synthetic");
const RECORDINGS_DIR = value("recordings");
const REAL_NARRATION = flag("real-narration");
const SCRIPT_PATH = value("script");
const WORK = value("work", join(tmpdir(), `yt-dryrun-${Date.now()}`));

if (!SYNTHETIC && !RECORDINGS_DIR) {
  console.error("Pass --recordings <dir> for the real gate, or --synthetic to exercise the seams without recordings.");
  process.exit(1);
}

/** A short script, so a dry run is minutes rather than the full twelve. */
function defaultScript() {
  const t = (id, mode, text, direction) => ({ id, mode, text, direction });
  return {
    title: "Moving to San Antonio: what it actually costs",
    hook: "Everyone quotes you the price.",
    promise: "By the end you'll know the real monthly number.",
    sections: [
      {
        title: "The payment gap",
        boundaryPull: "But the number that decides it is the one nobody quotes.",
        takes: [
          t("s1t1", ON_CAMERA, "Everyone quotes you the price of the house. Nobody quotes you the number that actually decides whether you can afford to live in it.", "energy up, this is the hook"),
          t("s1t2", VOICEOVER, "The sticker price is the smallest part of what you pay every month out here. Taxes and insurance do most of the damage and almost nobody tells you that up front.", "over the drone footage"),
        ],
      },
      {
        title: "Neighbourhoods",
        boundaryPull: "That changes everything about where you should be looking.",
        takes: [
          t("s2t1", VOICEOVER, "North of town you get newer construction and bigger lots. South of town you get more house for the money but a much longer drive into the city.", "over the walkthrough"),
          t("s2t2", ON_CAMERA, "I would rather have the shorter commute than the extra bedroom, and most people who move here end up agreeing with me after about a year.", "walking shot if you can"),
        ],
      },
    ],
    close: t("close", ON_CAMERA, "Text me and I will run the real numbers on whatever house you are looking at, no charge and no pitch attached to it.", "look right at the lens"),
  };
}

/** Speak each take with the local TTS so the matcher has real speech to chew on. */
function synthesiseRecordings(takes, dir) {
  mkdirSync(dir, { recursive: true });
  const made = [];
  for (const take of takes) {
    const aiff = join(dir, `${take.id}.aiff`);
    const mp4 = join(dir, `${take.id}.mp4`);
    try {
      // macOS `say`; on Linux, espeak writes a wav with the same shape.
      if (process.platform === "darwin") {
        execFileSync("say", ["-o", aiff, take.text], { timeout: 120_000 });
      } else {
        execFileSync("espeak", ["-w", aiff, take.text], { timeout: 120_000 });
      }
      // Wrap it in a video so it looks like a phone recording to everything
      // downstream — vertical, because that is what Peter's phone produces.
      execFileSync("ffmpeg", [
        "-y", "-f", "lavfi", "-i", "color=c=#2b3a42:s=1080x1920:r=30",
        "-i", aiff,
        "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", mp4,
      ], { stdio: ["pipe", "pipe", "pipe"], timeout: 300_000 });
      rmSync(aiff, { force: true });
      made.push(mp4);
    } catch (err) {
      console.warn(`  could not synthesise ${take.id}: ${String(err.message).slice(0, 120)}`);
    }
  }
  return made;
}

/** Stand-in B-roll: vertical, like the real library. */
function synthesiseBroll(dir, count = 8) {
  mkdirSync(dir, { recursive: true });
  const out = [];
  for (let i = 0; i < count; i++) {
    const p = join(dir, `broll-${i}.mp4`);
    execFileSync("ffmpeg", [
      // testsrc2 has no `decimals` option — an earlier version passed one and
      // ffmpeg refused the whole filtergraph. Vary the source instead.
      "-y", "-f", "lavfi", "-i", i % 2 ? `testsrc2=s=1080x1920:r=30:d=20` : `smptebars=s=1080x1920:r=30:d=20`,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-an", p,
    ], { stdio: ["pipe", "pipe", "pipe"], timeout: 300_000 });
    out.push({ id: `b${i}`, name: `broll-${i}.mp4`, durationSeconds: 20, contentHash: `h${i}`, localPath: p });
  }
  return out;
}

/** Offline narration: a tone of the right length, so timing is real and TTS is free. */
function offlineNarration(plan, dir) {
  mkdirSync(dir, { recursive: true });
  let n = 0;
  for (const seg of plan.segments) {
    if (seg.kind !== "voiceover" || seg.narrationSource) continue;
    const p = join(dir, `narration-${n++}.m4a`);
    execFileSync("ffmpeg", [
      "-y", "-f", "lavfi", "-i", `sine=frequency=280:duration=${seg.seconds}`,
      "-af", "aformat=channel_layouts=stereo", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", p,
    ], { stdio: ["pipe", "pipe", "pipe"], timeout: 120_000 });
    seg.generatedNarrationPath = p;
  }
  console.log(`[DryRun] generated ${n} offline narration track(s) — no ElevenLabs spend`);
  return plan;
}

const stage = (name) => {
  const t0 = Date.now();
  return (extra = "") => console.log(`[DryRun] ${name}: ${((Date.now() - t0) / 1000).toFixed(1)}s ${extra}`);
};

async function main() {
  console.log("DRY RUN — the whole build path. Uploads nothing, posts nothing, writes no managed log.\n");
  mkdirSync(WORK, { recursive: true });
  console.log(`work dir: ${WORK}\n`);

  const script = SCRIPT_PATH ? JSON.parse(readFileSync(SCRIPT_PATH, "utf-8")) : defaultScript();
  // The same set the kit asks for and the ingest expects — see takesToRecord.
  const takes = takesToRecord(script);
  console.log(`script: "${script.title}" — ${takes.length} take(s) to record`);

  // ── recordings ────────────────────────────────────────────────────────────
  let recordingFiles = [];
  if (SYNTHETIC) {
    const done = stage("synthesise recordings");
    recordingFiles = synthesiseRecordings(takes, join(WORK, "rec"));
    done(`(${recordingFiles.length} clips)`);
  } else {
    recordingFiles = readdirSync(RECORDINGS_DIR)
      .filter((f) => /\.(mp4|mov|m4v)$/i.test(f))
      .map((f) => join(RECORDINGS_DIR, f));
    console.log(`recordings: ${recordingFiles.length} file(s) from ${RECORDINGS_DIR}`);
  }
  if (recordingFiles.length === 0) throw new Error("no recordings to work with");

  // ── transcribe + match ────────────────────────────────────────────────────
  const doneT = stage("transcribe");
  const clips = [];
  for (const path of recordingFiles) {
    const t = transcribeFile(path);
    if (!t) {
      console.warn(`  no transcript for ${path}`);
      continue;
    }
    clips.push({
      id: path,
      name: path.split("/").pop(),
      transcript: t.transcript,
      recordedAt: statSync(path).mtime.toISOString(),
      durationSeconds: t.duration || mediaDuration(path),
      localPath: path,
    });
  }
  doneT(`(${clips.length} transcribed)`);

  const match = matchTakesToClips(takes, clips);
  console.log("\n" + describeMatchResult(match) + "\n");
  if (!match.complete) {
    console.log("::warning::the match is incomplete — continuing so the later stages still get exercised");
  }

  // ── plan ──────────────────────────────────────────────────────────────────
  const recordings = {};
  for (const m of match.matches) {
    const clip = clips.find((c) => c.id === m.clipId);
    if (clip) recordings[m.takeId] = { path: clip.localPath, durationSeconds: clip.durationSeconds };
  }
  const brollPool = SYNTHETIC ? synthesiseBroll(join(WORK, "broll")) : loadLocalBroll(value("broll"));
  const plan = planTimeline(script, recordings, brollPool);
  console.log(
    `[DryRun] plan: ${plan.segments.length} segments, ${plan.stats.estimatedMinutes} min, ` +
    `on-camera ${(plan.stats.onCameraShare * 100).toFixed(0)}%, ${plan.stats.brollClipsUsed} B-roll clips`
  );
  if (plan.missingTakes.length) {
    console.log(`::warning::${plan.missingTakes.length} on-camera take(s) missing — the real build would stop here`);
  }

  // ── narrate ───────────────────────────────────────────────────────────────
  const doneN = stage("narrate");
  if (REAL_NARRATION) await generateNarration(plan);
  else offlineNarration(plan, join(WORK, "vo"));
  doneN();

  // ── visuals + opening + retention — PARITY WITH THE REAL BUILD ───────────
  // The dry run exists to predict the build, and it had drifted: the pipeline
  // gained the generated-visuals stage, the opening treatment and the
  // retention edit, and this gate ran none of them — it would have passed a
  // plan the real build then handled completely differently. Same stage
  // functions, same order, so it cannot drift again without failing here.
  const doneV = stage("visuals");
  const withVisuals = await applyGeneratedVisuals(plan, { workDir: join(WORK, "visuals"), market: value("market", "san_antonio") });
  const gen = withVisuals.generated;
  console.log(
    `[DryRun] visuals: ${gen.renderedCount} rendered, ${gen.split.graphicPct}% graphic / ${gen.split.footagePct}% footage; ` +
    `writer asked ${gen.intents.requested}, rejected ${gen.intents.rejected}, unspecified ${gen.intents.unspecifiedTakes}`
  );
  doneV();

  const opening = planOpening(withVisuals.segments, { overlay: null });
  if (!opening.ok) {
    console.log(`::warning::opening treatment cannot be satisfied — the real build would STOP: ${opening.failures.join("; ")}`);
  } else {
    console.log(`[DryRun] opening: ${opening.composition.opensOn}, ${opening.composition.takesInWindow.length} take(s) in the protected window`);
  }

  const doneRet = stage("retention edit");
  const retention = applyRetentionStage(withVisuals, { workDir: join(WORK, "retention"), dim: canvasFor(value("resolution", "1080p")) });
  console.log(renderRetentionSummary(retention).split("\n").map((l) => `[DryRun] ${l}`).join("\n"));
  doneRet();

  // ── render ────────────────────────────────────────────────────────────────
  const doneR = stage("render");
  const rendered = await renderTimeline(withVisuals, {
    workDir: join(WORK, "render"),
    resolveBrollPath: (id) => brollPool.find((b) => b.id === id)?.localPath || null,
    resolution: value("resolution", "1080p"),
  });
  doneR();
  const chapters = buildChapters(withVisuals, script);
  console.log(`[DryRun] chapters: ${chapters.length ? chapters.map((c) => `${c.timestamp} ${c.title}`).join(" | ") : "NONE (under the 3 minimum)"}`);
  console.log(
    `[DryRun] rendered ${(rendered.seconds / 60).toFixed(1)} min, ` +
    `${(rendered.bytes / 1024 / 1024).toFixed(1)} MB, ${rendered.chunkCount} caption chunks`
  );

  // ── shorts ────────────────────────────────────────────────────────────────
  const moments = pickMoments(plan);
  const shorts = cutShorts(moments, {
    workDir: join(WORK, "shorts"),
    resolveSourcePath: (m) =>
      m.kind === "on_camera" ? m.source : brollPool.find((b) => b.id === (m.source?.driveFileId || m.source))?.localPath || null,
  });

  console.log("\n=== DRY RUN COMPLETE — nothing was uploaded ===");
  console.log(`  master:  ${rendered.outputPath}`);
  for (const s of shorts) console.log(`  short ${s.index}: ${s.path} (${s.seconds}s, ${(s.bytes / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`\n  stages: ${JSON.stringify(rendered.stages)}`);
  console.log(`  work dir kept for inspection: ${WORK}`);
}

function loadLocalBroll(dir) {
  if (!dir || !existsSync(dir)) throw new Error("pass --broll <dir> with real B-roll for a non-synthetic run");
  return readdirSync(dir)
    .filter((f) => /\.(mp4|mov)$/i.test(f))
    .map((f, i) => {
      const p = join(dir, f);
      return { id: `b${i}`, name: f, durationSeconds: mediaDuration(p), contentHash: null, localPath: p };
    });
}

main().catch((err) => {
  console.error(`\nDRY RUN FAILED: ${err?.stack || err}`);
  process.exitCode = 1;
});
