/**
 * Cold-run the revision-3 visual chain end to end, twice, and diff the results.
 *
 * No network, no API keys, real ffmpeg and real sharp. This is the closest
 * thing to the finished build that can run without Peter's Drive and the CI
 * secrets, and it exercises the paths that actually encode pixels: reveal
 * timing, animated cards, kinetic typography, the coverage floor, and the
 * conform-for-concat step.
 *
 * Stock is deliberately left unconfigured, which is the state a build would be
 * in today — PEXELS_API_KEY is not among the repository secrets — so the
 * FOOTAGE takes here exercise the fallback rather than the fetch.
 */

import { execFileSync } from "child_process";
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";

import { buildVisuals } from "../../auto-poster/src/yt-visual-build.js";
import { buildEditList } from "../../auto-poster/src/yt-oncamera-edit.js";
import { findEmphasisWords } from "../../auto-poster/src/yt-reveal-timing.js";
import { auditCadence } from "../../auto-poster/src/yt-cadence.js";
import { creditsBlock } from "../../auto-poster/src/yt-stock.js";
import { PUNCH_INTERVAL } from "../../auto-poster/src/yt-config.js";

const ffmpeg = (a) => execFileSync("ffmpeg", a, { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });

// A script with one of everything: a graphic that will animate, a FOOTAGE take
// with keywords that cannot be served, a deliberate typography take, and a take
// the writer said nothing about.
const segments = [
  {
    kind: "voiceover", takeId: "s1t1", section: "The bill", seconds: 12,
    text: "Your property tax bill splits into school district, county, and city. The MUD is the one you can avoid.",
    visualIntent: {
      type: "NUMBER_BREAKDOWN",
      spec: {
        eyebrow: "PROPERTY TAX", title: "Where your bill goes",
        rows: [
          { label: "School district", value: "$4,200" },
          { label: "County", value: "$1,100" },
          { label: "City", value: "$900" },
          { label: "MUD", value: "$1,400", struck: true },
        ],
        total: "$7,600",
      },
    },
  },
  {
    kind: "voiceover", takeId: "s1t2", section: "The bill", seconds: 9,
    text: "Here is what one of those neighbourhoods actually looks like on a Tuesday afternoon.",
    visualIntent: { type: "FOOTAGE", spec: { keywords: ["aerial suburban neighborhood texas"] } },
  },
  {
    kind: "voiceover", takeId: "s1t3", section: "The point", seconds: 11,
    text: "Most people think the rate is the whole story. It is not. The line item under it is.",
    visualIntent: { type: "TYPOGRAPHY", spec: { eyebrow: "the part nobody reads" } },
  },
  {
    kind: "voiceover", takeId: "s1t4", section: "The point", seconds: 8,
    text: "Two houses at the same price can differ by four thousand dollars a year.",
    visualIntent: null,
  },
  {
    kind: "voiceover", takeId: "s1t5", section: "Timeline", seconds: 14,
    text: "First you get the appraisal notice in April. You protest by May. The board rules in July.",
    visualIntent: {
      type: "TIMELINE",
      spec: {
        eyebrow: "PROTEST", title: "How the year runs",
        steps: [
          { label: "Appraisal notice arrives", when: "April" },
          { label: "File your protest", when: "May" },
          { label: "Board rules", when: "July" },
        ],
      },
    },
  },
];

// Fixed word timings, so the run is deterministic without Whisper. Real builds
// transcribe; the shape is identical.
const WORDS = {
  s1t1: [
    { word: "Your", start: 0.0, end: 0.3 }, { word: "property", start: 0.4, end: 0.9 },
    { word: "tax", start: 1.0, end: 1.3 }, { word: "bill", start: 1.4, end: 1.7 },
    { word: "splits", start: 1.9, end: 2.3 }, { word: "into", start: 2.4, end: 2.6 },
    { word: "school", start: 2.8, end: 3.2 }, { word: "district,", start: 3.3, end: 3.9 },
    { word: "county,", start: 4.6, end: 5.2 }, { word: "and", start: 5.3, end: 5.4 },
    { word: "city.", start: 5.6, end: 6.1 }, { word: "The", start: 7.0, end: 7.1 },
    { word: "MUD", start: 7.3, end: 7.8 }, { word: "is", start: 7.9, end: 8.0 },
    { word: "the", start: 8.1, end: 8.2 }, { word: "one", start: 8.3, end: 8.6 },
    { word: "you", start: 8.7, end: 8.9 }, { word: "can", start: 9.0, end: 9.2 },
    { word: "avoid.", start: 9.3, end: 9.9 },
  ],
  s1t5: [
    { word: "First", start: 0.2, end: 0.6 }, { word: "you", start: 0.7, end: 0.8 },
    { word: "get", start: 0.9, end: 1.1 }, { word: "the", start: 1.2, end: 1.3 },
    { word: "appraisal", start: 1.4, end: 2.0 }, { word: "notice", start: 2.1, end: 2.5 },
    { word: "in", start: 2.6, end: 2.7 }, { word: "April.", start: 2.8, end: 3.4 },
    { word: "You", start: 5.0, end: 5.2 }, { word: "protest", start: 5.3, end: 5.9 },
    { word: "by", start: 6.0, end: 6.1 }, { word: "May.", start: 6.2, end: 6.7 },
    { word: "The", start: 9.0, end: 9.1 }, { word: "board", start: 9.2, end: 9.6 },
    { word: "rules", start: 9.7, end: 10.1 }, { word: "in", start: 10.2, end: 10.3 },
    { word: "July.", start: 10.4, end: 11.0 },
  ],
};

const getWordTimestamps = async (audioPath) => {
  const id = String(audioPath).match(/take-([a-z0-9]+)\./)?.[1];
  return WORDS[id] || null;
};

async function coldRun(label) {
  const dir = `/tmp/coldrun-${label}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  // A silent audio file per take, so wordsFor finds something on disk. Only two
  // takes have timings — the rest exercise the even-pacing path.
  const plan = { segments: segments.map((s) => ({ ...s })) };
  for (const seg of plan.segments) {
    const audio = join(dir, `take-${seg.takeId}.wav`);
    ffmpeg(["-y", "-f", "lavfi", "-i", `anullsrc=r=48000:cl=mono`, "-t", String(seg.seconds), audio]);
    seg.generatedNarrationPath = audio;
  }

  const t0 = Date.now();
  const { plan: built, report } = await buildVisuals(plan, {
    workDir: dir,
    ffmpeg,
    getWordTimestamps,
    visionClient: null,
    ownedPool: [],
    usedHashes: new Set(),
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  return { dir, built, report, elapsed };
}

function fingerprint(built) {
  // Structure only — file paths contain the run label, so they are excluded.
  return built.segments.map((s) => ({
    takeId: s.takeId,
    primary: s.visualPrimary,
    fellBack: s.visualFellBack,
    reason: s.visualReason,
    blocks: (s.broll || []).map((b) => ({ kind: b.kind, seconds: b.seconds })),
  }));
}

const a = await coldRun("a");
const b = await coldRun("b");

console.log(`\n=== COLD RUN A (${a.elapsed}s) / COLD RUN B (${b.elapsed}s) ===\n`);

console.log("PER-SEGMENT VISUAL SOURCE");
for (const s of a.built.segments) {
  const blocks = (s.broll || []).map((x) => `${x.kind} ${x.seconds}s`).join(" + ");
  const flag = s.visualFellBack ? `  <- FELL BACK: ${s.visualReason}` : "";
  console.log(`  ${s.takeId}  asked:${String(s.visual || "nothing").padEnd(17)} got: ${blocks}${flag}`);
}

const r = a.report;
console.log("\nCOVERAGE");
console.log(`  graphic ${r.byPct.graphic}%  typography ${r.byPct.typography}%  stock ${r.byPct.stock}%  owned ${r.byPct.owned}%`);
console.log(`  voiceover ${r.voiceoverSeconds}s, uncovered ${r.uncoveredSeconds}s`);
console.log(`  word timing: ${r.wordTimingCoverage.withTiming}/${r.wordTimingCoverage.takes} takes`);
console.log(`  stock configured: ${r.stockConfigured}`);
if (r.animationFailures.length) {
  console.log("  animation failures:");
  for (const f of r.animationFailures) console.log(`    ${f.takeId} ${f.type}: ${f.reason}`);
}

console.log("\nFALLBACKS");
for (const f of r.fallbacks) console.log(`  ${f.takeId}: asked ${f.asked} -> ${f.got} (${f.reason})`);
if (r.fallbacks.length === 0) console.log("  none");

console.log("\nCREDITS BLOCK");
console.log(creditsBlock(r.stockCredits) || "  (no stock used — no credit block, correctly)");

// ── cadence on a representative on-camera take ───────────────────────────────
const words = WORDS.s1t1;
const edit = buildEditList(24, [{ start: 8.1, end: 8.9 }, { start: 16.4, end: 17.2 }], {
  emphasis: findEmphasisWords(words), seed: 0,
});
console.log("\nCADENCE (24s on-camera take)");
console.log(`  interval knob: ${PUNCH_INTERVAL}s`);
console.log(`  pieces: ${edit.cadence.pieceCount}, average ${edit.cadence.averagePieceSeconds}s`);
console.log(`  pulses assigned: ${edit.cadence.pulsesAssigned}, dropped: ${edit.cadence.pulsesDropped.length}`);
for (const d of edit.cadence.pulsesDropped) console.log(`    dropped "${d.word}": ${d.why}`);

const cadence = auditCadence(a.built.segments);
console.log(`  cadence audit over the voiceover plan: ${cadence.ok ? "clean" : `${cadence.violations.length} violation(s)`}`);
for (const v of cadence.violations) console.log(`    ${v.at}s ${v.detail} held ${v.seconds}s`);

// ── determinism ──────────────────────────────────────────────────────────────
const fa = JSON.stringify(fingerprint(a.built), null, 1);
const fb = JSON.stringify(fingerprint(b.built), null, 1);
console.log("\nDETERMINISM");
console.log(`  plan structure identical: ${fa === fb}`);
if (fa !== fb) {
  console.log("  A:", fa);
  console.log("  B:", fb);
}

// Byte-compare the rendered clips across the two cold runs.
let compared = 0;
let identical = 0;
for (const [i, seg] of a.built.segments.entries()) {
  for (const [j, blk] of (seg.broll || []).entries()) {
    const other = b.built.segments[i]?.broll?.[j];
    if (!blk.sourcePath || !other?.sourcePath) continue;
    if (!existsSync(blk.sourcePath) || !existsSync(other.sourcePath)) continue;
    compared++;
    const ha = createHash("sha256").update(readFileSync(blk.sourcePath)).digest("hex");
    const hb = createHash("sha256").update(readFileSync(other.sourcePath)).digest("hex");
    if (ha === hb) identical++;
    else console.log(`  DIFFERS: ${seg.takeId} block ${j} (${blk.kind})`);
  }
}
console.log(`  rendered clips byte-identical: ${identical}/${compared}`);

// ── proof the files are real ─────────────────────────────────────────────────
console.log("\nRENDERED FILES");
for (const seg of a.built.segments) {
  for (const blk of seg.broll || []) {
    if (!blk.sourcePath || !existsSync(blk.sourcePath)) continue;
    const kb = (statSync(blk.sourcePath).size / 1024).toFixed(0);
    const dur = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", blk.sourcePath]).toString().trim();
    console.log(`  ${seg.takeId} ${blk.kind.padEnd(11)} ${kb.padStart(6)} KB  ${Number(dur).toFixed(2)}s (slot ${blk.seconds}s)`);
  }
}
console.log(`\nwork dir: ${a.dir}`);
