/**
 * yt-config.js — the knobs for the long-form engine.
 *
 * Everything here is read from the environment with a safe default, so a
 * cadence change or a narration-mode switch is a workflow edit, not a code
 * change.
 *
 * The one rule this file exists to enforce: NOTHING may assume one video per
 * week. Peter batch-records — a single session can cover several scripts, each
 * becoming its own video — so every count here is a number, never an
 * assumption baked into a loop somewhere.
 */

/** How many topic candidates the Monday brief offers. */
export const TOPIC_CANDIDATES = clampInt(process.env.YT_TOPIC_CANDIDATES, 3, 2, 6);

/**
 * How many briefs go out per cycle. Starts at 1.
 *
 * Raising this produces N independent scripts from one brief, so one recording
 * session covers N videos. Each gets its own requestId, its own recordings
 * folder, and its own video_review — they never share state.
 */
export const BRIEFS_PER_WEEK = clampInt(process.env.YT_BRIEFS_PER_WEEK, 1, 1, 5);

/** Target runtime. The brief calls for 10-15 minutes. */
export const TARGET_MINUTES_MIN = clampInt(process.env.YT_TARGET_MINUTES_MIN, 10, 3, 30);
export const TARGET_MINUTES_MAX = clampInt(process.env.YT_TARGET_MINUTES_MAX, 15, 4, 40);

/**
 * Share of runtime Peter is on camera. The rest is B-roll with narration.
 *
 * ~30% keeps the recording burden low enough that a session stays a session,
 * and it is the ratio the assembly probe was timed against.
 */
export const ON_CAMERA_SHARE = clampFloat(process.env.YT_ON_CAMERA_SHARE, 0.3, 0.1, 0.8);

/** Take length bounds. Short enough that nothing has to be memorised. */
export const TAKE_SECONDS_MIN = clampInt(process.env.YT_TAKE_SECONDS_MIN, 10, 5, 60);
export const TAKE_SECONDS_MAX = clampInt(process.env.YT_TAKE_SECONDS_MAX, 30, 10, 120);

/**
 * Who narrates the B-roll sections.
 *
 *   "elevenlabs" (default) — the existing cloned-voice pipeline, with the
 *                            pacing, silence-trim and fit guard already built.
 *   "peter"                — Peter records the voiceover takes himself, which
 *                            makes the recording kit longer and removes the
 *                            synthetic-speech element from the narration.
 *
 * NOTE: switching to "peter" does NOT by itself remove the YouTube AI
 * disclosure. See disclosureRequired() below — that decision has more inputs
 * than this one flag, and getting it wrong is a policy violation rather than a
 * bug.
 */
export const NARRATION_MODE = oneOf(process.env.YT_NARRATION_MODE, ["elevenlabs", "peter"], "elevenlabs");

/** Assembly resolution. 1080p until there is a reason to pay for 4K. */
export const RESOLUTION = oneOf(process.env.YT_RESOLUTION, ["1080p", "4k"], "1080p");

/** Drive folder that Peter uploads his recordings into, per request. */
export const RECORDINGS_ROOT = process.env.YT_RECORDINGS_ROOT || "YT Recordings";

/**
 * Does this video need YouTube's altered-or-synthetic content disclosure?
 *
 * Written as a function rather than a constant because the answer is a policy
 * question, and the tempting wrong answer changes as the pipeline changes.
 * When HeyGen was cut it would have been easy to conclude "no avatar, no
 * disclosure" — but the B-roll narration is still Peter's ElevenLabs voice
 * CLONE, and synthetic speech in a real person's voice is exactly what the
 * policy covers.
 *
 * So: required whenever any synthetic voice is used. It only drops away if
 * Peter narrates everything himself AND no other synthetic media is present.
 * Defaults to required on anything unrecognised.
 */
export function disclosureRequired({ narrationMode = NARRATION_MODE, syntheticMedia = [] } = {}) {
  if (syntheticMedia.length > 0) return true;
  if (narrationMode === "peter") return false;
  return true;
}

function clampInt(raw, fallback, min, max) {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function clampFloat(raw, fallback, min, max) {
  const n = Number.parseFloat(raw ?? "");
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function oneOf(raw, allowed, fallback) {
  const v = String(raw || "").trim().toLowerCase();
  return allowed.includes(v) ? v : fallback;
}
