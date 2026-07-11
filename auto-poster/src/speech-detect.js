/**
 * Speech Detection via Whisper — replaces the volume-only approach.
 * 
 * Flow:
 * 1. Fast pre-filter: check if audio exists and volume level (silent → skip Whisper)
 * 2. If audio present: run Whisper tiny model via Python script
 * 3. Return: { hasSpeech, hasMusic, transcript, confidence }
 * 
 * Decision matrix:
 * - Actual speech detected → skip voiceover (unchanged)
 * - Audio but NO speech (music only) → ADD voiceover (duck music to 20%)
 * - No audio at all → ADD voiceover (unchanged)
 * - Whisper error/ambiguous → assume speech present (fail-safe, never double voices)
 */
import { execSync } from "child_process";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DETECT_SCRIPT = join(__dirname, "..", "scripts", "detect-speech.py");

/**
 * Detect audio characteristics of a video.
 * @returns {{ hasSpeech: boolean, hasMusic: boolean, silent: boolean, transcript?: string, confidence: number }}
 */
export function detectSpeech(videoPath) {
  // ─── Step 1: Fast pre-filter — check if audio stream exists ─────────────
  let hasAudioStream = false;
  let meanVolume = -100;

  try {
    const result = execSync(
      `ffprobe -v error -select_streams a:0 -show_entries stream=codec_type -of csv=p=0 "${videoPath}"`,
      { encoding: "utf-8", timeout: 30000, stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
    hasAudioStream = result.includes("audio");
  } catch {
    hasAudioStream = false;
  }

  if (!hasAudioStream) {
    console.log("[SpeechDetect] No audio stream — silent video");
    return { hasSpeech: false, hasMusic: false, silent: true, confidence: 1.0 };
  }

  // Check volume level
  try {
    const volResult = execSync(
      `ffmpeg -i "${videoPath}" -af "volumedetect" -f null /dev/null 2>&1`,
      { encoding: "utf-8", timeout: 60000 }
    );
    const meanMatch = volResult.match(/mean_volume:\s*([-\d.]+)\s*dB/);
    if (meanMatch) {
      meanVolume = parseFloat(meanMatch[1]);
    }
  } catch {}

  // If audio is extremely quiet (< -50dB), it's effectively silent — skip Whisper
  if (meanVolume < -50) {
    console.log(`[SpeechDetect] Audio nearly silent (mean: ${meanVolume}dB) — treating as silent`);
    return { hasSpeech: false, hasMusic: false, silent: true, confidence: 0.95 };
  }

  // ─── Step 2: Run Whisper via Python script ──────────────────────────────
  console.log(`[SpeechDetect] Audio detected (mean: ${meanVolume}dB) — running Whisper...`);

  try {
    const output = execSync(
      `python3 "${DETECT_SCRIPT}" "${videoPath}"`,
      { encoding: "utf-8", timeout: 120000, stdio: ["pipe", "pipe", "pipe"] }
    ).trim();

    const result = JSON.parse(output);

    if (result.error) {
      console.warn(`[SpeechDetect] Whisper error: ${result.error} — assuming speech (fail-safe)`);
      return { hasSpeech: true, hasMusic: false, silent: false, confidence: 0.5, error: result.error };
    }

    const hasSpeech = result.has_speech === true;
    // If no speech but audio is present (mean > -35dB), it's likely music
    const hasMusic = !hasSpeech && meanVolume > -35;

    console.log(`[SpeechDetect] Whisper result: speech=${hasSpeech}, music=${hasMusic}, words=${result.word_count}, conf=${result.confidence}`);
    if (result.transcript) {
      console.log(`[SpeechDetect] Transcript: "${result.transcript.slice(0, 100)}${result.transcript.length > 100 ? '...' : ''}"`);
    }

    return {
      hasSpeech,
      hasMusic,
      silent: false,
      transcript: result.transcript,
      confidence: result.confidence,
      wordCount: result.word_count,
      isHallucination: result.is_hallucination,
    };
  } catch (err) {
    // Whisper failed — fail-safe: assume speech present
    console.warn(`[SpeechDetect] Whisper execution failed: ${err.message?.slice(0, 100)} — assuming speech (fail-safe)`);
    return { hasSpeech: true, hasMusic: false, silent: false, confidence: 0.5, error: err.message };
  }
}
