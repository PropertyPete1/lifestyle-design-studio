/**
 * Voiceover Pipeline — detect speech via Whisper, generate TTS via ElevenLabs, merge with ffmpeg
 * 
 * Decision matrix (updated Jul 2026):
 *   Genuine human speech (confirmed by coherence check) → skip voiceover
 *   Whisper hallucination / garbled text → ADD voiceover (duck music to 12%)
 *   Lyrics detected → ADD voiceover (duck music to 12%)
 *   Audio but NO speech (music only) → ADD voiceover, duck music to 12%
 *   No audio at all → ADD voiceover
 *   Whisper error/ambiguous → assume speech (fail-safe, never double voices)
 */

import { execSync } from "child_process";
import { writeFileSync, readFileSync, unlinkSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import Anthropic from "@anthropic-ai/sdk";
import { generateVoiceoverScript } from "./caption.js";
import { detectSpeech } from "./speech-detect.js";

// Voice ID from env var (changeable without code edits) with hardcoded fallback
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "qnTRoadmcb87J7GRHnhG";
const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1";

// Background music ducking level (0.12 = 12% volume)
const DUCK_VOLUME = 0.12;

let anthropicClient = null;
function getAnthropicClient() {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropicClient;
}

/**
 * Coherence check: ask Claude Haiku whether a Whisper transcript is real speech
 * or garbled hallucination / song lyrics.
 * Returns "SPEECH" or "NOT_SPEECH"
 */
async function checkTranscriptCoherence(transcript) {
  try {
    const client = getAnthropicClient();
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 10,
      messages: [{
        role: "user",
        content: `Is this coherent human speech from someone talking, or garbled/hallucinated text or song lyrics? Answer with exactly one word: SPEECH or NOT_SPEECH.\n\nTranscript: "${transcript}"`
      }],
    });
    const answer = response.content[0].text.trim().toUpperCase();
    console.log(`[Voiceover] Coherence check: "${transcript.slice(0, 60)}..." → ${answer}`);
    return answer.includes("NOT_SPEECH") ? "NOT_SPEECH" : "SPEECH";
  } catch (err) {
    // On error, fail-safe: assume it's real speech (don't risk doubling voices)
    console.warn(`[Voiceover] Coherence check failed: ${err.message} — assuming SPEECH (fail-safe)`);
    return "SPEECH";
  }
}

/**
 * Detect if a video already has speech audio.
 * LEGACY: kept for backwards compatibility but processVoiceover now uses detectSpeech() directly.
 * Uses ffprobe to check audio levels — if significant audio detected, assume speech.
 */
export function videoHasSpeech(videoPath) {
  try {
    const result = execSync(
      `ffprobe -v error -select_streams a:0 -show_entries stream=codec_type -of csv=p=0 "${videoPath}"`,
      { encoding: "utf-8", timeout: 30000, stdio: ["pipe", "pipe", "pipe"] }
    ).trim();

    if (!result || !result.includes("audio")) {
      console.log("[Voiceover] No audio stream detected — will add voiceover");
      return false;
    }

    const volResult = execSync(
      `ffmpeg -i "${videoPath}" -af "volumedetect" -f null /dev/null 2>&1`,
      { encoding: "utf-8", timeout: 60000 }
    );

    const meanMatch = volResult.match(/mean_volume:\s*([-\d.]+)\s*dB/);
    if (meanMatch) {
      const meanVolume = parseFloat(meanMatch[1]);
      if (meanVolume > -35) {
        console.log(`[Voiceover] Audio detected (mean: ${meanVolume}dB) — skipping voiceover`);
        return true;
      }
      console.log(`[Voiceover] Audio very quiet (mean: ${meanVolume}dB) — will add voiceover`);
      return false;
    }

    console.log("[Voiceover] Could not determine audio level — assuming speech present");
    return true;
  } catch (err) {
    console.warn("[Voiceover] Audio detection failed:", err.message);
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

  console.log(`[Voiceover] Using voice ID: ${VOICE_ID}`);

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
 * Keeps original video audio at reduced volume (12%), adds voiceover on top.
 */
function mergeAudioWithVideo(videoPath, audioPath) {
  const outputPath = join(tmpdir(), `merged_${Date.now()}.mp4`);

  // Mix: original audio at 12% volume + voiceover at full volume
  const cmd = `ffmpeg -y -i "${videoPath}" -i "${audioPath}" -filter_complex "[0:a]volume=${DUCK_VOLUME}[bg];[1:a]adelay=500|500[vo];[bg][vo]amix=inputs=2:duration=first:dropout_transition=2[a]" -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k -shortest "${outputPath}" 2>&1`;

  try {
    execSync(cmd, { encoding: "utf-8", timeout: 120000 });
    console.log(`[Voiceover] Merged video created (music ducked to ${DUCK_VOLUME * 100}%): ${outputPath}`);
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
 * 1. Detect speech using Whisper (with volume pre-filter for speed)
 * 2. If Whisper claims speech → coherence check via Claude Haiku
 * 3. Generate script via Claude
 * 4. Generate TTS via ElevenLabs
 * 5. Merge with video via ffmpeg (duck music to 12%)
 * Returns the path to the final video (original or merged).
 */
export async function processVoiceover(videoPath, city, dryRun = false) {
  // Step 1: Detect speech using Whisper (with volume pre-filter)
  const detection = detectSpeech(videoPath);

  if (detection.hasSpeech) {
    // Whisper claims speech — but is it real or hallucinated?
    if (detection.error) {
      // Whisper error → fail-safe: assume speech, skip voiceover
      console.log(`[Voiceover] Whisper error (fail-safe skip) — assuming speech present`);
      return { videoPath, skipped: true, reason: "whisper_error_failsafe", detection };
    }

    // Step 2: Coherence check — ask Claude if this is real speech
    const transcript = detection.transcript || "";
    const coherence = await checkTranscriptCoherence(transcript);

    if (coherence === "SPEECH") {
      // Genuine human speech confirmed — skip voiceover
      console.log(`[Voiceover] Coherence confirmed SPEECH — skipping voiceover`);
      return { videoPath, skipped: true, reason: "speech_confirmed", detection };
    }

    // NOT_SPEECH — Whisper hallucinated or detected lyrics
    // Policy: ADD voiceover with music ducked
    const isLikelyLyrics = detection.confidence < 0.6 && (detection.wordCount || 0) < 50;
    const reason = isLikelyLyrics ? "lyrics_override_add_voiceover" : "hallucination_override_add_voiceover";
    console.log(`[Voiceover] Coherence says NOT_SPEECH (${reason}) — will ADD voiceover over ducked music`);
    // Fall through to voiceover generation below
    detection._overrideReason = reason;
  }

  // Reaching here means: no speech, music only, silent, OR coherence override
  if (detection.silent) {
    console.log("[Voiceover] Silent video — will add voiceover");
  } else if (detection.hasMusic || detection._overrideReason) {
    console.log(`[Voiceover] Music/lyrics detected — will add voiceover (ducking music to ${DUCK_VOLUME * 100}%)`);
  }

  if (dryRun) {
    console.log("[Voiceover] DRY RUN — would generate voiceover");
    return { videoPath, skipped: false, reason: detection._overrideReason || "dry_run", detection };
  }

  // Step 3: Get video duration and generate script
  const duration = getVideoDuration(videoPath);
  const script = await generateVoiceoverScript(city, duration);
  console.log(`[Voiceover] Script: "${script.slice(0, 80)}..."`);

  // Step 4: Generate TTS
  const audioPath = await generateTTS(script);

  // Step 5: Merge (ducks original audio to 12% automatically)
  const mergedPath = mergeAudioWithVideo(videoPath, audioPath);

  // NOTE: Do NOT delete audioPath here — caller needs it for burned captions (Whisper word timing).
  // Caller is responsible for cleanup via cleanup(audioPath) after caption burn.

  const reason = detection._overrideReason || (detection.silent ? "silent_add_voiceover" : "music_only_add_voiceover");
  return { videoPath: mergedPath, skipped: false, reason, script, detection, audioPath };
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
