#!/usr/bin/env node
/**
 * calibrate-content-hash.mjs — empirically choose CONTENT_DUP_THRESHOLD.
 *
 * Measures the two distributions the threshold has to separate:
 *   SAME footage  (re-encoded / re-uploaded copies)  -> must land BELOW
 *   DIFFERENT tours                                  -> must land ABOVE
 *
 *   node scripts/calibrate-content-hash.mjs <videoA> <videoB> [moreVideos...]
 *
 * videoA/videoB are treated as a known same-footage pair. Every other file is
 * treated as a distinct tour. Also re-encodes videoA through the real freshness
 * settings (CRF 18) and through a caption-burn-equivalent to measure how much
 * the pipeline's own processing moves the hash.
 */
import { execSync } from "child_process";
import { existsSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { computeContentHash, contentHashDistance, CONTENT_DUP_THRESHOLD } from "../src/content-hash.js";

const files = process.argv.slice(2).filter((f) => existsSync(f));
if (files.length < 2) {
  console.error("need at least 2 existing video paths");
  process.exit(1);
}

const dur = (p) =>
  parseFloat(execSync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${p}"`, { encoding: "utf-8" }).trim());

const label = (p) => p.split("/").pop().slice(0, 44);

console.log("Hashing inputs...");
const entries = [];
for (const f of files) {
  const d = dur(f);
  const h = await computeContentHash(f, d);
  entries.push({ file: f, dur: d, hash: h });
  console.log(`  ${label(f)}  ${d.toFixed(1)}s  ${h ? "ok" : "HASH FAILED"}`);
}

// ── Pipeline-processed copies of videoA ──────────────────────────────────────
const src = entries[0];
const tmp = tmpdir();
const variants = [];

// Freshness pass: CRF 18, veryfast, trim ~3 end frames, tiny gain nudge (freshness.js)
const freshPath = join(tmp, "calib_fresh.mp4");
try {
  const endT = (src.dur - 3 / 30).toFixed(4);
  execSync(
    `ffmpeg -y -i "${src.file}" -t ${endT} -c:v libx264 -crf 18 -preset veryfast -c:a aac -b:a 192k -af volume=0.06dB -map_metadata -1 -movflags +faststart "${freshPath}"`,
    { timeout: 600000, stdio: "pipe" }
  );
  variants.push({ name: "freshness re-encode (CRF 18)", path: freshPath });
} catch (e) {
  console.error("  freshness variant failed:", e.message?.slice(0, 80));
}

// Caption burn equivalent: CRF 18 with burned-in text across the lower third
const burnPath = join(tmp, "calib_burn.mp4");
try {
  execSync(
    `ffmpeg -y -i "${freshPath}" -vf "drawtext=text='COMMENT TOUR FOR THE FULL BREAKDOWN':fontcolor=white:fontsize=48:borderw=4:x=(w-text_w)/2:y=h*0.78" -c:v libx264 -crf 18 -preset veryfast -c:a copy "${burnPath}"`,
    { timeout: 600000, stdio: "pipe" }
  );
  variants.push({ name: "freshness + burned captions", path: burnPath });
} catch (e) {
  console.error("  caption-burn variant failed:", e.message?.slice(0, 80));
}

console.log("\n── SAME footage (must be BELOW threshold) ──");
const sameDistances = [];
for (const v of variants) {
  const h = await computeContentHash(v.path, dur(v.path));
  const d = contentHashDistance(src.hash, h);
  sameDistances.push(d);
  console.log(`  ${d.toFixed(2)}   ${label(src.file)}  vs  ${v.name}`);
}
const pairD = contentHashDistance(entries[0].hash, entries[1].hash);
sameDistances.push(pairD);
console.log(`  ${pairD.toFixed(2)}   ${label(entries[0].file)}  vs  ${label(entries[1].file)}   <-- the incident pair (separate Drive uploads)`);

console.log("\n── DIFFERENT tours (must be ABOVE threshold) ──");
const diffDistances = [];
for (let i = 2; i < entries.length; i++) {
  for (const base of [entries[0], entries[1]]) {
    const d = contentHashDistance(base.hash, entries[i].hash);
    if (Number.isFinite(d)) {
      diffDistances.push(d);
      console.log(`  ${d.toFixed(2)}   ${label(base.file)}  vs  ${label(entries[i].file)}`);
    }
  }
}
for (let i = 2; i < entries.length; i++) {
  for (let j = i + 1; j < entries.length; j++) {
    const d = contentHashDistance(entries[i].hash, entries[j].hash);
    if (Number.isFinite(d)) {
      diffDistances.push(d);
      console.log(`  ${d.toFixed(2)}   ${label(entries[i].file)}  vs  ${label(entries[j].file)}`);
    }
  }
}

const maxSame = Math.max(...sameDistances.filter(Number.isFinite));
const minDiff = diffDistances.length ? Math.min(...diffDistances) : Infinity;
console.log("\n── VERDICT ──");
console.log(`  worst SAME-footage distance : ${maxSame.toFixed(2)}`);
console.log(`  best  DIFFERENT-tour distance: ${Number.isFinite(minDiff) ? minDiff.toFixed(2) : "n/a"}`);
console.log(`  separation margin            : ${Number.isFinite(minDiff) ? (minDiff - maxSame).toFixed(2) : "n/a"}`);
console.log(`  configured threshold         : ${CONTENT_DUP_THRESHOLD}`);
const ok = maxSame < CONTENT_DUP_THRESHOLD && CONTENT_DUP_THRESHOLD < minDiff;
console.log(`  ${ok ? "PASS — threshold separates both classes" : "FAIL — threshold does not separate cleanly"}`);

for (const v of variants) { try { unlinkSync(v.path); } catch {} }
