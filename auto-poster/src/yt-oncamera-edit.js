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
import {
  ONCAM_TREATMENT, ONCAM_BG_BLUR, ONCAM_BG_DARKEN, ONCAM_BG_ZOOM, ONCAM_VIGNETTE,
  PUNCH_INTERVAL, ZOOM_PULSES_ENABLED, ZOOM_PULSE_STRENGTH,
} from "./yt-config.js";

/** Silence shorter than this is breath and rhythm — cutting it sounds clipped. */
export const MIN_SILENCE_SECONDS = 0.4;

/** How much silence is left behind, so speech does not butt straight together. */
export const KEEP_SILENCE_SECONDS = 0.15;

/** Below this, ffmpeg calls it silence. Room tone on a phone sits well under. */
export const SILENCE_DB = -35;

/**
 * A take shorter than this gets no punch-ins — there is nothing to break up.
 *
 * Derived from the interval rather than fixed, because the two moved together:
 * at a 3s cadence an 8-second floor would leave 4-7 second takes uncut, which
 * is precisely the length that most needs a cut. A take must be able to hold
 * two pieces to be worth splitting at all.
 */
export function punchMinTakeSeconds(interval = PUNCH_INTERVAL) {
  return Math.max(2 * MIN_PIECE_SECONDS, interval * 1.6);
}

/**
 * How often the framing changes when nothing else forces a boundary.
 *
 * The interval WALKS between these bounds rather than sitting on one number, so
 * the rhythm does not become metronomic — a cut landing on exactly the same
 * beat forever is as invisible as no cut at all. The spread is proportional to
 * the interval so it stays a spread and not a rounding error at 3 seconds.
 */
export function punchBounds(interval = PUNCH_INTERVAL) {
  const spread = Math.max(0.4, interval * 0.22);
  return { min: Math.max(0.8, interval - spread), max: interval + spread };
}

// The constant forms of the above are declared further down, after
// MIN_PIECE_SECONDS — they call these functions, and the functions read it.

/**
 * The declick fade at each end of every rendered piece, in seconds.
 *
 * Not a taste value. A concat join splices two waveforms at whatever amplitude
 * each happened to be at, and that step is what a viewer hears as a click or a
 * pop on a cut. 15ms takes any step to zero and is far shorter than a syllable.
 */
export const PIECE_DECLICK_SECONDS = 0.015;

/**
 * How long a zoom pulse lasts, in and back out.
 *
 * Short. A pulse is a punctuation mark on a word, not a move — past about a
 * third of a second it stops reading as emphasis and starts reading as a slow
 * zoom that changed its mind.
 */
export const PULSE_SECONDS = 0.28;

/**
 * How far from a cut a pulse must stay.
 *
 * A pulse landing on a framing change is two things happening at once, and the
 * viewer reads the louder one — so the pulse is wasted and the cut looks like a
 * glitch. Half a second either side is enough for each to be its own event.
 */
export const PULSE_CUT_CLEARANCE = 0.5;

/**
 * When the opening beat lands.
 *
 * Not at zero. A pulse on the very first frame is over before the viewer's eye
 * has settled on the picture, so it reads as a decode glitch rather than as
 * emphasis. A fifth of a second in, it reads as the shot arriving with force.
 */
export const OPENING_PULSE_AT = 0.2;

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

/**
 * The bounds and the floor at the CONFIGURED interval.
 *
 * Exported as constants as well as functions because callers that do not
 * parameterise the interval should not have to call a function to learn what
 * the pipeline is actually doing. Declared HERE rather than beside the
 * functions because they call `punchMinTakeSeconds`, which reads
 * MIN_PIECE_SECONDS — evaluating them earlier hits the temporal dead zone and
 * throws on import.
 */
export const PUNCH_MIN_TAKE_SECONDS = punchMinTakeSeconds();
export const PUNCH_INTERVAL_MIN = punchBounds().min;
export const PUNCH_INTERVAL_MAX = punchBounds().max;

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
export function buildEditList(duration, silences = [], {
  isOpening = false,
  minKeep = 0,
  seed = 0,
  punchIns = true,
  interval = PUNCH_INTERVAL,
  emphasis = [],
  pulses = ZOOM_PULSES_ENABLED,
  pulseStrength = ZOOM_PULSE_STRENGTH,
} = {}) {
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
  const minTake = punchMinTakeSeconds(interval);
  const pieces = [];
  let framingIndex = seed;
  for (const span of spans) {
    // Every span boundary is already a cut, so the framing flips there — that
    // is what hides the removed pause.
    const sub = splitForPunchIns(span, { enabled: punchIns && !isOpening && total >= minTake, interval });
    for (const [subIndex, piece] of sub.entries()) {
      pieces.push({
        srcStart: round(piece.start),
        srcEnd: round(piece.end),
        seconds: round(piece.end - piece.start),
        // WHAT KIND OF JOIN OPENS THIS PIECE, and the distinction is audible.
        //
        // A span boundary is a DEAD-SPACE join: silence was removed and the two
        // halves of a sentence were pushed together. Nothing happened there
        // editorially — the viewer is not supposed to notice it at all.
        //
        // A boundary INSIDE a span is a deliberate cadence punch-in: the framing
        // changes on purpose, and that is the beat a sound can sit on.
        //
        // Revision 8 shipped a whoosh on every seam because the SFX layer could
        // only see "a piece boundary", so the removed pauses each got a sound
        // announcing the edit that was supposed to be invisible. That is the
        // "weird noise on cuts" note, and it is fixed by telling the two apart
        // here rather than by turning the effect off.
        joinKind: pieces.length === 0 ? null : subIndex === 0 ? "dead-space" : "punch-in",
        scale: isOpening ? PUSH_FROM : framingIndex % 2 === 0 ? FRAMING_WIDE : FRAMING_TIGHT,
        // The opening is the one animated move in the file.
        push: isOpening && pieces.length === 0 ? { from: PUSH_FROM, to: PUSH_TO, seconds: Math.min(PUSH_SECONDS, piece.end - piece.start) } : null,
        pulses: [],
      });
      framingIndex++;
    }
  }

  // ── 4. emphasis pulses ───────────────────────────────────────────────────
  const pulsePlan = pulses ? assignPulses(pieces, emphasis, { strength: pulseStrength }) : { assigned: 0, dropped: [] };

  // THE OPENING BEAT. Peter's note: the static talking face opener dies.
  //
  // Added explicitly rather than left to emphasis detection, because the first
  // beat has to hit whether or not the opening sentence happens to contain a
  // figure or a place name — and it usually does not, since a good hook opens
  // on a question. It rides ON TOP of the slow push (both are terms in one zoom
  // expression), so the frame arrives already moving and then keeps moving.
  if (pulses && isOpening && pieces.length > 0 && pieces[0].seconds > OPENING_PULSE_AT + PULSE_SECONDS + 0.1) {
    pieces[0].pulses.push({
      at: OPENING_PULSE_AT,
      seconds: PULSE_SECONDS,
      // Harder than an emphasis pulse. This one is a punch, not a nudge.
      strength: Math.min(0.12, pulseStrength * 1.8),
      word: "(opening beat)",
      kind: "opening",
    });
    pulsePlan.assigned++;
  }

  if (punchIns && !isOpening && total >= minTake && pieces.length === 1) {
    warnings.push("take is long enough for a punch-in but produced a single piece");
  }

  return {
    pieces,
    originalSeconds: round(total),
    editedSeconds: round(editedSeconds),
    removedSeconds: round(total - editedSeconds),
    warnings,
    cadence: {
      interval,
      pieceCount: pieces.length,
      averagePieceSeconds: pieces.length ? round(editedSeconds / pieces.length) : 0,
      pulsesAssigned: pulsePlan.assigned,
      pulsesDropped: pulsePlan.dropped,
    },
  };
}

/**
 * Put a zoom pulse on each emphasis word that has room for one.
 *
 * Emphasis times are in SOURCE time — where the word sits in the original
 * recording — because that is what the transcript gives us. Pieces carry their
 * source range, so finding the piece is a lookup and the offset within the
 * piece is a subtraction. Doing this in edited time would need the cumulative
 * trim at every point and would silently drift by however much silence was cut
 * before it.
 *
 * THREE WAYS A PULSE IS DROPPED, and all three are collisions:
 *   - it falls in a gap that was trimmed out, so the word is not in the video
 *   - it lands within PULSE_CUT_CLEARANCE of a cut, where the framing change
 *     already owns the moment
 *   - it lands during the opening push, which is a deliberate slow move that a
 *     pulse would fight
 *
 * Dropped pulses are returned rather than discarded: a take where every pulse
 * was dropped is worth seeing in the report, because it usually means the
 * cadence and the speech are fighting.
 */
export function assignPulses(pieces, emphasis = [], { strength = ZOOM_PULSE_STRENGTH, clearance = PULSE_CUT_CLEARANCE } = {}) {
  const dropped = [];
  let assigned = 0;

  for (const e of emphasis || []) {
    const at = Number(e?.at);
    if (!Number.isFinite(at)) continue;

    const piece = pieces.find((p) => at >= p.srcStart && at <= p.srcEnd);
    if (!piece) {
      dropped.push({ at, word: e.word, why: "the word was trimmed out of the take" });
      continue;
    }
    if (piece.push) {
      dropped.push({ at, word: e.word, why: "lands during the opening push" });
      continue;
    }
    const offset = at - piece.srcStart;
    if (offset < clearance || piece.seconds - offset < clearance + PULSE_SECONDS) {
      dropped.push({ at, word: e.word, why: "too close to a cut" });
      continue;
    }
    // Two pulses inside one 3-second piece is a wobble, not emphasis.
    if (piece.pulses.some((p) => Math.abs(p.at - offset) < PULSE_SECONDS * 2.5)) {
      dropped.push({ at, word: e.word, why: "another pulse is already on this beat" });
      continue;
    }

    piece.pulses.push({ at: round(offset), seconds: PULSE_SECONDS, strength, word: e.word, kind: e.kind });
    assigned++;
  }

  return { assigned, dropped };
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
export function splitForPunchIns(span, { enabled = true, interval = PUNCH_INTERVAL } = {}) {
  const { min, max } = punchBounds(interval);
  const length = span.end - span.start;
  if (!enabled || length <= max) return [span];

  const out = [];
  let at = span.start;
  let i = 0;
  while (span.end - at > max) {
    // Walk min -> max -> min across successive cuts. The old version stepped in
    // whole seconds, which at a 3-second interval would have been a 33% swing
    // between consecutive cuts — audible as a limp rather than a rhythm.
    const t = (i % 4) / 3;
    const step = min + (max - min) * (t > 1 ? 2 - t : t);
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
 * THE SEEK GOES BEFORE `-i`, AND THAT IS THE WHOLE POINT OF THIS COMMENT.
 *
 * It used to go after, on the reasoning that output-side seeking is
 * frame-accurate and input-side seeking lands on a keyframe. The second half of
 * that has not been true for years — modern ffmpeg seeks to the keyframe and
 * then decodes forward to the exact frame — and the first half was hiding a
 * defect that silenced most of every on-camera take.
 *
 * OUTPUT-SIDE SEEKING DOES NOT MOVE THE FILTER GRAPH'S CLOCK. Frames are
 * filtered on the SOURCE timeline and discarded afterwards, so every filter
 * here that is a function of time was being evaluated against the wrong one.
 * Everything downstream computes its times relative to the PIECE — the declick
 * fades below start at 0 and end at `pieceSeconds`, the zoom pulses gate on
 * `on` counted from the piece's first frame — so on any piece with
 * `srcStart > 0` the two clocks disagreed by exactly `srcStart`.
 *
 * Measured on a synthetic take, three 3-second pieces, ffmpeg 7.1.1:
 *
 *   piece 0 (srcStart 0)  peak 2927 — audio present, declick at both edges
 *   piece 1 (srcStart 3)  peak    0 — SILENT
 *   piece 2 (srcStart 6)  peak    0 — SILENT
 *
 * `afade=t=out` holds silence forever once its ramp completes, and its ramp was
 * completing at `pieceSeconds` on the source clock — before the retained window
 * even opened. So the take kept its first piece's audio and lost every piece
 * after it, which across twelve on-camera takes is most of Peter's voice. The
 * zoom pulses failed the same way and more quietly: `between(on, ...)` never
 * opened, so the pulses simply never fired off the first piece.
 *
 * With the seek on the input side all three pieces measure a clean fade in and
 * out around full-level speech, and the frames are identical — verified against
 * a per-frame luminance stamp, where both seek methods land on the same source
 * frame to the pixel. The accuracy the old comment was protecting was never at
 * risk; the clock it silently broke was.
 *
 * The tight framing is a CROP then a scale back up, not a `scale` alone:
 * cropping keeps the centre of the frame and discards the edges, which is what
 * a tighter lens does. Scaling alone would just make a smaller picture.
 */
/**
 * THE PIECE'S AUDIO CODEC, AND WHY IT IS NOT AAC ANY MORE.
 *
 * An AAC encoder emits whole frames of 1024 samples and prepends a frame of
 * priming samples to every file it writes. Neither is a problem for one file.
 * Concatenate seventy-six of them with `-c copy` and both are: the priming
 * frame is a real 21.3 ms of samples at the head of every piece, and the
 * demuxer offsets the next piece by the previous one's rounded-up duration.
 *
 * MEASURED, through this function and concatArgs, with an impulse planted
 * 1.5 s into each of four 3-second pieces (ffmpeg 7.1.1):
 *
 *   AAC pieces   1.5214  4.5507  7.5801  10.6094   →  +29.3 ms per join
 *   PCM pieces   1.5001  4.5001  7.5001  10.5001   →   +0.0 ms per join
 *
 * Card 8's build cut its twelve on-camera takes into seventy-six pieces. At
 * 29.3 ms a join that is close to two seconds of audio sliding behind the
 * picture across the video — his lips and his voice, drifting apart the longer
 * anyone watches. The video stream stays exactly right, which is what makes it
 * invisible to every duration check in the pipeline.
 *
 * PCM has no frame size and no priming, so the arithmetic is exact and there is
 * nothing to accumulate. The cost is a large intermediate file per piece, which
 * is deleted as soon as the take is concatenated, and one AAC encode per take
 * instead of one per piece — which is cheaper, not dearer.
 *
 * The container has to change with the codec: mp4 does not carry PCM sensibly,
 * so pieces land in Matroska. Callers pick the path; `pieceExtension` below is
 * how they know which.
 */
export const PIECE_AUDIO = process.env.YT_PIECE_AUDIO === "aac" ? "aac" : "pcm";

/** The container a piece must be written into for a given audio codec. */
export function pieceExtension(audio = PIECE_AUDIO) {
  return audio === "pcm" ? "mkv" : "mp4";
}

export function pieceArgs(input, output, piece, dim, { fps = 30, treatment = null, audio: audioCodec = PIECE_AUDIO } = {}) {
  const t = treatment || {
    mode: ONCAM_TREATMENT,
    blur: ONCAM_BG_BLUR,
    darken: ONCAM_BG_DARKEN,
    bgZoom: ONCAM_BG_ZOOM,
    vignette: ONCAM_VIGNETTE,
  };
  const args = ["-y", "-ss", String(piece.srcStart), "-to", String(piece.srcEnd), "-i", input];

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

  // ── the zoom expression ──────────────────────────────────────────────────
  //
  // ONE zoompan, whatever moves are on this piece. The opening push and the
  // emphasis pulses are both zooms, and the opening now wants BOTH: Peter's
  // note is a pulse on the first beat over the top of the slow push. Chaining
  // two zoompans would rasterise the frame twice and visibly soften it, and
  // running them as alternatives — which is what the first version did — makes
  // the opening pulse impossible to express at all.
  //
  // So the terms SUM into a single expression. The push is an eased ramp that
  // settles at its target; each pulse is a half-sine gated to its own window by
  // `between()`, so it contributes exactly zero outside it. Between pulses on a
  // non-opening piece the expression is exactly 1.0 and the frame is untouched.
  //
  // `on` is the output frame index. A zoom expression that does not reference
  // it is a constant, which ffmpeg accepts and renders as a perfectly still
  // "zoom" — this codebase has shipped that bug once already, and the tests
  // assert the expression is a function of the frame counter for that reason.
  // The base is where the frame sits with nothing happening: the push's start
  // scale, or 1.0. Every term below ADDS to it, so a piece with no moves is
  // exactly 1.0 and a piece with both is the sum — and the emitted string stays
  // the one a reader expects, "1+0.08*sin(...)", rather than "1+0+0.08*sin(...)".
  const base = piece.push ? piece.push.from : 1;
  const terms = [];
  if (piece.push) {
    const frames = Math.max(1, Math.round(piece.push.seconds * fps));
    const travel = round(piece.push.to - piece.push.from);
    terms.push(`${travel}*sin(min(on/${frames}\\,1)*PI/2)`);
  }
  for (const p of piece.pulses || []) {
    const startF = Math.max(0, Math.round(p.at * fps));
    const lenF = Math.max(1, Math.round(p.seconds * fps));
    terms.push(`${p.strength.toFixed(3)}*between(on\\,${startF}\\,${startF + lenF})*sin((on-${startF})/${lenF}*PI)`);
  }

  if (terms.length > 0) {
    const z = `${base}+${terms.join("+")}`;
    // THE RATE IS FIXED BEFORE zoompan, NOT INSIDE IT, AND THAT ORDER IS THE
    // WHOLE DIFFERENCE BETWEEN A 3-SECOND PIECE AND A 1536-SECOND ONE.
    //
    // `zoompan` does not merely filter frames — with an `fps` parameter it
    // GENERATES an output timeline at that rate and fills it, and it decides how
    // much to fill from the timestamps of the frames arriving. Handed a
    // 60fps source it produced 512 output frames for every input frame.
    //
    // Measured on a 60fps source, one 3-second piece, ffmpeg 7.1.1:
    //
    //   fps inside zoompan, input-side seek    1536.000s   74% duplicate frames
    //   fps BEFORE zoompan, input-side seek       3.000s    3% duplicate frames
    //
    // THIS IS OLDER THAN THE SEEK FIX AND WAS HIDDEN BY IT. With the seek on the
    // output side, ffmpeg trimmed the inflated stream back to `srcEnd` — the
    // right DURATION containing a sliver of the intended content, stretched.
    // That is why every on-camera piece carrying a push or a pulse has rendered
    // in heavy slow motion since the retention edit shipped, why the duplicate
    // frame ratio sat at 74%, and almost certainly what "the whole video feels
    // laggy" was in revision 8 — the graphics layer was investigated and the
    // cause was here.
    //
    // Upscaled before zoompan so the move lives inside real pixels rather than
    // resampling the delivery frame.
    // BOTH the leading `fps` and zoompan's own `fps` are required, and dropping
    // either one is a different defect:
    //
    //   fps only inside zoompan   input arrives at 60, zoompan generates a
    //                             30fps timeline to cover it -> 1536s, 512x
    //   fps only before zoompan   zoompan falls back to its DEFAULT of 25fps
    //                             and the trailing fps=30 pads it -> 108 frames
    //                             for 90, a 20% overrun
    //   both                      input and output agree at 30 -> 90 frames
    //
    // The pair is what makes it 1:1. Neither number is redundant.
    graph += `;[comp]fps=${fps},scale=${dim.w * 2}:${dim.h * 2},zoompan=z='${z}':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${dim.w}x${dim.h}:fps=${fps}[zoomed]`;
    tail = "[zoomed]";
  }
  // Idempotent: `fps` on a stream already at that rate passes it through, so the
  // zoom branch above having set it costs nothing here.
  graph += `;${tail}fps=${fps},setsar=1[v]`;

  // A DECLICK AT BOTH EDGES OF EVERY PIECE.
  //
  // The pieces are cut at arbitrary sample positions and then concatenated, so
  // each join splices two waveforms that are almost never at the same amplitude.
  // That step is a discontinuity, and a discontinuity is a click — which is the
  // other half of the "weird noise on cuts" note, and the half that survives
  // even after the whoosh is restricted to deliberate punch-ins.
  //
  // 15ms is short enough to be inaudible as a fade on speech (a syllable is
  // 80-200ms) and long enough to take any step down to zero.
  //
  // EDGE FADES RATHER THAN A TRUE CROSSFADE, deliberately. `acrossfade` overlaps
  // its inputs, so every join would shorten the take by the fade length — and
  // the captions, the micro-punches and the graphic reveals are all timed
  // against these durations, so a silent 15ms of drift per cut would walk the
  // whole video out of sync with its own words. Fading each edge to zero
  // preserves the timing exactly and removes the same discontinuity.
  const fade = round(PIECE_DECLICK_SECONDS);
  const pieceSeconds = Math.max(0, round(piece.srcEnd - piece.srcStart));
  // A piece shorter than two fades would be all fade. It gets none: a very short
  // piece is quiet at both ends anyway, and halving it would be worse than the
  // click.
  const audio = pieceSeconds > fade * 3
    ? ["-af", `afade=t=in:st=0:d=${fade},afade=t=out:st=${round(pieceSeconds - fade)}:d=${fade}`]
    : [];

  args.push(
    "-filter_complex", graph,
    "-map", "[v]", "-map", "0:a?",
    ...audio,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    ...(audioCodec === "pcm"
      ? ["-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2"]
      : ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"]),
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
 *
 * ─── THE FOUR OPTIONAL ARGUMENTS, AND WHY THEY ARE ARGUMENTS ────────────────
 *
 * `interval`, `treatment`, `silences` and `duration` all default to exactly
 * what this function did before they existed, so every long-form caller is
 * unchanged by their presence. `tests/reel-edit.test.mjs` pins that with
 * "editOnCameraTake's new arguments change nothing for a long-form caller",
 * which makes the SAME call the pipeline makes and asserts the emitted ffmpeg
 * invocations are byte-identical to buildEditList's own default plan.
 *
 * They exist because the reels manual edit queue runs THIS function rather than
 * a second copy of it (see reel-edit.js). A reel needs a faster cadence and a
 * plain fit instead of the 16:9 blur-fill, and both were already parameters one
 * level down in buildEditList and pieceArgs — so passing them through is the
 * difference between one editor with two callers and two editors that drift.
 *
 * `silences` and `duration` are the subtler pair, and they close a real hole.
 * A caller that wants to INSPECT the plan before rendering it — to refuse an
 * edit that would cut into speech, say — used to have to call detectSilences
 * itself, and this function would then call it again. Two detections is not
 * merely wasteful: the caller's could pass `duration` and pick up a trailing
 * unterminated silence that this one, calling `detectSilences(input)` bare,
 * would drop. The plan that was checked would not have been the plan that
 * rendered, which is the worst possible shape for a safety check.
 */
export function editOnCameraTake(input, outputDir, {
  dim,
  index = 0,
  isOpening = false,
  minKeep = 0,
  fps = 30,
  interval = PUNCH_INTERVAL,
  treatment = null,
  silences = null,
  duration = null,
  pieceAudio = PIECE_AUDIO,
  ffmpeg,
  writeFileSync,
  join,
  mediaDuration,
}) {
  const total = duration ?? mediaDuration(input);
  const found = silences ?? detectSilences(input);
  const plan = buildEditList(total, found, { isOpening, minKeep, seed: index, interval });

  const files = [];
  // The extension follows the codec: PCM pieces are Matroska, so the joins do
  // not accumulate an AAC priming frame apiece. See PIECE_AUDIO.
  const ext = pieceExtension(pieceAudio);
  plan.pieces.forEach((piece, i) => {
    const out = join(outputDir, `oc${String(index).padStart(2, "0")}_p${String(i).padStart(3, "0")}.${ext}`);
    ffmpeg(pieceArgs(input, out, piece, dim, { fps, treatment, audio: pieceAudio }));
    files.push(out);
  });

  return { ...plan, files, silenceCount: found.length };
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}
