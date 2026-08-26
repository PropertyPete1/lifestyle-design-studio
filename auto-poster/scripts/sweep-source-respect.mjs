#!/usr/bin/env node
/**
 * Planted-case sweep for the source-respect gates — REAL media, REAL tooling.
 *
 * Builds four clips with ffmpeg (and the OS text-to-speech voice for the
 * talking head), then runs the actual production chain over them — detectSpeech
 * via Whisper, detectBurnedCaptions via tesseract, processVoiceover's decision
 * in dry-run — and asserts the gate verdicts:
 *
 *   1. talking-head clip   → voiceover SKIPPED (source has speech)
 *   2. captioned clip      → caption layer BLOCKED (source has captions)
 *   3. silent b-roll clip  → voiceover STILL WORKS (the feature survives)
 *   4. static-overlay clip → captions still allowed (an overlay is not a
 *                            subtitle track; the gate must not kill captions
 *                            on every listing clip with a price plate)
 *   5. the price misread   → "$2,500 source, two-and-a-half-million read"
 *                            BLOCKED, and the violation NAMED
 *
 * Needs: ffmpeg, tesseract, python3 with openai-whisper importable, and (for
 * the speech clip) either macOS `say` or espeak. Exits non-zero on any finding.
 *
 * Run:  node scripts/sweep-source-respect.mjs
 */
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { detectSpeech } from "../src/speech-detect.js";
import { processVoiceover } from "../src/voiceover.js";
import {
  speechVerdict,
  detectBurnedCaptions,
  sourceFigureValues,
  checkNumberHonesty,
} from "../src/source-respect.js";

const work = mkdtempSync(join(tmpdir(), "source-respect-sweep-"));
const findings = [];
const passes = [];

function report(name, ok, detail) {
  (ok ? passes : findings).push(`${name}: ${detail}`);
  console.log(`${ok ? "✓" : "✖ FINDING"} — ${name}: ${detail}`);
}

function sh(cmd, args) {
  execFileSync(cmd, args, { stdio: ["pipe", "pipe", "pipe"], timeout: 120000 });
}

/** Speech WAV via the platform TTS (macOS `say`, else espeak). */
function makeSpeechWav(text, out) {
  try {
    const aiff = out.replace(/\.wav$/, ".aiff");
    sh("say", ["-o", aiff, text]);
    sh("ffmpeg", ["-y", "-v", "error", "-i", aiff, "-ar", "16000", out]);
    return;
  } catch {
    sh("espeak", ["-w", out, text]);
  }
}

/**
 * A clip whose frames carry per-second text, WITHOUT ffmpeg's drawtext filter —
 * minimal ffmpeg builds (the local one included) ship without it. Frames are
 * rendered with PIL at 1fps and encoded as an image sequence, which needs no
 * video filters at all. `texts[i]` is the text for second i; null = no text.
 */
function makeTextClip(texts, out, bg = "#333333") {
  const frameDir = join(work, `frames-${Date.now()}`);
  mkdirSync(frameDir);
  const py = join(work, `frames-${Date.now()}.py`);
  writeFileSync(py, `
import json, sys
from PIL import Image, ImageDraw, ImageFont
texts = json.loads(sys.argv[1])
out_dir = sys.argv[2]
bg = sys.argv[3]
font = None
for path in [
    "/System/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
]:
    try:
        font = ImageFont.truetype(path, 56)
        break
    except Exception:
        pass
if font is None:
    raise SystemExit("no usable font for the planted captions")
for i, text in enumerate(texts):
    img = Image.new("RGB", (720, 1280), bg)
    if text:
        d = ImageDraw.Draw(img)
        w = d.textlength(text, font=font)
        x = (720 - w) / 2
        y = 1020
        d.rectangle([x - 20, y - 16, x + w + 20, y + 76], fill="black")
        d.text((x, y), text, font=font, fill="white")
    img.save(f"{out_dir}/frame{i:03d}.png")
`);
  sh("python3", [py, JSON.stringify(texts), frameDir, bg]);
  sh("ffmpeg", ["-y", "-v", "error", "-framerate", "1", "-i", join(frameDir, "frame%03d.png"),
    "-c:v", "libx264", "-r", "30", "-pix_fmt", "yuv420p", out]);
}

console.log("── building planted clips ──────────────────────────────────────");

// 1. TALKING HEAD — a person saying a price, over plain footage.
const speechWav = join(work, "speech.wav");
makeSpeechWav(
  "This home is listed at two thousand five hundred dollars a month. Come take a tour with me today and I will show you the kitchen, the primary suite, and the backyard before it is gone.",
  speechWav
);
const talkingHead = join(work, "talking-head.mp4");
makeTextClip(Array(18).fill(null), join(work, "talking-head-video.mp4"), "#224466");
sh("ffmpeg", ["-y", "-v", "error", "-i", join(work, "talking-head-video.mp4"), "-i", speechWav,
  "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-shortest", talkingHead]);

// 2. CAPTIONED CLIP — silent footage whose burned-in captions change every 4s.
const capLines = [
  "LOOK AT THIS KITCHEN ISLAND",
  "QUARTZ COUNTERS EVERYWHERE",
  "THE PRIMARY SUITE IS HUGE",
  "WAIT FOR THE BACKYARD",
  "COMMENT TOUR FOR DETAILS",
  "LINK IN BIO TODAY",
];
const captioned = join(work, "captioned.mp4");
makeTextClip(capLines.flatMap((t) => [t, t, t, t]), captioned);

// 3. SILENT B-ROLL — nothing but pictures. The voiceover feature must survive.
const silent = join(work, "silent-broll.mp4");
makeTextClip(Array(18).fill(null), silent, "#446622");

// 4. STATIC OVERLAY — one price plate held for the whole clip. NOT captions.
const overlay = join(work, "static-overlay.mp4");
makeTextClip(Array(24).fill("STARTING AT $440,000"), overlay);

console.log("── running the real chain ──────────────────────────────────────");

// ─── CASE 1: talking head → NO voiceover ────────────────────────────────────
{
  const detection = detectSpeech(talkingHead);
  const verdict = speechVerdict(detection);
  report(
    "talking-head clip",
    verdict.sourceHasSpeech === true,
    verdict.sourceHasSpeech
      ? `voiceover refused — ${verdict.say}`
      : `GATE FAILED OPEN: verdict says no speech (words=${verdict.wordCount}, transcript="${(detection.transcript || "").slice(0, 60)}")`
  );

  // And the full decision path agrees, forceVoiceover included.
  const vo = await processVoiceover(talkingHead, "san_antonio", true, null, { forceVoiceover: true });
  report(
    "talking-head via processVoiceover(force)",
    vo.skipped === true && vo.reason === "source_has_speech_force_refused",
    `skipped=${vo.skipped} reason=${vo.reason}`
  );
}

// ─── CASE 2: captioned clip → no new caption layer ──────────────────────────
{
  const scan = detectBurnedCaptions(captioned);
  report(
    "captioned clip",
    scan.detected === true,
    scan.detected
      ? scan.say
      : `GATE FAILED OPEN: scan says no captions (${scan.novelTexts} novel / ${scan.textFrames} text frames)`
  );
}

// ─── CASE 3: silent b-roll → voiceover still works ──────────────────────────
{
  const detection = detectSpeech(silent);
  const verdict = speechVerdict(detection);
  const vo = await processVoiceover(silent, "austin", true);
  report(
    "silent b-roll clip",
    verdict.sourceHasSpeech === false && vo.skipped === false,
    verdict.sourceHasSpeech === false && vo.skipped === false
      ? "voiceover proceeds — the feature survives"
      : `FEATURE KILLED: verdict=${JSON.stringify(verdict)} vo.reason=${vo.reason}`
  );
}

// ─── CASE 4: static overlay → captions still allowed ────────────────────────
{
  const scan = detectBurnedCaptions(overlay);
  report(
    "static-overlay clip",
    scan.detected === false && scan.ocrUnavailable === false,
    scan.detected === false
      ? `overlay correctly not treated as captions (${scan.novelTexts} novel text across ${scan.textFrames} text frames)`
      : `FEATURE KILLED: a price plate was mistaken for a subtitle track`
  );
}

// ─── CASE 5: the price misread → blocked, and NAMED ─────────────────────────
{
  const allowed = sourceFigureValues(["Move-in special $2,500", "SAN ANTONIO"]);
  const check = checkNumberHonesty(
    "Would you believe brand new construction for two million five hundred thousand dollars. Comment TOUR.",
    allowed
  );
  const named = check.violations.map((v) => `"${v.raw}" (${v.value})`).join(", ");
  report(
    "price misread",
    check.ok === false && /two million five hundred thousand/.test(named),
    check.ok === false ? `blocked and named: ${named}` : "GATE FAILED OPEN: the 1000x price passed"
  );

  const honest = checkNumberHonesty("Just two thousand five hundred dollars to move in. Comment TOUR.", allowed);
  report("honest price on the same source", honest.ok === true, honest.ok ? "passes" : "honest figure wrongly blocked");
}

rmSync(work, { recursive: true, force: true });

console.log("────────────────────────────────────────────────────────────────");
console.log(`${passes.length} passed, ${findings.length} finding(s)`);
if (findings.length > 0) {
  console.log("FINDINGS:");
  for (const f of findings) console.log(`  ✖ ${f}`);
  process.exit(1);
}
console.log("ZERO FINDINGS — every planted case hit its gate.");
