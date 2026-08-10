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

import { planVisuals, REASON, coverageReport } from "./yt-visual-plan.js";
import { SCENE_MAX_SECONDS } from "./yt-config.js";
import { documentFrequencies, properLexicon, keywordsForWindow } from "./yt-scene-keywords.js";

/**
 * The longest graphic animation we will render for one take.
 *
 * Spans the whole segment so reveals stay on the narration's clock, bounded only
 * so a pathological take cannot ask for hundreds of rasterises.
 */
const GRAPHIC_RENDER_MAX_SECONDS = 40;

/**
 * Trim one phase window out of a rendered graphic.
 *
 * `-ss` AFTER `-i` and a re-encode, both deliberate. Seeking before the input
 * lands on the nearest keyframe, which for a graphic whose reveals are ~0.14s
 * apart can drop a phase onto the wrong state; and `-c copy` cuts on keyframes
 * for the same reason. A phase that starts a third of a second late is a reveal
 * that has already happened off-screen.
 */
export function phaseArgs(input, output, from, seconds) {
  return [
    "-y", "-i", input,
    "-ss", String(Math.max(0, from)), "-t", String(Math.max(0.1, seconds)),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-an", "-fps_mode", "cfr",
    output,
  ];
}
import { renderAnimatedGraphic, renderBeatClip, assertAnimated } from "./yt-visual-animate.js";
import { fetchStockClip, stockEnabled } from "./yt-stock.js";
import { MAP } from "./yt-visual-intent.js";
import { mapSpecForIntent, MapSession } from "./yt-map-render.js";

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
  // ONE session per video, so map two knows what map one drew.
  const mapSession = new MapSession();
  // Walks so consecutive beats differ, video-wide.
  let beatPhase = 0;

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
        session: mapSession,
        type: seg.visual,
        spec,
        // THE WHOLE SEGMENT, not a 22s slice of it.
        //
        // The reveals are timed against this take's words, so the animation has to
        // span the same timeline the narration does. Each graphic block then shows
        // its own WINDOW of that one continuous render — phase 2 opens where the
        // clock says it should, which is what makes it resume rather than restart,
        // and every reveal still lands on the word it was anchored to whenever the
        // graphic is the thing on screen.
        seconds: Math.min(seg.seconds, GRAPHIC_RENDER_MAX_SECONDS),
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
        renderedSeconds: r.seconds,
        timing: { syncedCount: r.syncedCount, revealCount: r.reveals.length, source: r.source, stateCount: r.stateCount },
      };
    } catch (err) {
      animationFailures.push({ takeId: seg.takeId, type: seg.visual, reason: err.message });
      return { ok: false, reason: err.message };
    }
  };

  /**
   * Can this take have stock at all?
   *
   * NO VERIFIER MEANS NO FETCH. The vision check fails closed, so without a
   * client every clip would be rejected — after being searched for, downloaded
   * and graded. That spends Pexels quota (200/hour) and runner bandwidth to
   * reach a foregone conclusion, and reports it as "no stock clip passed the
   * vision check", which reads like the clips were bad rather than like the
   * checker was absent. Reachable on any job that has PEXELS_API_KEY and no
   * ANTHROPIC_API_KEY — the dry-run job is exactly that shape.
   *
   * Answering with the take's whole length is what lets the planner lay out as
   * many stock windows as the scene cap allows; each one is then fetched
   * separately below, and any that comes back empty becomes a beat.
   */
  const stockAvailable = (seg) => {
    if (!stockEnabled() || !visionClient) return 0;
    return seg.seconds || 0;
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

  const planned = await planVisuals(plan.segments || [], { renderGraphic, stockAvailable, ownedFor });

  // Rarity is measured across the WHOLE script, so it has to be computed once
  // over every segment before any single window is looked at.
  const frequencies = documentFrequencies(planned.segments);
  // Capitalisation is only evidence when read across the whole script — see
  // properLexicon. Built once here so a window opening on a place name cannot
  // mistake it for a common noun.
  const lexicon = properLexicon(planned.segments);
  const stockAttempts = [];
  const stockWindows = [];

  // ── turn the coverage blocks into broll entries the renderer understands ──
  const segments = [];
  for (const seg of planned.segments) {
    if (seg.kind !== "voiceover") { segments.push(seg); continue; }

    const broll = [];
    for (const block of seg.visualBlocks) {
      if (block.kind === "graphic" && seg.graphicClip) {
        // Slice this phase's window out of the one render. Without this every
        // phase points at the same file and plays it from zero — the build/cut/
        // rebuild loop that made revision 6 cap the graphic at a single scene.
        const from = Math.min(block.startAt ?? 0, Math.max(0, (seg.graphicSeconds || 0) - 0.1));
        const dur = Math.min(block.seconds, Math.max(0.1, (seg.graphicSeconds || block.seconds) - from));
        let phasePath = seg.graphicClip;
        if ((block.phaseOf || 1) > 1) {
          phasePath = join(dir, `phase-${seg.takeId}-${block.phase}.mp4`);
          try {
            ffmpeg(phaseArgs(seg.graphicClip, phasePath, from, dur));
          } catch (err) {
            // A failed slice must not cost the segment its picture: fall back to
            // the whole clip, which is the pre-phase behaviour, and say so.
            animationFailures.push({ takeId: seg.takeId, type: seg.visual, reason: `phase ${block.phase} slice failed (${err.message}) — phase plays from the start` });
            phasePath = seg.graphicClip;
          }
        }
        broll.push({ generated: true, preRendered: true, kind: "graphic", visual: seg.visual, sourcePath: phasePath, seconds: block.seconds, phase: block.phase, fileName: `${seg.visual}.mp4` });
        continue;
      }
      if (block.kind === "stock") {
        // EACH WINDOW IS ITS OWN SEARCH, AGAINST ITS OWN SENTENCE.
        //
        // Card 7 fetched one clip per take and sliced it, so a take that moved
        // from a hospital to houses from the eighties showed the hospital
        // throughout. Now the window's words choose the window's footage:
        // "Audie Murphy VA hospital" searches for a hospital campus and the
        // proper noun is dropped before the query is built, so the clip is never
        // presented as that specific place.
        const win = keywordsForWindow(seg, block, {
          frequencies,
          lexicon,
          fallbackKeywords: seg.visualSpec?.keywords || [],
        });
        const wi = index++;
        let clip = null;
        let attempts = [{ stage: "keywords", reason: "no searchable concept in this window" }];

        if (win.keywords.length > 0) {
          try {
            const r = await fetchStockClip({
              keywords: win.keywords,
              seconds: block.seconds,
              subject: win.subject,
              dir,
              index: wi,
              orientation: seg.visualSpec?.orientation || "landscape",
              usedHashes,
              client: visionClient,
              ffmpeg,
              driveGet,
              drivePut,
            });
            clip = r?.clip || null;
            attempts = r?.attempts || [];
          } catch (err) {
            console.warn(`[Visuals] stock lookup threw for ${seg.takeId} window ${block.phase}: ${err.message}`);
            attempts = [{ stage: "error", reason: err.message }];
          }
        }

        stockWindows.push({
          takeId: seg.takeId,
          phase: block.phase ?? 0,
          startAt: block.startAt ?? 0,
          seconds: block.seconds,
          phrase: win.phrase,
          keywords: win.keywords,
          subject: win.subject,
          dropped: win.dropped,
          source: win.source,
          matched: Boolean(clip),
          contentHash: clip?.contentHash || null,
          query: clip?.query || null,
        });
        if (attempts.length) stockAttempts.push({ takeId: seg.takeId, phase: block.phase ?? 0, attempts });

        if (clip) {
          // NO CLIP TWICE IN ONE VIDEO. `usedHashes` arrives holding what recent
          // videos used and was only ever READ — nothing added to it during a
          // build, so two windows could independently pick the same clip and the
          // no-repeat rule silently covered only the history. Adding here is what
          // makes it hold within this video as well.
          usedHashes.add(clip.contentHash);
          stockCredits.push(clip.credit);
          broll.push({
            generated: true, preRendered: true, kind: "stock",
            sourcePath: clip.path, seconds: block.seconds,
            contentHash: clip.contentHash, query: clip.query, fileName: "stock.mp4",
          });
          continue;
        }

        // Nothing survived for this window. The beat carries it, and the reason
        // is recorded per window rather than per take — "take 4 got no stock" was
        // true of four windows for four different reasons.
        block.kind = "beat";
        block.reason = win.keywords.length === 0 ? REASON.NO_KEYWORDS : REASON.STOCK_NO_MATCH;
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

      // BEAT — the wordless floor, and anything that fell through to it.
      if (block.kind === "beat") {
        const bi = index++;
        try {
          const beat = await renderBeatClip({
            seconds: block.seconds, dir, index: bi, ffmpeg, writeFileSync,
            // Phase carries across the video so two beats are never the same
            // geometry, the way two stock blocks are never the same window.
            startPhase: beatPhase,
          });
          beatPhase += 313;
          broll.push({ generated: true, preRendered: true, kind: "beat", sourcePath: beat.path, seconds: block.seconds, fileName: "beat.mp4" });
        } catch (err) {
          animationFailures.push({ takeId: seg.takeId, type: "BEAT", reason: err.message });
        }
        continue;
      }

      // NOTHING ELSE SETS THE NARRATION AS PROSE.
      //
      // The typography branch lived here and is gone. Every block kind is handled
      // above, and the plan's floor is a beat, so reaching this line means the
      // planner emitted a kind the builder does not know — which is a wiring bug
      // and must be loud rather than silently leaving the segment short.
      animationFailures.push({ takeId: seg.takeId, type: String(block.kind || "?").toUpperCase(), reason: `no builder for block kind "${block.kind}"` });
    }

    // A take PLANNED for stock whose every window came back empty is a fall, and
    // it did not used to look like one. The planner set `visualPrimary: "stock"`
    // before any fetch happened, so a take carried entirely by beats still
    // reported stock as its primary layer and never appeared in the fallback
    // list — the coverage split said "beat" and the fallback list said nothing,
    // which is the reporting gap the whole per-window change would otherwise
    // have opened.
    if (seg.visualPrimary === "stock" && !broll.some((b) => b.kind === "stock")) {
      seg.visualPrimary = "beat";
      seg.visualFellBack = true;
      seg.visualReason = REASON.STOCK_NO_MATCH;
    }

    segments.push({ ...seg, broll });
  }

  const report = {
    // RECOMPUTED, not the planner's. Windows that failed their fetch became
    // beats a moment ago, and the coverage split has to describe what the video
    // contains rather than what the plan hoped for — reporting the pre-fetch
    // numbers would overstate stock by exactly the windows that failed, which is
    // the one direction the number must never be wrong in.
    ...coverageReport(segments),
    intents: planned.intents,
    stockWindows,
    // Drives the map attribution line in the description. Computed from what
    // actually reached the timeline rather than from what was requested: a MAP
    // intent that fell back to typography must not credit a map source for a
    // map the video does not contain.
    mapsUsed: segments.some((s) => (s.broll || []).some((b) => b.visual === MAP)),
    animationFailures,
    stockAttempts,
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
    // SCENE STATS. The cadence audit measures motion INSIDE a visual; this
    // measures how often the visual itself changes, which is the thing card 5
    // got wrong while passing every in-graphic check.
    scenes: (() => {
      const all = segments.flatMap((sg) => (sg.broll || []).filter((b) => b.seconds > 0).map((b) => ({ kind: b.kind || (b.generated ? "generated" : "footage"), seconds: b.seconds })));
      const lengths = all.map((b) => b.seconds);
      const runs = all.reduce((n, b, i) => (i > 0 && b.kind === all[i - 1].kind ? n + 1 : n), 0);
      return {
        count: all.length,
        averageSeconds: lengths.length ? round2(lengths.reduce((a, b) => a + b, 0) / lengths.length) : 0,
        longestSeconds: lengths.length ? round2(Math.max(...lengths)) : 0,
        overCap: lengths.filter((l) => l > SCENE_MAX_SECONDS + 1.6).length,
        sameKindRuns: runs,
        cap: SCENE_MAX_SECONDS,
      };
    })(),
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

/** Milliseconds are enough for a word boundary; more just makes noisy diffs. */
function round2(n) {
  return Math.round(n * 1000) / 1000;
}
