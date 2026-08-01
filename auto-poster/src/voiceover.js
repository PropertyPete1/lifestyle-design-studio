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
import { writeFileSync, readFileSync, unlinkSync, existsSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import Anthropic from "@anthropic-ai/sdk";
import { generateVoiceoverScript } from "./caption.js";
import { detectSpeech } from "./speech-detect.js";
import { loadLog } from "./state.js";
import {
  resolveTempo,
  buildAudioFilterChain,
  resolveVoiceSettings,
  pickPersona,
  getRecentTranscripts,
  fitsInClip,
  availableAudioSeconds,
  requiredTempoToFit,
  TEMPO_MAX,
  SILENCE_KEEP_SEC,
} from "./voiceover-style.js";

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
      // Tuned for energetic marketer delivery; each knob documented in
      // voiceover-style.js and overridable via ELEVENLABS_STABILITY /
      // ELEVENLABS_STYLE / ELEVENLABS_SIMILARITY.
      voice_settings: resolveVoiceSettings(),
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

/** Duration of an audio/video file in seconds, or 0 if it can't be read. */
function getMediaDuration(path) {
  try {
    return parseFloat(
      execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${path}"`, {
        encoding: "utf-8",
        timeout: 30000,
      }).trim()
    ) || 0;
  } catch {
    return 0;
  }
}

/** Run the pacing chain at a specific tempo. Returns the output path or null. */
function runPacingPass(audioPath, tempo, outputPath) {
  const chain = buildAudioFilterChain(tempo);
  execSync(`ffmpeg -y -i "${audioPath}" -af "${chain}" -c:a libmp3lame -q:a 2 "${outputPath}" 2>&1`, {
    encoding: "utf-8",
    timeout: 60000,
  });
  if (!existsSync(outputPath) || statSync(outputPath).size < 1024) return null;
  return outputPath;
}

/**
 * Post-process the TTS MP3 for fast, dead-air-free delivery — and guarantee the
 * result actually fits inside the clip.
 *
 * Two passes in one ffmpeg invocation:
 *   1. silenceremove — collapse inter-sentence gaps down to ~250ms. ElevenLabs
 *      leaves long pauses that read as dead air over fast-cut listing footage.
 *   2. atempo — speed the whole read up (default 1.18x, VOICEOVER_TEMPO override,
 *      clamped 1.0–1.30 so it never becomes hard to understand).
 *
 * AUDIO ONLY. This runs on the MP3 before the merge, so it adds no video
 * re-encode generation — the merge still uses `-c:v copy`.
 *
 * FIT ENFORCEMENT (integration audit, issue #7): the merge uses
 * `amix=duration=first` + `-shortest`, so any audio past the clip length is
 * discarded silently — and the CTA is the last line of every script. Two
 * independent things can cause an overrun:
 *
 *   1. this post-process failing (it is best-effort, so the read stays at 1.0x
 *      while the word budget assumed 1.18x), and
 *   2. the model overshooting its word target, which is only a prompt
 *      instruction and is not enforced anywhere.
 *
 * Measuring the finished audio against the clip catches BOTH, so the fit check
 * is the authoritative gate rather than the word budget. If the read overruns we
 * re-run at exactly the tempo needed (still clamped to TEMPO_MAX); if even that
 * cannot fit it, we log loudly instead of letting the CTA vanish quietly.
 *
 * Still non-fatal: a pacing failure must never cost the whole post.
 */
export function postProcessVoiceoverAudio(audioPath, clipDurationSec = 0) {
  const tempo = resolveTempo();
  const outputPath = audioPath.replace(/\.mp3$/, "_fast.mp3");
  const hasClip = Number.isFinite(clipDurationSec) && clipDurationSec > 0;

  let current = audioPath;
  try {
    const before = statSync(audioPath).size;
    const produced = runPacingPass(audioPath, tempo, outputPath);
    if (!produced) {
      console.warn("[Voiceover] Post-process produced no usable audio — keeping original");
      try { unlinkSync(outputPath); } catch {}
    } else {
      const after = statSync(outputPath).size;
      console.log(`[Voiceover] Pacing: silence>${SILENCE_KEEP_SEC}s trimmed, tempo ${tempo}x (${(before / 1024).toFixed(0)}KB -> ${(after / 1024).toFixed(0)}KB)`);
      current = outputPath;
    }
  } catch (err) {
    console.warn(`[Voiceover] Audio post-process failed (non-fatal): ${err.message?.slice(0, 120)}`);
    try { unlinkSync(outputPath); } catch {}
  }

  // ─── Fit check ─────────────────────────────────────────────────────────────
  if (hasClip) {
    const audioSec = getMediaDuration(current);
    if (audioSec > 0 && !fitsInClip(audioSec, clipDurationSec)) {
      const available = availableAudioSeconds(clipDurationSec);
      console.warn(`[Voiceover] Read overruns the clip: ${audioSec.toFixed(1)}s of audio vs ${available.toFixed(1)}s available — CTA would be cut`);

      // The retry re-paces from the ORIGINAL audio (so tempo is never applied
      // twice), which means the required multiplier must be computed against the
      // ORIGINAL duration too. Deriving it from the already-paced duration
      // understates it and produces a retry that still overruns.
      const originalSec = getMediaDuration(audioPath) || audioSec;
      const needed = requiredTempoToFit(originalSec, clipDurationSec);
      const retryTempo = Math.min(TEMPO_MAX, needed * 1.02); // 2% safety margin
      const retryPath = audioPath.replace(/\.mp3$/, "_fit.mp3");
      try {
        const fitted = runPacingPass(audioPath, retryTempo, retryPath);
        const fittedSec = fitted ? getMediaDuration(fitted) : 0;
        if (fitted && fittedSec > 0 && fitsInClip(fittedSec, clipDurationSec)) {
          console.log(`[Voiceover] ✓ Re-paced at ${retryTempo.toFixed(2)}x — now ${fittedSec.toFixed(1)}s, fits in ${available.toFixed(1)}s`);
          if (current !== audioPath) { try { unlinkSync(current); } catch {} }
          try { unlinkSync(audioPath); } catch {}
          return retryPath;
        }
        try { unlinkSync(retryPath); } catch {}
        // Needed more speedup than TEMPO_MAX allows — refuse to garble the read.
        console.error(`::warning::[Voiceover] CTA WILL BE TRUNCATED: script needs ${needed.toFixed(2)}x to fit but max is ${TEMPO_MAX}x. Audio ${audioSec.toFixed(1)}s > ${available.toFixed(1)}s available. Shorten the script or lengthen the clip.`);
      } catch (err) {
        console.error(`::warning::[Voiceover] Re-pacing failed: ${err.message?.slice(0, 120)} — CTA may be truncated`);
        try { unlinkSync(retryPath); } catch {}
      }
    }
  }

  if (current !== audioPath) { try { unlinkSync(audioPath); } catch {} }
  return current;
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
export async function processVoiceover(videoPath, city, dryRun = false, videoOverlays = null, opts = {}) {
  const { forceVoiceover = false, angleInstruction = null } = opts;

  // If forceVoiceover is set (trial variants), skip speech detection entirely
  if (forceVoiceover) {
    console.log(`[Voiceover] forceVoiceover=true — skipping speech detection, generating voiceover`);
    if (dryRun) {
      return { videoPath, skipped: false, reason: "force_voiceover_dry_run", detection: { hasSpeech: false } };
    }
    const duration = getVideoDuration(videoPath);
    const styleLog = opts.log || loadLog();
    const persona = pickPersona(styleLog, city);
    const avoidTranscripts = getRecentTranscripts(styleLog, 5);
    const script = await generateVoiceoverScript(city, duration, videoOverlays, {
      angleInstruction,
      persona,
      avoidTranscripts,
    });
    console.log(`[Voiceover] Script: "${script.slice(0, 80)}..."`);
    let audioPath = await generateTTS(script);
    audioPath = postProcessVoiceoverAudio(audioPath, duration);
    const mergedPath = mergeAudioWithVideo(videoPath, audioPath);
    return { videoPath: mergedPath, mergedPath, skipped: false, reason: "force_voiceover", script, detection: { hasSpeech: false }, audioPath, persona: persona.id };
  }

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
  const styleLog = opts.log || loadLog();
  const persona = pickPersona(styleLog, city);
  const avoidTranscripts = getRecentTranscripts(styleLog, 5);
  const script = await generateVoiceoverScript(city, duration, videoOverlays, {
    angleInstruction,
    persona,
    avoidTranscripts,
  });
  console.log(`[Voiceover] Script: "${script.slice(0, 80)}..."`);

  // Step 4: Generate TTS, then tighten pacing (silence trim + speedup)
  let audioPath = await generateTTS(script);
  audioPath = postProcessVoiceoverAudio(audioPath, duration);

  // Step 5: Merge (ducks original audio to 12% automatically)
  const mergedPath = mergeAudioWithVideo(videoPath, audioPath);

  // NOTE: Do NOT delete audioPath here — caller needs it for burned captions (Whisper word timing).
  // It intentionally points at the POST-PROCESSED audio, so burned captions stay
  // in sync with what is actually in the merged video.
  // Caller is responsible for cleanup via cleanup(audioPath) after caption burn.

  const reason = detection._overrideReason || (detection.silent ? "silent_add_voiceover" : "music_only_add_voiceover");
  return { videoPath: mergedPath, skipped: false, reason, script, detection, audioPath, persona: persona.id };
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
