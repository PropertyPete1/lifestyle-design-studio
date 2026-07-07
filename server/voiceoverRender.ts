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

    // Step 3: Check audio duration and apply atempo if needed
    const rawAudioDuration = getMediaDuration(audioPath, FFPROBE);
    console.log(`[VoRender] Raw audio duration: ${rawAudioDuration}s vs video: ${videoDurationSec}s`);

    const durationRatio = rawAudioDuration / videoDurationSec;
    const durationMismatchPct = Math.round((durationRatio - 1) * 100);
    let finalAudioPath = audioPath;
    let atempoApplied = false;

    if (durationRatio > ATEMPO_MAX || durationRatio < ATEMPO_MIN) {
      // Beyond ±5% — flag as mismatch but still try to render
      console.log(`[VoRender] Duration mismatch: ${durationMismatchPct}% (beyond ±5% tolerance)`);
      // Still apply atempo to best-fit
      const atempoValue = Math.max(ATEMPO_MIN, Math.min(ATEMPO_MAX, durationRatio));
      finalAudioPath = `${prefix}_tempo.mp3`;
      execSync(
        `"${FFMPEG}" -y -i "${audioPath}" -filter:a "atempo=${atempoValue}" "${finalAudioPath}"`,
        { timeout: 60000 }
      );
      atempoApplied = true;
    } else if (Math.abs(durationMismatchPct) > 1) {
      // Within ±5% — apply atempo to match exactly
      const atempoValue = durationRatio;
      finalAudioPath = `${prefix}_tempo.mp3`;
      execSync(
        `"${FFMPEG}" -y -i "${audioPath}" -filter:a "atempo=${atempoValue}" "${finalAudioPath}"`,
        { timeout: 60000 }
      );
      atempoApplied = true;
      console.log(`[VoRender] Applied atempo=${atempoValue.toFixed(4)}`);
    }

    const finalAudioDuration = getMediaDuration(finalAudioPath, FFPROBE);

    // Step 4: Generate SRT captions from word timestamps
    const srtPath = `${prefix}_captions.srt`;
    generateSRT(alignment, srtPath, atempoApplied ? videoDurationSec / rawAudioDuration : 1);

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
    const audioStorageKey = `voiceover-audio/job_${jobId}.mp3`;
    await storagePut(audioStorageKey, readFileSync(finalAudioPath), "audio/mpeg");

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
 * Generate SRT subtitle file from word-level timestamps.
 * Groups words into 3-5 word chunks for readable captions.
 */
function generateSRT(
  alignment: { words: string[]; wordStartTimesMs: number[]; wordEndTimesMs: number[] },
  outputPath: string,
  timeScale: number = 1
): void {
  const { words, wordStartTimesMs, wordEndTimesMs } = alignment;

  if (!words.length || !wordStartTimesMs.length) {
    // Fallback: empty SRT
    writeFileSync(outputPath, "");
    return;
  }

  const WORDS_PER_CHUNK = 4;
  const lines: string[] = [];
  let idx = 1;

  for (let i = 0; i < words.length; i += WORDS_PER_CHUNK) {
    const chunkWords = words.slice(i, i + WORDS_PER_CHUNK);
    const startMs = Math.round(wordStartTimesMs[i] * timeScale);
    const endIdx = Math.min(i + WORDS_PER_CHUNK - 1, words.length - 1);
    const endMs = Math.round(wordEndTimesMs[endIdx] * timeScale);

    // Filter out delivery tags from display
    const displayWords = chunkWords.filter(w => !w.match(/^\[[\w]+\]$/));
    if (displayWords.length === 0) continue;

    lines.push(`${idx}`);
    lines.push(`${formatSRTTime(startMs)} --> ${formatSRTTime(endMs)}`);
    lines.push(displayWords.join(" ").toUpperCase());
    lines.push("");
    idx++;
  }

  writeFileSync(outputPath, lines.join("\n"), "utf-8");
}

function formatSRTTime(ms: number): string {
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const millis = ms % 1000;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad3(millis)}`;
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function pad3(n: number): string {
  return n.toString().padStart(3, "0");
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

  // Caption style: bold, white text, black outline, centered lower-third
  // Safe-zone aware (margin from bottom)
  const subtitleStyle = "FontName=Arial,FontSize=22,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2,Shadow=0,Alignment=2,MarginV=80";

  // Escape the SRT path for ffmpeg (handle special characters)
  const escapedSrtPath = srtPath.replace(/'/g, "'\\''").replace(/:/g, "\\:");

  let cmd: string;
  if (existsSync(srtPath) && readFileSync(srtPath, "utf-8").trim().length > 0) {
    // With captions
    cmd = [
      `"${ffmpegPath}" -y -i "${sourceVideoPath}" -i "${voiceoverAudioPath}"`,
      `-filter_complex "${audioFilter}"`,
      `-vf "subtitles='${escapedSrtPath}':force_style='${subtitleStyle}'"`,
      `-map 0:v -map "${audioOutput}"`,
      `-c:v libx264 -preset medium -crf 18 -c:a aac -b:a 192k`,
      `-movflags +faststart`,
      `"${outputPath}"`,
    ].join(" ");
  } else {
    // Without captions (fallback if SRT is empty)
    cmd = [
      `"${ffmpegPath}" -y -i "${sourceVideoPath}" -i "${voiceoverAudioPath}"`,
      `-filter_complex "${audioFilter}"`,
      `-map 0:v -map "${audioOutput}"`,
      `-c:v libx264 -preset medium -crf 18 -c:a aac -b:a 192k`,
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
  const suffixes = ["_tts.mp3", "_tempo.mp3", "_captions.srt", "_final.mp4"];
  for (const suffix of suffixes) {
    const path = `${prefix}${suffix}`;
    if (existsSync(path)) {
      try { unlinkSync(path); } catch { /* ignore */ }
    }
  }
}
