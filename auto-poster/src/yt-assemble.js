/**
 * yt-assemble.js — turning a timeline plan into a finished 12-minute video.
 *
 * The filter graphs here are the ones the Phase 0 probe measured on a real
 * runner with real 4K60 portrait footage, not ones invented afterwards:
 * 1080p came out at 18 minutes of wall for 12 minutes of video, 5% of the job
 * ceiling. Changing a graph here changes those numbers, so they are kept
 * literal and commented rather than generated.
 *
 * WHY THE ARGUMENT BUILDERS ARE SEPARATE AND PURE
 * A bad ffmpeg flag does not throw — it produces a video that is subtly wrong,
 * and you find out twelve minutes into watching it. Building the arguments in
 * testable functions means a wrong scale filter or a dropped `-shortest` fails
 * in the suite instead of in the render.
 *
 * WHAT THE SOURCE FOOTAGE ACTUALLY IS
 * The Drive library is 4K60 PORTRAIT (2160x3840) phone and drone footage. This
 * is a 16:9 format, so every B-roll clip is scaled to fit and pillarboxed. That
 * decode-and-scale was 71% of the probe's wall time — it is the expensive part
 * of the whole pipeline, and the reason the caption burn is a separate pass
 * rather than being folded into a single graph.
 */

import { execFileSync, spawnSync } from "child_process";
import { writeFileSync, existsSync, mkdirSync, statSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { generateTTS, postProcessVoiceoverAudio } from "./voiceover.js";
import { RESOLUTION, PROGRAMME_LUFS, MUSIC_DB, GRAPHIC_GRAIN_STRENGTH } from "./yt-config.js";
// The early motion gate borrows the artifact QC's own measurement — one
// threshold, two moments. Imported as a namespace so tests can stub the gate
// without reaching into the QC module's internals.
import * as motionGate from "./yt-artifact-qc.js";
import { preserveGateEvidence } from "./yt-evidence.js";
import { kenBurnsArgs } from "./yt-visual-broll.js";
import { renderOverlayPng, burnOverlayArgs } from "./yt-opening.js";
import { pieceArgs, pieceExtension } from "./yt-oncamera-edit.js";
import { pipCompositeArgs } from "./yt-pip.js";
import { renderPunchPng } from "./yt-punch.js";
import { bedEnvelope } from "./yt-music.js";
import { ensureSfxKit, mixSfxArgs, punchSfxTimeline } from "./yt-sfx.js";
import { assertRenderableText } from "./yt-text-safety.js";

export const CANVAS = {
  "1080p": { w: 1920, h: 1080 },
  "4k": { w: 3840, h: 2160 },
};

/** Constant rate factor and preset, matching the probe. */
const CRF = 20;
const PRESET = "veryfast";
const FPS = 30;

/**
 * ONE video timescale for every segment and every join, and it is not a
 * preference — it is the fix for the six frozen tails that survived three
 * builds.
 *
 * Measured through the real command graph: on-camera segments copied their
 * video from the .mov piece chain and arrived at the join carrying a 1/16000
 * timescale; everything x264 wrote natively carried 1/15360. The `-c copy`
 * segment concat then rescaled packet-by-packet between the two, and 30fps is
 * NOT representable in integer ticks at 16000 (533.33 per frame) — the
 * rounding accumulated into manufactured multi-second frame durations at the
 * boundaries and a video stream that outran its audio by seconds. The caption
 * burn honoured those durations faithfully: picture and burned caption frozen
 * up to 25 seconds at every voiceover-to-on-camera cut, three renders running.
 * 15360 divides 30 (512 ticks exactly), every writer below pins it, and the
 * concat has nothing left to rescale.
 */
const VIDEO_TIMESCALE = 15360;
const TIMESCALE_ARGS = ["-video_track_timescale", String(VIDEO_TIMESCALE)];
const AUDIO_BITRATE = "192k";

/**
 * Every segment's audio is forced to these, and it is not optional.
 *
 * The concat demuxer with `-c copy` does NOT reject segments whose audio
 * parameters disagree — it declares the first segment's format for the whole
 * file and reinterprets the rest. Verified locally: concatenating a mono
 * 44.1kHz segment with a stereo 48kHz one produced no error, no warning, and a
 * 4.0s timeline that came out 4.38s long.
 *
 * That is precisely the failure this format cannot absorb. Peter's phone
 * records one thing, ElevenLabs returns another (44.1kHz mono MP3), and the
 * timeline alternates between them every segment — so the drift compounds for
 * twelve minutes and the first person to notice is a viewer watching lips go
 * out of sync.
 */
const AUDIO_RATE = "48000";
const AUDIO_CHANNELS = "2";

/** The audio encode flags every segment must share. */
export function segmentAudioArgs() {
  return ["-c:a", "aac", "-b:a", AUDIO_BITRATE, "-ar", AUDIO_RATE, "-ac", AUDIO_CHANNELS];
}

/** How long the fade at each segment edge is. Matches the piece declick. */
export const SEGMENT_DECLICK_SECONDS = 0.015;

/**
 * A fade at both ends of a SEGMENT, for the same reason the pieces have one.
 *
 * THE JOIN THE PIECE DECLICK NEVER COVERED. `pieceArgs` fades the edges of every
 * piece inside an on-camera take, so the cuts within a take are silent. Nothing
 * did the same for the boundary BETWEEN segments — and that boundary splices two
 * completely unrelated recordings: a voiceover take's narration butting straight
 * against a phone take's room tone, concatenated with `-c copy`.
 *
 * The 2026-08-13 render was flagged for one click, at 297.523s. That is 0.16s
 * into segment `s4t1`, which is to say it is the seam where the preceding
 * voiceover segment meets the on-camera take — the one kind of join in the whole
 * timeline that had no fade on it. The detector had already been recalibrated
 * against this render and stands by it at 10.2x its own neighbourhood.
 *
 * 15ms, the same as the pieces: inaudible on speech, long enough to take any
 * step down to zero.
 */
export function segmentDeclickArgs(seconds, { fade = SEGMENT_DECLICK_SECONDS } = {}) {
  const total = Number(seconds) || 0;
  // A segment shorter than three fades would be mostly fade. It gets none — the
  // same rule pieceArgs applies, and for the same reason.
  if (total <= fade * 3) return [];
  const out = Math.round((total - fade) * 1000) / 1000;
  return ["-af", `afade=t=in:st=0:d=${fade},afade=t=out:st=${out}:d=${fade}`];
}

/**
 * How far under the narration the music bed sits.
 *
 * WAS a linear 0.25 constant. IS `YT_MUSIC_DB`, because "the music is too loud"
 * is the most likely note to come back from a review round and it should cost a
 * workflow edit rather than a code change. The envelope that rides on top of it
 * — up under the hook, back for the body, up for the close — lives in
 * yt-music.js with the rest of the bed's decisions.
 */

export function canvasFor(resolution = RESOLUTION) {
  return CANVAS[resolution] || CANVAS["1080p"];
}

// ─── argument builders (pure) ───────────────────────────────────────────────

/**
 * Normalise any source clip onto the canvas.
 *
 * `force_original_aspect_ratio=decrease` + `pad` is what turns portrait 4K into
 * a pillarboxed 16:9 frame without stretching anyone's face. `setsar=1` matters
 * more than it looks: phone footage carries odd sample aspect ratios, and
 * concat silently produces a stretched segment if they disagree.
 */
export function normalizeArgs(input, output, dim, { seconds = null, startAt = 0, loop = false } = {}) {
  const args = ["-y"];
  if (loop) args.push("-stream_loop", "-1");
  if (startAt > 0) args.push("-ss", String(startAt));
  args.push("-i", input);
  if (seconds) args.push("-t", String(seconds));
  args.push(
    "-vf",
    `scale=${dim.w}:${dim.h}:force_original_aspect_ratio=decrease,` +
      `pad=${dim.w}:${dim.h}:(ow-iw)/2:(oh-ih)/2:color=black,fps=${FPS},setsar=1`,
    "-c:v", "libx264",
    "-preset", PRESET,
    "-crf", String(CRF),
    "-pix_fmt", "yuv420p",
    ...TIMESCALE_ARGS,
    "-an",
    output
  );
  return args;
}

/**
 * Conform an already-finished clip for concatenation.
 *
 * For revision 3's generated visuals, which arrive as mp4s at the delivery size
 * with their motion already baked in. This does the minimum concat requires —
 * exact size, rate, pixel format and SAR — and adds no move of its own.
 *
 * `-stream_loop -1` with `-t` rather than a pad: a clip that came back a
 * fraction short of its slot repeats instead of leaving a black tail, which is
 * the same rule owned footage follows. The loop is bounded by `-t`, so a clip
 * longer than its slot is simply cut.
 *
 * GRAIN, on the generated layers only. The motion gate measures duplicate
 * frames and real footage never duplicates: sensor noise makes every frame
 * unique. A rasterised card holding between reveals is the same PNG frame
 * after frame — to the measurement AND to the eye reading texture, a held card
 * is a freeze-frame however smooth its reveals were. The grain is that missing
 * texture: film-stock noise on the LUMA plane only (chroma grain sparkles in
 * colour; luma grain reads as stock), a fresh pattern every frame, so every
 * generated frame genuinely differs everywhere the way a filmed one does.
 * Stock arrives with a sensor's own noise and gets none; on-camera never
 * comes through here. `t+u` is temporal (the fresh-pattern part — the whole
 * point) mixed uniform/gaussian so it reads organic rather than digital.
 * Strength is measured against the gate's own tool — see
 * GRAPHIC_GRAIN_STRENGTH in yt-config.js for the numbers.
 */
export function conformArgs(input, output, dim, { seconds, fps = FPS, grain = 0 } = {}) {
  const texture = grain > 0 ? `,noise=c0s=${grain}:c0f=t+u` : "";
  return [
    "-y",
    "-stream_loop", "-1",
    "-i", input,
    "-t", String(seconds),
    "-vf",
    `scale=${dim.w}:${dim.h}:force_original_aspect_ratio=decrease,` +
      `pad=${dim.w}:${dim.h}:(ow-iw)/2:(oh-ih)/2:color=black,fps=${fps}${texture},setsar=1`,
    "-c:v", "libx264",
    "-preset", PRESET,
    "-crf", String(CRF),
    "-pix_fmt", "yuv420p",
    ...TIMESCALE_ARGS,
    "-an",
    output,
  ];
}

/** Mux one narration track onto a silent visual segment. */
export function muxNarrationArgs(videoIn, audioIn, output, { seconds = null } = {}) {
  return [
    "-y", "-i", videoIn, "-i", audioIn,
    "-map", "0:v", "-map", "1:a",
    "-c:v", "copy", ...TIMESCALE_ARGS,
    // The same 15ms edge fade the on-camera segments get. A voiceover segment's
    // narration ends abruptly against whatever the next segment opens with, and
    // that seam is exactly where the one confirmed click landed.
    ...segmentDeclickArgs(seconds),
    ...segmentAudioArgs(),
    // `-t` MAKES THE SEGMENT THE LENGTH THE PLAN SAYS, which is a different
    // guarantee from the one `-shortest` gives and the one that actually matters
    // here.
    //
    // `-shortest` ends the segment when the shorter of picture and narration
    // runs out. Measured, and it does work under `-c:v copy` — a 12s picture
    // with 5s of narration comes out at 5.000s either way. What it does NOT do
    // is bound the segment to `seg.seconds`: give it a 12s picture and 8s of
    // narration against a 5s allocation and it produces 8 seconds.
    //
    // That case is reachable. `generateNarration` only sets `seg.seconds` from
    // the audio it generates, and it skips any segment that already carries a
    // `narrationSource` — which, under YT_NARRATION_MODE=peter, is every
    // voiceover take. So nothing reconciles the plan's allocation with the
    // length of the recording Peter actually made, and a take that reads long
    // silently stretches its segment.
    //
    // Captions are laid out from `seg.seconds` (buildCaptionChunks), so a
    // segment that renders longer than its allocation drifts every caption after
    // it for the rest of the video. `-t` closes that: the artifact is the length
    // the plan described, and the QC duration check verifies it end to end.
    //
    // NOT PRESENTED AS THE CAUSE OF THE 2026-08-12 OVERRUN. That render came out
    // 20.5 minutes against an 11.2 minute plan and the mechanism is still
    // unidentified — four candidates were tested and none reproduced. This is a
    // real defect found while looking for it, fixed on its own merits.
    ...(seconds ? ["-t", String(seconds)] : []),
    // Kept for the case it genuinely covers: a picture shorter than its
    // narration would otherwise freeze its last frame to fill the gap.
    "-shortest",
    output,
  ];
}

/** Concat pre-normalised segments. Same codec and canvas throughout, so this is a copy. */
export function concatArgs(listFile, output) {
  // The timescale rides along even under -c copy: it is a container property,
  // and pinning it here means a stray intermediate written by anything else
  // still leaves the concat output uniform.
  return ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", ...TIMESCALE_ARGS, output];
}

/**
 * Duck a music bed under the narration, riding an energy envelope.
 *
 * TWO MECHANISMS, DOING DIFFERENT JOBS, and conflating them is how a bed ends up
 * either inaudible or in the way.
 *
 * The SIDECHAIN is per-syllable. Keyed off the narration itself, so the bed
 * drops when he speaks and returns in the gaps — rather than sitting at one low
 * volume for twelve minutes, which sounds like a mistake.
 *
 * The ENVELOPE is per-section. The bed comes up under the hook, settles for the
 * body, and comes up again for the close, on the ramps yt-music.js computes.
 * `eval=frame` is what makes the expression a curve rather than a value sampled
 * once at filter-init — without it ffmpeg evaluates `t` at zero and the whole
 * video plays at the hook's level.
 *
 * The envelope is applied BEFORE the compressor so the compressor sees the level
 * the viewer will hear. Ducking a signal and then raising it afterwards would
 * hand the loud sections back exactly the headroom the duck just took away.
 */
export function duckArgs(videoIn, musicIn, output, { envelope = null, bedOnlyOutput = null } = {}) {
  const level = envelope?.expr
    ? `volume=eval=frame:volume='${envelope.expr}'`
    : `volume=${envelope?.body ?? 0.25}`;

  // `normalize=0` IS LOAD-BEARING AND WAS MISSING.
  //
  // amix divides by its input count unless told not to, so this stage was
  // handing back a mix with the narration 6 dB quieter than it arrived. The bed
  // lost the same 6 dB, so the BALANCE looked untouched and the defect hid — but
  // the video got quieter every time it passed through, and every dB the voice
  // gives up is a dB of margin the bed does not have to beat. yt-sfx.js already
  // learned this and says so; this stage did not.
  //
  // With it off the levels are exactly what the two branches computed: the
  // narration at the level programmeGain put it, the bed at MUSIC_DB under it.
  const graph =
    `[1:a]${level}[bed];` +
    `[0:a]asplit=2[vo1][vo2];` +
    `[bed][vo1]sidechaincompress=threshold=${SIDECHAIN_THRESHOLD}:ratio=12:attack=20:release=400[ducked];` +
    `[ducked]asplit=2[duck1][duck2];` +
    `[vo2][duck1]amix=inputs=2:duration=first:normalize=0:dropout_transition=0[aout]`;

  const args = [
    "-y", "-i", videoIn, "-i", musicIn,
    "-filter_complex", graph,
    "-map", "0:v", "-map", "[aout]",
    "-c:v", "copy", ...TIMESCALE_ARGS, "-c:a", "aac", "-b:a", AUDIO_BITRATE,
    "-movflags", "+faststart",
    output,
  ];

  // THE BED, ALONE, AS THIS EXACT GRAPH PRODUCED IT.
  //
  // Written out so the artifact check can measure the music against the voice
  // in the finished file. There is no way to un-mix two signals after the fact,
  // so the only honest way to ask "is the bed under his voice at 7:12" is to
  // keep the branch that made it — post-envelope, post-sidechain, the same
  // samples that were summed into the mix.
  //
  // A second output on the SAME invocation rather than a second run: two runs
  // would be two encodes of a twelve-minute file, and worse, they could differ.
  // What the check measures has to be what the viewer hears, and sharing the
  // filter graph is what makes that true rather than likely.
  if (bedOnlyOutput) {
    args.push("-map", "[duck2]", "-c:a", "pcm_s16le", "-vn", bedOnlyOutput);
  }
  return args;
}

/**
 * Where the sidechain starts pulling the bed down, in linear amplitude.
 *
 * 0.05 is about -26 dBFS. THIS NUMBER ONLY MEANS ANYTHING BECAUSE THE PROGRAMME
 * IS LEVELLED FIRST — it is a threshold on an absolute signal level, and before
 * levelProgrammeArgs existed there was no absolute level to speak of. Peter's
 * phone takes arrive wherever the room put them, `postProcessVoiceoverAudio`
 * only ever touched generated TTS, and card 8's build generated none at all
 * (`narrated 0 voiceover take(s)`, YT_NARRATION_MODE=peter). So the compressor
 * was comparing a fixed threshold against a level nobody had ever set, and if
 * that level had come in under -26 dBFS the duck would have done nothing while
 * looking perfectly correct in the filter graph.
 */
const SIDECHAIN_THRESHOLD = 0.05;

/**
 * Bring the whole programme to a known loudness before anything is mixed under
 * it.
 *
 * WHY A MEASURED STATIC GAIN AND NOT `loudnorm`'s OWN FILTER. loudnorm in
 * single-pass mode is a dynamic processor: it rides the level, and riding the
 * level of a twelve-minute narration is exactly the audible processing this
 * channel should not have on a man talking to camera. Measuring the integrated
 * loudness and applying ONE gain to the whole file moves it to the right place
 * and changes nothing else — his dynamics, his pauses and his emphasis all
 * survive intact.
 *
 * The true-peak ceiling is what stops the gain from clipping a take that was
 * recorded quiet but peaky. Whichever of the two limits binds, binds.
 */
export function programmeGainDb(measured, { targetLufs = PROGRAMME_LUFS, ceilingDbTp = -1.5 } = {}) {
  const i = Number(measured?.inputI);
  const tp = Number(measured?.inputTp);
  if (!Number.isFinite(i) || i <= -70) return { db: 0, reason: "no measurable programme loudness — leaving it alone" };
  const wanted = targetLufs - i;
  const headroom = Number.isFinite(tp) ? ceilingDbTp - tp : Infinity;
  const db = Math.round(Math.min(wanted, headroom) * 100) / 100;
  return {
    db,
    measuredLufs: Math.round(i * 10) / 10,
    truePeakDb: Number.isFinite(tp) ? Math.round(tp * 10) / 10 : null,
    limitedByPeak: headroom < wanted,
    reason: null,
  };
}

/** Ask ffmpeg what the programme's integrated loudness and true peak are. */
export function measureLoudnessArgs(input) {
  return [
    "-hide_banner", "-nostats", "-i", input,
    "-af", "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json",
    "-f", "null", "-",
  ];
}

/**
 * loudnorm prints its JSON to stderr after the progress output. Parsed from the
 * LAST brace-balanced block rather than the first, because a file that produced
 * warnings can have other output in the way.
 */
export function parseLoudnessJson(stderr) {
  const text = String(stderr || "");
  const start = text.lastIndexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const j = JSON.parse(text.slice(start, end + 1));
    return {
      inputI: Number.parseFloat(j.input_i),
      inputTp: Number.parseFloat(j.input_tp),
      inputLra: Number.parseFloat(j.input_lra),
    };
  } catch {
    return null;
  }
}

/**
 * What gain the BED needs so it sits `under` dB below the programme.
 *
 * MUSIC_DB'S OWN DOCUMENTATION SAYS "where the bed sits UNDER THE NARRATION",
 * and until this function existed it was nothing of the kind — it was a gain
 * applied to whatever the mp3's own mastering happened to be, mixed against
 * whatever level Peter's room happened to give. Two absolute numbers with no
 * relationship between them, describing a relationship.
 *
 * Both sides are measured now, so the number means the sentence. And it is
 * measured against what the programme ACTUALLY REACHED rather than the target
 * it was aiming at: a quiet, peaky recording gets held back by its true peak,
 * lands short of -16 LUFS, and a bed placed relative to the target would then
 * sit that much closer to his voice than intended. The one case where this most
 * matters is the one where it would silently go wrong.
 */
export function bedRelativeGainDb({ bedLufs, programmeLufs, under = -14, fallback = -14 }) {
  const b = Number(bedLufs);
  const p = Number(programmeLufs);
  if (!Number.isFinite(b) || !Number.isFinite(p) || b <= -70) {
    return { db: fallback, measured: false, reason: "could not measure both sides — falling back to the absolute knob" };
  }
  const want = p + under;          // where the bed should land, in LUFS
  return { db: Math.round((want - b) * 100) / 100, measured: true, bedLufs: Math.round(b * 10) / 10, targetLufs: Math.round(want * 10) / 10, reason: null };
}

/** Apply the measured gain, leaving the picture untouched. */
export function levelProgrammeArgs(videoIn, output, gainDb) {
  return [
    "-y", "-i", videoIn,
    "-af", `volume=${gainDb.toFixed(2)}dB`,
    "-map", "0:v", "-map", "0:a",
    "-c:v", "copy", ...TIMESCALE_ARGS, ...segmentAudioArgs(),
    output,
  ];
}

/**
 * Burn the caption track, and the micro-punches with it.
 *
 * ONE PASS FOR BOTH, and that is the reason the punches composite here rather
 * than in a stage of their own. This is a full re-encode of a twelve-minute
 * file — the second most expensive thing the pipeline does — and a separate
 * overlay pass would double it to put six words on screen. Folded in, the
 * punches cost a handful of PNG inputs on an encode that was already happening.
 *
 * Each punch is a still gated to its own window by `enable`, the pattern
 * burnHookArgs already proved on the opening. There is no fade IN: an instant
 * appearance is what makes it a slam rather than a dissolve, which is the whole
 * point of the device. The fade OUT is short enough to feel like a release and
 * long enough not to click.
 */
export function burnArgs(videoIn, assPath, output, { punches = [] } = {}) {
  const usable = (punches || []).filter((p) => p && p.pngPath);
  if (usable.length === 0) {
    return [
      "-y", "-i", videoIn,
      // `fps` BEFORE the captions: the burn is the encode that turned three
      // renders' timestamp debt into frozen pictures, honouring multi-second
      // frame durations exactly as stated. With honest input this is a
      // pass-through; with a dishonest frame it flattens the hold onto the
      // 30fps grid instead of amplifying it — the last belt behind the pinned
      // timescale and the timestamp probes.
      "-vf", `fps=${FPS},ass=${assPath}`,
      "-c:v", "libx264", "-preset", PRESET, "-crf", String(CRF), "-pix_fmt", "yuv420p",
      ...TIMESCALE_ARGS,
      "-c:a", "copy", "-movflags", "+faststart",
      output,
    ];
  }

  const inputs = [];
  for (const p of usable) inputs.push("-loop", "1", "-t", String(p.seconds), "-i", p.pngPath);

  // The captions burn FIRST so a punch sits over them rather than under them.
  // A caption drawn on top of the plate would be the card 7 picture exactly:
  // two pieces of text fighting in the middle of the frame.
  // Same fps normalisation as the no-punches path, same reason.
  const chains = [`[0:v]fps=${FPS},ass=${assPath}[cap]`];
  let last = "[cap]";
  usable.forEach((p, i) => {
    const fade = Math.min(0.2, p.seconds / 4);
    // `setpts` IS LOAD-BEARING AND WAS NOT OBVIOUS. A PNG input has its own
    // timeline starting at zero, so `fade=t=out:st=1.0` fades one second into
    // the OVERLAY, not one second into the video — the plate finished fading
    // long before its `enable` window opened, and the punch rendered as nothing
    // at all. Verified against extracted frames: without the shift, zero gold
    // pixels inside the window; with it, the plate is solid through the hold and
    // gone after the release.
    chains.push(
      `[${i + 1}:v]format=rgba,fade=t=out:st=${(p.seconds - fade).toFixed(2)}:d=${fade.toFixed(2)}:alpha=1,` +
        `setpts=PTS-STARTPTS+${p.at.toFixed(3)}/TB[pv${i}]`
    );
    const out = i === usable.length - 1 ? "[v]" : `[pc${i}]`;
    // `eof_action=pass` so the main video continues after a plate's frames run
    // out, rather than the graph holding the last one or stalling.
    chains.push(
      `${last}[pv${i}]overlay=0:0:eof_action=pass:enable='between(t,${p.at.toFixed(3)},${(p.at + p.seconds).toFixed(3)})'${out}`
    );
    last = `[pc${i}]`;
  });

  return [
    "-y", "-i", videoIn, ...inputs,
    "-filter_complex", chains.join(";"),
    "-map", "[v]", "-map", "0:a?",
    "-c:v", "libx264", "-preset", PRESET, "-crf", String(CRF), "-pix_fmt", "yuv420p",
    ...TIMESCALE_ARGS,
    "-c:a", "copy", "-movflags", "+faststart",
    output,
  ];
}

// ─── captions ───────────────────────────────────────────────────────────────

/** Words per caption chunk. Four is what the reels pipeline settled on. */
const WORDS_PER_CHUNK = 4;

/**
 * Caption chunks straight off the timeline.
 *
 * The reels pipeline Whispers the finished audio to get word timings. That is
 * the right call there — the narration is generated and nobody knows exactly
 * how long each word took. Here the script text is KNOWN and every segment's
 * start and duration are known, so chunks are laid out proportionally inside
 * each segment's own window. It is accurate enough to read, and it avoids a
 * twelve-minute Whisper pass whose errors would put wrong words on screen.
 */
export function buildCaptionChunks(plan, { wordsPerChunk = WORDS_PER_CHUNK } = {}) {
  const chunks = [];
  let elapsed = 0;

  for (const seg of plan.segments || []) {
    const words = String(seg.text || "").split(/\s+/).filter(Boolean);
    const duration = seg.seconds || 0;
    if (words.length === 0 || duration <= 0) {
      elapsed += duration;
      continue;
    }
    const groups = [];
    for (let i = 0; i < words.length; i += wordsPerChunk) {
      groups.push(words.slice(i, i + wordsPerChunk));
    }
    const per = duration / groups.length;
    groups.forEach((g, i) => {
      chunks.push({
        start: round(elapsed + i * per),
        end: round(elapsed + (i + 1) * per),
        text: g.join(" "),
      });
    });
    elapsed += duration;
  }
  return chunks;
}

/** ASS timestamps are H:MM:SS.cc, and the hour is not zero-padded. */
export function assTimestamp(seconds) {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const cs = Math.round((s - Math.floor(s)) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(Math.min(cs, 99)).padStart(2, "0")}`;
}

export function buildAssFile(chunks, dim) {
  const fontSize = Math.round(dim.h * 0.055);
  const marginV = Math.round(dim.h * 0.08);
  const header =
`[Script Info]
ScriptType: v4.00+
PlayResX: ${dim.w}
PlayResY: ${dim.h}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,${fontSize},&H00FFFFFF,&H00000000,&H80000000,-1,1,3,1,2,60,60,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const events = chunks
    .map((c) => `Dialogue: 0,${assTimestamp(c.start)},${assTimestamp(c.end)},Default,,0,0,0,,${escapeAss(c.text)}`)
    .join("\n");
  return `${header}${events}\n`;
}

function escapeAss(text) {
  // THIS USED TO STRIP BRACES, AND THE STRIPPING WAS THE BUG.
  //
  // Braces open an override block in ASS and a stray one swallows the rest of
  // the line, so deleting them looks like the careful thing to do. What it
  // actually does is turn a caption reading `{{PRICE}}` into a caption reading
  // `PRICE` — no error, no visible brace, just a template's insides rendered in
  // the caption font as though somebody had written them. A substitution
  // failure that survives to pixels looking like a word is the worst available
  // outcome, and it was the one this line guaranteed.
  //
  // Now it stops. The renderer is still protected from the unbalanced brace —
  // the build never reaches ffmpeg — and the reason is on screen in the log
  // instead of in the video.
  assertRenderableText(text, "a caption chunk");
  return String(text).replace(/\r?\n/g, "\\N");
}

// ─── execution ──────────────────────────────────────────────────────────────

/**
 * EXPORTED so the visual builder uses this runner and not its own.
 *
 * yt-visual-build.js takes ffmpeg as an argument — that is what lets the whole
 * decision table be tested without encoding anything — and the pipeline has to
 * hand it something. Handing it a second, locally-defined runner would mean two
 * timeout policies and two error shapes for the same binary, and the first
 * attempt at this handed it an identifier that did not exist at all: the build
 * reached the visual stage after eight minutes of transcription and died on
 * `ReferenceError: ffmpeg is not defined`.
 */
export function ffmpeg(args, timeoutMs = 60 * 60_000) {
  return execFileSync("ffmpeg", args, {
    timeout: timeoutMs,
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf-8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

/**
 * Run ffmpeg for what it says on stderr rather than for what it writes.
 *
 * The analysis filters — loudnorm's JSON, silencedetect's spans, astats — all
 * report there, and `ffmpeg()` above throws the stderr away. Kept separate
 * rather than changing that return shape, because every existing caller wants
 * "it worked or it threw" and this is the only kind of caller that does not.
 */
export function ffmpegStderr(args, timeoutMs = 30 * 60_000) {
  const res = spawnSync("ffmpeg", args, {
    timeout: timeoutMs,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  return String(res.stderr || "");
}

export function mediaDuration(path) {
  try {
    return (
      parseFloat(
        execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], {
          encoding: "utf-8",
          timeout: 60_000,
        }).trim()
      ) || 0
    );
  } catch {
    return 0;
  }
}

/** One stream's duration, not the container's — the container hides a short one. */
export function streamDuration(path, kind /* "v" | "a" */) {
  try {
    return (
      parseFloat(
        execFileSync("ffprobe", [
          "-v", "error", "-select_streams", `${kind}:0`,
          "-show_entries", "stream=duration", "-of", "csv=p=0", path,
        ], { encoding: "utf-8", timeout: 60_000 }).trim()
      ) || 0
    );
  } catch {
    return 0;
  }
}

/**
 * Fail the build when a media file's video timestamps are dishonest.
 *
 * THE CLASS THIS CLOSES, measured on three renders and finally reproduced
 * through the real command graph: segments that probed perfectly — right
 * frame count, right stream ends — entered a `-c copy` concat with mismatched
 * video timescales, and the join manufactured frames whose STATED durations
 * ran to whole seconds. Every frame-counting gate passed (the frames all
 * differ), every stream-end gate passed (the last timestamp is right), and
 * the caption burn then honoured the stated durations: picture frozen up to
 * 25 seconds over live narration, six spans, three builds running.
 *
 * So this probe reads what nothing else read: the per-frame durations. A
 * frame claiming more than `maxFrameSeconds` of screen time, or a video
 * stream running past its audio by more than `maxSkewSeconds`, fails with the
 * offender's timestamp in the message. Runs per segment AND on the joined
 * file — the defect assembles at the join, and both ends deserve a gate.
 *
 * THE FRAME LIMIT IS TEN FRAMES, NOT TWO, and the slack is measured: an
 * honest mux legitimately pads a boundary frame to ~0.1s where a segment's
 * video rounds against its `-t`. A third of a second at a cut is invisible;
 * the manufactured frames this probe exists for claimed 2 to 25 seconds.
 * Tightening the limit into the boundary-rounding noise would fail every
 * honest join to catch nothing extra.
 */
export function assertHonestTimestamps(path, label, { maxFrameSeconds = 0.34, maxSkewSeconds = 0.25 } = {}) {
  // PACKETS, NOT FRAMES, and the difference is 108x. A frame-level scan makes
  // ffprobe parse every frame: measured at 216 SECONDS on a 1987 MB render
  // here, and on a slower runner with a 2378 MB file it blew through the
  // 300s timeout and failed a build whose picture was fine (run 31893490615:
  // "spawnSync ffprobe ETIMEDOUT"). Packets carry pts_time and duration_time
  // straight from the container index — no decoding — and the same file scans
  // in 2 seconds with byte-identical output: 20,068 rows either way, and the
  // manufactured 0.783s duration in the broken-join control shows up
  // identically in both. Same signal, none of the cost.
  let rows;
  try {
    rows = execFileSync("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "packet=pts_time,duration_time", "-of", "csv=p=0", path,
    ], { encoding: "utf-8", timeout: 300_000, maxBuffer: 256 * 1024 * 1024 }).trim().split("\n").filter(Boolean);
  } catch (err) {
    throw new Error(`${label}: could not read packet timestamps from ${path} (${err.message}) — nobody verified this file's clock`);
  }
  if (rows.length === 0) {
    throw new Error(`${label}: ${path} has no video packets — nobody verified this file's clock`);
  }
  let worst = { at: 0, dur: 0 };
  for (const r of rows) {
    const [pts, dur] = r.split(",").map((x) => Number.parseFloat(x) || 0);
    if (dur > worst.dur) worst = { at: pts, dur };
  }
  const video = streamDuration(path, "v");
  const audio = streamDuration(path, "a");
  const skew = audio > 0 ? video - audio : 0;
  if (worst.dur > maxFrameSeconds || skew > maxSkewSeconds) {
    throw new Error(
      `${label}: dishonest video timestamps — ` +
      (worst.dur > maxFrameSeconds ? `a frame at ${Math.round(worst.at * 100) / 100}s claims ${Math.round(worst.dur * 1000) / 1000}s of screen time (limit ${maxFrameSeconds}s)` : "") +
      (worst.dur > maxFrameSeconds && skew > maxSkewSeconds ? "; " : "") +
      (skew > maxSkewSeconds ? `video runs ${Math.round(skew * 100) / 100}s past its audio (limit ${maxSkewSeconds}s)` : "") +
      ` — a later encode would honour this as a frozen picture`
    );
  }
  return { frames: rows.length, worstFrameSeconds: Math.round(worst.dur * 1000) / 1000, skewSeconds: Math.round(skew * 100) / 100 };
}

/**
 * Fail the build when a segment's picture ends before its narration.
 *
 * The tolerance is two frames: codec padding legitimately differs between an
 * AAC audio stream and an x264 video stream, and a picture two frames short
 * displays as nothing at all. A picture SECONDS short displays as the last
 * frame frozen with the captions dead under live narration — the defect this
 * assertion exists to make loud and early.
 */
export function assertPictureCoversAudio(path, takeId, { tolerance = 0.15 } = {}) {
  const video = streamDuration(path, "v");
  const audio = streamDuration(path, "a");
  if (audio > 0 && video > 0 && video < audio - tolerance) {
    throw new Error(
      `${takeId}: the picture ends ${Math.round((audio - video) * 100) / 100}s before the narration ` +
      `(video stream ${video}s, audio stream ${audio}s) — a piece is missing or short, ` +
      `and the join would freeze the last frame over live narration`
    );
  }
  if (video <= 0 || audio <= 0) {
    throw new Error(`${takeId}: could not read stream durations from ${path} (video ${video}s, audio ${audio}s) — nobody verified this segment`);
  }
  return { video, audio };
}

/**
 * Render a planned timeline.
 *
 * @param {object} plan        from planTimeline
 * @param {object} opts
 * @param {string} opts.workDir
 * @param {Function} opts.resolveBrollPath  driveFileId -> local path (downloaded by the caller)
 * @param {string} [opts.musicPath]         optional bed
 * @param {string} [opts.resolution]
 * @returns {{ outputPath, seconds, bytes, stages }}
 */
export async function renderTimeline(plan, { workDir, resolveBrollPath, musicPath = null, resolution = RESOLUTION, openingOverlay = null, punches = [] } = {}) {
  if (!plan?.segments?.length) throw new Error("renderTimeline needs a plan with segments");
  if (plan.missingTakes?.length) {
    // Rendering around a missing on-camera take would produce a video with a
    // hole in the argument. The caller reports and stops.
    throw new Error(`cannot render: ${plan.missingTakes.length} on-camera take(s) were never recorded`);
  }

  const dim = canvasFor(resolution);
  const dir = workDir || join(tmpdir(), `yt-assemble-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const stages = {};
  const t = (name, fn) => {
    const t0 = Date.now();
    const out = fn();
    stages[name] = Math.round((Date.now() - t0) / 100) / 10;
    console.log(`[Assemble] ${name}: ${stages[name]}s`);
    return out;
  };

  // The overlay is rasterised once, up front, because the segment loop below
  // is synchronous ffmpeg work and sharp is not.
  let overlayPngPath = null;
  if (openingOverlay) {
    overlayPngPath = join(dir, "opening-overlay.png");
    writeFileSync(overlayPngPath, await renderOverlayPng(openingOverlay, dim));
  }

  // ── 1. each segment becomes one normalised, narrated file ────────────────
  const segmentFiles = [];
  t("segments", () => {
    plan.segments.forEach((seg, i) => {
      const base = join(dir, `seg${String(i).padStart(3, "0")}`);

      if (seg.kind === "on_camera") {
        let withAudio = `${base}.mp4`;

        // ── the edited take ──────────────────────────────────────────────
        // Dead air removed and the framing changed at every resulting seam, so
        // each cut is covered by a punch-in rather than showing as a jump. The
        // opening take gets the push instead. See yt-oncamera-edit.js.
        const edit = seg.editPlan;
        if (edit && edit.pieces.length > 0) {
          const pieceFiles = [];
          const ext = pieceExtension();
          edit.pieces.forEach((piece, pi) => {
            const out = `${base}_e${String(pi).padStart(3, "0")}.${ext}`;
            ffmpeg(pieceArgs(seg.source, out, piece, dim, { fps: FPS }));
            pieceFiles.push(out);
          });
          const listFile = `${base}_edit.txt`;
          writeFileSync(listFile, pieceFiles.map((p) => `file '${p}'`).join("\n"));
          // THE PIECES CARRY PCM, SO THE JOIN IS SAMPLE-EXACT, and the take is
          // encoded to AAC once at the end rather than once per piece. An AAC
          // encode per piece put a 21.3 ms priming frame at every join and the
          // concat demuxer stacked them: 29.3 ms of audio sliding behind the
          // picture per join, measured, which across card 8's seventy-six
          // pieces is close to two seconds by the close. See PIECE_AUDIO.
          const jointed = `${base}_joined.${ext}`;
          ffmpeg(concatArgs(listFile, jointed));
          // The declick at the segment's own edges goes on here, where the take
          // is already being re-encoded to AAC — see segmentDeclickArgs.
          ffmpeg([
            "-y", "-i", jointed, "-c:v", "copy", ...TIMESCALE_ARGS,
            ...segmentDeclickArgs(mediaDuration(jointed)),
            ...segmentAudioArgs(), withAudio,
          ]);
          rmSync(jointed, { force: true });
          pieceFiles.forEach((p) => rmSync(p, { force: true }));
          rmSync(listFile, { force: true });
          console.log(
            `[Assemble] ${seg.takeId}: ${edit.pieces.length} piece(s), ` +
              `${edit.removedSeconds}s of dead air removed (${edit.originalSeconds}s -> ${edit.editedSeconds}s)`
          );
        } else {
          // Unedited fallback: the take as recorded, on the canvas.
          const visual = `${base}_v.mp4`;
          ffmpeg(normalizeArgs(seg.source, visual, dim, { seconds: seg.seconds }));
          ffmpeg([
            "-y", "-i", visual, "-i", seg.source,
            "-map", "0:v", "-map", "1:a?",
            "-t", String(seg.seconds),
            "-c:v", "copy", ...TIMESCALE_ARGS, ...segmentAudioArgs(),
            withAudio,
          ]);
          rmSync(visual, { force: true });
        }

        // The opening overlay burns onto the FIRST segment only, and only when
        // that segment is on-camera — which planOpening has already guaranteed.
        // Burning here rather than after the concat keeps the filter operating
        // on a 20-second file instead of a twelve-minute one.
        // The on-camera copy-mux is where the foreign timescale entered the
        // chain three renders running — its clock is probed like everyone
        // else's, with the take's name on the failure.
        try {
          assertHonestTimestamps(withAudio, seg.takeId);
        } catch (err) {
          preserveGateEvidence("segment-timestamps", { takeId: seg.takeId, error: err.message }, { files: [withAudio] });
          throw err;
        }

        if (i === 0 && overlayPngPath) {
          const burned = `${base}_burned.mp4`;
          ffmpeg(burnOverlayArgs(withAudio, overlayPngPath, burned));
          rmSync(withAudio, { force: true });
          segmentFiles.push(burned);
          console.log(`[Assemble] burned the opening overlay: "${openingOverlay}"`);
          return;
        }

        segmentFiles.push(withAudio);
        return;
      }

      // Voiceover: B-roll for the picture, cloned voice (or his own) for the sound.
      //
      // A MISSING PIECE IS A BUILD FAILURE, NOT A SHRUG. These `existsSync`
      // checks used to `return`, silently dropping the block — and a dropped
      // block is a video stream shorter than its narration, which the concat
      // carries as a hole and the final encode fills by freezing the last real
      // frame, caption and all. Card 11 shipped 84 seconds of that. Every
      // sourcePath here was written by this very process minutes ago; one that
      // is gone is a bug that must stop the build while its name is on screen.
      const pieces = [];
      seg.broll.forEach((b, bi) => {
        const piece = `${base}_b${bi}.mp4`;

        // Revision 3: animated graphics, graded stock and the beat arrive as
        // finished CLIPS. They are already the right size, rate and length, so
        // they are conformed for concat — plus film grain on the generated
        // layers, which is what lets a held card read (and measure) as footage
        // rather than as a freeze. See conformArgs.
        if (b.preRendered) {
          if (!existsSync(b.sourcePath)) {
            throw new Error(`${seg.takeId} block ${bi} (${b.kind || "generated"}): source missing at ${b.sourcePath}`);
          }
          const grain = b.kind === "stock" ? 0 : GRAPHIC_GRAIN_STRENGTH;
          ffmpeg(conformArgs(b.sourcePath, piece, dim, { seconds: b.seconds, fps: FPS, grain }));
          pieces.push(piece);
          return;
        }

        if (b.generated) {
          if (!existsSync(b.sourcePath)) {
            throw new Error(`${seg.takeId} block ${bi} (still): source missing at ${b.sourcePath}`);
          }
          ffmpeg(kenBurnsArgs(b.sourcePath, piece, { seconds: b.seconds, dim, fps: FPS }));
          pieces.push(piece);
          return;
        }

        const src = resolveBrollPath(b.driveFileId);
        if (!src) {
          throw new Error(`${seg.takeId} block ${bi}: Drive clip ${b.driveFileId} did not resolve to a local file`);
        }
        // -stream_loop covers a clip shorter than its slot; the -t cut still
        // governs, so a 4s clip filling a 6s slot repeats rather than gapping.
        ffmpeg(normalizeArgs(src, piece, dim, { seconds: b.seconds, loop: true }));
        pieces.push(piece);
      });
      if (pieces.length === 0) throw new Error(`voiceover take ${seg.takeId} has no usable B-roll`);

      const listFile = `${base}_list.txt`;
      writeFileSync(listFile, pieces.map((p) => `file '${p}'`).join("\n"));
      const visual = `${base}_v.mp4`;
      ffmpeg(concatArgs(listFile, visual));

      // ── the floating head ────────────────────────────────────────────────
      // Composited before the narration is muxed, so the filter runs on a
      // silent visual and the audio is copied once at the end rather than
      // re-encoded twice. A segment with no cutout, or one whose matte failed
      // the quality gate, simply skips this and plays full-screen.
      let picture = visual;
      if (seg.pip?.cutoutPath && existsSync(seg.pip.cutoutPath)) {
        const pipped = `${base}_pip.mp4`;
        ffmpeg(pipCompositeArgs(visual, seg.pip.cutoutPath, pipped, seg.pip.placement, { seconds: seg.seconds, fps: FPS }));
        rmSync(visual, { force: true });
        picture = pipped;
        console.log(`[Assemble] ${seg.takeId}: PIP in the ${seg.pip.placement.corner} corner`);
      }

      const narration = seg.narrationSource || seg.generatedNarrationPath;
      if (!narration) throw new Error(`voiceover take ${seg.takeId} has no narration audio`);
      const withAudio = `${base}.mp4`;
      ffmpeg(muxNarrationArgs(picture, narration, withAudio, { seconds: seg.seconds }));

      // THE PICTURE COVERS THE NARRATION, PROVED PER SEGMENT. A segment whose
      // video stream runs out while its audio continues is invisible to every
      // duration check — the container reports the longer stream — and it is
      // exactly the shape of card 11's six frozen tails: `-shortest` under
      // `-c:v copy` did not reliably cut, the concat carried the hole, and the
      // caption encode froze the last frame over 25 seconds of live narration.
      // One ffprobe per segment converts that whole class into a named failure
      // thirty seconds after the segment renders — and the failing segment
      // file itself is kept, because the file IS the evidence and it lives in
      // a tmpdir the runner is about to destroy.
      try {
        assertPictureCoversAudio(withAudio, seg.takeId);
        assertHonestTimestamps(withAudio, seg.takeId);
      } catch (err) {
        preserveGateEvidence("picture-covers-audio", {
          takeId: seg.takeId,
          error: err.message,
          broll: (seg.broll || []).map((b) => ({ kind: b.kind, seconds: b.seconds, sourceSeconds: b.sourceSeconds, sourcePath: b.sourcePath })),
        }, { files: [withAudio] });
        throw err;
      }

      pieces.forEach((p) => rmSync(p, { force: true }));
      rmSync(picture, { force: true });
      rmSync(listFile, { force: true });
      segmentFiles.push(withAudio);
    });
  });

  // ── 1b. what the segments actually came out as ───────────────────────────
  //
  // MEASURED, ONE FFPROBE EACH, BEFORE ANYTHING IS JOINED. Twenty-four probes
  // against a stage that just spent ten minutes encoding is free, and it is the
  // difference between "the render is the wrong length" and "these four
  // voiceover segments are the wrong length".
  //
  // The 2026-08-12 build needed exactly this and did not have it: a 20.5 minute
  // file from an 11.2 minute plan, and no way to tell which branch of the loop
  // above had produced the extra nine minutes without another full build.
  const segmentDurations = plan.segments.map((seg, i) => {
    const measured = mediaDuration(segmentFiles[i]);
    return {
      takeId: seg.takeId,
      kind: seg.kind,
      planned: round(seg.seconds || 0),
      measured: round(measured),
      drift: round(measured - (seg.seconds || 0)),
    };
  });
  const strayed = segmentDurations.filter((s) => Math.abs(s.drift) > 0.25);
  if (strayed.length > 0) {
    for (const s of strayed) {
      console.log(`::warning::${s.takeId} (${s.kind}) rendered ${s.measured}s against a planned ${s.planned}s (${s.drift > 0 ? "+" : ""}${s.drift}s)`);
    }
  }
  console.log(
    `[Assemble] segment lengths: ${segmentDurations.length} measured, ` +
      `${strayed.length} off plan by more than 0.25s, ` +
      `total ${round(segmentDurations.reduce((n, s) => n + s.measured, 0))}s against a planned ${plannedSeconds(plan)}s`
  );

  // ── 2. concat ────────────────────────────────────────────────────────────
  const concatList = join(dir, "concat.txt");
  writeFileSync(concatList, segmentFiles.map((p) => `file '${p}'`).join("\n"));
  const joined = join(dir, "joined.mp4");
  t("concat", () => ffmpeg(concatArgs(concatList, joined)));

  // ── 2b. the motion gate, HERE, not only at the end ───────────────────────
  //
  // The artifact QC runs the same measurement on the finished file — after the
  // levelling, the mix and the caption burn, which is forty minutes of work on
  // top of a picture that may already be dead. Card 11's fifty-five minute
  // build failed on frames that were frozen at THIS stage. Running the check on
  // the joined file costs two minutes and fails while every intermediate is
  // still on disk and the take names still mean something. The threshold is
  // the same one the artifact gate uses; passing here and failing there would
  // mean a later stage froze the picture, which is its own diagnosis.
  // ── 2a. the clock gate on the joined file ────────────────────────────────
  //
  // The defect ASSEMBLES at the join even when every segment is individually
  // honest — mismatched timescales are a property of the pair, not of either
  // file. One frame-duration scan of the joined file catches the class
  // wherever it originates, before forty minutes of audio work and a caption
  // burn are spent amplifying it.
  t("clock-gate", () => {
    try {
      const clock = assertHonestTimestamps(joined, "joined");
      console.log(`[Assemble] clock gate: clean (worst frame ${clock.worstFrameSeconds}s, video-audio skew ${clock.skewSeconds}s across ${clock.frames} frames)`);
    } catch (err) {
      preserveGateEvidence("clock-gate", { error: err.message }, { files: [joined] });
      throw err;
    }
  });

  t("motion-gate", () => {
    const { checkMotion } = motionGate;
    const verdict = checkMotion({ path: joined, duration: mediaDuration(joined) });
    if (!verdict.ok) {
      // The joined file is the evidence, and it is about to die with the
      // runner's tmpdir — kept, with the measurement, same rule as every gate.
      const kept = preserveGateEvidence("motion-gate", { failures: verdict.failures, stats: verdict.stats }, { files: [joined] });
      const worst = verdict.failures.slice(0, 6).map((f) => f.reason).join("; ");
      throw new Error(
        `the joined picture fails the motion gate before captions: ${worst}` +
        `${verdict.failures.length > 6 ? ` (+${verdict.failures.length - 6} more)` : ""}. ` +
        `Evidence: ${kept.reportPath || "unwritable"}${kept.copied.length ? ` + ${kept.copied.length} file(s) in the failed-render artifact` : ""}`
      );
    }
    console.log(`[Assemble] motion gate: clean (${verdict.stats.duplicates}/${verdict.stats.frames} duplicate frames, worst window ${Math.round((verdict.stats.worstWindow?.ratio || 0) * 100)}%)`);
  });

  // ── 3. level the programme ───────────────────────────────────────────────
  // BEFORE ANY OF THE THREE THINGS THAT MIX SOMETHING UNDER IT. The hits, the
  // bed and the sidechain threshold are all absolute levels, and until this
  // stage existed they were absolute levels measured against nothing: Peter's
  // takes come in wherever the room left them, and the only leveller in the
  // codebase (postProcessVoiceoverAudio) runs on generated TTS, which a
  // YT_NARRATION_MODE=peter build has none of.
  let levelled = joined;
  let programme = { db: 0, reason: "not measured" };
  try {
    const measured = parseLoudnessJson(ffmpegStderr(measureLoudnessArgs(joined)));
    programme = programmeGainDb(measured, { targetLufs: PROGRAMME_LUFS });
    if (Math.abs(programme.db) >= 0.1) {
      levelled = join(dir, "levelled.mp4");
      t("level", () => ffmpeg(levelProgrammeArgs(joined, levelled, programme.db)));
    }
    console.log(
      `[Assemble] programme loudness: ${programme.measuredLufs ?? "?"} LUFS -> ${PROGRAMME_LUFS} LUFS ` +
        `(${programme.db >= 0 ? "+" : ""}${programme.db} dB` +
        `${programme.limitedByPeak ? `, held back by a ${programme.truePeakDb} dBTP peak` : ""})`
    );
  } catch (err) {
    // A measurement that fails costs the calibration, not the video — but it
    // must be loud, because every level below it is now guesswork again and the
    // artifact check is the only thing that will notice.
    console.log(`::warning::could not measure programme loudness (${err.message}) — levels are uncalibrated this build`);
  }

  // ── 4. the sound: punches, then the bed ──────────────────────────────────
  // The synthesised hits go in BEFORE the bed so the sidechain compressor sees
  // them as part of the programme it is ducking under, rather than sitting on
  // top of a mix that was already balanced without them.
  let scored = levelled;
  const sfxTimeline = punchSfxTimeline(plan, punches);
  if (sfxTimeline.length > 0) {
    const kit = ensureSfxKit(dir, ffmpeg);
    if (kit) {
      const withSfx = join(dir, "sfx.mp4");
      try {
        t("sfx", () => ffmpeg(mixSfxArgs(levelled, sfxTimeline, kit, withSfx)));
        scored = withSfx;
        console.log(`[Assemble] mixed ${sfxTimeline.length} synthesised hit(s)`);
      } catch (err) {
        // A failed SFX mix costs the sound, never the video.
        console.log(`::warning::the SFX mix failed (${err.message}) — the video ships without them`);
      }
    }
  }

  let mixed = scored;
  // The two files the audio check needs: the programme without any bed on it,
  // and the bed as the duck actually produced it. Null when there is no bed,
  // which is its own answer — a video with no music cannot have music over the
  // voice, and the check says so rather than being skipped.
  let bedOnlyPath = null;
  const voiceOnlyPath = scored;
  if (musicPath && existsSync(musicPath)) {
    mixed = join(dir, "mixed.mp4");
    bedOnlyPath = join(dir, "bed-only.wav");

    // Both sides measured, so MUSIC_DB means "under his voice" rather than
    // "under full scale". `achieved` is what the levelling actually reached,
    // which is not the target whenever a true peak got in the way.
    const achieved = Number.isFinite(programme.measuredLufs) ? programme.measuredLufs + programme.db : null;
    let bedLevel = { db: MUSIC_DB, measured: false, reason: "the bed was not measured" };
    try {
      const bedMeasured = parseLoudnessJson(ffmpegStderr(measureLoudnessArgs(musicPath)));
      bedLevel = bedRelativeGainDb({ bedLufs: bedMeasured?.inputI, programmeLufs: achieved, under: MUSIC_DB, fallback: MUSIC_DB });
    } catch (err) {
      console.log(`::warning::could not measure the music bed (${err.message}) — using ${MUSIC_DB} dB flat`);
    }

    const envelope = bedEnvelope({ seconds: mediaDuration(scored) || plannedSeconds(plan), db: bedLevel.db });
    t("duck", () => ffmpeg(duckArgs(scored, musicPath, mixed, { envelope, bedOnlyOutput: bedOnlyPath })));
    console.log(
      `[Assemble] music bed ${bedLevel.measured
        ? `at ${bedLevel.db} dB — ${bedLevel.bedLufs} LUFS brought to ${bedLevel.targetLufs} LUFS, ${MUSIC_DB} dB under the programme`
        : `at ${bedLevel.db} dB absolute (${bedLevel.reason})`}` +
        `; gain ${envelope.body} ` +
        (envelope.shaped ? `lifting to ${envelope.lift} under the hook and from ${envelope.closeAt}s` : "(flat — too short to shape)")
    );
  } else {
    console.log("[Assemble] no music bed supplied — narration only");
  }

  // ── 5. captions, and the micro-punches in the same pass ──────────────────
  const assPath = join(dir, "captions.ass");
  const chunks = buildCaptionChunks(plan);
  writeFileSync(assPath, buildAssFile(chunks, dim));

  // Rasterise the plates before the encode, for the same reason the opening
  // overlay is: sharp is async and the render loop is not.
  const plates = [];
  for (const [i, p] of (punches || []).entries()) {
    const pngPath = join(dir, `punch-${String(i).padStart(2, "0")}.png`);
    writeFileSync(pngPath, await renderPunchPng(p.text, dim, { hold: p.seconds }));
    plates.push({ ...p, pngPath });
  }

  const finalPath = join(dir, "final.mp4");
  t("captions", () => ffmpeg(burnArgs(mixed, assPath, finalPath, { punches: plates })));

  const seconds = mediaDuration(finalPath);
  const bytes = statSync(finalPath).size;
  console.log(
    `[Assemble] done: ${(seconds / 60).toFixed(1)} min, ${(bytes / 1024 / 1024).toFixed(1)} MB, ` +
    `${chunks.length} caption chunks, ${plates.length} micro-punch(es)`
  );
  return {
    outputPath: finalPath,
    seconds,
    bytes,
    chunkCount: chunks.length,
    punches: plates,
    stages,
    // EVERYTHING THE ARTIFACT CHECKS NEED, HANDED BACK RATHER THAN REDERIVED.
    //
    // The checks run on the finished file, but two of them need to know what
    // went INTO it — you cannot separate a bed from a voice after they are
    // summed. These are the intermediate artifacts of this exact render, and
    // handing them over is what makes the difference between measuring the
    // video and measuring a reconstruction of it.
    //
    // `captionChunks` is here for the same reason and with a caveat: it is
    // PLANNED timing, and the checks must not trust it for windows. It is
    // passed so the OCR pass can compare what it READ against what was
    // SUPPOSED to be there — text, not time.
    qcInputs: {
      voiceOnlyPath,
      bedOnlyPath,
      programme,
      captionChunks: chunks,
      punches: plates,
      // The two the duration check compares. `plannedSeconds` is a plan value
      // and is exactly the point: this is the one check whose whole job is to
      // ask whether the artifact still matches it.
      plannedSeconds: plannedSeconds(plan),
      segmentDurations,
    },
  };
}

/**
 * Generate the cloned-voice narration for every voiceover take that needs it.
 *
 * Runs before renderTimeline and mutates the plan's segments with the audio
 * path, so the render stays synchronous ffmpeg work with no network in the
 * middle of it. Uses the same TTS call, voice settings and pacing post-process
 * as the reels — two voices across one channel would be an obvious tell.
 */
/**
 * Did this render actually use a synthetic voice?
 *
 * `generatedNarrationPath` is set by generateNarration and ONLY by
 * generateNarration, which skips any segment that already carries a
 * narrationSource. So its presence anywhere in the plan is proof the clone
 * spoke, and its absence everywhere is proof it did not — regardless of what
 * narrationMode predicted.
 *
 * Call it AFTER generateNarration. Before that the answer is always false and
 * means nothing.
 */
export function syntheticNarrationUsed(plan) {
  return (plan?.segments || []).some((seg) => Boolean(seg?.generatedNarrationPath));
}

export async function generateNarration(plan) {
  let generated = 0;
  for (const seg of plan.segments || []) {
    if (seg.kind !== "voiceover" || seg.narrationSource) continue;
    const raw = await generateTTS(seg.text);
    // The pacing pass trims long silences and applies the tempo the reels use.
    // Passing the segment length lets the existing fit guard re-run at whatever
    // tempo is needed rather than letting the tail get cut off.
    seg.generatedNarrationPath = postProcessVoiceoverAudio(raw, seg.seconds);
    // The narration is authoritative for length: a take that reads long should
    // stretch its B-roll, not lose its last sentence.
    const actual = mediaDuration(seg.generatedNarrationPath);
    if (actual > 0) seg.seconds = round(actual);
    generated++;
  }
  console.log(`[Assemble] narrated ${generated} voiceover take(s) with the cloned voice`);
  return plan;
}

/**
 * The timeline's length from the plan alone.
 *
 * A fallback for the envelope when ffprobe cannot read the joined file — the
 * bed's shape needs to know where the close begins, and a probe that returned 0
 * would put the close at a negative offset and flatten the envelope silently.
 */
export function plannedSeconds(plan) {
  return round((plan?.segments || []).reduce((n, s) => n + (s.seconds || 0), 0));
}

function round(n) {
  return Math.round(n * 100) / 100;
}
