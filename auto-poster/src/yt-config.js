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
export function disclosureRequired({
  narrationMode = NARRATION_MODE,
  syntheticMedia = [],
  syntheticNarration = null,
} = {}) {
  if (syntheticMedia.length > 0) return true;

  // EVIDENCE BEATS CONFIGURATION.
  //
  // narrationMode is a PREDICTION about what a render will contain. It is set
  // before anything is recorded, and it is wrong the moment reality differs —
  // if Peter misses one voiceover take in "peter" mode, the clone quietly fills
  // that segment in and the video contains synthetic speech in a real person's
  // voice while the config still says it does not. That is the exact case the
  // policy covers, and a disclosure decided from a flag would have been dropped
  // on a video that needed it.
  //
  // So when the render is known, the render decides. `syntheticNarration` is
  // three-valued on purpose: true and false are observations, null means nobody
  // looked yet and the mode is the best guess available.
  if (syntheticNarration === true) return true;
  if (syntheticNarration === false) return false;

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

/**
 * Whether the floating-head PIP may be composited over visuals.
 *
 * Per-video kill switch. Off is always safe: the visual plays full-screen,
 * which is exactly what it did before the feature existed.
 */
export const PIP_ENABLED = process.env.YT_PIP_ENABLED !== "false";

/**
 * Whether dead air is cut out of on-camera takes.
 *
 * Separate from the punch-ins deliberately. If a take ever gets clipped wrong,
 * this can be turned off without losing the framing changes, which are the
 * retention edit and carry no risk to the words.
 */
export const JUMP_CUTS_ENABLED = process.env.YT_JUMP_CUTS !== "false";

/** Whether on-camera takes get punch-in framing changes. */
export const PUNCH_INS_ENABLED = process.env.YT_PUNCH_INS !== "false";

/**
 * How often the framing changes during an on-camera take, in seconds.
 *
 * WAS 7-9. IS 3, and the change is the point of revision 3's edit note.
 *
 * Seven seconds is a documentary cadence: it reads as considered, and it is
 * what you want if the viewer has already decided to watch. This channel is
 * fighting for the first thirty seconds against an infinite feed, and the
 * format that wins that fight cuts every two to four. Peter asked for ~3.
 *
 * A KNOB RATHER THAN A CONSTANT because 3 is a hypothesis. Video 1 goes through
 * review rounds and the right number is whatever survives them; the whole point
 * is that finding out costs a workflow edit rather than a code change. The
 * bounds are wide enough to get back to the old feel (7-9) without touching
 * this file.
 */
export const PUNCH_INTERVAL = clampFloat(process.env.YT_PUNCH_INTERVAL, 3, 1.5, 12);

/**
 * Whether emphasis words get a quick zoom pulse.
 *
 * Separate from the punch-in cadence deliberately, and for the same reason jump
 * cuts are separate from framing: if the pulses ever read as a tic, they can be
 * turned off without losing the cadence, which is the part carrying retention.
 */
export const ZOOM_PULSES_ENABLED = process.env.YT_ZOOM_PULSES !== "false";

/** How hard a pulse hits. 0.04 is a nudge; 0.10 is a shove. */
export const ZOOM_PULSE_STRENGTH = clampFloat(process.env.YT_ZOOM_PULSE_STRENGTH, 0.05, 0.01, 0.15);

/**
 * How a portrait on-camera take sits in the 16:9 frame.
 *
 *   "blur-fill"  — the take centered at full height, a blurred and darkened
 *                  copy of itself filling the sides. The polished treatment.
 *   "pillarbox"  — black bars. The old behaviour, kept as the escape hatch.
 *
 * THE TUNING KNOBS BELOW ARE THE POINT: video 1 iterates through Peter's
 * review notes, and each note should be a config change, not a code change.
 * Whatever combination finally gets his approve is the standing recipe.
 */
export const ONCAM_TREATMENT = oneOf(process.env.YT_ONCAM_TREATMENT, ["blur-fill", "pillarbox"], "blur-fill");

/** Gaussian blur sigma on the background copy. Higher = softer, more abstract. */
export const ONCAM_BG_BLUR = clampFloat(process.env.YT_ONCAM_BG_BLUR, 24, 4, 60);

/** How much the background is darkened, 0 (none) to 0.8 (near black). */
export const ONCAM_BG_DARKEN = clampFloat(process.env.YT_ONCAM_BG_DARKEN, 0.4, 0, 0.8);

/** Extra zoom on the background so its edges never show through the blur. */
export const ONCAM_BG_ZOOM = clampFloat(process.env.YT_ONCAM_BG_ZOOM, 1.1, 1.0, 1.5);

/**
 * The gold-tinted vignette over the background. Subtle by design — it reads
 * as warmth in the corners, not a colour cast on his face (it never touches
 * the centered foreground). Set to 0 to disable.
 */
export const ONCAM_VIGNETTE = clampFloat(process.env.YT_ONCAM_VIGNETTE, 0.35, 0, 1);

/**
 * Whether the video carries a music bed at all.
 *
 * Off is always safe: renderTimeline treats a missing bed as an ordinary state
 * and ships narration only, which is what every revision before this one did.
 */
export const MUSIC_ENABLED = process.env.YT_MUSIC !== "false";

/**
 * Where the bed sits under the narration, in dB.
 *
 * A KNOB IN dB RATHER THAN THE OLD LINEAR CONSTANT because this is the number
 * Peter will actually want to move after watching, and "make the music quieter"
 * is a sentence about decibels. -14 dB is a hard duck before the sidechain
 * compressor has done anything; the compressor then pulls it further down on
 * every syllable, so the bed is audible between sentences and nearly gone
 * underneath them.
 *
 * The bounds stop the two failures that are not worth allowing: a bed loud
 * enough to compete with speech, and a bed so quiet it is only in the file to
 * satisfy a checklist.
 */
export const MUSIC_DB = clampFloat(process.env.YT_MUSIC_DB, -14, -40, -3);

/**
 * How much the bed lifts under the hook and the close, in dB above MUSIC_DB.
 *
 * The energy change is the point — a bed at one level for twelve minutes is
 * wallpaper. +5 dB is a little under double the perceived loudness, which reads
 * as the music leaning in rather than as a level jump.
 */
export const MUSIC_LIFT_DB = clampFloat(process.env.YT_MUSIC_LIFT_DB, 5, 0, 12);

/**
 * Whether single-word micro-punches slam over the visual on emphasis beats.
 *
 * Separate knob from the punch-in framing changes despite the shared word: those
 * are camera moves on an on-camera take, these are text over any visual. Turning
 * one off must not cost the other.
 */
export const MICRO_PUNCHES_ENABLED = process.env.YT_MICRO_PUNCHES !== "false";

/**
 * The most micro-punches one video may carry.
 *
 * A ceiling rather than a target. The device works because it is rare — the
 * fifth one is punctuation and the fifteenth is a style, and a style that puts a
 * word on screen every forty seconds is competing with the captions it is
 * supposed to be emphasising.
 */
export const MICRO_PUNCH_MAX = clampInt(process.env.YT_MICRO_PUNCH_MAX, 6, 0, 12);

/** How long one punch holds the frame. Long enough to read, short enough to hit. */
export const MICRO_PUNCH_SECONDS = clampFloat(process.env.YT_MICRO_PUNCH_SECONDS, 1.2, 0.6, 2.5);

/**
 * Whether punches and punch-in cuts carry a sound.
 *
 * SYNTHESISED, NOT LICENSED. The standing decision was to ship revision 8
 * without SFX rather than stretch the licensing bar if clean sources came back
 * thin — and they did: the sources with usable terms either have no API for
 * audio or gate downloads behind OAuth. Generating the impact and the whoosh
 * from ffmpeg's own oscillators sidesteps the question rather than compromising
 * on it, because a tone we synthesise is a tone we own. See yt-sfx.js.
 */
export const PUNCH_SFX_ENABLED = process.env.YT_PUNCH_SFX !== "false";

/** How loud the synthesised hits sit, in dB. Under the bed, not over it. */
export const PUNCH_SFX_DB = clampFloat(process.env.YT_PUNCH_SFX_DB, -20, -40, -6);

/**
 * Whether the whoosh plays on punch-in cuts. OFF.
 *
 * Revision 8 put one on every seam, including the joins where dead air was
 * removed — so the edit that is supposed to be invisible announced itself
 * dozens of times, which is what "weird noise on cuts" was. The seam
 * classification that fixes it lives in yt-oncamera-edit.js, and the whoosh is
 * now restricted to deliberate cadence punch-ins.
 *
 * It still defaults OFF, because the note was about the sound being there at
 * all and a fix for the wrong-place problem is not evidence that the
 * right-place version is wanted. The impacts on micro-punches stay on. Turn
 * this on to judge it.
 */
export const PUNCH_WHOOSH_ENABLED = process.env.YT_PUNCH_WHOOSH === "true";

/**
 * The frame rate the animated graphics actually move at.
 *
 * NOT a new encode rate — the clips were always encoded at 30fps. This is how
 * often the DRAWING changes, which is a different number and was the one that
 * mattered: a road drew in 5 steps over 0.7s (~7fps), a counter in 12 over 1.6s
 * (~7.5fps), and the wordless beat advanced once every 0.4s (2.5fps) across
 * more than half the runtime. Encoded at 30fps, held for four frames each. That
 * is what "the whole video feels laggy" was.
 *
 * Tied to the delivery rate by default so motion is smooth by construction. It
 * is a knob because rasterising is the expensive part of a build and a long
 * beat at full rate is real minutes.
 */
export const GRAPHIC_TWEEN_FPS = clampInt(process.env.YT_GRAPHIC_TWEEN_FPS, 30, 8, 60);

/**
 * The most frames one wordless beat may rasterise.
 *
 * A bound on the one thing that could make a build much slower. At 30fps this
 * is three seconds, which is more than the beat is now allowed to hold anyway
 * (see BEAT_BRIDGE_MAX_SECONDS) — so in practice it never binds, and it is here
 * so that a regression in the fallback chain costs a slightly steppier beat
 * rather than twenty minutes of rasterising.
 */
export const BEAT_MAX_FRAMES = clampInt(process.env.YT_BEAT_MAX_FRAMES, 90, 8, 900);

/**
 * The longest the wordless beat may hold the screen.
 *
 * THE BEAT IS A BRIDGE, NOT A LAYER. Revision 8 gave it 56% of the runtime, and
 * abstract gold arcs played through the passages naming actual neighbourhoods —
 * the video's core content covered by the one visual that says nothing. That is
 * the worst available fallback, and it happened because the beat was an
 * unbounded floor rather than a last resort.
 *
 * Two seconds is a breath between scenes. Anything longer and the neighbouring
 * scene is extended instead.
 */
export const BEAT_BRIDGE_MAX_SECONDS = clampFloat(process.env.YT_BEAT_BRIDGE_MAX_SECONDS, 2, 0.5, 8);

/**
 * The longest one visual may own the screen, in seconds.
 *
 * A 30-second narration used to sit on a single stock clip or a single graphic
 * for its whole length. Nothing was frozen — the graphic animated, the clip
 * moved — and it still read as one shot held far too long, because the SCENE
 * never changed. In-graphic motion and a scene change are different things and
 * only the second one resets attention.
 *
 * 8s by default, a knob because the right number is a review-round answer.
 */
export const SCENE_MAX_SECONDS = clampFloat(process.env.YT_SCENE_MAX_SECONDS, 8, 3, 20);
