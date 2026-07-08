/**
 * Voiceover Render Pipeline
 *
 * Handles the full render chain:
 * 1. TTS generation via ElevenLabs (with word timestamps)
 * 2. Duration comparison & atempo adjustment (±5%)
 * 3. Video assembly: voiceover + ducked/muted original audio
 * 4. Loudness normalization to -14 LUFS
 * 5. Caption burn-in (word-by-word, bold, centered lower-third)
 *
 * Uses @ffmpeg-installer/ffmpeg and @ffprobe-installer/ffprobe npm packages
 * so this works in production (Cloud Run, Node-only) without system ffmpeg.
 */

import { execSync } from "child_process";
import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { generateSpeechWithTimestamps } from "./elevenlabs";
import { storagePut } from "./storage";
import { getFFmpegPath, getFFprobePath } from "./ffmpegPaths";
import { stripDeliveryTags } from "./voiceoverScript";

const WORK_DIR = "/tmp/voiceover-render";
const LUFS_TARGET = -14;
const ATEMPO_MIN = 0.95;
const ATEMPO_MAX = 1.05;

// Ensure work directory exists
if (!existsSync(WORK_DIR)) mkdirSync(WORK_DIR, { recursive: true });

export interface RenderOptions {
  /** Path to the source video file (downloaded from Drive/S3) */
  sourceVideoPath: string;
  /** The approved voiceover script */
  script: string;
  /** "duck" (reduce original to 15-20%) or "mute" (remove original audio) */
  originalAudioMode: "duck" | "mute";
  /** Unique job ID for temp file naming */
  jobId: number;
}

export interface RenderResult {
  /** Path to the final rendered video */
  outputPath: string;
  /** Audio duration in seconds */
  audioDurationSec: number;
  /** Video duration in seconds */
  videoDurationSec: number;
  /** Duration mismatch percentage */
  durationMismatchPct: number;
  /** Whether atempo was applied */
  atempoApplied: boolean;
  /** Characters used for TTS */
  charactersUsed: number;
  /** S3 storage key for the audio file */
  audioStorageKey: string;
}

/**
 * Execute the full render pipeline.
 */
export async function renderVoiceover(options: RenderOptions): Promise<RenderResult> {
  const { sourceVideoPath, script, originalAudioMode, jobId } = options;
  const prefix = join(WORK_DIR, `job_${jobId}`);

  // Resolve binary paths from npm packages
  const FFMPEG = getFFmpegPath();
  const FFPROBE = getFFprobePath();
  console.log(`[VoRender] Using ffmpeg: ${FFMPEG}`);
  console.log(`[VoRender] Using ffprobe: ${FFPROBE}`);

  // Clean up any previous attempt
  cleanupJobFiles(prefix);

  try {
    // Step 1: Get video duration
    const videoDurationSec = getMediaDuration(sourceVideoPath, FFPROBE);
    console.log(`[VoRender] Video duration: ${videoDurationSec}s`);

    // Step 2: Generate TTS with timestamps
    // Safety net: strip any bracket tags that slipped through script generation
    const cleanScript = stripDeliveryTags(script);
    console.log(`[VoRender] Generating TTS (${cleanScript.length} chars)...`);
    const { audio, charactersUsed, alignment } = await generateSpeechWithTimestamps(cleanScript);
    const audioPath = `${prefix}_tts.mp3`;
    writeFileSync(audioPath, audio);
    console.log(`[VoRender] TTS generated: ${audio.length} bytes`);

    // Step 3: Trim silence from TTS audio (removes dead space between sentences)
    const trimmedPath = `${prefix}_trimmed.mp3`;
    execSync(
      `"${FFMPEG}" -y -i "${audioPath}" -af "silenceremove=start_periods=1:start_silence=0.1:start_threshold=-40dB,areverse,silenceremove=start_periods=1:start_silence=0.1:start_threshold=-40dB,areverse,compand=attacks=0:points=-80/-80|-45/-25|-27/-15|0/-7|20/-7:gain=3" "${trimmedPath}"`,
      { timeout: 60000 }
    );
    const trimmedExists = existsSync(trimmedPath);
    const workingAudioPath = trimmedExists ? trimmedPath : audioPath;
    if (trimmedExists) {
      console.log(`[VoRender] Trimmed silence from TTS audio`);
    }

    // Step 4: Check audio duration and apply atempo if needed
    const rawAudioDuration = getMediaDuration(workingAudioPath, FFPROBE);
    console.log(`[VoRender] Audio duration (after trim): ${rawAudioDuration}s vs video: ${videoDurationSec}s`);

    const durationRatio = rawAudioDuration / videoDurationSec;
    const durationMismatchPct = Math.round((durationRatio - 1) * 100);
    let finalAudioPath = workingAudioPath;
    let atempoApplied = false;

    if (durationRatio > ATEMPO_MAX || durationRatio < ATEMPO_MIN) {
      // Beyond ±5% — flag as mismatch but still try to render
      console.log(`[VoRender] Duration mismatch: ${durationMismatchPct}% (beyond ±5% tolerance)`);
      // Still apply atempo to best-fit
      const atempoValue = Math.max(ATEMPO_MIN, Math.min(ATEMPO_MAX, durationRatio));
      finalAudioPath = `${prefix}_tempo.mp3`;
      execSync(
        `"${FFMPEG}" -y -i "${workingAudioPath}" -filter:a "atempo=${atempoValue}" "${finalAudioPath}"`,
        { timeout: 60000 }
      );
      atempoApplied = true;
    } else if (Math.abs(durationMismatchPct) > 1) {
      // Within ±5% — apply atempo to match exactly
      const atempoValue = durationRatio;
      finalAudioPath = `${prefix}_tempo.mp3`;
      execSync(
        `"${FFMPEG}" -y -i "${workingAudioPath}" -filter:a "atempo=${atempoValue}" "${finalAudioPath}"`,
        { timeout: 60000 }
      );
      atempoApplied = true;
      console.log(`[VoRender] Applied atempo=${atempoValue.toFixed(4)}`);
    }

    const finalAudioDuration = getMediaDuration(finalAudioPath, FFPROBE);

    // Step 4: Generate ASS captions from word timestamps (ASS supports reliable positioning)
    const srtPath = `${prefix}_captions.ass`;
    // timeScale adjusts timestamps to match the tempo-adjusted audio.
    // If atempo was applied, scale = 1/atempoValue (inverse of speed change).
    // If no atempo, timestamps are already correct (scale=1).
    const actualAtempoValue = atempoApplied
      ? Math.max(ATEMPO_MIN, Math.min(ATEMPO_MAX, durationRatio))
      : 1;
    const timeScale = atempoApplied ? 1 / actualAtempoValue : 1;
    generateASS(alignment, srtPath, timeScale);

    // Step 5: Assemble final video
    const outputPath = `${prefix}_final.mp4`;
    assembleVideo({
      sourceVideoPath,
      voiceoverAudioPath: finalAudioPath,
      srtPath,
      outputPath,
      originalAudioMode,
      ffmpegPath: FFMPEG,
    });
    console.log(`[VoRender] Final video assembled: ${outputPath}`);

        // Step 6: Upload audio to S3 for caching
    const audioKeyInput = `voiceover-audio/job_${jobId}.mp3`;
    const { key: audioStorageKey } = await storagePut(audioKeyInput, readFileSync(finalAudioPath), "audio/mpeg");
    return {
      outputPath,
      audioDurationSec: finalAudioDuration,
      videoDurationSec,
      durationMismatchPct,
      atempoApplied,
      charactersUsed,
      audioStorageKey,
    };
  } catch (err) {
    cleanupJobFiles(prefix);
    throw err;
  }
}

/**
 * Generate ASS subtitle file from word-level timestamps.
 * ASS format gives us reliable positioning control (top-center).
 * Groups words into 3-5 word chunks for readable captions.
 */
function generateASS(
  alignment: { words: string[]; wordStartTimesMs: number[]; wordEndTimesMs: number[] },
  outputPath: string,
  timeScale: number = 1
): void {
  const { words, wordStartTimesMs, wordEndTimesMs } = alignment;

  if (!words.length || !wordStartTimesMs.length) {
    writeFileSync(outputPath, "");
    return;
  }

  // ASS header with style: top-center (Alignment=8), white bold text, black outline
  // PlayResX/Y match 1080x1920 (9:16 portrait video)
  // MarginV=80 pushes text comfortably below the very top edge
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,40,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,3,0,8,20,20,250,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const WORDS_PER_CHUNK = 4;
  const dialogueLines: string[] = [];

  for (let i = 0; i < words.length; i += WORDS_PER_CHUNK) {
    const chunkWords = words.slice(i, i + WORDS_PER_CHUNK);
    const startMs = Math.round(wordStartTimesMs[i] * timeScale);
    const endIdx = Math.min(i + WORDS_PER_CHUNK - 1, words.length - 1);
    const endMs = Math.round(wordEndTimesMs[endIdx] * timeScale);

    // Filter out delivery tags from display
    const displayWords = chunkWords.filter(w => !w.match(/^\[[\w]+\]$/));
    if (displayWords.length === 0) continue;

    const text = displayWords.join(" ").toUpperCase();
    const start = formatASSTime(startMs);
    const end = formatASSTime(endMs);
    dialogueLines.push(`Dialogue: 0,${start},${end},Default,,0,0,0,,${text}`);
  }

  writeFileSync(outputPath, header + dialogueLines.join("\n") + "\n", "utf-8");
}

function formatASSTime(ms: number): string {
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const centis = Math.floor((ms % 1000) / 10);
  return `${hours}:${pad(minutes)}:${pad(seconds)}.${pad(centis)}`;
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

/**
 * Assemble the final video with voiceover + captions.
 */
function assembleVideo(opts: {
  sourceVideoPath: string;
  voiceoverAudioPath: string;
  srtPath: string;
  outputPath: string;
  originalAudioMode: "duck" | "mute";
  ffmpegPath: string;
}): void {
  const { sourceVideoPath, voiceoverAudioPath, srtPath, outputPath, originalAudioMode, ffmpegPath } = opts;

  // Build the ffmpeg filter chain
  let audioFilter: string;

  if (originalAudioMode === "mute") {
    // Replace original audio entirely with voiceover
    audioFilter = `[1:a]loudnorm=I=${LUFS_TARGET}:TP=-1:LRA=11[vo]`;
  } else {
    // Duck original audio to 15% and mix with voiceover
    audioFilter = [
      `[0:a]volume=0.15[orig]`,
      `[1:a]loudnorm=I=${LUFS_TARGET}:TP=-1:LRA=11[vo]`,
      `[orig][vo]amix=inputs=2:duration=first:dropout_transition=2[mixed]`,
    ].join(";");
  }

  const audioOutput = originalAudioMode === "mute" ? "[vo]" : "[mixed]";

  // Styles are embedded in the ASS file itself (top-center, white bold, black outline)

  // Escape the ASS path for ffmpeg (handle special characters)
  const escapedSrtPath = srtPath.replace(/'/g, "'\\''").replace(/:/g, "\\:");

  let cmd: string;
  if (existsSync(srtPath) && readFileSync(srtPath, "utf-8").trim().length > 0) {
    // With captions — must re-encode video to burn in subtitles
    // CRITICAL: Do NOT force color space conversion. The source may be HDR (bt2020/HLG/10-bit).
    // Forcing bt709 crushes dynamic range and changes brightness.
    // Instead: re-encode at high quality preserving original pixel format and color metadata.
    cmd = [
      `"${ffmpegPath}" -y -i "${sourceVideoPath}" -i "${voiceoverAudioPath}"`,
      `-filter_complex "${audioFilter}"`,
      `-vf "ass='${escapedSrtPath}'"`,
      `-map 0:v -map "${audioOutput}"`,
      `-c:v libx264 -preset medium -crf 16`,
      `-c:a aac -b:a 192k`,
      `-movflags +faststart`,
      `"${outputPath}"`,
    ].join(" ");
  } else {
    // Without captions — copy video stream directly (zero quality loss)
    cmd = [
      `"${ffmpegPath}" -y -i "${sourceVideoPath}" -i "${voiceoverAudioPath}"`,
      `-filter_complex "${audioFilter}"`,
      `-map 0:v -map "${audioOutput}"`,
      `-c:v copy -c:a aac -b:a 192k`,
      `-movflags +faststart`,
      `"${outputPath}"`,
    ].join(" ");
  }

  console.log(`[VoRender] Running ffmpeg assembly...`);
  execSync(cmd, { timeout: 600000 }); // 10 min timeout for 4K video
}

/**
 * Get media file duration in seconds.
 */
function getMediaDuration(filePath: string, ffprobePath: string): number {
  const result = execSync(
    `"${ffprobePath}" -v quiet -show_entries format=duration -of csv=p=0 "${filePath}"`,
    { encoding: "utf-8", timeout: 15000 }
  ).trim();
  return Math.round(parseFloat(result));
}

/**
 * Clean up temporary files for a job.
 */
function cleanupJobFiles(prefix: string): void {
  const suffixes = ["_tts.mp3", "_trimmed.mp3", "_tempo.mp3", "_captions.ass", "_final.mp4"];
  for (const suffix of suffixes) {
    const path = `${prefix}${suffix}`;
    if (existsSync(path)) {
      try { unlinkSync(path); } catch { /* ignore */ }
    }
  }
}
