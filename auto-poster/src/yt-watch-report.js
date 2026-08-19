/**
 * yt-watch-report.js — the pipeline watches its own video the way a viewer
 * would, and tells Peter where the picture stops serving the words.
 *
 * WHY THIS EXISTS. Video 1 shipped after every mechanical gate went green —
 * and the first person to notice that a baseball diamond was playing under
 * military-base narration, and that the wordless bridge read as an alien
 * radar app, was Peter, watching eleven minutes with a notepad. The gates
 * measure honesty (frames move, clocks agree, durations match); nothing
 * measured MATCH — does this visual belong with these words? That judgment
 * needs eyes, the pipeline already employs a set, and the review card is
 * where their notes belong: a ranked, timestamped list so Peter spot-checks
 * flagged seconds instead of taking his own.
 *
 * ADVISORY, STRUCTURALLY. This runs after the artifact QC has already said
 * "the render may ship", writes its findings, and can neither block nor fail
 * a build: every path out of buildWatchReport returns a report object, and
 * the worst possible outcome is a card that says the watcher was unavailable.
 * The one QUALITY gate that stays a gate is the artifact QC; this is a
 * reviewer, and reviewers advise.
 *
 * WHAT IS JUDGED. Stock scenes — the layer where wrong-subject failures
 * live — are judged frame-against-words by the same model that graded the
 * clips at fetch time, but with a different question: not "could this depict
 * X" (fetch already believed it could) but "does this serve these words on
 * screen". Beats are counted and cap-checked, graphics and on-camera are
 * listed for the timeline but not judged: their failure modes (emptiness,
 * energy) are visible in the artifact QC and on the card's own checklist.
 */

import { join } from "path";
import { writeFileSync, readFileSync } from "fs";

import { windowTokens } from "./yt-scene-keywords.js";
import { BEAT_BRIDGE_MAX_SECONDS } from "./yt-config.js";
import { preserveGateEvidence } from "./yt-evidence.js";

const WATCH_MODEL = process.env.YT_WATCH_MODEL || "claude-haiku-4-5-20251001";

/** How many stock scenes the watcher will pay to judge in one build. */
const MAX_JUDGED = Number.parseInt(process.env.YT_WATCH_MAX_SCENES || "60", 10);

/** M:SS for the card. */
function ts(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Flatten the plan into absolutely-timed scenes with the words spoken over
 * each. Pure, so the sweep can drive it without media.
 */
export function sceneTimeline(plan) {
  const scenes = [];
  let elapsed = 0;
  for (const seg of plan.segments || []) {
    const segSeconds = seg.seconds || 0;
    if (seg.kind !== "voiceover") {
      scenes.push({ at: elapsed, seconds: segSeconds, kind: seg.kind || "on_camera", takeId: seg.takeId, words: String(seg.text || "") });
      elapsed += segSeconds;
      continue;
    }
    let offset = 0;
    for (const b of seg.broll || []) {
      const kind = b.kind || (b.driveFileId ? "owned" : "beat");
      scenes.push({
        at: elapsed + offset,
        seconds: b.seconds || 0,
        kind,
        takeId: seg.takeId,
        query: b.query || null,
        words: windowTokens(seg, { startAt: offset, seconds: b.seconds || 0 }).join(" "),
      });
      offset += b.seconds || 0;
    }
    elapsed += segSeconds;
  }
  return scenes;
}

/** Ask the model whether one frame serves one set of words. Fails closed to "unjudged". */
async function judgeScene({ framePath, words, query, client }) {
  const prompt = `One frame from a stock B-roll scene in a real-estate explainer. While it is on screen the narration says: "${String(words).slice(0, 200)}"${query ? ` (the clip was fetched for the search "${query}")` : ""}.

Judge the MATCH for a viewer: does this visual belong with these words?
- "good": the subject serves the words.
- "weak": not wrong, but generic — any video could use it here.
- "wrong": the subject fights the words (different topic, different sense of a word, or visibly unrelated).

Respond ONLY with JSON: {"verdict":"good|weak|wrong","see":"what is on screen, 8 words max"}`;
  try {
    const image = { type: "image", source: { type: "base64", media_type: "image/jpeg", data: readFileSync(framePath).toString("base64") } };
    const res = await client.messages.create({ model: WATCH_MODEL, max_tokens: 128, messages: [{ role: "user", content: [image, { type: "text", text: prompt }] }] });
    const text = res?.content?.[0]?.text || "";
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    if (!["good", "weak", "wrong"].includes(parsed.verdict)) return null;
    return { verdict: parsed.verdict, see: String(parsed.see || "").slice(0, 80) };
  } catch {
    return null;
  }
}

/**
 * Watch the finished video and report, never throw.
 *
 * @returns {{ text, matchRate, judged, flagged }}
 */
export async function buildWatchReport({ plan, videoPath, ffmpeg, client, workDir }) {
  try {
    const scenes = sceneTimeline(plan);
    const stock = scenes.filter((s) => s.kind === "stock" && s.seconds >= 1).slice(0, MAX_JUDGED);
    const beats = scenes.filter((s) => s.kind === "beat");
    const overCap = beats.filter((b) => b.seconds > BEAT_BRIDGE_MAX_SECONDS + 0.55);

    const rows = [];
    if (client && videoPath && ffmpeg) {
      for (const [i, s] of stock.entries()) {
        const frame = join(workDir, `watch-${String(i).padStart(3, "0")}.jpg`);
        try {
          ffmpeg(["-y", "-ss", String(Math.max(0, s.at + s.seconds / 2)), "-i", videoPath, "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4", frame]);
        } catch {
          continue;
        }
        const j = await judgeScene({ framePath: frame, words: s.words, query: s.query, client });
        if (j) rows.push({ ...s, ...j });
      }
    }

    const judged = rows.length;
    const good = rows.filter((r) => r.verdict === "good").length;
    const flagged = rows
      .filter((r) => r.verdict !== "good")
      .sort((a, b) => (a.verdict === "wrong" ? 0 : 1) - (b.verdict === "wrong" ? 0 : 1) || a.at - b.at);
    const matchRate = judged > 0 ? Math.round((good / judged) * 100) : null;

    const lines = [];
    lines.push("WATCH REPORT (advisory — the pipeline watched it so you can spot-check)");
    lines.push(
      judged > 0
        ? `Match rate: ${good}/${judged} stock scenes serve their words (${matchRate}%).`
        : "Match rate: no stock scenes were judged" + (client ? "." : " — no vision client on this run.")
    );
    lines.push(`Bridges: ${beats.length} totalling ${Math.round(beats.reduce((n, b) => n + b.seconds, 0))}s${overCap.length ? ` — ${overCap.length} OVER the ${BEAT_BRIDGE_MAX_SECONDS}s cap` : ", all within cap"}.`);
    if (flagged.length > 0) {
      lines.push("");
      lines.push("Worst first — the seconds worth your eyes:");
      for (const f of flagged.slice(0, 10)) {
        lines.push(`  ${ts(f.at)}  [${f.verdict.toUpperCase()}] see "${f.see}" vs say "${f.words.split(/\s+/).slice(0, 9).join(" ")}"`);
      }
      if (flagged.length > 10) lines.push(`  (+${flagged.length - 10} more in the run's watch-report artifact)`);
    } else if (judged > 0) {
      lines.push("Nothing flagged — every judged scene serves its words.");
    }
    for (const b of overCap.slice(0, 4)) {
      lines.push(`  ${ts(b.at)}  [BRIDGE ${Math.round(b.seconds)}s] over cap while saying "${b.words.split(/\s+/).slice(0, 9).join(" ")}"`);
    }

    const report = { matchRate, judged, flagged, beats: beats.length, beatSeconds: Math.round(beats.reduce((n, b) => n + b.seconds, 0)), scenes: scenes.length };
    // The full record rides the diagnostics artifact on every run — not a
    // gate, but the same shelf the gates use, so one download answers "what
    // did the watcher see" months later.
    preserveGateEvidence("watch-report", { ...report, rows, advisory: true }, { log: () => {} });
    try {
      writeFileSync(join(workDir, "watch-report.json"), JSON.stringify({ ...report, rows }, null, 2));
    } catch { /* the workDir copy is a convenience, never a failure */ }

    return { text: lines.join("\n"), ...report };
  } catch (err) {
    return { text: `WATCH REPORT unavailable — ${err.message}. The build is unaffected.`, matchRate: null, judged: 0, flagged: [] };
  }
}
