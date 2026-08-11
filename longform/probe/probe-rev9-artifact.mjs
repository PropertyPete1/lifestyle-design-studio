/**
 * probe-rev9-artifact.mjs — watching the artifact the way Peter does.
 *
 * THE GAP THIS CLOSES. Three defects reached his screen through a suite that was
 * green: abstract circles over the passages naming neighbourhoods, motion that
 * stepped, and a noise on every removed breath. None of them was detectable from
 * a plan or a metric, because all three are properties of the finished media —
 * how it looks frame to frame and how it sounds across a join.
 *
 * So this probe renders real clips and measures them as media:
 *
 *   MOTION SMOOTHNESS  frame-to-frame difference across an animated graphic and
 *                      across the beat. A slideshow shows as a sawtooth — big
 *                      differences at state changes, zeros in between. Smooth
 *                      motion shows as a low, even line with no zero runs.
 *
 *   AUDIO DISCONTINUITY  the sample step either side of every concat join. A
 *                      click is a step; a declicked join is not.
 *
 * Run:  node longform/probe/probe-rev9-artifact.mjs
 */

import { execFileSync, spawnSync } from "child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { renderBeatClip, renderAnimatedGraphic } from "../../auto-poster/src/yt-visual-animate.js";
import { mapSpecForIntent } from "../../auto-poster/src/yt-map-render.js";
import { pieceArgs } from "../../auto-poster/src/yt-oncamera-edit.js";

const DIR = mkdtempSync(join(tmpdir(), "rev9-art-"));
const ff = (args) => execFileSync("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"], encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
const DIM = { w: 1280, h: 720 };

const bad = [];
const ok = [];
const check = (label, pass, detail) => {
  (pass ? ok : bad).push(`${label}${detail ? ` — ${detail}` : ""}`);
  console.log(`${pass ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
};

console.log(`work dir: ${DIR}\n`);

/**
 * Frame-to-frame difference across a clip, as a series.
 *
 * `signalstats` gives per-frame statistics but not a difference against the
 * previous frame; `tblend=difference` does exactly that, and its average pixel
 * value per frame IS the motion between consecutive frames. Reading it back
 * through `signalstats` YAVG gives one number per frame with no image library.
 */
function motionSeries(path) {
  const out = spawnSync("ffmpeg", [
    "-i", path,
    "-vf", "tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG",
    "-f", "null", "-",
  ], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  const text = `${out.stdout || ""}${out.stderr || ""}`;
  return [...text.matchAll(/lavfi\.signalstats\.YAVG=([\d.]+)/g)].map((m) => Number(m[1])).slice(1);
}

/**
 * Does this clip move like a slideshow?
 *
 * A stepped animation holds a still for several frames — a run of near-zero
 * differences — and then jumps. Smooth motion never holds. The measure is the
 * SHARE of frames that are effectively identical to the one before, counted only
 * over the part of the clip that is supposed to be moving.
 */
function heldShare(series, floor = 0.02) {
  if (series.length === 0) return 1;
  return series.filter((v) => v <= floor).length / series.length;
}

// ─── 1. the beat, which carried the video and moved at 2.5fps ──────────────

console.log("── motion: the wordless beat ──");
const beat = await renderBeatClip({ seconds: 2, dir: DIR, index: 0, ffmpeg: ff, writeFileSync });
const beatSeries = motionSeries(beat.path);
const beatHeld = heldShare(beatSeries);
console.log(`   ${beatSeries.length} frames, ${(beatHeld * 100).toFixed(1)}% held, mean ${(beatSeries.reduce((a, b) => a + b, 0) / Math.max(1, beatSeries.length)).toFixed(3)}`);
// At 2.5fps in a 30fps clip, 11 of every 12 frames are identical: ~92% held.
check("the beat is not a slideshow", beatHeld < 0.25, `${(beatHeld * 100).toFixed(1)}% of frames identical to the previous one`);
check("the beat actually moves", beatSeries.some((v) => v > 0.05), `peak ${Math.max(...beatSeries).toFixed(3)}`);

// ─── 2. an animated graphic drawing a road ─────────────────────────────────

console.log("\n── motion: a map drawing a road ──");
const spec = mapSpecForIntent({ lines: ["1604"], places: ["Stone Oak"] }, { market: "san_antonio" });
if (!spec) {
  check("the map fixture resolves geometry", false, "no spec — cannot measure the draw");
} else {
  const g = await renderAnimatedGraphic({
    type: "MAP", spec, seconds: 6, words: null, dir: DIR, index: 1, ffmpeg: ff, writeFileSync,
  });
  const gs = motionSeries(g.path);
  // Only the passage where the road is actually drawing is supposed to move;
  // the holds either side are legitimately still, so the measure is taken over
  // the moving window rather than the whole clip.
  const moving = gs.filter((v) => v > 0.005);
  const movingHeld = heldShare(moving, 0.02);
  console.log(`   ${gs.length} frames, ${moving.length} with motion, ${(movingHeld * 100).toFixed(1)}% of those held`);
  check("the road draw does not step", movingHeld < 0.35, `${(movingHeld * 100).toFixed(1)}% held within the moving passage`);
  check("no dead states in the render", g.deadStates.length === 0, `${g.deadStates.length} dead`);
  const fps = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", g.path], { encoding: "utf-8" }).trim();
  check("the graphic is delivered at 30fps", fps.startsWith("30/1") || fps === "30", fps);
}

// ─── 3. audio joins ────────────────────────────────────────────────────────

console.log("\n── audio: the joins ──");
// A take with a loud steady tone, cut into two pieces and concatenated. Without
// a declick the splice lands mid-waveform and steps; with one it does not.
const take = join(DIR, "take.mp4");
ff([
  "-y",
  "-f", "lavfi", "-i", `color=c=0x101010:s=${DIM.w}x${DIM.h}:d=12:r=30`,
  "-f", "lavfi", "-i", "sine=frequency=300:duration=12:sample_rate=48000",
  "-af", "volume=6",
  "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
  "-c:a", "aac", "-b:a", "192k", "-shortest", take,
]);

const mkPiece = (i, from, to, declick) => {
  const out = join(DIR, `p${i}.mp4`);
  const piece = { srcStart: from, srcEnd: to, scale: 1, pulses: [] };
  const args = pieceArgs(take, out, piece, DIM, { fps: 30 });
  if (!declick) {
    const ai = args.indexOf("-af");
    if (ai >= 0) args.splice(ai, 2);
  }
  ff(args);
  return out;
};

/** The largest single-sample step in a window — a click, if there is one. */
function maxStep(path, aroundSeconds) {
  const raw = join(DIR, `probe-${Math.round(aroundSeconds * 1000)}.pcm`);
  ff(["-y", "-ss", String(Math.max(0, aroundSeconds - 0.05)), "-t", "0.1", "-i", path,
    "-f", "s16le", "-ac", "1", "-ar", "48000", raw]);
  const buf = readFileSync(raw);
  let worst = 0;
  for (let i = 2; i < buf.length; i += 2) {
    const a = buf.readInt16LE(i - 2);
    const b = buf.readInt16LE(i);
    worst = Math.max(worst, Math.abs(b - a));
  }
  return worst;
}

for (const declick of [false, true]) {
  const a = mkPiece(declick ? 10 : 20, 1.0, 4.013, declick);
  const b = mkPiece(declick ? 11 : 21, 7.007, 10.0, declick);
  const list = join(DIR, `list-${declick}.txt`);
  writeFileSync(list, [`file '${a}'`, `file '${b}'`].join("\n"));
  const joined = join(DIR, `joined-${declick}.mp4`);
  ff(["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", joined]);
  const step = maxStep(joined, 3.013);
  console.log(`   declick=${String(declick).padEnd(5)} max sample step at the join: ${step}`);
  if (declick) {
    // A 300Hz sine at this level steps by ~2600 per sample naturally, so the
    // threshold is about the SPLICE being no worse than the waveform itself.
    check("a declicked join has no discontinuity", step < 6000, `${step}`);
  }
}

console.log(`\n${bad.length === 0 ? "ALL CHECKS PASSED" : `${bad.length} CHECK(S) FAILED`}  (${ok.length} passed)`);
if (bad.length) { for (const b of bad) console.log(`  ✗ ${b}`); process.exitCode = 1; }
