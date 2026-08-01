/**
 * voiceover-style.js — delivery pacing + persona rotation for generated voiceovers.
 *
 * Lives in its own module because BOTH caption.js (script generation) and
 * voiceover.js (TTS + audio post-processing) need these values. Importing one
 * from the other would create a cycle: voiceover.js already imports
 * generateVoiceoverScript from caption.js.
 *
 * Goal: sound like a professional marketer — fast, no dead air, and different
 * every single time. What is NOT relaxed: the payment-figure guard
 * (findMonthlyPaymentFigure) and the gated-term leak scanner both still run on
 * every generated script. Personas change the VOICE, never the facts.
 */

// ─── Delivery pacing ─────────────────────────────────────────────────────────

export const TEMPO_DEFAULT = 1.18;
export const TEMPO_MIN = 1.0;   // 1.0 = untouched; never slow the read down
export const TEMPO_MAX = 1.30;  // past ~1.3 the read starts to lose intelligibility

/**
 * Strict numeric parse for env-supplied config.
 *
 * Deliberately NOT parseFloat: parseFloat("1.2x") returns 1.2, silently honoring
 * a typo'd value. For a config knob it is more predictable to reject anything
 * that isn't a clean number and fall back to the documented default.
 */
function strictNumber(raw) {
  if (typeof raw !== "string" && typeof raw !== "number") return NaN;
  const s = String(raw).trim();
  if (!s) return NaN;
  return Number(s);
}

/**
 * Resolve the playback tempo multiplier applied to the TTS audio.
 * Invalid / missing input falls back to the default rather than throwing —
 * a malformed env var must never take down a live posting run.
 */
export function resolveTempo(raw = process.env.VOICEOVER_TEMPO) {
  const n = strictNumber(raw);
  if (!Number.isFinite(n)) return TEMPO_DEFAULT;
  return Math.min(TEMPO_MAX, Math.max(TEMPO_MIN, n));
}

// ─── Silence trimming ────────────────────────────────────────────────────────
//
// ElevenLabs leaves noticeable gaps between sentences. Those gaps read as "dead
// air" against fast-cut listing footage. We collapse any silence longer than
// SILENCE_KEEP_SEC down to SILENCE_KEEP_SEC — long enough that words still have
// natural spacing, short enough that the read never stalls.

export const SILENCE_KEEP_SEC = 0.25;      // silence longer than this is trimmed TO this
export const SILENCE_THRESHOLD_DB = -38;   // below this level counts as silence

/**
 * Build the ffmpeg -af chain: trim inter-sentence silence, then speed up.
 * Audio-only — this never touches the video stream, so it adds no video
 * re-encode generation.
 */
export function buildAudioFilterChain(tempo = resolveTempo()) {
  const silence = `silenceremove=stop_periods=-1:stop_duration=${SILENCE_KEEP_SEC}:stop_threshold=${SILENCE_THRESHOLD_DB}dB`;
  return `${silence},atempo=${tempo}`;
}

// ─── Fitting the read inside the clip ────────────────────────────────────────
//
// The merge mixes the voiceover with `amix=duration=first` and `-shortest`, so
// the output is clamped to the CLIP's length. Anything the voiceover has left
// over at that point is discarded with no error — and since every script ends
// on the CTA, an overrun deletes the call to action silently.
//
// The word budget alone cannot prevent this. It assumes the tempo speedup is
// applied, but that step is best-effort (ffmpeg failure falls back to the
// original audio), and the word count itself is only a prompt instruction the
// model may overshoot. So the audio is measured against the clip AFTER
// processing, and the tempo is adjusted to whatever actually makes it fit.

/** Voiceover lead-in. MUST match `adelay=500|500` in mergeAudioWithVideo. */
export const AUDIO_LEAD_IN_SEC = 0.5;

/** Seconds of voiceover the clip can actually carry. */
export function availableAudioSeconds(clipDurationSec) {
  return Math.max(0, clipDurationSec - AUDIO_LEAD_IN_SEC);
}

/** Does this much audio survive the merge intact? */
export function fitsInClip(audioDurationSec, clipDurationSec) {
  if (!Number.isFinite(audioDurationSec) || !Number.isFinite(clipDurationSec)) return true;
  return audioDurationSec <= availableAudioSeconds(clipDurationSec);
}

/**
 * Tempo multiplier that would make `audioDurationSec` fit the clip.
 * Returned UNCLAMPED so callers can tell "needs 1.2x" (achievable) from
 * "needs 1.9x" (not achievable without becoming unintelligible).
 */
export function requiredTempoToFit(audioDurationSec, clipDurationSec) {
  const available = availableAudioSeconds(clipDurationSec);
  if (available <= 0 || !Number.isFinite(audioDurationSec) || audioDurationSec <= 0) return TEMPO_DEFAULT;
  return audioDurationSec / available;
}

// ─── Words-per-second budget ─────────────────────────────────────────────────
//
// Script length must track the tempo speedup: at 1.18x the same clip fits ~18%
// more words, and a script that ends early leaves the tail of the video silent.

export const BASE_WORDS_PER_SEC = 2.2;

/** Target word count for a clip, scaled by the delivery tempo. */
export function targetWordsForDuration(videoDurationSec, tempo = resolveTempo()) {
  return Math.floor(videoDurationSec * BASE_WORDS_PER_SEC * tempo);
}

// ─── ElevenLabs voice settings ───────────────────────────────────────────────
//
// stability        lower = more expressive and variable, higher = flatter and
//                  more consistent. 0.5 read as corporate; ~0.35 gives the
//                  energy swings a hype read needs.
// similarity_boost how tightly to cling to the reference voice timbre. Left at
//                  0.75 — this is voice identity, not energy.
// style            how much speaking-style exaggeration to apply. Raised to
//                  ~0.6 for punch. Pushing this much past 0.6 starts to slur.
// use_speaker_boost clarity boost for the reference speaker. Always on.

export const VOICE_STABILITY_DEFAULT = 0.35;
export const VOICE_STYLE_DEFAULT = 0.6;
export const VOICE_SIMILARITY_DEFAULT = 0.75;

const clamp01 = (raw, fallback) => {
  const n = strictNumber(raw);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
};

export function resolveVoiceSettings(env = process.env) {
  return {
    stability: clamp01(env.ELEVENLABS_STABILITY, VOICE_STABILITY_DEFAULT),
    similarity_boost: clamp01(env.ELEVENLABS_SIMILARITY, VOICE_SIMILARITY_DEFAULT),
    style: clamp01(env.ELEVENLABS_STYLE, VOICE_STYLE_DEFAULT),
    use_speaker_boost: true,
  };
}

// ─── Personas ────────────────────────────────────────────────────────────────
//
// Rotated so the same city never draws the same persona twice in a row. These
// change TONE ONLY. Every persona inherits the same hard rules: no payment
// figures, no community/builder names, no invented facts about the actual home.

export const STORY_GUARDRAIL = `If you open with a mini-scenario it must be GENERIC social-media flavor about an unnamed buyer reacting emotionally. NEVER invent a fact about this specific property, its price, its builder, its finishes, or any real person. No named people. No claimed sales, offers, or deadlines. The scenario is a vibe, not a claim.`;

export const PERSONAS = [
  {
    id: "rapid_fire_hype",
    label: "Rapid-fire hype",
    instruction: `PERSONA: RAPID-FIRE HYPE. Breathless energy, like you cannot believe what you are looking at. Stack short exclamations. Every sentence lands a punch. Think three to six words per sentence.`,
  },
  {
    id: "deadpan_comedian",
    label: "Deadpan comedian",
    instruction: `PERSONA: DEADPAN COMEDIAN. Flat, dry, understated delivery about something objectively impressive. The humor is the gap between how big a deal it is and how casually you say it. One dry joke, then move.`,
  },
  {
    id: "storyteller",
    label: "Storyteller (mini-scenario open)",
    instruction: `PERSONA: STORYTELLER. Open with ONE short made-up-but-plausible human moment, then pivot hard to the home. Example shape: "my buyer almost cried when she walked into this kitchen." Keep the scenario to a single sentence. ${STORY_GUARDRAIL}`,
  },
  {
    id: "hot_take_contrarian",
    label: "Hot-take contrarian",
    instruction: `PERSONA: HOT-TAKE CONTRARIAN. Open by challenging a common assumption about new construction or the local market, then immediately show why this home flips it. Confident, slightly provocative, never negative about the home itself.`,
  },
  {
    id: "checklist_sprint",
    label: "Checklist sprint",
    instruction: `PERSONA: CHECKLIST SPRINT. Machine-gun a list of what the home has. Clipped fragments, no connective filler. Think "Quartz counters. Ceilings for days. Yard that actually fits a dog." Then land the close.`,
  },
  {
    id: "insider_secret",
    label: "Secret you're not supposed to know",
    instruction: `PERSONA: INSIDER SECRET. Conspiratorial, lowered-voice energy — you are letting the viewer in on something most buyers miss about new builds right now. Generic industry insight only. Do NOT invent a specific incentive, discount, deadline, or builder claim.`,
  },
];

export const PERSONA_IDS = PERSONAS.map((p) => p.id);

/** Look up the persona used for this city's most recent generated voiceover. */
export function getLastPersonaForCity(log, city) {
  const posts = log?.posts || [];
  for (let i = posts.length - 1; i >= 0; i--) {
    const p = posts[i];
    if (p.city === city && p.voiceover_persona) return p.voiceover_persona;
  }
  return null;
}

/**
 * Pick a persona for this city, never repeating the city's previous one.
 * `rand` is injectable so rotation is deterministic under test.
 */
export function pickPersona(log, city, rand = Math.random) {
  const last = getLastPersonaForCity(log, city);
  const pool = PERSONAS.filter((p) => p.id !== last);
  // pool is never empty: PERSONAS has 6 entries and we exclude at most 1
  const idx = Math.floor(rand() * pool.length) % pool.length;
  return pool[idx];
}

/**
 * Last N transcripts of voiceovers WE generated, newest first.
 *
 * Deliberately excludes entries where voiceover === false: those transcripts are
 * Whisper capturing the owner's OWN hand-recorded narration. Feeding those in as
 * "do not resemble" would push the model away from the exact voice we are trying
 * to emulate.
 */
export function getRecentTranscripts(log, limit = 5) {
  const posts = log?.posts || [];
  const out = [];
  for (let i = posts.length - 1; i >= 0 && out.length < limit; i--) {
    const p = posts[i];
    if (p.voiceover === true && typeof p.voiceover_transcript === "string" && p.voiceover_transcript.trim()) {
      out.push(p.voiceover_transcript.trim());
    }
  }
  return out;
}

/** Render the "do not resemble these" prompt block, or "" when there's no history. */
export function buildAvoidBlock(transcripts) {
  if (!transcripts?.length) return "";
  const lines = transcripts.map((t, i) => `${i + 1}. "${t.slice(0, 160)}"`).join("\n");
  return `\nRECENT SCRIPTS — DO NOT RESEMBLE THESE. Different opening words, different structure, different joke:\n${lines}\n`;
}
