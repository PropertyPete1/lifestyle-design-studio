/**
 * yt-timeline.js — deciding what goes on screen, and for how long.
 *
 * Split out from the renderer because this is where the judgement lives and
 * ffmpeg is where the work lives. Everything here is pure: given a script, the
 * clips Peter recorded, and the B-roll library, it returns a plan. No files are
 * read, nothing is encoded, and every rule below can be argued with in a test
 * instead of by watching a twelve-minute render.
 *
 * THE SHAPE OF A LONG-FORM TIMELINE
 * Takes run in script order. An ON_CAMERA take shows Peter's own recording. A
 * VOICEOVER take shows B-roll with his cloned voice over it — and because a
 * voiceover take can run 30 seconds, one clip held for 30 seconds is a dead
 * screen, so B-roll is cut into segments of a few seconds each.
 *
 * B-ROLL IS THE SCARCE RESOURCE. A 12-minute video at 70% B-roll needs about
 * eight minutes of footage, and the San Antonio folder holds 138 clips of
 * 15-40 seconds. That is enough for one video and not obviously enough for ten,
 * so the allocator spends the freshest footage first, never repeats a clip
 * inside one video, and only starts reusing when it has no choice — loudly,
 * via a flag the caller can surface rather than silently making a video out of
 * the same six clips.
 */

import { ON_CAMERA, VOICEOVER } from "./yt-script.js";

/** How long one B-roll clip holds the screen before cutting. */
export const BROLL_SEGMENT_SECONDS = 6;

/** Never cut a segment shorter than this — it reads as a glitch, not a cut. */
export const MIN_SEGMENT_SECONDS = 2;

/** Words per second read aloud, matching the script engine and the kit. */
const WORDS_PER_SECOND = 2.5;

export function estimateSpeechSeconds(text) {
  const words = String(text || "").split(/\s+/).filter(Boolean).length;
  return words / WORDS_PER_SECOND;
}

/**
 * Choose B-roll for one voiceover take.
 *
 * Preference order, and the order matters:
 *   1. clips not used in THIS video      — never repeat inside one video
 *   2. clips not used in RECENT videos   — content-hash carried by the caller
 *   3. anything left, flagged as reused
 *
 * Rule 1 outranks rule 2 deliberately. A clip repeating twice in one video is
 * far more noticeable than the same clip appearing in two videos a month apart.
 */
export function allocateBroll(seconds, pool, { usedInVideo, usedRecently = new Set() } = {}) {
  const segments = [];
  let remaining = Math.max(0, seconds);
  let exhausted = false;

  while (remaining >= MIN_SEGMENT_SECONDS) {
    const clip = pickClip(pool, usedInVideo, usedRecently);
    if (!clip) {
      exhausted = true;
      break;
    }
    usedInVideo.add(clip.id);

    // Never ask for more of a clip than it has, and never leave a stub too
    // short to read as a shot.
    const want = Math.min(BROLL_SEGMENT_SECONDS, remaining);
    const available = clip.durationSeconds || BROLL_SEGMENT_SECONDS;
    const take = Math.min(want, available);
    if (take < MIN_SEGMENT_SECONDS) continue;

    segments.push({
      driveFileId: clip.id,
      fileName: clip.name,
      contentHash: clip.contentHash || null,
      seconds: round(take),
      reused: usedRecently.has(clip.contentHash || clip.id),
    });
    remaining -= take;
  }

  // Anything under MIN_SEGMENT_SECONDS is padding onto the last shot rather
  // than a cut nobody would read as intentional.
  if (remaining > 0 && segments.length > 0) {
    segments[segments.length - 1].seconds = round(segments[segments.length - 1].seconds + remaining);
    remaining = 0;
  }

  return { segments, shortfall: round(remaining), exhausted };
}

function pickClip(pool, usedInVideo, usedRecently) {
  const unusedHere = pool.filter((c) => !usedInVideo.has(c.id));
  if (unusedHere.length === 0) return null;
  const fresh = unusedHere.filter((c) => !usedRecently.has(c.contentHash || c.id));
  return (fresh.length > 0 ? fresh : unusedHere)[0];
}

/**
 * Build the full timeline.
 *
 * @param {object} script         the approved script
 * @param {Map|object} recordings takeId -> { path, durationSeconds } for Peter's clips
 * @param {Array} brollPool       [{ id, name, durationSeconds, contentHash }]
 * @param {Set}   usedRecently    content hashes spent on recent videos
 * @returns {{ segments, totalSeconds, missingTakes, brollExhausted, stats }}
 */
export function planTimeline(script, recordings, brollPool = [], { usedRecently = new Set() } = {}) {
  const takes = orderedTakes(script);
  const get = (id) => (recordings instanceof Map ? recordings.get(id) : recordings?.[id]);

  const segments = [];
  const missingTakes = [];
  const usedInVideo = new Set();
  let brollExhausted = false;
  let onCameraSeconds = 0;
  let voiceoverSeconds = 0;

  for (const take of takes) {
    if (take.mode === ON_CAMERA) {
      const rec = get(take.id);
      if (!rec?.path) {
        // An on-camera take with no recording cannot be substituted — there is
        // no footage of Peter saying it. Report and let the caller stop.
        missingTakes.push({ takeId: take.id, mode: take.mode, section: take.section });
        continue;
      }
      const seconds = rec.durationSeconds || estimateSpeechSeconds(take.text);
      segments.push({
        kind: "on_camera",
        takeId: take.id,
        section: take.section,
        source: rec.path,
        seconds: round(seconds),
        text: take.text,
      });
      onCameraSeconds += seconds;
      continue;
    }

    // VOICEOVER: narration drives the length, B-roll fills the picture.
    const rec = get(take.id);
    const seconds = rec?.durationSeconds || estimateSpeechSeconds(take.text);
    const { segments: broll, exhausted } = allocateBroll(seconds, brollPool, { usedInVideo, usedRecently });
    if (exhausted) brollExhausted = true;

    segments.push({
      kind: "voiceover",
      takeId: take.id,
      section: take.section,
      // Present when Peter recorded the narration himself; null means the
      // renderer generates it with the cloned voice.
      narrationSource: rec?.path || null,
      seconds: round(seconds),
      text: take.text,
      broll,
    });
    voiceoverSeconds += seconds;
  }

  const totalSeconds = round(onCameraSeconds + voiceoverSeconds);
  return {
    segments,
    totalSeconds,
    missingTakes,
    brollExhausted,
    stats: {
      takeCount: takes.length,
      onCameraSeconds: round(onCameraSeconds),
      voiceoverSeconds: round(voiceoverSeconds),
      onCameraShare: totalSeconds > 0 ? round(onCameraSeconds / totalSeconds) : 0,
      brollClipsUsed: usedInVideo.size,
      estimatedMinutes: round(totalSeconds / 60),
    },
  };
}

/** Takes in the order the viewer hears them — sections, then CTA, then close. */
export function orderedTakes(script) {
  const out = [];
  (script?.sections || []).forEach((s, si) => {
    (s.takes || []).forEach((t, ti) => {
      out.push({ ...t, id: t.id || `s${si + 1}t${ti + 1}`, section: s.title });
    });
  });
  if (script?.softCta?.text) out.push({ ...script.softCta, id: script.softCta.id || "cta", section: "Soft CTA" });
  if (script?.close?.text) out.push({ ...script.close, id: script.close.id || "close", section: "Close" });
  return out;
}

/**
 * Chapter markers for the YouTube description, derived from the timeline.
 *
 * YouTube requires the first chapter to start at 00:00 and wants at least three
 * — a partial list is worse than none, because it disables chapters entirely
 * and leaves the timestamps sitting in the description looking broken.
 */
export function buildChapters(plan, script) {
  const chapters = [];
  let elapsed = 0;
  let currentSection = null;

  for (const seg of plan.segments) {
    if (seg.section && seg.section !== currentSection) {
      chapters.push({ seconds: Math.floor(elapsed), title: seg.section });
      currentSection = seg.section;
    }
    elapsed += seg.seconds;
  }

  if (chapters.length === 0) return [];
  // Force the first marker to zero; YouTube ignores the whole list otherwise.
  chapters[0].seconds = 0;
  return chapters.length >= 3 ? chapters.map((c) => ({ ...c, timestamp: formatTimestamp(c.seconds) })) : [];
}

export function formatTimestamp(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
}

function round(n) {
  return Math.round(n * 100) / 100;
}
