/**
 * yt-recording-kit.js — turning a script into something Peter can actually shoot.
 *
 * The kit is the whole reason the take is the atom of this system. Peter is not
 * a presenter with a teleprompter; he is holding a phone, probably outside,
 * probably between showings. Anything that asks him to remember a paragraph
 * will come back ad-libbed, and anything that asks him to shoot in a particular
 * order will come back in a different one.
 *
 * So the kit is a checklist: read this, record it, next. Every take stands
 * alone, every take says which way to point the camera, and the whole thing is
 * ordered for CONVENIENCE rather than for the timeline — all the on-camera
 * takes together, because that is one setup, one outfit, one light.
 *
 * The ingest does not care what order he shoots in (see yt-take-match.js), so
 * the kit is free to optimise purely for how a human would rather work.
 */

import { allTakes, ON_CAMERA, VOICEOVER } from "./yt-script.js";
import { RECORDINGS_ROOT, TAKE_SECONDS_MIN, TAKE_SECONDS_MAX, NARRATION_MODE } from "./yt-config.js";

/** Read-aloud rate used to estimate each take. Matches the script engine's. */
const WORDS_PER_SECOND = 2.5;

export function estimateSeconds(text) {
  const words = String(text || "").split(/\s+/).filter(Boolean).length;
  return Math.round(words / WORDS_PER_SECOND);
}

/** Where Peter uploads. One folder per request, so two videos can never mix. */
export function recordingsFolderPath(requestId) {
  return `${RECORDINGS_ROOT}/${requestId}`;
}

/**
 * Build the kit.
 *
 * Which takes Peter records depends on the narration mode: on the default he
 * shoots only the ON_CAMERA takes and ElevenLabs narrates the rest, but in
 * "peter" mode the voiceover takes are his too. That is the only difference
 * between the modes as far as the kit is concerned — the takes themselves are
 * identical either way.
 */
/**
 * The takes Peter is actually asked to record.
 *
 * THE SINGLE DEFINITION, and it has to be, because two places depend on it: the
 * kit tells him what to shoot, and the ingest decides what counts as missing.
 * When they disagreed — the kit asking for on-camera takes while the ingest
 * expected every take — the matcher reported the voiceover takes missing on
 * every run and the build never proceeded. Caught by the dry-run gate.
 */
export function takesToRecord(script, narrationMode = NARRATION_MODE) {
  return [
    ...allTakes(script).filter((t) => t.mode === ON_CAMERA || narrationMode === "peter"),
    // The thumbnail take is part of what Peter is asked to shoot, so it lives
    // in THIS list — the single definition the kit and the ingest share. Its
    // `optional: true` is what keeps it out of missing-take accounting
    // (matchTakesToClips), so listing it here cannot block a build.
    { ...THUMBNAIL_TAKE },
  ];
}

/** The thumbnail take's mode — not on the timeline, not narration. */
export const THUMBNAIL = "thumbnail";

/**
 * The thumbnail take — ten seconds of raw material for the video's face.
 *
 * A thumbnail with Peter's face on it out-clicks a text card, and the takes
 * recorded FOR the timeline are the wrong place to harvest that face: he is
 * mid-sentence in every frame, eyes wherever the read took them. This take is
 * three deliberate expressions straight down the lens, and nothing else.
 *
 * WHY THE SPOKEN SLATE. Matching is by transcript (yt-take-match.js) — a
 * silent clip of expressions has no words to match, so the take opens with
 * Peter SAYING "thumbnail take". Two words, in order, that no script take
 * will ever contain: recall 1.0 against this take, noise against everything
 * else. No filename convention, no new matching machinery.
 *
 * OPTIONAL, STRUCTURALLY. `optional: true` is what keeps this take out of
 * missing-take accounting (matchTakesToClips skips optional takes when
 * deciding `complete`), so a kit Peter shot before this feature existed —
 * video 1's, for one — still builds. The generator falls back to harvesting
 * the best face frame from the on-camera takes instead.
 */
export const THUMBNAIL_TAKE = Object.freeze({
  id: "thumbnail",
  mode: THUMBNAIL,
  section: "packaging",
  optional: true,
  text: "Thumbnail take.",
  direction:
    'Say "thumbnail take", then hold three BIG expressions straight down the lens, ' +
    "about three seconds each: SURPRISED (eyebrows up, mouth open), CONCERNED " +
    "(brow down, lips tight), CONFIDENT (slight smile, chin up). No words after " +
    "the slate — the expressions are the take. Face the light, fill the frame.",
});

export function buildKit(scriptResult, { requestId, narrationMode = NARRATION_MODE } = {}) {
  if (!requestId) throw new Error("buildKit requires a requestId");
  const script = scriptResult?.script || scriptResult;
  if (!script?.title) throw new Error("buildKit requires a script with a title");

  const toRecord = takesToRecord(script, narrationMode);

  // Group by mode so one camera setup covers a whole block. Within a block,
  // running order — he is reading down a page.
  const onCamera = toRecord.filter((t) => t.mode === ON_CAMERA);
  const voiceover = toRecord.filter((t) => t.mode === VOICEOVER);
  const thumbnailTakes = toRecord.filter((t) => t.mode === THUMBNAIL);

  const number = (list, offset) =>
    list.map((t, i) => ({
      number: offset + i + 1,
      takeId: t.id,
      mode: t.mode,
      section: t.section,
      text: t.text,
      direction: t.direction || "",
      estimatedSeconds: estimateSeconds(t.text),
    }));

  // The thumbnail take rides at the end of the on-camera block — same setup,
  // same light, ten extra seconds. It is numbered like the rest so "which one
  // did I skip" stays answerable from the numbers alone.
  const numbered = [
    ...number(onCamera, 0),
    ...number(thumbnailTakes, onCamera.length).map((t) => ({ ...t, estimatedSeconds: 10, optional: true })),
    ...number(voiceover, onCamera.length + thumbnailTakes.length),
  ];
  const totalSeconds = numbered.reduce((n, t) => n + t.estimatedSeconds, 0);

  return {
    requestId,
    title: script.title,
    narrationMode,
    folderPath: recordingsFolderPath(requestId),
    takes: numbered,
    stats: {
      takeCount: numbered.length,
      onCameraCount: onCamera.length,
      voiceoverCount: voiceover.length,
      estimatedRecordingSeconds: totalSeconds,
      // What it actually costs him: reading time plus the resets between takes.
      estimatedSessionMinutes: Math.max(1, Math.round((totalSeconds * 2.5) / 60)),
    },
  };
}

const HOW_TO = [
  `HOW THIS WORKS`,
  `  1. Read one take. Record it. Move to the next. Nothing needs memorising.`,
  `  2. Shoot them in any order you like — they get matched by what you say, not by filename.`,
  `  3. Fluffed one? Just record it again. The last version of a take is the one that gets used.`,
  `  4. Upload everything to the Drive folder at the bottom. One folder, all the clips.`,
  ``,
  `  LANDSCAPE. Phone SIDEWAYS, every take — the video is 16:9, and a portrait take gets`,
  `  composited into a blurred-fill frame instead of filling the screen. Voiceover takes too:`,
  `  record them as VIDEO of you reading the line (not a voice memo) — that footage is what`,
  `  puts you on screen in a corner bubble while the maps and graphics play.`,
  ``,
  `  Get somewhere quiet-ish. Don't worry about being perfect —`,
  `  the words matter more than the delivery, and a stumble sounds more like you than a`,
  `  clean read does.`,
];

/**
 * The plain-text kit, for email.
 *
 * Deliberately not markdown: this gets read on a phone in a mail client, and
 * often while standing in a driveway.
 */
export function renderKitText(kit) {
  const lines = [];
  lines.push(`RECORDING KIT — ${kit.title}`);
  lines.push(`${kit.stats.takeCount} takes, about ${kit.stats.estimatedSessionMinutes} minutes of your time.`);
  lines.push("");
  lines.push(...HOW_TO);
  lines.push("");

  let lastMode = null;
  for (const take of kit.takes) {
    if (take.mode !== lastMode) {
      lines.push("");
      lines.push("=".repeat(60));
      lines.push(
        take.mode === ON_CAMERA
          ? `ON CAMERA — ${kit.stats.onCameraCount} takes. This is you, on screen.`
          : take.mode === THUMBNAIL
            ? `THUMBNAIL — 1 take, 10 seconds. Your face becomes the thumbnail; skip it and the build harvests a frame from the takes above instead.`
            : `VOICEOVER — ${kit.stats.voiceoverCount} takes. Audio only, plays over footage.`
      );
      lines.push("=".repeat(60));
      lastMode = take.mode;
    }
    lines.push("");
    lines.push(`--- TAKE ${take.number} (${take.takeId}) — about ${take.estimatedSeconds}s${take.optional ? ", OPTIONAL" : ""} ---`);
    if (take.direction) lines.push(`    Direction: ${take.direction}`);
    lines.push("");
    lines.push(indent(take.text));
  }

  lines.push("");
  lines.push("=".repeat(60));
  lines.push(`UPLOAD TO: ${kit.folderPath}`);
  lines.push("");
  lines.push(`When the clips are in that folder, the build picks them up on its next run.`);
  lines.push(`Anything missing gets reported back to you rather than guessed at.`);
  return lines.join("\n");
}

function indent(text) {
  return String(text || "")
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n");
}

/** The structured payload the dashboard renders as a checklist. */
export function kitPayload(kit) {
  return {
    requestId: kit.requestId,
    title: kit.title,
    folderPath: kit.folderPath,
    narrationMode: kit.narrationMode,
    stats: kit.stats,
    takes: kit.takes,
    instructions: HOW_TO.join("\n"),
  };
}
