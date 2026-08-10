/**
 * yt-visual-build.js — the wiring between the visual planner and ffmpeg.
 *
 * yt-visual-plan.js decides WHAT covers each second and is pure. This module is
 * the impure half: it renders the graphics, fetches the stock, builds the
 * typography, and hands the pipeline a plan whose `broll` lists point at real
 * files. Keeping the two apart is what lets the entire decision table be tested
 * without ffmpeg, a network, or an API key.
 *
 * WORD TIMINGS COME FROM THE NARRATION THAT WILL ACTUALLY PLAY. Whisper runs on
 * `narrationSource` when Peter recorded the take himself and on
 * `generatedNarrationPath` when the clone did — which means this must run AFTER
 * generateNarration, for the same reason the old visual pass did: before that,
 * segment lengths are estimates and there is no audio to align against.
 */

import { join } from "path";
import { existsSync, writeFileSync } from "fs";

import { planVisuals, REASON } from "./yt-visual-plan.js";
import { renderAnimatedGraphic, renderTypographyClip, assertAnimated } from "./yt-visual-animate.js";
import { fetchStockClip, stockEnabled } from "./yt-stock.js";
import { MAP } from "./yt-visual-intent.js";
import { mapSpecForIntent } from "./yt-map-render.js";

/**
 * Transcribe one take's narration, or return null.
 *
 * Never throws and never blocks the build. Whisper is slow, occasionally
 * unavailable, and completely optional: without it every reveal falls back to
 * even pacing, which is a perfectly good graphic. Losing the build over a
 * missing transcript would be trading the whole video for the synchronisation.
 */
export async function wordsFor(seg, { getWordTimestamps }) {
  const audio = seg.narrationSource || seg.generatedNarrationPath;
  if (!audio || !existsSync(audio)) return null;
  try {
    const words = await getWordTimestamps(audio);
    return Array.isArray(words) && words.length > 0 ? words : null;
  } catch (err) {
    console.warn(`[Visuals] no word timing for ${seg.takeId}: ${err.message} — reveals will use even pacing`);
    return null;
  }
}

/**
 * Build every visual in the plan and splice the results into each segment.
 *
 * @returns {{ plan, report }}
 */
export async function buildVisuals(plan, {
  workDir,
  market = "san_antonio",
  ffmpeg,
  getWordTimestamps,
  visionClient = null,
  ownedPool = [],
  usedHashes = new Set(),
  driveGet = null,
  drivePut = null,
} = {}) {
  const dir = workDir;
  const timings = new Map();
  const animationFailures = [];
  const stockCredits = [];

  // Transcribe once per segment and reuse. The graphic reveals, the typography
  // word arrivals and the emphasis pulses all read the same timings, and
  // Whisper is far too slow to run three times for one take.
  for (const seg of plan.segments || []) {
    if (seg.kind !== "voiceover") continue;
    timings.set(seg.takeId, await wordsFor(seg, { getWordTimestamps }));
  }

  let index = 0;
  const graphicTimings = [];

  const renderGraphic = async (seg) => {
    const i = index++;
    try {
      // MAP resolves its spec against the vendored geometry BEFORE anything is
      // rendered. The writer names places and roads in prose ("just past 1604",
      // "Timberwood Park") and this is where those become ids we actually hold
      // geometry for. A script can legitimately name a suburb the TIGER extract
      // does not include, and when nothing resolves there is no map to draw —
      // that is a content gap, not a bug, and it falls to typography with a
      // reason that says which names failed rather than a bare null.
      let spec = seg.visualSpec;
      if (seg.visual === MAP) {
        spec = mapSpecForIntent(seg.visualSpec, { market });
        if (!spec) {
          const named = [...(seg.visualSpec?.places || []), ...(seg.visualSpec?.lines || [])];
          const reason = named.length
            ? `no vendored geometry for ${named.slice(0, 4).map((n) => `"${n}"`).join(", ")}`
            : REASON.MAP_EMPTY_SPEC;
          animationFailures.push({ takeId: seg.takeId, type: MAP, reason });
          return { ok: false, reason };
        }
      }

      const r = await renderAnimatedGraphic({
        type: seg.visual,
        spec,
        seconds: Math.min(seg.seconds, 22),
        words: timings.get(seg.takeId),
        dir,
        index: i,
        ffmpeg,
        writeFileSync,
      });

      if (r.deadStates.length > 0) {
        animationFailures.push({ takeId: seg.takeId, type: seg.visual, reason: `${r.deadStates.length} reveal state(s) rendered identically` });
        return { ok: false, reason: "reveal states rendered identically" };
      }

      const verdict = await assertAnimated(r.path, { seconds: r.seconds, reveals: r.reveals, dir, ffmpeg, index: i });
      if (!verdict.ok) {
        animationFailures.push({ takeId: seg.takeId, type: seg.visual, reason: verdict.failures.join("; ") });
        return { ok: false, reason: verdict.failures.join("; ") };
      }

      graphicTimings.push({ type: seg.visual, takeId: seg.takeId, syncedCount: r.syncedCount, revealCount: r.reveals.length, source: r.source });
      return {
        ok: true,
        path: r.path,
        timing: { syncedCount: r.syncedCount, revealCount: r.reveals.length, source: r.source, stateCount: r.stateCount },
      };
    } catch (err) {
      animationFailures.push({ takeId: seg.takeId, type: seg.visual, reason: err.message });
      return { ok: false, reason: err.message };
    }
  };

  const fetchStock = async (seg) => {
    const i = index++;
    // NO VERIFIER MEANS NO FETCH.
    //
    // The vision check fails closed, so without a client every clip would be
    // rejected — after being searched for, downloaded and graded. That spends
    // Pexels quota (200/hour) and runner bandwidth to reach a foregone
    // conclusion, and reports it as "no stock clip passed the vision check",
    // which reads like the clips were bad rather than like the checker was
    // absent. Reachable on any job that has PEXELS_API_KEY and no
    // ANTHROPIC_API_KEY — the dry-run job is exactly that shape.
    if (!visionClient) {
      return { clip: null, attempts: [{ stage: "config", reason: "no vision client, so stock cannot be verified and is not fetched" }] };
    }
    try {
      return await fetchStockClip({
        keywords: seg.visualSpec?.keywords || [],
        seconds: seg.seconds,
        subject: (seg.visualSpec?.keywords || [])[0] || seg.text?.slice(0, 80),
        dir,
        index: i,
        orientation: seg.visualSpec?.orientation || "landscape",
        usedHashes,
        client: visionClient,
        ffmpeg,
        driveGet,
        drivePut,
      });
    } catch (err) {
      console.warn(`[Visuals] stock lookup threw for ${seg.takeId}: ${err.message}`);
      return { clip: null, attempts: [{ stage: "error", reason: err.message }] };
    }
  };

  // Owned footage is allocated from whatever is in the long-form folder — which
  // is empty by default, so this is normally zero and the other layers cover
  // everything.
  const ownedSeconds = new Map();
  let ownedCursor = 0;
  const ownedFor = (seg) => {
    if (ownedPool.length === 0) return 0;
    const clip = ownedPool[ownedCursor % ownedPool.length];
    ownedCursor++;
    const available = Math.min(clip.durationSeconds || 0, seg.seconds);
    ownedSeconds.set(seg.takeId, { clip, seconds: available });
    return available;
  };

  const planned = await planVisuals(plan.segments || [], { renderGraphic, fetchStock, ownedFor });

  // ── turn the coverage blocks into broll entries the renderer understands ──
  const segments = [];
  for (const seg of planned.segments) {
    if (seg.kind !== "voiceover") { segments.push(seg); continue; }

    const broll = [];
    for (const block of seg.visualBlocks) {
      if (block.kind === "graphic" && seg.graphicClip) {
        broll.push({ generated: true, preRendered: true, kind: "graphic", visual: seg.visual, sourcePath: seg.graphicClip, seconds: block.seconds, fileName: `${seg.visual}.mp4` });
        continue;
      }
      if (block.kind === "stock" && seg.stockClip) {
        broll.push({ generated: true, preRendered: true, kind: "stock", sourcePath: seg.stockClip, seconds: block.seconds, contentHash: seg.stockContentHash, fileName: "stock.mp4" });
        if (seg.stockCredit) stockCredits.push(seg.stockCredit);
        continue;
      }
      if (block.kind === "owned") {
        const owned = ownedSeconds.get(seg.takeId);
        if (owned?.clip) {
          broll.push({ driveFileId: owned.clip.id, fileName: owned.clip.name, contentHash: owned.clip.contentHash || null, seconds: block.seconds, reused: false });
          continue;
        }
        // The allocator promised footage and the pool could not deliver. Rather
        // than emit a broll entry pointing at nothing — which renderTimeline
        // would skip, leaving the segment short — fall through to typography.
        block.kind = "typography";
        block.reason = REASON.NO_OWNED_FOOTAGE;
      }

      // TYPOGRAPHY, and anything that fell through to it.
      const i = index++;
      const clip = await renderTypographyClip({
        text: seg.text,
        words: timings.get(seg.takeId),
        seconds: block.seconds,
        eyebrow: seg.visualSpec?.eyebrow || null,
        dir,
        index: i,
        ffmpeg,
        writeFileSync,
      });
      if (clip) {
        broll.push({ generated: true, preRendered: true, kind: "typography", sourcePath: clip.path, seconds: block.seconds, fileName: "typography.mp4" });
      } else {
        // Only reachable with empty narration, which the script validator
        // already rejects. Reported rather than silently short.
        animationFailures.push({ takeId: seg.takeId, type: "TYPOGRAPHY", reason: "no narration text to set" });
      }
    }

    segments.push({ ...seg, broll });
  }

  const report = {
    ...planned.coverage,
    intents: planned.intents,
    // Drives the map attribution line in the description. Computed from what
    // actually reached the timeline rather than from what was requested: a MAP
    // intent that fell back to typography must not credit a map source for a
    // map the video does not contain.
    mapsUsed: segments.some((s) => (s.broll || []).some((b) => b.visual === MAP)),
    animationFailures,
    stockAttempts: planned.stockAttempts,
    stockCredits,
    stockConfigured: stockEnabled(),
    wordTimingCoverage: {
      takes: timings.size,
      withTiming: [...timings.values()].filter(Boolean).length,
    },
    // REVEAL SYNC, the number Peter kept asking for and the build kept not
    // printing. Per-graphic sync was collected from the start and only ever
    // returned, never logged, so the report said "24/24 takes transcribed" —
    // which is about AVAILABILITY of timing — and left "how many reveals
    // actually landed on a spoken word" invisible. They are different numbers
    // and the second one is the one that says whether the animation is doing
    // what it claims.
    revealSync: (() => {
      const g = graphicTimings.filter(Boolean);
      const reveals = g.reduce((n, t) => n + (t.revealCount || 0), 0);
      const synced = g.reduce((n, t) => n + (t.syncedCount || 0), 0);
      return {
        graphics: g.length,
        reveals,
        synced,
        pct: reveals > 0 ? Math.round((synced / reveals) * 100) : 0,
        evenPaced: g.filter((t) => t.source !== "word-timing").length,
        byType: g.reduce((acc, t) => {
          const k = t.type || "?";
          acc[k] = acc[k] || { reveals: 0, synced: 0 };
          acc[k].reveals += t.revealCount || 0;
          acc[k].synced += t.syncedCount || 0;
          return acc;
        }, {}),
      };
    })(),
  };

  return { plan: { ...plan, segments, visuals: report }, report };
}
