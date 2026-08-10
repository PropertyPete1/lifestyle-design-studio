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

import { execFileSync } from "child_process";
import { writeFileSync, existsSync, mkdirSync, statSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { generateTTS, postProcessVoiceoverAudio } from "./voiceover.js";
import { RESOLUTION } from "./yt-config.js";
import { kenBurnsArgs } from "./yt-visual-broll.js";
import { renderOverlayPng, burnOverlayArgs } from "./yt-opening.js";
import { pieceArgs } from "./yt-oncamera-edit.js";
import { pipCompositeArgs } from "./yt-pip.js";
import { renderPunchPng } from "./yt-punch.js";
import { bedEnvelope } from "./yt-music.js";
import { ensureSfxKit, mixSfxArgs, punchSfxTimeline } from "./yt-sfx.js";

export const CANVAS = {
  "1080p": { w: 1920, h: 1080 },
  "4k": { w: 3840, h: 2160 },
};

/** Constant rate factor and preset, matching the probe. */
const CRF = 20;
const PRESET = "veryfast";
const FPS = 30;
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
 */
export function conformArgs(input, output, dim, { seconds, fps = FPS } = {}) {
  return [
    "-y",
    "-stream_loop", "-1",
    "-i", input,
    "-t", String(seconds),
    "-vf",
    `scale=${dim.w}:${dim.h}:force_original_aspect_ratio=decrease,` +
      `pad=${dim.w}:${dim.h}:(ow-iw)/2:(oh-ih)/2:color=black,fps=${fps},setsar=1`,
    "-c:v", "libx264",
    "-preset", PRESET,
    "-crf", String(CRF),
    "-pix_fmt", "yuv420p",
    "-an",
    output,
  ];
}

/** Mux one narration track onto a silent visual segment. */
export function muxNarrationArgs(videoIn, audioIn, output) {
  return [
    "-y", "-i", videoIn, "-i", audioIn,
    "-map", "0:v", "-map", "1:a",
    "-c:v", "copy", ...segmentAudioArgs(),
    // The visual is cut to the narration's length upstream, but -shortest is
    // the belt to that braces: a narration overrun would otherwise freeze the
    // last frame for however long it ran over.
    "-shortest",
    output,
  ];
}

/** Concat pre-normalised segments. Same codec and canvas throughout, so this is a copy. */
export function concatArgs(listFile, output) {
  return ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", output];
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
export function duckArgs(videoIn, musicIn, output, { envelope = null } = {}) {
  const level = envelope?.expr
    ? `volume=eval=frame:volume='${envelope.expr}'`
    : `volume=${envelope?.body ?? 0.25}`;
  return [
    "-y", "-i", videoIn, "-i", musicIn,
    "-filter_complex",
    `[1:a]${level}[bed];` +
      `[0:a]asplit=2[vo1][vo2];` +
      `[bed][vo1]sidechaincompress=threshold=0.05:ratio=12:attack=20:release=400[ducked];` +
      `[vo2][ducked]amix=inputs=2:duration=first:dropout_transition=0[aout]`,
    "-map", "0:v", "-map", "[aout]",
    "-c:v", "copy", "-c:a", "aac", "-b:a", AUDIO_BITRATE,
    "-movflags", "+faststart",
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
      "-vf", `ass=${assPath}`,
      "-c:v", "libx264", "-preset", PRESET, "-crf", String(CRF), "-pix_fmt", "yuv420p",
      "-c:a", "copy", "-movflags", "+faststart",
      output,
    ];
  }

  const inputs = [];
  for (const p of usable) inputs.push("-loop", "1", "-t", String(p.seconds), "-i", p.pngPath);

  // The captions burn FIRST so a punch sits over them rather than under them.
  // A caption drawn on top of the plate would be the card 7 picture exactly:
  // two pieces of text fighting in the middle of the frame.
  const chains = [`[0:v]ass=${assPath}[cap]`];
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
  // Braces open an override block in ASS; a stray one swallows the rest of the
  // line, so a caption containing "{" would silently lose its text.
  return String(text || "").replace(/[{}]/g, "").replace(/\r?\n/g, "\\N");
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
          edit.pieces.forEach((piece, pi) => {
            const out = `${base}_e${String(pi).padStart(3, "0")}.mp4`;
            ffmpeg(pieceArgs(seg.source, out, piece, dim, { fps: FPS }));
            pieceFiles.push(out);
          });
          const listFile = `${base}_edit.txt`;
          writeFileSync(listFile, pieceFiles.map((p) => `file '${p}'`).join("\n"));
          ffmpeg(concatArgs(listFile, withAudio));
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
            "-c:v", "copy", ...segmentAudioArgs(),
            withAudio,
          ]);
          rmSync(visual, { force: true });
        }

        // The opening overlay burns onto the FIRST segment only, and only when
        // that segment is on-camera — which planOpening has already guaranteed.
        // Burning here rather than after the concat keeps the filter operating
        // on a 20-second file instead of a twelve-minute one.
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
      const pieces = [];
      seg.broll.forEach((b, bi) => {
        const piece = `${base}_b${bi}.mp4`;

        // A generated map or card is a still, so it gets a slow push rather
        // than the normalise-and-pillarbox path — it is already the right
        // aspect and the right size, and running it through `scale` would only
        // cost a resample.
        // Revision 3: animated graphics, kinetic typography and graded stock
        // arrive as finished CLIPS rather than stills. They are already the
        // right size, rate and length, so they are conformed for concat and
        // nothing else — pushing a clip that already moves would be a second
        // camera move fighting the first.
        if (b.preRendered) {
          if (!existsSync(b.sourcePath)) return;
          ffmpeg(conformArgs(b.sourcePath, piece, dim, { seconds: b.seconds, fps: FPS }));
          pieces.push(piece);
          return;
        }

        if (b.generated) {
          if (!existsSync(b.sourcePath)) return;
          ffmpeg(kenBurnsArgs(b.sourcePath, piece, { seconds: b.seconds, dim, fps: FPS }));
          pieces.push(piece);
          return;
        }

        const src = resolveBrollPath(b.driveFileId);
        if (!src) return;
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
      ffmpeg(muxNarrationArgs(picture, narration, withAudio));

      pieces.forEach((p) => rmSync(p, { force: true }));
      rmSync(picture, { force: true });
      rmSync(listFile, { force: true });
      segmentFiles.push(withAudio);
    });
  });

  // ── 2. concat ────────────────────────────────────────────────────────────
  const concatList = join(dir, "concat.txt");
  writeFileSync(concatList, segmentFiles.map((p) => `file '${p}'`).join("\n"));
  const joined = join(dir, "joined.mp4");
  t("concat", () => ffmpeg(concatArgs(concatList, joined)));

  // ── 3. the sound: punches, then the bed ──────────────────────────────────
  // The synthesised hits go in BEFORE the bed so the sidechain compressor sees
  // them as part of the programme it is ducking under, rather than sitting on
  // top of a mix that was already balanced without them.
  let scored = joined;
  const sfxTimeline = punchSfxTimeline(plan, punches);
  if (sfxTimeline.length > 0) {
    const kit = ensureSfxKit(dir, ffmpeg);
    if (kit) {
      const withSfx = join(dir, "sfx.mp4");
      try {
        t("sfx", () => ffmpeg(mixSfxArgs(joined, sfxTimeline, kit, withSfx)));
        scored = withSfx;
        console.log(`[Assemble] mixed ${sfxTimeline.length} synthesised hit(s)`);
      } catch (err) {
        // A failed SFX mix costs the sound, never the video.
        console.log(`::warning::the SFX mix failed (${err.message}) — the video ships without them`);
      }
    }
  }

  let mixed = scored;
  if (musicPath && existsSync(musicPath)) {
    mixed = join(dir, "mixed.mp4");
    const envelope = bedEnvelope({ seconds: mediaDuration(scored) || plannedSeconds(plan) });
    t("duck", () => ffmpeg(duckArgs(scored, musicPath, mixed, { envelope })));
    console.log(
      `[Assemble] music bed at ${envelope.body} ` +
        (envelope.shaped ? `lifting to ${envelope.lift} under the hook and from ${envelope.closeAt}s` : "(flat — too short to shape)")
    );
  } else {
    console.log("[Assemble] no music bed supplied — narration only");
  }

  // ── 4. captions, and the micro-punches in the same pass ──────────────────
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
  return { outputPath: finalPath, seconds, bytes, chunkCount: chunks.length, punches: plates, stages };
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
