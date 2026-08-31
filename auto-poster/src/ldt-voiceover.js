/**
 * ldt-voiceover.js — voiceover for LDT intake clips.
 *
 * Operator clips arrive as screen recordings of PRIMARY working: captions
 * burned into the video, no audio. This module reads the caption script and
 * voices it with the SAME ElevenLabs voice the realty pipeline uses
 * (generateTTS in voiceover.js — voice ID, model and settings are reused, not
 * duplicated), then muxes the read onto the clip.
 *
 * SCRIPT SOURCE, in order:
 *   1. A sidecar .txt with the clip's basename in the intake folder is the
 *      script, EXACTLY as written. A sidecar that exists but cannot be read is
 *      a loud fallback, never a silent switch to OCR — the operator named an
 *      exact script and OCR would read something else.
 *   2. Otherwise the burned-in captions are OCR'd off sampled frames
 *      (tesseract, the same tooling as the realty caption gate). Lines are
 *      deduped consecutively, text that persists across most frames is
 *      dropped as UI chrome (these are screen recordings — the app's own
 *      interface text is not the caption track), order is kept, and the
 *      extracted script is logged on the posted-log entry so a human can
 *      check what was read. Nothing is ever invented: every spoken line was
 *      either typed by the operator or read off the operator's own frames.
 *
 * TIMING: cues with SRT-style timestamps (sidecar) or first-seen frame times
 * (OCR) place each line's audio at its caption's on-screen time. An untimed
 * sidecar is read straight through and fitted to the clip — tempo raised only
 * as needed, clamped to TEMPO_MAX so the read never garbles, then padded with
 * silence. The video is NEVER truncated and the script is NEVER cut short: a
 * read that cannot fit inside the clip at TEMPO_MAX is a fallback, not a
 * trim.
 *
 * SKIPS AND FALLBACKS — the doctrine is fail-toward-the-silent-clip:
 *   - "-novo" in the filename skips the voiceover on purpose.
 *   - A clip with an audible audio track keeps it (a silent track — screen
 *     recorders add one — counts as no audio and is replaced). When the audio
 *     cannot be measured the clip is assumed audible: paving over a person is
 *     the incident class this repo already paid for (source-respect.js), so
 *     every indeterminate reading degrades to posting the clip as-is.
 *   - Any failure past that point (no script, TTS error, unfittable read,
 *     mux error, output that measures wrong) logs loudly, stamps its reason
 *     on the entry, and posts the ORIGINAL silent clip. A broken voiceover
 *     must never cost the slot.
 *
 * OUTPUT: vertical 1080x1920 for FB/IG/TikTok. A clip already at 1080x1920
 * keeps `-c:v copy` — zero video re-encode, burned captions and hook overlay
 * pixel-identical; anything else is scaled/padded once. The muxed file is
 * measured before it is trusted (self-QC doctrine: the pipeline watches its
 * own render).
 *
 * Every ffmpeg/ffprobe/tesseract touchpoint takes injectable runners (the
 * source-respect.js / yt-artifact-qc.js DI shape) so tests never need the
 * real binaries or the ElevenLabs API.
 */

import { execFileSync, spawnSync } from "child_process";
import { existsSync, statSync, unlinkSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { generateTTS } from "./voiceover.js";
import { TEMPO_MAX } from "./voiceover-style.js";
import { ocrAvailable, ocrNormaliseTokens } from "./source-respect.js";
import { downloadFileById } from "./drive.js";

// ─── Filename flag ──────────────────────────────────────────────────────────

/**
 * "-novo" as a hyphenated token in the basename skips the voiceover on
 * purpose: "demo-novo.mp4", "walkthrough-novo-v2.mov". Matched against the
 * name with its extension stripped so ".mov" vs ".mp4" never matters, and as
 * a delimited token so a word merely containing "novo" ("renovation") can
 * never trip it.
 */
export function stripExtension(name) {
  return String(name || "").replace(/\.[^.]+$/, "");
}

export function hasNoVoFlag(fileName) {
  return /-novo(?=[-_. ]|$)/i.test(stripExtension(fileName));
}

// ─── Sidecar lookup ─────────────────────────────────────────────────────────

/** The sidecar script for "clip.mp4" is "clip.txt" — same basename, .txt. */
export function sidecarNameFor(clipName) {
  return `${stripExtension(clipName)}.txt`;
}

/**
 * Find the sidecar in the already-listed intake folder (no extra Drive
 * round-trip — the runner holds the full listing). Case-insensitive on the
 * whole name: Drive preserves case but operators type it.
 */
export function findSidecarFile(files, clipName) {
  const want = sidecarNameFor(clipName).toLowerCase();
  return (files || []).find(f => String(f.name || "").toLowerCase() === want) || null;
}

// ─── Script parsing ─────────────────────────────────────────────────────────

/**
 * "HH:MM:SS,mmm" / "MM:SS.mmm" / "MM:SS" → seconds, or null. Milliseconds are
 * OPTIONAL in both this parser and the arrow regex below, and deliberately in
 * both at once: operators hand-type "0:05 --> 0:08", and a regex that demands
 * ",000" would drop such a file into plain-script mode — where the timestamp
 * lines themselves get READ ALOUD in Peter's voice into a published post.
 */
export function parseSrtTime(s) {
  const m = String(s || "").trim().match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/);
  if (!m) return null;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  const ms = m[4] ? parseInt(m[4].padEnd(3, "0"), 10) : 0;
  return h * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + ms / 1000;
}

const SRT_ARROW_RE = /^((?:\d{1,2}:)?\d{1,2}:\d{1,2}(?:[.,]\d{1,3})?)\s*-->\s*(?:\d{1,2}:)?\d{1,2}:\d{1,2}(?:[.,]\d{1,3})?/;

/**
 * Parse a sidecar script.
 *
 * Returns { timed, cues: [{ text, startSec }] }.
 *
 * The file is SRT-style when any line carries a "start --> end" timestamp;
 * then each cue's text lines join into one spoken line placed at its start.
 * Anything else is a plain script: every non-empty line is a line of the
 * read, in order, untimed. The two modes are decided for the WHOLE file
 * first, so a plain script whose text happens to contain a bare number can
 * never lose that line to SRT index-stripping — dropping an operator's line
 * is the same sin as inventing one.
 */
export function parseScriptText(raw) {
  const text = String(raw || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const isSrt = lines.some(l => SRT_ARROW_RE.test(l.trim()));

  if (!isSrt) {
    const cues = lines.map(l => l.trim()).filter(Boolean)
      .map(t => ({ text: t, startSec: null }));
    return { timed: false, cues };
  }

  const cues = [];
  let current = null;
  const close = () => {
    if (current && current.parts.length) {
      cues.push({ text: current.parts.join(" "), startSec: current.startSec });
    }
    current = null;
  };
  for (const line of lines) {
    const t = line.trim();
    const arrow = t.match(SRT_ARROW_RE);
    if (arrow) {
      close();
      current = { startSec: parseSrtTime(arrow[1]), parts: [] };
      continue;
    }
    if (!t) { close(); continue; }
    if (/^\d+$/.test(t) && !current) continue; // SRT cue index
    if (current) current.parts.push(t);
  }
  close();

  // A malformed timestamp poisons the whole timed plan; read straight through
  // instead of guessing where a line belongs.
  const timed = cues.length > 0 && cues.every(c => Number.isFinite(c.startSec));
  return { timed, cues };
}

// ─── OCR extraction ─────────────────────────────────────────────────────────

/** Sample every ~2s: a caption that lives less than that isn't readable anyway. */
export const OCR_FRAME_INTERVAL_SEC = 2;

/**
 * A line on at least this fraction of the sampled frames is persistent UI
 * chrome (window titles, buttons, watermarks — these are screen recordings),
 * not a caption. Captions change; chrome stays.
 */
export const STATIC_LINE_FRACTION = 0.6;

/**
 * The frame-fraction test alone misfires on SHORT clips: a 6s clip samples 3
 * frames, and a real caption held for the whole clip rides all of them — the
 * fraction says "chrome" and the whole script would be dropped. So chrome
 * additionally has to persist this many SECONDS of wall time. The trade-off
 * runs the safe direction: on a sub-~11s clip genuine chrome gets voiced (and
 * the logged voiceover_script shows it), rather than a genuine caption
 * silently vanishing — dropping a line is the same sin as inventing one.
 */
export const CHROME_MIN_DWELL_SEC = 10;

export function ocrSampleTimestamps(durationSec, intervalSec = OCR_FRAME_INTERVAL_SEC) {
  const dur = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 30;
  const stamps = [];
  for (let at = Math.min(0.5, dur / 4); at < dur - 0.2; at += intervalSec) {
    stamps.push(+at.toFixed(2));
  }
  return stamps.length >= 2 ? stamps : [+(dur * 0.25).toFixed(2), +(dur * 0.75).toFixed(2)];
}

/**
 * Parse tesseract TSV output into visual lines plus a mean word confidence.
 * TSV instead of plain stdout because the spec for this lane is that the OCR
 * confidence is LOGGED — a human deciding whether to trust the read needs a
 * number, and plain `tesseract stdout` doesn't carry one.
 */
export function parseTesseractTsv(tsv) {
  const byLine = new Map();
  const confs = [];
  for (const row of String(tsv || "").split("\n").slice(1)) {
    const cols = row.split("\t");
    if (cols.length < 12 || cols[0] !== "5") continue; // level 5 = word
    const word = (cols[11] || "").trim();
    if (!word) continue;
    const key = `${cols[2]}|${cols[3]}|${cols[4]}`; // block|paragraph|line
    if (!byLine.has(key)) byLine.set(key, []);
    byLine.get(key).push(word);
    const conf = parseFloat(cols[10]);
    if (Number.isFinite(conf) && conf >= 0) confs.push(conf);
  }
  return {
    lines: [...byLine.values()].map(ws => ws.join(" ")),
    meanConf: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null,
  };
}

function defaultFrameOcr(pngPath, run = spawnSync) {
  const res = run("tesseract", [pngPath, "stdout", "--psm", "6", "tsv"], {
    encoding: "utf-8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (res.error || res.status !== 0) return null;
  return parseTesseractTsv(res.stdout);
}

function defaultExtract(args) {
  execFileSync("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"], timeout: 30000 });
}

/**
 * Token containment: how much of the SMALLER reading appears in the larger.
 * The clustering question is "is this the same caption?", and the same
 * caption shows up as a partial read one frame and a fuller read the next —
 * fully contained, containment 1.0 — while two DIFFERENT captions sharing
 * scaffold words ("watch this…", "…right here") stay under the line. Jaccard
 * (source-respect's measure) scores those two cases identically, which is
 * why this module measures containment instead: merging two different
 * captions DROPS a line the operator wrote, and dropping a line is the same
 * sin as inventing one.
 */
export function containmentSimilarity(aTokens, bTokens) {
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  if (a.size === 0 || b.size === 0) return a.size === b.size ? 1 : 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / Math.min(a.size, b.size);
}

/**
 * Turn per-frame OCR reads into ordered caption cues.
 *
 * `frameReads` is [{ atSec, lines, meanConf }] in time order. Lines cluster
 * consecutively — a line joins a cluster only while that cluster is still on
 * screen (last seen within `windowSec`), so one caption held across many
 * frames is ONE cue, while the same words returning much later would be read
 * again. Clusters on ≥ STATIC_LINE_FRACTION of all sampled frames are chrome
 * and are dropped. Survivors keep first-appearance order; lines first seen on
 * the same frame merge into one cue (a caption wrapped across two visual
 * lines is one spoken line); and adjacent near-identical cues dedupe.
 */
export function extractCaptionCues(frameReads, totalFrames, opts = {}) {
  const {
    simThreshold = 0.75,
    staticFraction = STATIC_LINE_FRACTION,
    windowSec = 2.5 * OCR_FRAME_INTERVAL_SEC,
    chromeDwellSec = CHROME_MIN_DWELL_SEC,
  } = opts;

  const clusters = [];
  let framesWithText = 0;
  for (const frame of frameReads || []) {
    let sawText = false;
    for (const raw of frame.lines || []) {
      const tokens = ocrNormaliseTokens(raw);
      if (tokens.length < 2) continue; // OCR noise, not text
      sawText = true;
      const match = clusters.find(c =>
        frame.atSec - c.lastAt <= windowSec && containmentSimilarity(tokens, c.tokens) >= simThreshold);
      if (match) {
        match.lastAt = frame.atSec;
        match.frames++;
        // Keep the longest reading of the cluster — the most complete OCR pass.
        if (raw.trim().length > match.text.length) { match.text = raw.trim(); match.tokens = tokens; }
      } else {
        clusters.push({ text: raw.trim(), tokens, firstAt: frame.atSec, lastAt: frame.atSec, frames: 1 });
      }
    }
    if (sawText) framesWithText++;
  }

  const staticMin = Math.max(3, Math.ceil((totalFrames || frameReads.length || 1) * staticFraction));
  // Chrome must clear BOTH bars: on most frames AND on screen for a long
  // stretch of wall time. See CHROME_MIN_DWELL_SEC for why fraction alone
  // eats the whole script of a short clip.
  const kept = clusters
    .filter(c => c.frames < staticMin || c.lastAt - c.firstAt < chromeDwellSec)
    .sort((a, b) => a.firstAt - b.firstAt);
  const staticDropped = clusters.length - kept.length;

  const cues = [];
  for (const c of kept) {
    const prev = cues[cues.length - 1];
    if (prev && prev.startSec === +c.firstAt.toFixed(2)) {
      prev.text = `${prev.text} ${c.text}`;
      continue;
    }
    if (prev && containmentSimilarity(ocrNormaliseTokens(prev.text), c.tokens) >= simThreshold) continue;
    cues.push({ text: c.text, startSec: +c.firstAt.toFixed(2) });
  }
  return { cues, staticDropped, framesWithText };
}

/**
 * OCR the burned-in captions off sampled frames.
 *
 * Returns { ok, cues, ocrStats } or { ok:false, reason, ocrStats? }. Cues are
 * timed by first appearance — the caption's on-screen time is when its line
 * should be spoken. When tesseract is missing the answer is "cannot read",
 * never an empty script: a check that cannot run is not a check that passed.
 */
export function extractScriptViaOcr(videoPath, opts = {}) {
  const {
    run = spawnSync,
    ocr = defaultFrameOcr,
    extract = defaultExtract,
    durationSec = null,
    intervalSec = OCR_FRAME_INTERVAL_SEC,
    workDir = tmpdir(),
  } = opts;

  if (!ocrAvailable(run)) {
    return { ok: false, reason: "ocr_unavailable", say: "tesseract is not installed — the burned captions cannot be read" };
  }

  const dur = durationSec ?? probeMediaDurationSec(videoPath, { run }) ?? 30;
  const stamps = ocrSampleTimestamps(dur, intervalSec);
  const frameReads = [];
  for (let i = 0; i < stamps.length; i++) {
    const png = join(workDir, `ldt-vo-ocr-${Date.now()}-${String(i).padStart(3, "0")}.png`);
    try {
      // -ss BEFORE -i: output-side seeks leave time-dependent filters on the
      // source clock (the trap that once silenced whole takes).
      extract(["-y", "-v", "error", "-ss", String(stamps[i]), "-i", videoPath, "-frames:v", "1", "-q:v", "2", png]);
      const read = ocr(png, run);
      if (read) frameReads.push({ atSec: stamps[i], ...read });
    } catch {
      // An unreadable frame is a frame with no evidence either way.
    } finally {
      rmSync(png, { force: true });
    }
  }

  const { cues, staticDropped, framesWithText } = extractCaptionCues(frameReads, stamps.length, { windowSec: 2.5 * intervalSec });
  const confs = frameReads.map(f => f.meanConf).filter(Number.isFinite);
  const ocrStats = {
    frames_sampled: stamps.length,
    frames_with_text: framesWithText,
    mean_confidence: confs.length ? +(confs.reduce((a, b) => a + b, 0) / confs.length).toFixed(1) : null,
    static_lines_dropped: staticDropped,
  };
  if (cues.length === 0) {
    return { ok: false, reason: "no_captions_read", ocrStats };
  }
  return { ok: true, cues, ocrStats };
}

// ─── Probes ─────────────────────────────────────────────────────────────────

export function probeMediaDurationSec(path, { run = spawnSync } = {}) {
  const res = run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
    { encoding: "utf-8", timeout: 30000 });
  if (res.error || res.status !== 0) return null;
  const d = parseFloat(String(res.stdout || "").trim());
  return Number.isFinite(d) && d > 0 ? d : null;
}

export function probeDimensions(path, { run = spawnSync } = {}) {
  const res = run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=s=x:p=0", path],
    { encoding: "utf-8", timeout: 30000 });
  if (res.error || res.status !== 0) return null;
  const m = String(res.stdout || "").trim().match(/^(\d+)x(\d+)/);
  return m ? { width: parseInt(m[1], 10), height: parseInt(m[2], 10) } : null;
}

export function probeAudioStream(path, { run = spawnSync } = {}) {
  const res = run("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_type", "-of", "csv=p=0", path],
    { encoding: "utf-8", timeout: 30000 });
  if (res.error || res.status !== 0) return null; // indeterminate
  return String(res.stdout || "").includes("audio");
}

export function meanVolumeDb(path, { run = spawnSync } = {}) {
  const res = run("ffmpeg", ["-i", path, "-af", "volumedetect", "-f", "null", "-"],
    { encoding: "utf-8", timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  const m = `${res.stdout || ""}\n${res.stderr || ""}`.match(/mean_volume:\s*([-\d.]+)\s*dB/);
  return m ? parseFloat(m[1]) : null;
}

/**
 * A track whose mean volume sits at or under this is a screen recorder's
 * silent placeholder, not audio anyone recorded. Deliberately far below the
 * realty speech bar (-35dB): the failure that must never happen is paving
 * over something audible, so only near-digital silence counts as "no audio".
 */
export const SILENT_TRACK_MEAN_DB = -50;

/**
 * Classify the clip's existing audio: "no_track" | "silent_track" |
 * "audible" | "indeterminate". Indeterminate readings are the caller's cue
 * to skip the voiceover — assuming audible is the direction that can't pave
 * over a person.
 */
export function classifyExistingAudio(videoPath, { run = spawnSync } = {}) {
  const hasTrack = probeAudioStream(videoPath, { run });
  if (hasTrack === null) return { verdict: "indeterminate", meanDb: null };
  if (!hasTrack) return { verdict: "no_track", meanDb: null };
  const meanDb = meanVolumeDb(videoPath, { run });
  if (meanDb === null) return { verdict: "indeterminate", meanDb: null };
  return meanDb > SILENT_TRACK_MEAN_DB
    ? { verdict: "audible", meanDb }
    : { verdict: "silent_track", meanDb };
}

// ─── Fit math ───────────────────────────────────────────────────────────────

/**
 * Fit an untimed straight-through read into the clip. Tempo rises only as
 * needed (a read that fits plays at 1.0x — natural), clamped to TEMPO_MAX;
 * past that the read does not fit and the caller falls back, because neither
 * the video nor the script may be truncated. The 1% margin absorbs atempo's
 * resampling drift.
 */
export function untimedFit(audioSec, videoSec) {
  if (!Number.isFinite(audioSec) || audioSec <= 0 || !Number.isFinite(videoSec) || videoSec <= 0) {
    return { fits: false, tempo: 1, reason: "unmeasurable duration" };
  }
  const needed = audioSec / videoSec;
  if (needed <= 1) return { fits: true, tempo: 1 };
  if (needed > TEMPO_MAX) {
    return { fits: false, tempo: TEMPO_MAX, reason: `read needs ${needed.toFixed(2)}x to fit but max is ${TEMPO_MAX}x` };
  }
  return { fits: true, tempo: Math.min(TEMPO_MAX, +(needed * 1.01).toFixed(3)) };
}

/**
 * Give every timed cue its slot: from its start to the next cue's start (the
 * last runs to the video end). A cue at or past the video end means the
 * timestamps don't describe this video — refuse the whole plan rather than
 * guess.
 */
export function timedPlacementPlan(cues, videoSec) {
  if (!cues?.length) return { ok: false, reason: "no cues" };
  const sorted = [...cues].sort((a, b) => a.startSec - b.startSec);
  const late = sorted.find(c => c.startSec >= videoSec - 0.25);
  if (late) {
    return { ok: false, reason: `cue at ${late.startSec}s is at/past the video end (${videoSec.toFixed(1)}s)` };
  }
  const lines = sorted.map((c, i) => ({
    text: c.text,
    startSec: c.startSec,
    slotSec: +(((i + 1 < sorted.length ? sorted[i + 1].startSec : videoSec) - c.startSec)).toFixed(3),
  }));
  return { ok: true, lines };
}

/**
 * Tempo for one timed line. Prefers fitting its slot; a line that cannot fit
 * its slot even at TEMPO_MAX overlaps the next line's start (mild and
 * audible-natural) — but a line that cannot finish before the VIDEO ends is
 * a hard no (`fitsVideo: false`), because the tail would be cut and the
 * script is never truncated.
 */
export function fitLineTempo(audioSec, line, videoSec) {
  const slotNeeded = line.slotSec > 0 ? audioSec / line.slotSec : Infinity;
  const tempo = Math.min(TEMPO_MAX, Math.max(1, +slotNeeded.toFixed(3)));
  const effective = audioSec / tempo;
  return {
    tempo,
    effectiveSec: +effective.toFixed(3),
    overlapsNext: effective > line.slotSec + 1e-6,
    fitsVideo: line.startSec + effective <= videoSec + 0.05,
  };
}

// ─── Mux ────────────────────────────────────────────────────────────────────

export const TARGET_WIDTH = 1080;
export const TARGET_HEIGHT = 1920;

const SCALE_PAD = `scale=${TARGET_WIDTH}:${TARGET_HEIGHT}:force_original_aspect_ratio=decrease,` +
  `pad=${TARGET_WIDTH}:${TARGET_HEIGHT}:(ow-iw)/2:(oh-ih)/2,setsar=1`;

function videoMapArgs(needsScale, filterParts, videoLabelOut) {
  // With -c:v copy the burned captions and hook overlay stay pixel-identical;
  // the re-encode path exists only to honor the 1080x1920 output contract.
  if (!needsScale) return { map: ["-map", "0:v", "-c:v", "copy"], filter: null };
  filterParts.push(`[0:v]${SCALE_PAD}[${videoLabelOut}]`);
  return { map: ["-map", `[${videoLabelOut}]`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p"], filter: true };
}

/** ffmpeg args for the straight-through read: optional atempo, silence-pad to the video. */
export function buildUntimedMuxArgs(videoPath, audioPath, outPath, { videoSec, tempo = 1, needsScale = false }) {
  const filters = [];
  const chain = [];
  if (tempo > 1.005) chain.push(`atempo=${tempo}`);
  chain.push(`apad=whole_dur=${videoSec}`);
  filters.push(`[1:a]${chain.join(",")}[a]`);
  const v = videoMapArgs(needsScale, filters, "v");
  return [
    "-y", "-i", videoPath, "-i", audioPath,
    "-filter_complex", filters.join(";"),
    ...v.map, "-map", "[a]",
    "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart",
    outPath,
  ];
}

/**
 * ffmpeg args for the timed read: each line tempo-fitted and delayed to its
 * caption's on-screen time, mixed at full volume (normalize=0 — amix's
 * default divides by input count), padded to the video.
 */
export function buildTimedMuxArgs(videoPath, lines, outPath, { videoSec, needsScale = false }) {
  const filters = [];
  const labels = [];
  lines.forEach((l, i) => {
    const chain = [];
    if (l.tempo > 1.005) chain.push(`atempo=${l.tempo}`);
    chain.push(`adelay=${Math.round(l.startSec * 1000)}:all=1`);
    filters.push(`[${i + 1}:a]${chain.join(",")}[l${i}]`);
    labels.push(`[l${i}]`);
  });
  filters.push(lines.length > 1
    ? `${labels.join("")}amix=inputs=${lines.length}:normalize=0,apad=whole_dur=${videoSec}[a]`
    : `${labels[0]}apad=whole_dur=${videoSec}[a]`);
  const v = videoMapArgs(needsScale, filters, "v");
  return [
    "-y", "-i", videoPath,
    ...lines.flatMap(l => ["-i", l.audioPath]),
    "-filter_complex", filters.join(";"),
    ...v.map, "-map", "[a]",
    "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart",
    outPath,
  ];
}

function defaultExec(args, timeoutMs = 15 * 60_000) {
  execFileSync("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"], timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
}

async function defaultDownloadText(file) {
  const buf = await downloadFileById(file.id);
  return buf.toString("utf-8");
}

function cleanupPaths(...paths) {
  for (const p of paths) {
    try { if (p && existsSync(p)) unlinkSync(p); } catch { /* best effort */ }
  }
}

// ─── Orchestrator ───────────────────────────────────────────────────────────

/**
 * Add the voiceover to one intake clip.
 *
 * Returns { videoPath, applied, entryFields } and NEVER throws: every skip
 * and every failure comes back as the ORIGINAL path with `entryFields`
 * saying, in posted-log vocabulary, what happened and why. All values in
 * entryFields are non-null — recordPost's pass-through silently drops nulls,
 * and a reason that doesn't persist is a reason nobody can act on.
 *
 * opts: clipName, files (the intake folder listing, for the sidecar),
 * dryRun, plus injectable seams — downloadText, tts, run, ocr, extract,
 * exec, workDir — all defaulting to the real implementations.
 */
export async function applyLdtVoiceover(videoPath, opts = {}) {
  const {
    clipName = "",
    files = [],
    dryRun = false,
    downloadText = defaultDownloadText,
    tts = generateTTS,
    run = spawnSync,
    ocr = undefined,
    extract = undefined,
    exec = defaultExec,
    workDir = tmpdir(),
  } = opts;

  const skip = (reason, extra = {}) => {
    console.log(`[LDT VO] Skipped: ${reason}`);
    return { videoPath, applied: false, entryFields: { voiceover: false, voiceover_reason: reason, ...extra } };
  };
  const fallback = (reason, extra = {}) => {
    console.warn(`::warning::[LDT VO] Voiceover failed (${reason}) — posting the silent clip rather than losing the slot`);
    return { videoPath, applied: false, entryFields: { voiceover: false, voiceover_reason: `fallback:${reason}`, ...extra } };
  };

  const temps = [];
  try {
    // ── Deliberate skips ─────────────────────────────────────────────────
    if (hasNoVoFlag(clipName)) return skip("novo_flag");

    const audio = classifyExistingAudio(videoPath, { run });
    if (audio.verdict === "audible") {
      return skip("existing_audio", { voiceover_existing_audio_db: audio.meanDb });
    }
    if (audio.verdict === "indeterminate") {
      return skip("existing_audio_indeterminate");
    }

    const videoSec = probeMediaDurationSec(videoPath, { run });
    if (!videoSec) return fallback("video_duration_unreadable");

    // ── Script source ────────────────────────────────────────────────────
    let parsed;
    let source;
    let ocrStats = null;
    const sidecar = findSidecarFile(files, clipName);
    if (sidecar) {
      let text;
      try {
        text = await downloadText(sidecar);
      } catch (err) {
        // The operator named an exact script; reading something else off the
        // frames instead would not be that script. Fall back, loudly.
        return fallback(`sidecar_download_failed: ${err.message?.slice(0, 120)}`);
      }
      parsed = parseScriptText(text);
      if (!parsed.cues.length) return fallback("sidecar_empty");
      source = "sidecar";
      console.log(`[LDT VO] Script from sidecar ${sidecar.name} (${parsed.cues.length} line${parsed.cues.length === 1 ? "" : "s"}, ${parsed.timed ? "timed" : "untimed"})`);
    } else {
      const read = extractScriptViaOcr(videoPath, { run, ocr, extract, durationSec: videoSec, workDir });
      ocrStats = read.ocrStats || null;
      if (!read.ok) return fallback(`ocr:${read.reason}`, ocrEntryFields(ocrStats));
      parsed = { timed: true, cues: read.cues };
      source = "ocr";
      console.log(`[LDT VO] Script OCR'd off ${read.ocrStats.frames_with_text}/${read.ocrStats.frames_sampled} frames (mean confidence ${read.ocrStats.mean_confidence ?? "n/a"}, ${read.cues.length} lines):`);
      for (const c of read.cues) console.log(`  [${c.startSec}s] ${c.text}`);
    }

    const script = parsed.cues.map(c => c.text).join(" ");
    const scriptFields = {
      voiceover_source: source,
      voiceover_script: script,
      voiceover_timed: parsed.timed,
      ...ocrEntryFields(ocrStats),
    };

    if (dryRun) {
      console.log(`[LDT VO] DRY RUN — would voice (${source}): "${script.slice(0, 160)}${script.length > 160 ? "…" : ""}"`);
      return { videoPath, applied: false, entryFields: { voiceover: false, voiceover_reason: "dry_run", ...scriptFields } };
    }

    // ── TTS + fit + mux ──────────────────────────────────────────────────
    const dims = probeDimensions(videoPath, { run });
    const needsScale = !!dims && !(dims.width === TARGET_WIDTH && dims.height === TARGET_HEIGHT);
    const outPath = join(workDir, `ldt_vo_${Date.now()}.mp4`);
    let qcFields;

    if (parsed.timed) {
      const plan = timedPlacementPlan(parsed.cues, videoSec);
      if (!plan.ok) return fallback(`timing:${plan.reason}`, scriptFields);

      const lines = [];
      const ends = [];
      let maxTempo = 1;
      let lastEnd = 0;
      for (const line of plan.lines) {
        let audioPath;
        try {
          audioPath = await tts(line.text);
        } catch (err) {
          cleanupPaths(...temps);
          return fallback(`tts_failed: ${err.message?.slice(0, 120)}`, scriptFields);
        }
        temps.push(audioPath);
        const lineSec = probeMediaDurationSec(audioPath, { run });
        if (!lineSec) { cleanupPaths(...temps); return fallback("tts_audio_unreadable", scriptFields); }
        const fit = fitLineTempo(lineSec, line, videoSec);
        if (!fit.fitsVideo) {
          cleanupPaths(...temps);
          return fallback(`timing:line at ${line.startSec}s needs ${(lineSec / fit.tempo).toFixed(1)}s but the video ends at ${videoSec.toFixed(1)}s`, scriptFields);
        }
        if (fit.overlapsNext) {
          console.warn(`::warning::[LDT VO] Line at ${line.startSec}s overruns its caption slot even at ${fit.tempo}x — it will overlap the next line's start`);
        }
        lines.push({ audioPath, startSec: line.startSec, tempo: fit.tempo });
        ends.push(line.startSec + fit.effectiveSec);
        maxTempo = Math.max(maxTempo, fit.tempo);
        lastEnd = Math.max(lastEnd, line.startSec + fit.effectiveSec);
      }

      // Overlapping the NEXT line's start is a mild, natural spill (warned
      // above); audio still playing when the line AFTER NEXT begins means
      // three copies of the same voice stacked — captions too dense to voice.
      const stacked = plan.lines.findIndex((l, i) =>
        i + 2 < plan.lines.length && ends[i] > plan.lines[i + 2].startSec + 1e-6);
      if (stacked !== -1) {
        cleanupPaths(...temps);
        return fallback(`timing:line at ${plan.lines[stacked].startSec}s would still be playing two captions later — captions too dense to voice`, scriptFields);
      }

      try {
        exec(buildTimedMuxArgs(videoPath, lines, outPath, { videoSec, needsScale }));
      } catch (err) {
        cleanupPaths(...temps, outPath);
        return fallback(`mux_failed: ${err.message?.slice(0, 120)}`, scriptFields);
      }
      qcFields = { voiceover_audio_sec: +lastEnd.toFixed(2), voiceover_tempo: maxTempo, voiceover_lines: lines.length };
    } else {
      let audioPath;
      try {
        audioPath = await tts(script);
      } catch (err) {
        return fallback(`tts_failed: ${err.message?.slice(0, 120)}`, scriptFields);
      }
      temps.push(audioPath);
      const audioSec = probeMediaDurationSec(audioPath, { run });
      if (!audioSec) { cleanupPaths(...temps); return fallback("tts_audio_unreadable", scriptFields); }
      const fit = untimedFit(audioSec, videoSec);
      if (!fit.fits) {
        cleanupPaths(...temps);
        return fallback(`unfittable:${fit.reason}`, scriptFields);
      }
      try {
        exec(buildUntimedMuxArgs(videoPath, audioPath, outPath, { videoSec, tempo: fit.tempo, needsScale }));
      } catch (err) {
        cleanupPaths(...temps, outPath);
        return fallback(`mux_failed: ${err.message?.slice(0, 120)}`, scriptFields);
      }
      qcFields = { voiceover_audio_sec: +audioSec.toFixed(2), voiceover_tempo: fit.tempo, voiceover_lines: parsed.cues.length };
    }

    // ── Self-QC: measure the render before trusting it ───────────────────
    if (!existsSync(outPath) || statSync(outPath).size < 10240) {
      cleanupPaths(...temps, outPath);
      return fallback("mux_output_missing_or_tiny", { ...scriptFields, ...qcFields });
    }
    const outSec = probeMediaDurationSec(outPath, { run });
    if (!outSec || Math.abs(outSec - videoSec) > Math.max(1, videoSec * 0.02)) {
      cleanupPaths(...temps, outPath);
      return fallback(`mux_output_duration_off: ${outSec ?? "unreadable"}s vs video ${videoSec.toFixed(1)}s`, { ...scriptFields, ...qcFields });
    }
    // Measured, not assumed: this also catches the fail-open where the INPUT
    // dims probe errored (needsScale=false → copy) on a landscape recording —
    // the render must actually be 1080x1920, or the silent original posts.
    const outDims = probeDimensions(outPath, { run });
    if (!outDims || outDims.width !== TARGET_WIDTH || outDims.height !== TARGET_HEIGHT) {
      cleanupPaths(...temps, outPath);
      return fallback(`mux_output_dims_off: ${outDims ? `${outDims.width}x${outDims.height}` : "unreadable"} vs ${TARGET_WIDTH}x${TARGET_HEIGHT}`, { ...scriptFields, ...qcFields });
    }

    cleanupPaths(...temps);
    console.log(`[LDT VO] ✓ Voiceover applied (${source}, ${qcFields.voiceover_lines} lines, audio ${qcFields.voiceover_audio_sec}s in video ${videoSec.toFixed(1)}s, tempo ${qcFields.voiceover_tempo}x${needsScale ? `, rescaled to ${TARGET_WIDTH}x${TARGET_HEIGHT}` : ", video stream copied"})`);
    return {
      videoPath: outPath,
      applied: true,
      entryFields: {
        voiceover: true,
        voiceover_reason: `${source}_voiceover`,
        ...scriptFields,
        ...qcFields,
        voiceover_video_sec: +videoSec.toFixed(2),
        voiceover_output_sec: +outSec.toFixed(2),
        voiceover_rescaled: needsScale,
      },
    };
  } catch (err) {
    // The doctrine, enforced last: no voiceover failure may cost the slot.
    cleanupPaths(...temps);
    return fallback(`vo_error: ${err.message?.slice(0, 160)}`);
  }
}

/** OCR stats → entry fields, nulls dropped (recordPost skips nulls anyway). */
function ocrEntryFields(ocrStats) {
  if (!ocrStats) return {};
  const out = {
    voiceover_ocr_frames_sampled: ocrStats.frames_sampled,
    voiceover_ocr_frames_with_text: ocrStats.frames_with_text,
    voiceover_ocr_static_dropped: ocrStats.static_lines_dropped,
  };
  if (Number.isFinite(ocrStats.mean_confidence)) out.voiceover_ocr_confidence = ocrStats.mean_confidence;
  return out;
}
