/**
 * yt-oncamera-edit.js — cutting the dead air out, and hiding the seams.
 *
 * THE INSIGHT THIS FILE IS BUILT ON: jump cuts and punch-ins are the same
 * problem. Both slice one recorded take into pieces. Removing a breath leaves a
 * seam where the picture jumps; changing the framing at that exact frame turns
 * the seam into an edit. Do them in two passes and the cuts land in arbitrary
 * places and read as glitches; do them from ONE edit list and every removed
 * pause is covered by a framing change for free.
 *
 * So this module produces a single list of pieces:
 *
 *   [{ srcStart, srcEnd, scale }, ...]
 *
 * `srcStart/srcEnd` skip the silence — that is the jump cut. `scale` alternates
 * between a wide and a tight framing at every boundary — that is the punch-in.
 * The renderer trims, scales, crops and concatenates. Nothing else needs to
 * know that either feature exists.
 *
 * WHY NOT AN ANIMATED ZOOM FOR THE PUNCH-IN
 * Because a two-camera edit is what this is imitating, and a two-camera edit
 * cuts. An animated push between framings reads as a slideshow effect; an
 * instant change of framing on a cut reads as a second camera. The only
 * animated move in the whole file is the opening push-in, which is a different
 * device doing a different job.
 *
 * EVERYTHING HERE IS PURE except detectSilences, which has to ask ffmpeg. A
 * wrong cut point produces a video that clips his words, and that is a thing
 * you want to argue with in a test rather than by watching a twelve-minute
 * render.
 */

import { spawnSync } from "child_process";
import { ONCAM_TREATMENT, ONCAM_BG_BLUR, ONCAM_BG_DARKEN, ONCAM_BG_ZOOM, ONCAM_VIGNETTE } from "./yt-config.js";

/** Silence shorter than this is breath and rhythm — cutting it sounds clipped. */
export const MIN_SILENCE_SECONDS = 0.4;

/** How much silence is left behind, so speech does not butt straight together. */
export const KEEP_SILENCE_SECONDS = 0.15;

/** Below this, ffmpeg calls it silence. Room tone on a phone sits well under. */
export const SILENCE_DB = -35;

/** A take shorter than this gets no punch-ins — there is nothing to break up. */
export const PUNCH_MIN_TAKE_SECONDS = 8;

/** How often the framing changes when nothing else forces a boundary. */
export const PUNCH_INTERVAL_MIN = 7;
export const PUNCH_INTERVAL_MAX = 9;

/** The two framings. Wide is the recorded frame; tight is a crop into it. */
export const FRAMING_WIDE = 1.0;
export const FRAMING_TIGHT = 1.08;

/** The opening push. Slow enough to be felt rather than seen. */
export const PUSH_FROM = 1.0;
export const PUSH_TO = 1.08;
export const PUSH_SECONDS = 3.5;

/** A piece shorter than this is a flash frame, not a shot. */
export const MIN_PIECE_SECONDS = 0.45;

/**
 * The least of a take that may survive trimming before the trim is disbelieved.
 *
 * Removing two thirds of a take is not editing, it is a symptom: a dead mic, a
 * take that is mostly room tone, a threshold that is wrong for this recording.
 * Without this floor a 20-second take with one long pause came out as a single
 * 0.575-second piece — the whole take deleted, no error, no warning, and the
 * only sign would be a video that jumps.
 *
 * The narration budget (`minKeep`) catches this when a budget is known. This
 * catches it when one is not, which is every take the caller has not measured.
 */
export const MIN_RETAINED_SHARE = 0.35;

// ─── silence detection ──────────────────────────────────────────────────────

/**
 * Ask ffmpeg where the silence is.
 *
 * `silencedetect` writes its findings to stderr as log lines rather than
 * returning data, so this parses them. Returns [{ start, end }] in seconds.
 *
 * Not pure — it is the one place here that touches a file — so it is kept tiny
 * and the parsing is separated out, because the parsing is where the bugs are.
 */
export function detectSilences(path, { db = SILENCE_DB, minSeconds = MIN_SILENCE_SECONDS, duration = null } = {}) {
  // spawnSync, NOT execFileSync, and the difference is the whole function.
  // silencedetect writes its findings to STDERR, and execFileSync returns
  // stdout — so on a successful run it handed back an empty string and this
  // reported "no silence in this take". It failed exactly the way that costs
  // the most: no error, no warning, a plausible answer, and every pause left
  // in the finished video.
  const res = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-nostats", "-i", path, "-af", `silencedetect=noise=${db}dB:d=${minSeconds}`, "-f", "null", "-"],
    { encoding: "utf-8", timeout: 10 * 60_000, maxBuffer: 32 * 1024 * 1024 }
  );

  const log = `${res.stderr || ""}${res.stdout || ""}`;
  if (!log.trim()) {
    // No log at all means ffmpeg never ran, which is a different thing from a
    // take with no pauses in it and must not be reported as one.
    throw new Error(`silencedetect produced no output for ${path}${res.error ? ` — ${res.error.message}` : ""}`);
  }
  return parseSilenceLog(log, { duration });
}

/**
 * Parse silencedetect's log output.
 *
 * The log emits `silence_start: N` and later `silence_end: N | silence_duration: N`
 * as separate lines, and the FINAL silence may have a start with no end when
 * the file ends mid-silence. That unterminated case is the one worth handling
 * deliberately: dropping it leaves a trailing pause in every take that fades
 * out, which is most of them.
 */
export function parseSilenceLog(log, { duration = null } = {}) {
  const out = [];
  let open = null;
  for (const line of String(log).split(/\r?\n/)) {
    const start = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (start) {
      open = Math.max(0, parseFloat(start[1]));
      continue;
    }
    const end = /silence_end:\s*(-?[\d.]+)/.exec(line);
    if (end && open !== null) {
      const e = parseFloat(end[1]);
      if (e > open) out.push({ start: open, end: e });
      open = null;
    }
  }
  if (open !== null && duration !== null && duration > open) out.push({ start: open, end: duration });
  return out;
}

// ─── the edit list ──────────────────────────────────────────────────────────

/**
 * Turn a take plus its silences into the pieces that will be rendered.
 *
 * @param {number} duration      the recorded take's length
 * @param {Array}  silences      [{start,end}] from detectSilences
 * @param {object} opts
 * @param {boolean} opts.isOpening   the opening take gets the push instead of punch-ins
 * @param {number}  opts.minKeep     narration floor — see below
 * @returns {{ pieces, removedSeconds, originalSeconds, editedSeconds, warnings }}
 */
export function buildEditList(duration, silences = [], { isOpening = false, minKeep = 0, seed = 0, punchIns = true } = {}) {
  const warnings = [];
  const total = Math.max(0, Number(duration) || 0);
  if (total <= 0) return { pieces: [], removedSeconds: 0, originalSeconds: 0, editedSeconds: 0, warnings: ["take has no duration"] };

  // ── 1. speech spans: what is left once the silences are taken out ────────
  const trimmed = normaliseSilences(silences, total);
  let spans = [];
  let cursor = 0;
  for (const s of trimmed) {
    // KEEP_SILENCE_SECONDS of the pause is retained, split either side, so the
    // result breathes. Cutting flush makes him sound like he is being rushed.
    const keepHead = Math.min(KEEP_SILENCE_SECONDS / 2, (s.end - s.start) / 2);
    const spanEnd = Math.min(total, s.start + keepHead);
    if (spanEnd > cursor) spans.push({ start: cursor, end: spanEnd });
    cursor = Math.max(cursor, Math.min(total, s.end - keepHead));
  }
  if (cursor < total) spans.push({ start: cursor, end: total });

  // A take that is nearly all silence leaves nothing usable. Better to keep it
  // whole and let a human notice than to ship four disconnected syllables.
  spans = spans.filter((s) => s.end - s.start >= MIN_PIECE_SECONDS);
  let editedSeconds = spans.reduce((n, s) => n + (s.end - s.start), 0);

  // Checking only for ZERO surviving spans was not enough, and the gap was
  // wide: a 20-second take with one 19-second pause left a single 0.575s span,
  // which cleared the per-piece minimum, so the fallback never fired and the
  // take was silently deleted down to half a second. The share of the take that
  // survives is the honest test, not the count of pieces.
  if (spans.length === 0 || editedSeconds < total * MIN_RETAINED_SHARE) {
    warnings.push(
      spans.length === 0
        ? "every span was shorter than a shot after trimming — keeping the take uncut"
        : `trimming would keep only ${round(editedSeconds)}s of ${round(total)}s — that is a bad recording, not a bad pause. Keeping the take uncut`
    );
    spans = [{ start: 0, end: total }];
    editedSeconds = total;
  }

  // ── 2. the narration floor ───────────────────────────────────────────────
  // Trimming is only allowed to remove dead air. If it has cut so much that the
  // picture can no longer cover the narration this take is supposed to carry,
  // the trim is wrong and the whole take is restored. A video missing a
  // sentence is worse than a video with a pause in it.
  if (minKeep > 0 && editedSeconds < minKeep) {
    warnings.push(
      `trimming would leave ${round(editedSeconds)}s against a ${round(minKeep)}s narration budget — restoring the take uncut`
    );
    spans = [{ start: 0, end: total }];
    editedSeconds = total;
  }

  // ── 3. framing ───────────────────────────────────────────────────────────
  const pieces = [];
  let framingIndex = seed;
  for (const span of spans) {
    // Every span boundary is already a cut, so the framing flips there — that
    // is what hides the removed pause.
    const sub = splitForPunchIns(span, { enabled: punchIns && !isOpening && total >= PUNCH_MIN_TAKE_SECONDS });
    for (const piece of sub) {
      pieces.push({
        srcStart: round(piece.start),
        srcEnd: round(piece.end),
        seconds: round(piece.end - piece.start),
        scale: isOpening ? PUSH_FROM : framingIndex % 2 === 0 ? FRAMING_WIDE : FRAMING_TIGHT,
        // The opening is the one animated move in the file.
        push: isOpening && pieces.length === 0 ? { from: PUSH_FROM, to: PUSH_TO, seconds: Math.min(PUSH_SECONDS, piece.end - piece.start) } : null,
      });
      framingIndex++;
    }
  }

  if (punchIns && !isOpening && total >= PUNCH_MIN_TAKE_SECONDS && pieces.length === 1) {
    warnings.push("take is long enough for a punch-in but produced a single piece");
  }

  return {
    pieces,
    originalSeconds: round(total),
    editedSeconds: round(editedSeconds),
    removedSeconds: round(total - editedSeconds),
    warnings,
  };
}

/**
 * Clamp, sort and merge overlapping silence intervals.
 *
 * silencedetect can report intervals that touch or overlap after rounding, and
 * an unsorted or overlapping list produces spans with negative length — which
 * become ffmpeg trims that silently output nothing.
 */
export function normaliseSilences(silences, total) {
  const clean = (silences || [])
    .map((s) => ({ start: Math.max(0, Number(s.start) || 0), end: Math.min(total, Number(s.end) || 0) }))
    .filter((s) => s.end - s.start >= MIN_SILENCE_SECONDS)
    .sort((a, b) => a.start - b.start);

  const merged = [];
  for (const s of clean) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else merged.push({ ...s });
  }
  return merged;
}

/**
 * Break a long span so the framing changes every 7-9 seconds.
 *
 * A span with no pause in it can run thirty seconds, and a locked-off shot of
 * one person talking for thirty seconds is where viewers leave. The interval
 * walks between the bounds rather than sitting at one number so the rhythm does
 * not become metronomic.
 */
export function splitForPunchIns(span, { enabled = true } = {}) {
  const length = span.end - span.start;
  if (!enabled || length <= PUNCH_INTERVAL_MAX) return [span];

  const out = [];
  let at = span.start;
  let i = 0;
  while (span.end - at > PUNCH_INTERVAL_MAX) {
    const step = PUNCH_INTERVAL_MIN + (i % (PUNCH_INTERVAL_MAX - PUNCH_INTERVAL_MIN + 1));
    out.push({ start: at, end: at + step });
    at += step;
    i++;
  }
  // The remainder joins the previous piece when it is too short to be a shot.
  if (span.end - at < MIN_PIECE_SECONDS && out.length > 0) out[out.length - 1].end = span.end;
  else out.push({ start: at, end: span.end });
  return out;
}

// ─── ffmpeg ─────────────────────────────────────────────────────────────────

/**
 * Render one piece of a take to its own file.
 *
 * `-ss` before `-i` seeks fast but lands on a keyframe; after `-i` it is
 * frame-accurate and slower. Accuracy wins here without argument — a cut point
 * that drifts to the nearest keyframe is a cut point that lands mid-word.
 *
 * The tight framing is a CROP then a scale back up, not a `scale` alone:
 * cropping keeps the centre of the frame and discards the edges, which is what
 * a tighter lens does. Scaling alone would just make a smaller picture.
 */
export function pieceArgs(input, output, piece, dim, { fps = 30, treatment = null } = {}) {
  const t = treatment || {
    mode: ONCAM_TREATMENT,
    blur: ONCAM_BG_BLUR,
    darken: ONCAM_BG_DARKEN,
    bgZoom: ONCAM_BG_ZOOM,
    vignette: ONCAM_VIGNETTE,
  };
  const args = ["-y", "-i", input, "-ss", String(piece.srcStart), "-to", String(piece.srcEnd)];

  // The punch-in crop applies to the SOURCE — a tighter framing of him — and
  // the treatment then composes that tighter framing into the 16:9 frame.
  // Cropping after composition would zoom the blurred background too, which
  // reads as a digital zoom rather than a second camera.
  const punch = piece.scale && piece.scale > 1.0001
    ? `crop=iw/${piece.scale}:ih/${piece.scale}:(iw-iw/${piece.scale})/2:(ih-ih/${piece.scale})/2,`
    : "";

  let graph;
  if (t.mode === "blur-fill") {
    // The take centered at full height; a blurred, darkened, slightly zoomed
    // copy of the same frame filling the width behind it. The gold vignette
    // sits on the BACKGROUND only — warmth in the corners, never a colour
    // cast on his face.
    const gold = t.vignette > 0
      ? `,vignette=angle=PI/4,colorbalance=rs=${(0.08 * t.vignette).toFixed(3)}:gs=${(0.04 * t.vignette).toFixed(3)}:bs=${(-0.06 * t.vignette).toFixed(3)}`
      : "";
    graph =
      `[0:v]${punch}split=2[fg][bg];` +
      `[bg]scale=${Math.round(dim.w * t.bgZoom)}:${Math.round(dim.h * t.bgZoom)}:force_original_aspect_ratio=increase,` +
      `crop=${dim.w}:${dim.h},gblur=sigma=${t.blur},eq=brightness=${(-t.darken * 0.5).toFixed(3)}:saturation=${(1 - t.darken * 0.4).toFixed(3)}${gold}[bgd];` +
      `[fg]scale=-2:${dim.h}[fgs];` +
      `[bgd][fgs]overlay=(W-w)/2:0[comp]`;
  } else {
    graph = `[0:v]${punch}scale=${dim.w}:${dim.h}:force_original_aspect_ratio=decrease,pad=${dim.w}:${dim.h}:(ow-iw)/2:(oh-ih)/2:color=black[comp]`;
  }

  let tail = "[comp]";
  if (piece.push) {
    // The one animated move: an eased push over the opening seconds, applied
    // to the COMPOSED frame so foreground and background travel together —
    // which is what a real camera push does. `on` is the output frame index;
    // a constant here produces a still zoom, a mistake made once already.
    const frames = Math.max(1, Math.round(piece.push.seconds * fps));
    const travel = round(piece.push.to - piece.push.from);
    const z = `${piece.push.from}+${travel}*sin(min(on/${frames}\\,1)*PI/2)`;
    graph += `;[comp]scale=${dim.w * 2}:${dim.h * 2},zoompan=z='${z}':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${dim.w}x${dim.h}:fps=${fps}[pushed]`;
    tail = "[pushed]";
  }
  graph += `;${tail}fps=${fps},setsar=1[v]`;

  args.push(
    "-filter_complex", graph,
    "-map", "[v]", "-map", "0:a?",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    output
  );
  return args;
}

/**
 * Edit one on-camera take: detect its silence, build the list, render the
 * pieces, concatenate them.
 *
 * Returns the report the build summary prints, because "we removed dead air"
 * is a claim that should come with a number.
 */
export function editOnCameraTake(input, outputDir, { dim, index = 0, isOpening = false, minKeep = 0, fps = 30, ffmpeg, writeFileSync, join, mediaDuration }) {
  const duration = mediaDuration(input);
  const silences = detectSilences(input);
  const plan = buildEditList(duration, silences, { isOpening, minKeep, seed: index });

  const files = [];
  plan.pieces.forEach((piece, i) => {
    const out = join(outputDir, `oc${String(index).padStart(2, "0")}_p${String(i).padStart(3, "0")}.mp4`);
    ffmpeg(pieceArgs(input, out, piece, dim, { fps }));
    files.push(out);
  });

  return { ...plan, files, silenceCount: silences.length };
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}
