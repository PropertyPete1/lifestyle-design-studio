/**
 * yt-teaser.js — a ~20-second vertical teaser that sends people to the video.
 *
 * When a long-form video publishes, this cuts its HOOK into a reel-shaped
 * clip and hands it to the Trial tab, where Peter posts it natively — the
 * same lane his trial reels already travel. The teaser's one job is traffic:
 * open the loop the hook was written to open, heighten it, and point at
 * YouTube. It must never RESOLVE the loop — the payoff lives in the video,
 * and a teaser that answers its own question is a substitute, not a trailer.
 *
 * THE LOOP GUARD IS STRUCTURAL, NOT EDITORIAL. Rather than asking a model
 * "does this resolve the tension?", the cut is only ever allowed to contain
 * the hook take and, when the hook alone is too short, the next section's
 * boundary take — lines the script engine wrote to CREATE retention. The
 * close and the CTA sections are unreachable by construction, and the tests
 * pin that. (Same doctrine as yt-shorts.js: the strong moments are marked by
 * the script, so picking them is a lookup, not a judgement call.)
 *
 * CUT FROM THE SOURCES, NOT FROM THE MASTER — yt-shorts.js's argument,
 * inherited whole: the phone takes are portrait at full resolution, and the
 * 16:9 master would hand back a blurry center crop.
 *
 * The retention edit is reel-edit.js (dead air removed, framing change every
 * 2.5s), the captions are the long-form burner fed WHISPER words measured
 * from the EDITED clip (the edit moves every word, so plan-time positions
 * would drift), and the ending is a brand plate: "THE FULL VIDEO IS ON
 * YOUTUBE — LINK IN BIO".
 */

import { execFileSync } from "child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import sharp from "sharp";

import { renderReelEdit, REEL_DIM } from "./reel-edit.js";
import { ON_CAMERA } from "./yt-script.js";
import { transcribeFile } from "./yt-ingest.js";
import { buildAssFile, burnArgs, assertHonestTimestamps, ffmpeg as runFfmpegDefault, mediaDuration } from "./yt-assemble.js";
import { BRAND } from "./carousel-render.js";

/** The teaser's speech budget, before the end plate. */
export const TEASER_MIN_SECONDS = 12;
export const TEASER_MAX_SECONDS = 25;

/** The end plate: long enough to read twice, short enough to not be an outro. */
export const PLATE_SECONDS = 2.6;

/** Words per caption chunk — the reels' rhythm, not the long-form's. */
export const TEASER_WORDS_PER_CHUNK = 4;

/**
 * Which takes may appear, in order. THE ONLY PLACE CONTENT IS CHOSEN.
 *
 * There is no take literally named "hook": the writer opens the video on
 * section 1's first ON_CAMERA take (the prompt pins the hook there — "the
 * video opens on Peter's face and one claim"), so that take IS the hook.
 * It always leads; the on-camera take that opens section 2 — a face plus a
 * boundary moment, the retention writing yt-shorts.js already ranks second —
 * joins only when the hook alone cannot reach the minimum.
 *
 * Anything else — later sections, the close, the soft CTA — is out of reach
 * no matter how short the hook runs, because a too-short teaser is a smaller
 * failure than a self-resolving one. The close and CTA live OUTSIDE
 * script.sections, so this walk cannot reach them by construction.
 */
export function pickTeaserTakes(script, recordings) {
  const all = [];
  (script?.sections || []).forEach((s, si) => {
    (s.takes || []).forEach((t, ti) => {
      all.push({ ...t, id: t.id || `s${si + 1}t${ti + 1}`, sectionIndex: si });
    });
  });
  const onCamera = all.filter((t) => t.mode === ON_CAMERA);
  const hook = onCamera.find((t) => t.sectionIndex === 0) || null;
  if (!hook) return { takes: [], reason: "no on-camera take in section 1" };

  const picks = [];
  const rec = (id) => recordings?.[id];
  if (!rec(hook.id)?.path) return { takes: [], reason: `no recording for the hook take ${hook.id}` };
  picks.push({ takeId: hook.id, path: rec(hook.id).path, seconds: rec(hook.id).durationSeconds || null });

  const boundary = onCamera.find((t) => t.sectionIndex === 1) || null;
  if (boundary && rec(boundary.id)?.path) {
    picks.push({ takeId: boundary.id, path: rec(boundary.id).path, seconds: rec(boundary.id).durationSeconds || null });
  }
  return { takes: picks };
}

/**
 * Trim an edited reel at a legal cut so it fits the budget.
 *
 * The pieces' cumulative boundaries are the only honest trim points — a `-t`
 * at an arbitrary second ends mid-syllable, which is the failure speechSafe
 * exists to prevent, reintroduced at the last step.
 */
export function trimPointFor(pieces, maxSeconds) {
  let elapsed = 0;
  let cut = 0;
  for (const p of pieces || []) {
    const next = elapsed + (p.editedSeconds ?? p.seconds ?? 0);
    if (next > maxSeconds) break;
    elapsed = next;
    cut = elapsed;
  }
  return cut > 0 ? cut : null;
}

/** The end plate as SVG — the carousel's brand tokens, teaser-sized. */
export function endPlateSvg({ dim = REEL_DIM } = {}) {
  const C = BRAND.colors;
  const cx = dim.w / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${dim.w}" height="${dim.h}" viewBox="0 0 ${dim.w} ${dim.h}">
  <rect width="${dim.w}" height="${dim.h}" fill="#000000"/>
  <rect x="0" y="${dim.h - 14}" width="${dim.w}" height="14" fill="${C.accentDim}" fill-opacity="0.8"/>
  <text x="${cx}" y="${dim.h * 0.44}" text-anchor="middle" font-family="Georgia, 'DejaVu Serif', serif" font-weight="bold" font-size="86" fill="${C.ink}">THE FULL VIDEO</text>
  <text x="${cx}" y="${dim.h * 0.44 + 104}" text-anchor="middle" font-family="Georgia, 'DejaVu Serif', serif" font-weight="bold" font-size="86" fill="${C.ink}">IS ON YOUTUBE</text>
  <rect x="${cx - 130}" y="${dim.h * 0.44 + 150}" width="260" height="6" rx="3" fill="${C.accent}"/>
  <text x="${cx}" y="${dim.h * 0.44 + 230}" text-anchor="middle" font-family="'Helvetica Neue', Helvetica, Arial, sans-serif" font-size="52" letter-spacing="6" fill="${C.accent}">LINK IN BIO</text>
</svg>`;
}

/** Whisper words -> caption chunks in the shape buildAssFile expects. */
export function chunksFromWords(words, { wordsPerChunk = TEASER_WORDS_PER_CHUNK } = {}) {
  const usable = (words || []).filter((w) => w && w.word && Number.isFinite(w.start) && Number.isFinite(w.end));
  const chunks = [];
  for (let i = 0; i < usable.length; i += wordsPerChunk) {
    const group = usable.slice(i, i + wordsPerChunk);
    chunks.push({
      start: group[0].start,
      end: Math.max(group[group.length - 1].end, group[0].start + 0.3),
      text: group.map((w) => w.word).join(" "),
    });
  }
  return chunks;
}

/**
 * Cut the teaser. Every step measured, every exit explained.
 *
 * Returns { path, seconds, report } on success; throws with a reason when the
 * cut cannot honestly be made (no takes, edit refused, QC failed) — the
 * CALLER decides whether a missing teaser blocks anything, and for the build
 * path it never does.
 */
export async function cutTeaser({
  script,
  recordings,
  workDir,
  minSeconds = TEASER_MIN_SECONDS,
  maxSeconds = TEASER_MAX_SECONDS,
  runFfmpeg = runFfmpegDefault,
  transcribe = transcribeFile,
} = {}) {
  const dir = join(workDir, "teaser");
  mkdirSync(dir, { recursive: true });

  const picked = pickTeaserTakes(script, recordings);
  if (picked.takes.length === 0) throw new Error(`teaser has no material: ${picked.reason}`);

  // ── 1. retention-edit each allowed take, stopping once the budget is full ──
  const parts = [];
  let total = 0;
  const report = { takes: [], edited: 0, trimmedAt: null };
  for (const take of picked.takes) {
    if (total >= minSeconds) break;
    const partDir = join(dir, `part-${take.takeId}`);
    mkdirSync(partDir, { recursive: true });
    const edit = renderReelEdit(take.path, partDir, {});
    let path = edit.outputPath;
    let seconds = edit.editedSeconds;

    const room = maxSeconds - total;
    if (seconds > room) {
      const cut = trimPointFor(edit.pieces, room);
      if (cut === null) {
        // Not even one whole piece fits — this take contributes nothing
        // honest, and a mid-syllable sliver is worse than stopping here.
        report.takes.push({ takeId: take.takeId, skipped: `no cut point within ${room}s` });
        break;
      }
      const trimmed = join(partDir, "trimmed.mp4");
      runFfmpeg(["-y", "-i", path, "-t", String(cut), "-c:v", "libx264", "-preset", "veryfast", "-crf", "19",
                 "-pix_fmt", "yuv420p", "-video_track_timescale", "15360",
                 "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", trimmed]);
      path = trimmed;
      seconds = mediaDuration(trimmed);
      report.trimmedAt = cut;
    }
    parts.push({ path, seconds });
    total += seconds;
    report.takes.push({ takeId: take.takeId, seconds, removed: edit.removedSeconds });
  }

  if (parts.length === 0) throw new Error("the edit produced no usable parts");
  if (total < minSeconds) {
    // Short is shippable — the loop guard forbids reaching for more material,
    // and a 10-second teaser that teases beats a 20-second one that spoils.
    console.log(`::warning::teaser runs ${total.toFixed(1)}s, under the ${minSeconds}s target — the hook was short and the loop guard forbids padding from later sections`);
  }

  // ── 2. join the speech parts (single part = rename-by-encode is skipped) ──
  let speechPath = parts[0].path;
  if (parts.length > 1) {
    const joined = join(dir, "speech-joined.mp4");
    const inputs = parts.flatMap((p) => ["-i", p.path]);
    const n = parts.length;
    const filter = `${parts.map((_, i) => `[${i}:v][${i}:a]`).join("")}concat=n=${n}:v=1:a=1[v][a]`;
    runFfmpeg(["-y", ...inputs, "-filter_complex", filter, "-map", "[v]", "-map", "[a]",
               "-r", "30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-pix_fmt", "yuv420p",
               "-video_track_timescale", "15360",
               "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", joined]);
    speechPath = joined;
  }

  // ── 3. captions from the words as EDITED — measured, not planned ──────────
  const transcript = transcribe(speechPath, { words: true });
  if (transcript?.words?.length > 0) {
    const assPath = join(dir, "teaser.ass");
    writeFileSync(assPath, buildAssFile(chunksFromWords(transcript.words), REEL_DIM));
    const captioned = join(dir, "speech-captioned.mp4");
    runFfmpeg(burnArgs(speechPath, assPath, captioned));
    speechPath = captioned;
    report.captions = transcript.words.length;
  } else {
    // A teaser without captions is a degraded teaser, not a dead one — but the
    // gap must be loud enough to investigate, because "whisper failed" and
    // "the take had no words" need different fixes.
    console.log("::warning::teaser captions skipped — transcription returned no word timestamps");
    report.captions = 0;
  }

  // ── 4. the end plate, then one concat ──────────────────────────────────────
  const platePng = join(dir, "plate.png");
  writeFileSync(platePng, await sharp(Buffer.from(endPlateSvg())).png().toBuffer());
  const finalPath = join(dir, "teaser.mp4");
  runFfmpeg([
    "-y",
    "-i", speechPath,
    "-loop", "1", "-t", String(PLATE_SECONDS), "-i", platePng,
    "-f", "lavfi", "-t", String(PLATE_SECONDS), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
    "-filter_complex",
    `[1:v]scale=${REEL_DIM.w}:${REEL_DIM.h},setsar=1,fps=30[plate];[0:v][0:a][plate][2:a]concat=n=2:v=1:a=1[v][a]`,
    "-map", "[v]", "-map", "[a]",
    "-r", "30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-pix_fmt", "yuv420p",
    "-video_track_timescale", "15360",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    "-movflags", "+faststart",
    finalPath,
  ]);

  // ── 5. self-QC before anyone is told it exists ─────────────────────────────
  const seconds = mediaDuration(finalPath);
  const expected = total + PLATE_SECONDS;
  if (Math.abs(seconds - expected) > 1.0) {
    throw new Error(`teaser measures ${seconds}s but its parts sum to ${expected.toFixed(1)}s — a stage dropped or duplicated content`);
  }
  if (seconds > maxSeconds + PLATE_SECONDS + 1.0) {
    throw new Error(`teaser runs ${seconds}s, over the ${maxSeconds + PLATE_SECONDS}s ceiling`);
  }
  const audio = execFileSync(
    "ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type", "-of", "csv=p=0", finalPath],
    { encoding: "utf-8", timeout: 60_000 }
  ).trim();
  if (!audio) throw new Error("teaser has no audio stream");
  assertHonestTimestamps(finalPath, "teaser");

  report.seconds = seconds;
  report.bytes = statSync(finalPath).size;
  return { path: finalPath, seconds, report };
}

/**
 * The post text, per platform. Deterministic — a caption writer that can
 * hallucinate a payoff would defeat the loop guard one layer up.
 *
 * All three end where the teaser ends: the payoff is on YouTube. The link
 * lives in the bio on IG/TikTok (neither passes link juice from captions);
 * LinkedIn gets the ask spelled out in its own register, no hashtags.
 */
export function teaserCaptions({ title, hookLine }) {
  const hook = String(hookLine || "").trim();
  const t = String(title || "").trim();
  const opener = hook ? hook.split(/(?<=[.!?])\s/)[0] : t;
  return {
    instagram: [
      opener,
      "",
      `The full breakdown — "${t}" — is on YouTube. Link in bio.`,
      "",
      "#realestate #sanantonio #austintx #movingtotexas",
    ].join("\n"),
    tiktok: [
      opener,
      `Full video on YouTube — link in bio. "${t}"`,
      "#realestate #texas #fyp",
    ].join("\n"),
    linkedin: [
      opener,
      "",
      `I broke the whole thing down in a long-form video: "${t}".`,
      "The full version is on my YouTube channel — link in the comments.",
    ].join("\n"),
  };
}
