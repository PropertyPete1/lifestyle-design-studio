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

/** How far under the narration the music bed sits. */
const MUSIC_BED_VOLUME = 0.25;

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
 * Duck a music bed under the narration.
 *
 * sidechaincompress keyed off the narration itself, so the bed drops when he
 * speaks and comes back when he does not — rather than sitting at one low
 * volume for twelve minutes, which sounds like a mistake.
 */
export function duckArgs(videoIn, musicIn, output) {
  return [
    "-y", "-i", videoIn, "-i", musicIn,
    "-filter_complex",
    `[1:a]volume=${MUSIC_BED_VOLUME}[bed];` +
      `[0:a]asplit=2[vo1][vo2];` +
      `[bed][vo1]sidechaincompress=threshold=0.05:ratio=12:attack=20:release=400[ducked];` +
      `[vo2][ducked]amix=inputs=2:duration=first:dropout_transition=0[aout]`,
    "-map", "0:v", "-map", "[aout]",
    "-c:v", "copy", "-c:a", "aac", "-b:a", AUDIO_BITRATE,
    "-movflags", "+faststart",
    output,
  ];
}

/** Burn the caption track. A full re-encode — the second most expensive stage. */
export function burnArgs(videoIn, assPath, output) {
  return [
    "-y", "-i", videoIn,
    "-vf", `ass=${assPath}`,
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

function ffmpeg(args, timeoutMs = 60 * 60_000) {
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
export async function renderTimeline(plan, { workDir, resolveBrollPath, musicPath = null, resolution = RESOLUTION, openingOverlay = null } = {}) {
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
        // Peter's own clip carries its own audio, so it only needs the canvas.
        const visual = `${base}_v.mp4`;
        ffmpeg(normalizeArgs(seg.source, visual, dim, { seconds: seg.seconds }));
        const withAudio = `${base}.mp4`;
        ffmpeg([
          "-y", "-i", visual, "-i", seg.source,
          "-map", "0:v", "-map", "1:a?",
          "-t", String(seg.seconds),
          "-c:v", "copy", ...segmentAudioArgs(),
          withAudio,
        ]);
        rmSync(visual, { force: true });

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

      const narration = seg.narrationSource || seg.generatedNarrationPath;
      if (!narration) throw new Error(`voiceover take ${seg.takeId} has no narration audio`);
      const withAudio = `${base}.mp4`;
      ffmpeg(muxNarrationArgs(visual, narration, withAudio));

      pieces.forEach((p) => rmSync(p, { force: true }));
      rmSync(visual, { force: true });
      rmSync(listFile, { force: true });
      segmentFiles.push(withAudio);
    });
  });

  // ── 2. concat ────────────────────────────────────────────────────────────
  const concatList = join(dir, "concat.txt");
  writeFileSync(concatList, segmentFiles.map((p) => `file '${p}'`).join("\n"));
  const joined = join(dir, "joined.mp4");
  t("concat", () => ffmpeg(concatArgs(concatList, joined)));

  // ── 3. music bed, if there is one ────────────────────────────────────────
  let mixed = joined;
  if (musicPath && existsSync(musicPath)) {
    mixed = join(dir, "mixed.mp4");
    t("duck", () => ffmpeg(duckArgs(joined, musicPath, mixed)));
  } else {
    console.log("[Assemble] no music bed supplied — narration only");
  }

  // ── 4. captions ──────────────────────────────────────────────────────────
  const assPath = join(dir, "captions.ass");
  const chunks = buildCaptionChunks(plan);
  writeFileSync(assPath, buildAssFile(chunks, dim));
  const finalPath = join(dir, "final.mp4");
  t("captions", () => ffmpeg(burnArgs(mixed, assPath, finalPath)));

  const seconds = mediaDuration(finalPath);
  const bytes = statSync(finalPath).size;
  console.log(
    `[Assemble] done: ${(seconds / 60).toFixed(1)} min, ${(bytes / 1024 / 1024).toFixed(1)} MB, ` +
    `${chunks.length} caption chunks`
  );
  return { outputPath: finalPath, seconds, bytes, chunkCount: chunks.length, stages };
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

function round(n) {
  return Math.round(n * 100) / 100;
}
