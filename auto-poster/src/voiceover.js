/**
 * Voiceover Pipeline — detect speech, generate TTS via ElevenLabs, merge with ffmpeg
 */

import { execSync } from "child_process";
import { writeFileSync, readFileSync, unlinkSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { generateVoiceoverScript } from "./caption.js";

const VOICE_ID = "ymv1q5WLElzdmrHdtgsw"; // Peters pro voice
const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1";

/**
 * Detect if a video already has speech audio.
 * Uses ffprobe to check audio levels — if significant audio detected, assume speech.
 */
export function videoHasSpeech(videoPath) {
  try {
    // Check if video has an audio stream
    const result = execSync(
      `ffprobe -v error -select_streams a:0 -show_entries stream=codec_type -of csv=p=0 "${videoPath}"`,
      { encoding: "utf-8", timeout: 30000, stdio: ["pipe", "pipe", "pipe"] }
    ).trim();

    // If no audio stream, definitely no speech
    if (!result || !result.includes("audio")) {
      console.log("[Voiceover] No audio stream detected — will add voiceover");
      return false;
    }

    // Check audio volume using volumedetect filter
    const volResult = execSync(
      `ffmpeg -i "${videoPath}" -af "volumedetect" -f null /dev/null 2>&1`,
      { encoding: "utf-8", timeout: 60000 }
    );

    // Parse mean_volume from output
    const meanMatch = volResult.match(/mean_volume:\s*([-\d.]+)\s*dB/);
    if (meanMatch) {
      const meanVolume = parseFloat(meanMatch[1]);
      // If mean volume is above -35dB, likely has speech/music
      if (meanVolume > -35) {
        console.log(`[Voiceover] Audio detected (mean: ${meanVolume}dB) — skipping voiceover`);
        return true;
      }
      console.log(`[Voiceover] Audio very quiet (mean: ${meanVolume}dB) — will add voiceover`);
      return false;
    }

    // If we can't determine, assume it has speech (safer)
    console.log("[Voiceover] Could not determine audio level — assuming speech present");
    return true;
  } catch (err) {
    console.warn("[Voiceover] Audio detection failed:", err.message);
    // On error, assume speech present (safer to not double-voiceover)
    return true;
  }
}

/**
 * Get video duration in seconds.
 */
export function getVideoDuration(videoPath) {
  try {
    const result = execSync(
      `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${videoPath}"`,
      { encoding: "utf-8", timeout: 15000 }
    ).trim();
    return parseFloat(result) || 30;
  } catch {
    return 30;
  }
}

/**
 * Generate TTS audio using ElevenLabs API.
 * Returns the path to the generated MP3 file.
 */
async function generateTTS(script) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY not set");

  const res = await fetch(`${ELEVENLABS_BASE}/text-to-speech/${VOICE_ID}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": apiKey,
    },
    body: JSON.stringify({
      text: script,
      model_id: "eleven_multilingual_v2",
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0.4,
        use_speaker_boost: true,
      },
    }),
  });

  if (!res.ok) {
    const err = await res.text().then(t => t.slice(0, 200));
    throw new Error(`ElevenLabs TTS failed (${res.status}): ${err}`);
  }

  const audioBuffer = Buffer.from(await res.arrayBuffer());
  const outputPath = join(tmpdir(), `voiceover_${Date.now()}.mp3`);
  writeFileSync(outputPath, audioBuffer);

  console.log(`[Voiceover] TTS generated (${(audioBuffer.length / 1024).toFixed(0)} KB)`);
  return outputPath;
}

/**
 * Merge voiceover audio with video using ffmpeg.
 * Keeps original video audio at reduced volume, adds voiceover on top.
 */
function mergeAudioWithVideo(videoPath, audioPath) {
  const outputPath = join(tmpdir(), `merged_${Date.now()}.mp4`);

  // Mix: original audio at 20% volume + voiceover at full volume
  const cmd = `ffmpeg -y -i "${videoPath}" -i "${audioPath}" -filter_complex "[0:a]volume=0.2[bg];[1:a]adelay=500|500[vo];[bg][vo]amix=inputs=2:duration=first:dropout_transition=2[a]" -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k -shortest "${outputPath}" 2>&1`;

  try {
    execSync(cmd, { encoding: "utf-8", timeout: 120000 });
    console.log(`[Voiceover] Merged video created: ${outputPath}`);
    return outputPath;
  } catch (err) {
    // If original has no audio, just add voiceover as the only audio track
    const fallbackCmd = `ffmpeg -y -i "${videoPath}" -i "${audioPath}" -map 0:v -map 1:a -c:v copy -c:a aac -b:a 192k -shortest "${outputPath}" 2>&1`;
    try {
      execSync(fallbackCmd, { encoding: "utf-8", timeout: 120000 });
      console.log(`[Voiceover] Merged video (no original audio): ${outputPath}`);
      return outputPath;
    } catch (err2) {
      throw new Error(`ffmpeg merge failed: ${err2.message}`);
    }
  }
}

/**
 * Full voiceover pipeline:
 * 1. Check if video has speech → skip if yes
 * 2. Generate script via Claude
 * 3. Generate TTS via ElevenLabs
 * 4. Merge with video via ffmpeg
 * Returns the path to the final video (original or merged).
 */
export async function processVoiceover(videoPath, city, dryRun = false) {
  // Step 1: Check for existing speech
  if (videoHasSpeech(videoPath)) {
    console.log("[Voiceover] Video already has speech — using original");
    return { videoPath, skipped: true, reason: "speech_detected" };
  }

  if (dryRun) {
    console.log("[Voiceover] DRY RUN — would generate voiceover");
    return { videoPath, skipped: false, reason: "dry_run" };
  }

  // Step 2: Get video duration and generate script
  const duration = getVideoDuration(videoPath);
  const script = await generateVoiceoverScript(city, duration);
  console.log(`[Voiceover] Script: "${script.slice(0, 80)}..."`);

  // Step 3: Generate TTS
  const audioPath = await generateTTS(script);

  // Step 4: Merge
  const mergedPath = mergeAudioWithVideo(videoPath, audioPath);

  // Cleanup TTS temp file
  try { unlinkSync(audioPath); } catch {}

  return { videoPath: mergedPath, skipped: false, script };
}

/**
 * Cleanup temp files.
 */
export function cleanup(...paths) {
  for (const p of paths) {
    try {
      if (p && existsSync(p)) unlinkSync(p);
    } catch {}
  }
}
