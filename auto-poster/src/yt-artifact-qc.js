/**
 * yt-artifact-qc.js — the pipeline watches its own render before Peter does.
 *
 * WHY THIS FILE EXISTS.
 *
 * Every check in this repo up to now has argued with a PLAN. The suite proves
 * `selectPunches` picks the right words, `buildEditList` cuts the right
 * silences, `bedEnvelope` computes the right curve — and every one of those was
 * green on the build that put "1604" on screen in gold and lost most of Peter's
 * voice. They were green because they were all correct. The plan was fine. The
 * file was not.
 *
 * That gap has a shape, and it is the same shape every time: something computed
 * against one timeline is applied on another. The declick fades were right about
 * where the piece started and wrong about which clock ffmpeg was counting on.
 * Nothing that reads a plan can see that, because the plan is the thing that was
 * right.
 *
 * So these checks decode the finished mp4 and measure it. They take no timings
 * from the plan — speech windows come from `silencedetect` run on the rendered
 * audio, motion comes from frame comparison, on-screen text comes from OCR of
 * extracted frames. Where a plan value appears it is the thing being CHECKED
 * AGAINST, never the thing being trusted: the OCR pass uses the punch list to
 * know what the pixels were supposed to say, and gets the window from the file.
 *
 * WHAT A FAILURE DOES. It fails the build. Not a warning, not a note on the
 * card — Peter's eyes were the only real QA in this loop and that is the bug
 * these checks exist to fix. A check that files a warning has handed the job
 * straight back to him.
 *
 * WHAT A CHECK THAT CANNOT RUN DOES. Also fails the build, unless it can prove
 * the thing it checks is absent. `tesseract` missing is not "no text problems";
 * it is "nobody looked". The one honest skip is a check whose subject does not
 * exist — a video with no bed cannot have the bed over the voice, and a video
 * with no punches has no punch windows to read.
 */

import { execFileSync, spawnSync } from "child_process";
import { existsSync, rmSync, mkdirSync, copyFileSync, statSync, writeFileSync } from "fs";
import { join } from "path";

import { describeTextProblem } from "./yt-text-safety.js";
import { punchDisplay } from "./yt-punch.js";

// ─── thresholds ─────────────────────────────────────────────────────────────

/**
 * How far under the voice the bed has to stay, in dB, inside a speech window.
 *
 * NOT A TASTE SETTING. This is the line between "there is music playing" and
 * "I cannot hear what he is saying", and 10 dB is where speech intelligibility
 * research puts it for a competing continuous signal. `YT_MUSIC_DB` decides how
 * the bed FEELS; this decides whether the video is publishable.
 */
export const MIN_VOICE_MARGIN_DB = Number.parseFloat(process.env.YT_QC_VOICE_MARGIN_DB || "10");

/** Below this the window is too quiet to be speech worth measuring. */
const SPEECH_FLOOR_DB = -45;

/** silencedetect's noise gate and minimum span, for finding the speech. */
const SILENCE_NOISE_DB = -35;
const SILENCE_MIN_SECONDS = 0.35;

/** A speech window shorter than this is a syllable between two pauses. */
const MIN_SPEECH_WINDOW = 0.4;

/**
 * How much of a ten-second window may be duplicate frames before it reads as
 * stepping rather than as stillness.
 *
 * Revision 8's note was "the whole video feels laggy" and the cause was drawing
 * at 7fps inside a 30fps encode — each frame held for four. Real footage never
 * does this: sensor noise alone makes two consecutive frames differ. So a high
 * duplicate ratio is a direct measurement of the defect, and 0.5 leaves room for
 * a genuinely held graphic while catching anything drawn at half rate or less.
 */
export const MAX_DUPLICATE_FRAME_RATIO = Number.parseFloat(process.env.YT_QC_MAX_DUPE_RATIO || "0.5");

/** The sample rate everything audio is measured at. */
const PCM_RATE = 48000;

// ─── decoding ───────────────────────────────────────────────────────────────

/**
 * Decode a file's audio to mono 16-bit PCM in memory.
 *
 * ONE DECODE, THEN ALL THE ARITHMETIC IN JS, rather than an ffmpeg invocation
 * per measurement. A twelve-minute video has a few hundred speech windows in it
 * and needs both an RMS and a click scan over each — as ffmpeg calls that is
 * twenty minutes of process spawning, and as an Int16Array it is 69 MB and
 * instant. It is also the only way the click scan can work at all: a click is a
 * single-sample event and there is no ffmpeg filter that reports one.
 */
export function decodePcm(path, { rate = PCM_RATE, run = execFileSync } = {}) {
  const raw = run(
    "ffmpeg",
    ["-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", String(rate), "-f", "s16le", "-"],
    { maxBuffer: 1024 * 1024 * 1024, encoding: "buffer" }
  );
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  // A Buffer's bytes are not guaranteed to be 2-aligned in its parent pool, so
  // the Int16Array has to be built from a copy of the range rather than a view
  // onto it. Getting this wrong throws "start offset must be a multiple of 2"
  // on some inputs and not others, which is the worst kind of intermittent.
  const aligned = Buffer.from(buf.buffer, buf.byteOffset, buf.length - (buf.length % 2));
  return new Int16Array(new Uint8Array(aligned).slice().buffer);
}

/** RMS of a sample range, in dBFS. -Infinity for digital silence. */
export function rmsDb(samples, from, to) {
  const a = Math.max(0, Math.floor(from));
  const b = Math.min(samples.length, Math.ceil(to));
  if (b <= a) return -Infinity;
  let sum = 0;
  for (let i = a; i < b; i++) {
    const v = samples[i] / 32768;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / (b - a));
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

// ─── 1. speech windows, from the file ───────────────────────────────────────

/**
 * Where somebody is speaking, measured on the rendered audio.
 *
 * THE PLAN IS NOT CONSULTED. Segment boundaries, caption chunk times and punch
 * timestamps are all predictions, and the whole reason these checks exist is
 * that predictions have been wrong in ways nothing noticed. `silencedetect` is
 * run on the voice track of the actual render and the speech is what is left.
 */
export function speechWindows(voicePath, { duration, run = spawnSync } = {}) {
  const res = run(
    "ffmpeg",
    ["-hide_banner", "-nostats", "-i", voicePath,
     "-af", `silencedetect=noise=${SILENCE_NOISE_DB}dB:d=${SILENCE_MIN_SECONDS}`,
     "-f", "null", "-"],
    { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 }
  );
  const log = String(res.stderr || "");

  const silences = [];
  let open = null;
  for (const line of log.split(/\r?\n/)) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (s) { open = Math.max(0, Number.parseFloat(s[1])); continue; }
    const e = /silence_end:\s*(-?[\d.]+)/.exec(line);
    if (e && open !== null) {
      const end = Number.parseFloat(e[1]);
      if (end > open) silences.push({ start: open, end });
      open = null;
    }
  }
  if (open !== null && duration > open) silences.push({ start: open, end: duration });

  const windows = [];
  let cursor = 0;
  for (const s of silences) {
    if (s.start - cursor >= MIN_SPEECH_WINDOW) windows.push({ start: cursor, end: s.start });
    cursor = Math.max(cursor, s.end);
  }
  if (duration - cursor >= MIN_SPEECH_WINDOW) windows.push({ start: cursor, end: duration });
  return windows;
}

/**
 * Is the music under the voice everywhere somebody is talking?
 *
 * MEASURES THE BED AGAINST THE VOICE IN EVERY WINDOW, not on average and not at
 * a sample of them. An average is exactly the statistic that hid this: a bed
 * sitting correctly for eleven minutes and covering him for forty seconds
 * averages out fine, and forty seconds is the whole complaint.
 *
 * The two signals come from the render's own intermediates — the programme
 * before the bed was added, and the bed as the duck produced it. They cannot be
 * recovered from the mix, and reconstructing them by re-running the filters
 * would be measuring a second render rather than this one.
 */
export function checkAudioLevels({ voicePath, bedPath, duration, margin = MIN_VOICE_MARGIN_DB, decode = decodePcm, windows = null }) {
  if (!bedPath) {
    return { name: "audio-levels", ok: true, skipped: "this render has no music bed — there is nothing over the voice", failures: [] };
  }
  if (!voicePath || !existsSync(voicePath) || !existsSync(bedPath)) {
    return {
      name: "audio-levels",
      ok: false,
      failures: [{ reason: `the audio check could not run: ${!existsSync(String(voicePath)) ? "the voice-only track is missing" : "the bed-only track is missing"}. Nobody looked, so this is a failure.` }],
    };
  }

  const voice = decode(voicePath);
  const bed = decode(bedPath);
  const spans = windows || speechWindows(voicePath, { duration });

  const failures = [];
  let worst = null;
  let measured = 0;

  for (const w of spans) {
    const from = w.start * PCM_RATE;
    const to = w.end * PCM_RATE;
    const vDb = rmsDb(voice, from, to);
    // A window quiet enough to be room tone is not a window where the bed can
    // drown anybody. Skipping these is not leniency: silencedetect's gate and a
    // window's own RMS disagree at the edges, and a 0.4s tail of breath would
    // otherwise fail every video ever made.
    if (!Number.isFinite(vDb) || vDb < SPEECH_FLOOR_DB) continue;
    const bDb = rmsDb(bed, from, to);
    measured++;
    const actual = Number.isFinite(bDb) ? vDb - bDb : Infinity;
    if (!worst || actual < worst.margin) {
      worst = { at: w.start, margin: Math.round(actual * 10) / 10, voiceDb: Math.round(vDb * 10) / 10, bedDb: Math.round(bDb * 10) / 10 };
    }
    if (actual < margin) {
      failures.push({
        at: Math.round(w.start * 100) / 100,
        until: Math.round(w.end * 100) / 100,
        voiceDb: Math.round(vDb * 10) / 10,
        bedDb: Math.round(bDb * 10) / 10,
        margin: Math.round(actual * 10) / 10,
        reason:
          `at ${timestamp(w.start)} the bed is ${Math.round(actual * 10) / 10} dB under the voice ` +
          `(voice ${Math.round(vDb * 10) / 10} dBFS, music ${Math.round(bDb * 10) / 10} dBFS) — ` +
          `${margin} dB is the floor`,
      });
    }
  }

  return {
    name: "audio-levels",
    ok: failures.length === 0,
    // Reported even when it passes, because "the tightest point in the video was
    // 14 dB" is the sentence that says the check actually measured something.
    stats: { speechWindows: spans.length, measured, tightest: worst, marginRequired: margin },
    failures,
  };
}

// ─── 2. join clicks ─────────────────────────────────────────────────────────

/**
 * Sample-level discontinuities anywhere in the finished audio.
 *
 * SCANNED ACROSS THE WHOLE FILE RATHER THAN AT THE KNOWN JOINS, and that is the
 * point rather than thoroughness for its own sake. The joins are a plan value.
 * The defect this catches is a join whose declick did not land where the plan
 * said it would — so a scan that only looked where the plan pointed would be
 * asking the suspect for its own alibi.
 *
 * A click is a STEP: one sample far from its neighbour. Speech cannot do that —
 * it is band-limited, so consecutive samples at 48 kHz are necessarily close. A
 * plosive rises over about a millisecond, which is fifty samples, so comparing
 * each step against the median step nearby separates the two cleanly.
 */
export function checkJoinClicks({ path, decode = decodePcm, threshold = 8, minAbs = 0.08 }) {
  if (!path || !existsSync(path)) {
    return { name: "join-clicks", ok: false, failures: [{ reason: "the finished file is missing — nobody looked" }] };
  }
  const s = decode(path);
  if (s.length < PCM_RATE) {
    return { name: "join-clicks", ok: true, skipped: "less than a second of audio", failures: [] };
  }

  const win = Math.round(PCM_RATE * 0.005); // 5 ms either side
  const failures = [];
  const found = [];
  let lastAt = -1;

  // Stepped in half-windows: a click is one sample wide, so nothing is missed by
  // computing the local median once per block rather than per sample.
  for (let base = win; base + win < s.length; base += win) {
    let localMax = 0;
    let localSum = 0;
    let localAt = base;
    for (let i = base; i < base + win; i++) {
      const d = Math.abs(s[i] - s[i - 1]);
      localSum += d;
      if (d > localMax) { localMax = d; localAt = i; }
    }
    const mean = localSum / win;
    // A block of digital silence has mean 0 and any step in it is a real event,
    // so the absolute floor carries the decision there instead of the ratio.
    const ratio = mean > 0 ? localMax / mean : (localMax > 0 ? Infinity : 0);
    const abs = localMax / 32768;
    if (ratio > threshold && abs > minAbs) {
      const at = localAt / PCM_RATE;
      // One click per 0.25s, so a single splice reported once rather than as the
      // three blocks its ring happened to touch.
      if (at - lastAt < 0.25) continue;
      lastAt = at;
      found.push({ at: Math.round(at * 1000) / 1000, step: Math.round(abs * 1000) / 1000, ratio: Math.round(ratio) });
    }
  }

  for (const f of found) {
    failures.push({
      at: f.at,
      reason: `a click at ${timestamp(f.at)} — the waveform steps by ${f.step} of full scale in one sample (${f.ratio}x the local average). A join's declick did not land.`,
    });
  }

  return { name: "join-clicks", ok: failures.length === 0, stats: { clicks: found.length }, failures };
}

// ─── 3. frame-step motion ───────────────────────────────────────────────────

/**
 * Does the picture actually move?
 *
 * `mpdecimate` drops frames that are near-identical to the one before, and its
 * debug log names every one it dropped with a timestamp. That count IS the
 * measurement: a graphic drawn at 7 fps inside a 30 fps encode is three
 * duplicates for every real frame, and real footage produces almost none because
 * sensor noise alone makes consecutive frames differ.
 *
 * REPORTED PER TEN-SECOND WINDOW rather than as one ratio over the video. A
 * twelve-minute file that is fine everywhere except one stepped graphic averages
 * out to nothing, and the stepped graphic is the finding.
 */
export function checkMotion({ path, duration, maxRatio = MAX_DUPLICATE_FRAME_RATIO, run = spawnSync }) {
  if (!path || !existsSync(path)) {
    return { name: "motion", ok: false, failures: [{ reason: "the finished file is missing — nobody looked" }] };
  }
  const res = run(
    "ffmpeg",
    ["-hide_banner", "-nostats", "-loglevel", "debug", "-i", path,
     "-vf", "mpdecimate", "-an", "-f", "null", "-"],
    { encoding: "utf-8", maxBuffer: 512 * 1024 * 1024 }
  );
  const log = String(res.stderr || "");

  const buckets = new Map();
  const bucketFor = (t) => Math.floor(t / 10);
  let total = 0;
  let dropped = 0;

  // mpdecimate logs one line per frame: "... pts_time:12.34 drop" or "... keep".
  for (const line of log.split(/\r?\n/)) {
    if (!line.includes("pts_time:")) continue;
    const isDrop = /\bdrop\b/.test(line);
    const isKeep = /\bkeep\b/.test(line);
    if (!isDrop && !isKeep) continue;
    const m = /pts_time:\s*([\d.]+)/.exec(line);
    if (!m) continue;
    const t = Number.parseFloat(m[1]);
    const b = bucketFor(t);
    const cur = buckets.get(b) || { frames: 0, dropped: 0 };
    cur.frames++;
    if (isDrop) cur.dropped++;
    buckets.set(b, cur);
    total++;
    if (isDrop) dropped++;
  }

  if (total === 0) {
    return {
      name: "motion",
      ok: false,
      failures: [{ reason: "mpdecimate reported on no frames at all — the motion check could not read this file, so nobody looked" }],
    };
  }

  const failures = [];
  let worst = null;
  for (const [b, v] of [...buckets.entries()].sort((a, c) => a[0] - c[0])) {
    // A partial final bucket is not a sample worth failing on.
    if (v.frames < 30) continue;
    const ratio = v.dropped / v.frames;
    if (!worst || ratio > worst.ratio) worst = { at: b * 10, ratio: Math.round(ratio * 100) / 100 };
    if (ratio > maxRatio) {
      failures.push({
        at: b * 10,
        ratio: Math.round(ratio * 100) / 100,
        reason:
          `from ${timestamp(b * 10)} to ${timestamp(b * 10 + 10)}, ${Math.round(ratio * 100)}% of frames are ` +
          `duplicates of the one before (${v.dropped} of ${v.frames}) — the picture is stepping, not moving`,
      });
    }
  }

  return {
    name: "motion",
    ok: failures.length === 0,
    stats: { frames: total, duplicates: dropped, overallRatio: Math.round((dropped / total) * 100) / 100, worstWindow: worst },
    failures,
  };
}

// ─── 4. the render is the length the plan said ──────────────────────────────

/**
 * How far the finished file may be from the timeline that described it.
 *
 * The tolerance is generous on purpose. This is not a check for the frame of
 * rounding a codec adds at a segment boundary — `join-clicks` and the marker
 * test cover that class. This is a check for the render having stopped
 * describing the plan at all, and the number that made it necessary is 83%.
 */
export const MAX_DURATION_DRIFT = Number.parseFloat(process.env.YT_QC_MAX_DURATION_DRIFT || "0.015");

/**
 * Did the render come out the length its own timeline asked for?
 *
 * THE CHEAPEST CHECK HERE AND THE MOST DIAGNOSTIC, and it did not exist for the
 * 2026-08-12 build. That render was 20.5 minutes against a 11.2 minute plan —
 * the single most useful sentence about it — and nothing said so. It was
 * inferred afterwards from a duplicate-frame count, which is the symptom two
 * steps downstream: a picture padded to twice its length is mostly frames
 * repeated, so `motion` fired ninety-five times and `duration` would have fired
 * once, with the actual number in it.
 *
 * PER-SEGMENT WHERE IT CAN BE. A total that disagrees says the render is wrong;
 * the segment table says WHICH segments, which is the difference between a fix
 * and another fifty-five minute bisect. Voiceover and on-camera segments come
 * from completely different branches of renderTimeline, so "the overrun is all
 * in the voiceover takes" is very nearly the diagnosis on its own.
 */
export function checkDuration({ actualSeconds, plannedSeconds, segments = [], tolerance = MAX_DURATION_DRIFT }) {
  if (!Number.isFinite(plannedSeconds) || plannedSeconds <= 0) {
    return {
      name: "duration",
      ok: false,
      failures: [{ reason: "the plan reported no duration, so the render could not be compared to it — nobody looked" }],
    };
  }
  if (!Number.isFinite(actualSeconds) || actualSeconds <= 0) {
    return {
      name: "duration",
      ok: false,
      failures: [{ reason: "the finished file reported no duration — ffprobe could not read it" }],
    };
  }

  const drift = actualSeconds - plannedSeconds;
  const pct = drift / plannedSeconds;
  const allowed = Math.max(2, plannedSeconds * tolerance);
  const failures = [];

  if (Math.abs(drift) > allowed) {
    // The offending segments, worst first, so the message names the branch.
    const bad = segments
      .filter((s) => Number.isFinite(s.measured) && Number.isFinite(s.planned) && Math.abs(s.measured - s.planned) > 0.25)
      .sort((a, b) => Math.abs(b.measured - b.planned) - Math.abs(a.measured - a.planned))
      .slice(0, 8)
      .map((s) => `${s.takeId} (${s.kind}) planned ${s.planned.toFixed(2)}s, rendered ${s.measured.toFixed(2)}s`);

    failures.push({
      at: 0,
      drift: Math.round(drift * 100) / 100,
      reason:
        `the render is ${fmtMinutes(actualSeconds)} against a ${fmtMinutes(plannedSeconds)} plan — ` +
        `${drift > 0 ? "+" : ""}${Math.round(drift)}s (${(pct * 100).toFixed(1)}%), and ${Math.round(allowed)}s is the limit.` +
        (bad.length
          ? ` The segments that disagree: ${bad.join("; ")}`
          : " No single segment disagrees, so the length was added after the segments were joined."),
    });
  }

  return {
    name: "duration",
    ok: failures.length === 0,
    stats: {
      plannedSeconds: Math.round(plannedSeconds * 10) / 10,
      actualSeconds: Math.round(actualSeconds * 10) / 10,
      driftSeconds: Math.round(drift * 10) / 10,
      driftPct: Math.round(pct * 1000) / 10,
      segmentsMeasured: segments.length,
    },
    failures,
  };
}

function fmtMinutes(seconds) {
  return `${(seconds / 60).toFixed(1)} min`;
}

// ─── 5. OCR on every overlay ────────────────────────────────────────────────

/** Is tesseract on this machine? A check that cannot run is not a check that passed. */
export function ocrAvailable(run = spawnSync) {
  const res = run("tesseract", ["--version"], { encoding: "utf-8" });
  return !res.error && res.status === 0;
}

/**
 * Read one frame of the finished video.
 *
 * The frame is taken from the MIDDLE of the window rather than its start: the
 * plate has a fade out, and a frame grabbed on the boundary can legitimately be
 * half-transparent. The middle is where it is unambiguously either there or not.
 */
export function extractFrameArgs(videoPath, at, out) {
  return ["-y", "-v", "error", "-ss", String(at), "-i", videoPath, "-frames:v", "1", "-q:v", "2", out];
}

/**
 * What tesseract reads on one frame, normalised for comparison.
 *
 * `--psm 6` treats the image as a block of text, which is what a punch plate is
 * — a single enormous line, sometimes wrapped. The character whitelist is
 * deliberately NOT set: restricting it to what we expect to see would hide the
 * exact case this check exists for, a brace or a bracket that should never have
 * been drawn.
 */
export function ocrFrame(pngPath, { run = spawnSync } = {}) {
  const res = run("tesseract", [pngPath, "stdout", "--psm", "6"], { encoding: "utf-8", maxBuffer: 8 * 1024 * 1024 });
  if (res.error || res.status !== 0) return null;
  return String(res.stdout || "");
}

/** Letters and digits only, upper-cased — what survives a comparison across fonts. */
export function ocrNormalise(s) {
  return String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Every punch window, read off the picture and compared to what it should say.
 *
 * THE COMPARISON IS TWO-SIDED AND BOTH SIDES MATTER.
 *
 *   1. What is on screen must BE the punch. A plate that drew the wrong string,
 *      or drew nothing at all, fails.
 *   2. What is on screen must not contain a template's punctuation. This is the
 *      one that catches a substitution failure, and it is checked against the
 *      PIXELS rather than against the plan — `escapeAss` proved that a string
 *      can be sanitised into something that renders as plausible content, so the
 *      only place left to catch it is after it has been drawn.
 *
 * OCR IS FUZZY AND THE COMPARISON ACCOUNTS FOR IT, up to a point. Case and
 * punctuation are dropped, because a gold `$0` on a scrim is routinely read as
 * `SO` or `$O`. What is NOT forgiven is a plate whose text is missing entirely
 * or whose reading has nothing in common with the punch — that is not OCR
 * uncertainty, that is a different string.
 */
export function checkOverlayText({ videoPath, punches = [], workDir, run = spawnSync, ocr = ocrFrame, extract = null }) {
  const usable = (punches || []).filter((p) => p && Number.isFinite(p.at));
  if (usable.length === 0) {
    return { name: "overlay-text", ok: true, skipped: "this render has no punch overlays to read", failures: [] };
  }
  if (!ocrAvailable(run)) {
    return {
      name: "overlay-text",
      ok: false,
      failures: [{
        reason:
          "tesseract is not installed, so the on-screen text was never read. " +
          `${usable.length} overlay(s) would have gone out unchecked — that is the defect this check exists for, so it fails.`,
      }],
    };
  }

  const runExtract = extract || ((args) => execFileSync("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] }));
  const failures = [];
  const read = [];

  usable.forEach((p, i) => {
    const at = p.at + (p.seconds || 0) / 2;
    const png = join(workDir, `qc-punch-${String(i).padStart(2, "0")}.png`);
    let text = null;
    try {
      runExtract(extractFrameArgs(videoPath, at, png));
      text = ocr(png, { run });
    } catch (err) {
      failures.push({ at: p.at, reason: `could not read the frame at ${timestamp(at)} for punch "${p.text}": ${err.message}` });
      return;
    } finally {
      rmSync(png, { force: true });
    }

    if (text === null) {
      failures.push({ at: p.at, reason: `tesseract failed on the frame at ${timestamp(at)} for punch "${p.text}" — nobody read this overlay` });
      return;
    }

    read.push({ at: p.at, expected: p.text, saw: text.trim().slice(0, 120) });

    const want = ocrNormalise(punchDisplay(p.text));
    const got = ocrNormalise(text);

    // AN EMPTY WINDOW IS ITS OWN FINDING and is reported first, because "the
    // plate never rendered" and "the plate rendered the wrong thing" have
    // different causes and the message should not guess. burnArgs' own header
    // records the empty case happening for real: without the `setpts` shift the
    // plate finished fading before its window opened and every punch was zero
    // gold pixels.
    if (got.length === 0) {
      failures.push({
        at: p.at,
        reason: `nothing is on screen at ${timestamp(at)}, where the punch "${punchDisplay(p.text)}" should be — the plate did not render`,
      });
      return;
    }

    // A template's punctuation ON SCREEN. Checked before the match, because a
    // frame reading "{{PRICE}}" is a failure whatever the punch list says.
    // `text.trim()` rather than `|| null`: an empty reading is handled above,
    // and turning it into null here reported it as "the value is missing
    // entirely" — true of the variable, wrong about the picture.
    const problem = describeTextProblem(text.trim());
    if (problem) {
      failures.push({
        at: p.at,
        reason: `the frame at ${timestamp(at)} has unrenderable text on it: ${problem}. Read: ${JSON.stringify(text.trim().slice(0, 80))}`,
      });
      return;
    }
    if (!got.includes(want)) {
      failures.push({
        at: p.at,
        reason:
          `the frame at ${timestamp(at)} does not say what the punch list says. ` +
          `Expected ${JSON.stringify(punchDisplay(p.text))}, read ${JSON.stringify(text.trim().slice(0, 80))}`,
      });
    }
  });

  return { name: "overlay-text", ok: failures.length === 0, stats: { overlays: usable.length, read: read.length }, failures };
}

// ─── the gate ───────────────────────────────────────────────────────────────

/**
 * Run everything against the finished file and say whether it may ship.
 *
 * ALL CHECKS RUN EVEN AFTER ONE FAILS. A build that stops at the first failure
 * costs another thirty-minute render to find the second, and the whole point of
 * watching the render is to come back with everything that is wrong with it.
 */
export function runArtifactQc({ videoPath, duration, qcInputs = {}, workDir, log = console.log }) {
  const t0 = Date.now();
  log("[QC] watching the render before anybody else does");

  const results = [];
  const guard = (name, fn) => {
    try {
      return fn();
    } catch (err) {
      // A check that threw did not pass. This is the branch that would otherwise
      // turn a broken checker into a green build.
      return { name, ok: false, failures: [{ reason: `the ${name} check threw and therefore did not run: ${err.message}` }] };
    }
  };

  // DURATION FIRST, because when it fails everything downstream is describing
  // the consequences. A picture padded to twice its length reports as ninety-five
  // motion failures, and reading those first is reading the symptom.
  results.push(guard("duration", () => checkDuration({
    actualSeconds: duration,
    plannedSeconds: qcInputs.plannedSeconds,
    segments: qcInputs.segmentDurations || [],
  })));
  results.push(guard("audio-levels", () => checkAudioLevels({
    voicePath: qcInputs.voiceOnlyPath,
    bedPath: qcInputs.bedOnlyPath,
    duration,
  })));
  results.push(guard("join-clicks", () => checkJoinClicks({ path: videoPath })));
  results.push(guard("motion", () => checkMotion({ path: videoPath, duration })));
  results.push(guard("overlay-text", () => checkOverlayText({
    videoPath,
    punches: qcInputs.punches || [],
    workDir,
  })));

  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    const head = r.ok ? (r.skipped ? `skipped — ${r.skipped}` : "clean") : `${r.failures.length} failure(s)`;
    log(`[QC] ${r.name}: ${head}${r.stats ? ` ${JSON.stringify(r.stats)}` : ""}`);
    for (const f of r.failures) log(`::error::QC ${r.name}: ${f.reason}`);
  }
  log(`[QC] finished in ${Math.round((Date.now() - t0) / 100) / 10}s — ${failed.length === 0 ? "the render may ship" : "the render may NOT ship"}`);

  return {
    ok: failed.length === 0,
    results,
    failures: failed.flatMap((r) => r.failures.map((f) => ({ check: r.name, ...f }))),
    summary: renderQcSummary(results),
  };
}

/**
 * Where a render that failed its checks is kept.
 *
 * A FIXED PATH, OUTSIDE THE WORK DIRECTORY, because the work directory is a
 * tmpdir named after a timestamp and the workflow step that collects the
 * evidence has to know where to look before the build has run.
 */
export const FAILED_RENDER_DIR = process.env.YT_QC_FAILED_DIR || "/tmp/yt-qc-failed";

/**
 * Keep the render that failed, and everything needed to argue with the failure.
 *
 * THE 2026-08-12 BUILD IS WHY THIS EXISTS. Fifty-five minutes of encoding
 * produced a video that failed two checks, the pipeline threw, and the file went
 * with the runner. The one artifact that would have answered "why is this 20.5
 * minutes long" in thirty seconds did not survive the function that noticed it
 * was wrong — so the next step was another fifty-five minutes to look at
 * something the build had already been holding.
 *
 * A gate that destroys its own evidence is worse than no gate: it converts a
 * diagnosable defect into a guess.
 *
 * COPIED, NOT MOVED, and failures here are swallowed. This runs on the way to
 * throwing an error that already says what is wrong; a preservation step that
 * threw would replace a useful failure with a confusing one.
 *
 * It also means Peter can WATCH a render the gate refused to card. "The checks
 * blocked it" and "nobody can see it" are different things, and only the first
 * one is intended.
 */
export function preserveFailedRender({ videoPath, qc, plan = null, dir = FAILED_RENDER_DIR, log = console.log }) {
  const kept = { dir, video: null, report: null, errors: [] };
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    kept.errors.push(`could not create ${dir}: ${err.message}`);
    log(`::warning::could not preserve the failed render — ${err.message}`);
    return kept;
  }

  try {
    if (videoPath && existsSync(videoPath)) {
      const dest = join(dir, "failed-render.mp4");
      copyFileSync(videoPath, dest);
      kept.video = dest;
      const mb = Math.round((statSync(dest).size / 1024 / 1024) * 10) / 10;
      log(`[QC] kept the failed render at ${dest} (${mb} MB) — it is downloadable from the run's artifacts`);
    } else {
      kept.errors.push("the render was already gone when the gate tried to keep it");
    }
  } catch (err) {
    kept.errors.push(`could not copy the render: ${err.message}`);
    log(`::warning::could not copy the failed render — ${err.message}`);
  }

  try {
    const dest = join(dir, "qc-report.json");
    writeFileSync(dest, JSON.stringify({
      failedAt: new Date().toISOString(),
      ok: qc?.ok ?? false,
      results: qc?.results ?? [],
      failures: qc?.failures ?? [],
      // The plan, so "what was this supposed to be" is answerable from the
      // evidence rather than by re-reading a log that has scrolled away.
      plan,
    }, null, 2));
    kept.report = dest;
  } catch (err) {
    kept.errors.push(`could not write the report: ${err.message}`);
  }

  return kept;
}

/** One block for the build report, so a pass is as legible as a failure. */
export function renderQcSummary(results) {
  return results
    .map((r) => {
      if (r.skipped) return `${r.name}: skipped (${r.skipped})`;
      if (r.ok) return `${r.name}: clean${r.stats ? ` — ${describeStats(r.name, r.stats)}` : ""}`;
      return `${r.name}: FAILED — ${r.failures.map((f) => f.reason).join("; ")}`;
    })
    .join("\n");
}

function describeStats(name, s) {
  if (name === "audio-levels") {
    return s.tightest
      ? `${s.measured} speech windows, tightest ${s.tightest.margin} dB at ${timestamp(s.tightest.at)} (floor ${s.marginRequired} dB)`
      : `${s.measured} speech windows`;
  }
  if (name === "motion") return `${s.duplicates}/${s.frames} duplicate frames, worst window ${Math.round((s.worstWindow?.ratio || 0) * 100)}%`;
  if (name === "join-clicks") return "no discontinuities";
  if (name === "overlay-text") return `${s.read}/${s.overlays} overlays read`;
  if (name === "duration") {
    return `${s.actualSeconds}s rendered against a ${s.plannedSeconds}s plan (${s.driftSeconds >= 0 ? "+" : ""}${s.driftSeconds}s, ${s.driftPct}%)`;
  }
  return JSON.stringify(s);
}

/** H:MM:SS.s — what you type into the scrubber to go and look. */
export function timestamp(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toFixed(1).padStart(4, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}
