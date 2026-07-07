/**
 * ElevenLabs Service Module
 *
 * Handles:
 * - Voice lookup (cached)
 * - Text-to-speech generation
 * - Character usage tracking
 */

const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1";
const VOICE_ID = "ymv1q5WLElzdmrHdtgsw"; // "Peters pro voice" — looked up via API
const MODEL_ID = "eleven_multilingual_v2"; // v2 model (latest multilingual)

function getApiKey(): string {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("[ElevenLabs] ELEVENLABS_API_KEY not set");
  return key;
}

/**
 * Get the configured voice ID for Peter's voice.
 */
export function getVoiceId(): string {
  return VOICE_ID;
}

/**
 * List all available voices (for verification/debugging).
 */
export async function listVoices(): Promise<Array<{ voice_id: string; name: string }>> {
  const res = await fetch(`${ELEVENLABS_BASE}/voices`, {
    headers: { "xi-api-key": getApiKey() },
  });
  if (!res.ok) {
    throw new Error(`[ElevenLabs] Failed to list voices: ${res.status}`);
  }
  const data = await res.json();
  return data.voices;
}

/**
 * Generate speech from text using Peter's Pro Voice.
 * Returns the audio as a Buffer (mp3 format).
 */
export async function generateSpeech(
  text: string,
  options?: {
    voiceId?: string;
    stability?: number;
    similarityBoost?: number;
    style?: number;
  }
): Promise<{ audio: Buffer; charactersUsed: number }> {
  const voiceId = options?.voiceId ?? VOICE_ID;

  const res = await fetch(`${ELEVENLABS_BASE}/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "xi-api-key": getApiKey(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      model_id: MODEL_ID,
      voice_settings: {
        stability: options?.stability ?? 0.35,
        similarity_boost: options?.similarityBoost ?? 0.75,
        style: options?.style ?? 0.7,
        use_speaker_boost: true,
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`[ElevenLabs] TTS failed (${res.status}): ${errText.slice(0, 300)}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  const audio = Buffer.from(arrayBuffer);
  const charactersUsed = text.length;

  return { audio, charactersUsed };
}

/**
 * Get current subscription/usage info from ElevenLabs.
 */
export async function getSubscriptionInfo(): Promise<{
  characterCount: number;
  characterLimit: number;
  tier: string;
}> {
  const res = await fetch(`${ELEVENLABS_BASE}/user/subscription`, {
    headers: { "xi-api-key": getApiKey() },
  });
  if (!res.ok) {
    throw new Error(`[ElevenLabs] Failed to get subscription: ${res.status}`);
  }
  const data = await res.json();
  return {
    characterCount: data.character_count ?? 0,
    characterLimit: data.character_limit ?? 0,
    tier: data.tier ?? "unknown",
  };
}

/**
 * Generate speech with timestamps for caption alignment.
 * Uses the /text-to-speech/{voice_id}/with-timestamps endpoint.
 * Returns audio buffer + word-level timestamps.
 */
export async function generateSpeechWithTimestamps(
  text: string,
  options?: {
    voiceId?: string;
    stability?: number;
    similarityBoost?: number;
    style?: number;
  }
): Promise<{
  audio: Buffer;
  charactersUsed: number;
  alignment: { words: string[]; wordStartTimesMs: number[]; wordEndTimesMs: number[] };
}> {
  const voiceId = options?.voiceId ?? VOICE_ID;

  const res = await fetch(`${ELEVENLABS_BASE}/text-to-speech/${voiceId}/with-timestamps`, {
    method: "POST",
    headers: {
      "xi-api-key": getApiKey(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      model_id: MODEL_ID,
      voice_settings: {
        stability: options?.stability ?? 0.35,
        similarity_boost: options?.similarityBoost ?? 0.75,
        style: options?.style ?? 0.7,
        use_speaker_boost: true,
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`[ElevenLabs] TTS with timestamps failed (${res.status}): ${errText.slice(0, 300)}`);
  }

  const data = await res.json();

  // ElevenLabs returns base64-encoded audio and alignment data
  const audioBase64 = data.audio_base64;
  const audio = Buffer.from(audioBase64, "base64");
  const charactersUsed = text.length;

  // Alignment comes as { characters, character_start_times_seconds, character_end_times_seconds }
  // We need to reconstruct word-level timestamps from character-level data
  const alignment = reconstructWordTimestamps(text, data.alignment);

  return { audio, charactersUsed, alignment };
}

/**
 * Reconstruct word-level timestamps from ElevenLabs character-level alignment.
 */
function reconstructWordTimestamps(
  text: string,
  charAlignment: {
    characters: string[];
    character_start_times_seconds: number[];
    character_end_times_seconds: number[];
  }
): { words: string[]; wordStartTimesMs: number[]; wordEndTimesMs: number[] } {
  const words: string[] = [];
  const wordStartTimesMs: number[] = [];
  const wordEndTimesMs: number[] = [];

  if (!charAlignment?.characters?.length) {
    return { words: text.split(/\s+/), wordStartTimesMs: [], wordEndTimesMs: [] };
  }

  let currentWord = "";
  let wordStartIdx = -1;

  for (let i = 0; i < charAlignment.characters.length; i++) {
    const char = charAlignment.characters[i];

    if (char === " " || char === "\n") {
      if (currentWord.length > 0) {
        words.push(currentWord);
        wordStartTimesMs.push(
          Math.round(charAlignment.character_start_times_seconds[wordStartIdx] * 1000)
        );
        wordEndTimesMs.push(
          Math.round(charAlignment.character_end_times_seconds[i - 1] * 1000)
        );
        currentWord = "";
        wordStartIdx = -1;
      }
    } else {
      if (currentWord.length === 0) {
        wordStartIdx = i;
      }
      currentWord += char;
    }
  }

  // Don't forget the last word
  if (currentWord.length > 0 && wordStartIdx >= 0) {
    words.push(currentWord);
    wordStartTimesMs.push(
      Math.round(charAlignment.character_start_times_seconds[wordStartIdx] * 1000)
    );
    wordEndTimesMs.push(
      Math.round(
        charAlignment.character_end_times_seconds[charAlignment.characters.length - 1] * 1000
      )
    );
  }

  return { words, wordStartTimesMs, wordEndTimesMs };
}
