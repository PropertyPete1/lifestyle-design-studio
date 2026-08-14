/**
 * yt-visual-build.js — the wiring between the visual planner and ffmpeg.
 *
 * yt-visual-plan.js decides WHAT covers each second and is pure. This module is
 * the impure half: it renders the graphics, fetches the stock, and hands the
 * pipeline a plan whose `broll` lists point at real files. Keeping the two
 * apart is what lets the entire decision table be tested without ffmpeg, a
 * network, or an API key.
 *
 * THREE PASSES, IN ORDER, AND THE ORDER IS THE FIX.
 *
 * Card 11 resolved sources, CUT the graphic phases, rendered the beats, and
 * only then ran the bridge that moves seconds between blocks — so every number
 * the bridge changed was already baked into a file. A stock clip graded to
 * exactly its window looped from the start when its window grew; a graphic
 * phase sliced at plan-time startAt regressed to earlier content when the
 * blocks around it moved; an 8-second beat was rendered and then capped to
 * two. The card visibly rebuilt itself at 6:12 and the bridge's "137.5s given
 * back to real visuals" was 137.5s of replayed footage.
 *
 * So now: RESOLVE every block's source (network, renders — the slow, impure
 * part), then BRIDGE on the resolved blocks (pure arithmetic over seconds and
 * capacities), then MATERIALISE files against the final numbers (slices,
 * beats, verification). Nothing is encoded until nothing will move again.
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
import { MIN_BLOCK_SECONDS } from "./yt-visual-plan.js";
import { SCENE_MAX_SECONDS, BEAT_BRIDGE_MAX_SECONDS } from "./yt-config.js";
import { documentFrequencies, properLexicon, keywordsForWindow } from "./yt-scene-keywords.js";
import { deriveConcept } from "./yt-concept-fallback.js";

/**
 * The longest graphic animation we will render for one take.
 *
 * Spans the whole segment so reveals stay on the narration's clock, bounded only
 * so a pathological take cannot ask for hundreds of rasterises.
 */
const GRAPHIC_RENDER_MAX_SECONDS = 40;

/**
 * How far past the scene cap a bridged scene may grow IN PLACE before the
 * overflow becomes a new scene instead.
 *
 * The stub-merge tolerance the planner already uses: under a fifth of the
 * default cap, invisible as a held shot. Growth past this is not refused — it
 * becomes a CONTINUATION block, a real cut to later content from the same
 * source, which is what the variety rule wanted all along.
 */
const SCENE_GROW_TOLERANCE = 1.6;

/**
 * Trim one window out of a longer rendered clip.
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
import { renderAnimatedGraphic, renderBeatClip, assertAnimated, assertClipCovers } from "./yt-visual-animate.js";
import { fetchStockClip, stockEnabled, stockQuotaStats, StockQuotaError } from "./yt-stock.js";
import { preserveGateEvidence } from "./yt-evidence.js";
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
  // Injected for the scenario sweep, defaulted for the build — the same
  // dependency shape renderGraphic has always had, for the same reason: the
  // whole ladder (search dies, vision refuses, concept rescues, everything
  // fails at once) has to be drivable in a test without Pexels or a network.
  stockFetcher = fetchStockClip,
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
      // that is a content gap, not a bug, and it falls through with a reason
      // that says which names failed rather than a bare null.
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
  const stockLive = stockEnabled() && Boolean(visionClient);

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
  const beatBridges = [];
  const conceptCalls = { asked: 0, answered: 0, matched: 0 };
  const leftoverRetries = { asked: 0, matched: 0 };

  const segments = [];
  // Everything the evidence file needs if a gate fires mid-build. Assembled
  // incrementally so even a failure on take 3 of 24 leaves takes 1-3's ladder
  // decisions on disk.
  const evidenceSoFar = () => ({
    stockWindows, stockAttempts, conceptCalls, leftoverRetries, beatBridges, animationFailures,
    quota: stockQuotaStats(),
  });

  try {
  for (const seg of planned.segments) {
    if (seg.kind !== "voiceover") { segments.push(seg); continue; }

    // ── PASS 1: RESOLVE each block to a source, no files cut yet ────────────
    const blocks = [];
    for (const block of seg.visualBlocks) {
      if (block.kind === "graphic" && seg.graphicClip) {
        blocks.push({ kind: "graphic", seconds: block.seconds });
        continue;
      }
      if (block.kind === "stock") {
        const resolved = await resolveStockWindow(seg, block, {
          frequencies, lexicon, mapSession, market, visionClient, dir,
          timings, ffmpeg, usedHashes, driveGet, drivePut, stockFetcher,
          index: () => index++,
          stockWindows, stockAttempts, animationFailures, stockCredits, conceptCalls,
        });
        blocks.push(resolved);
        continue;
      }
      if (block.kind === "owned") {
        const owned = ownedSeconds.get(seg.takeId);
        if (owned?.clip) {
          blocks.push({ kind: "owned", seconds: block.seconds, clip: owned.clip });
        } else {
          // The allocator promised footage and the pool could not deliver. The
          // beat carries it — bridged like any other beat, rather than the old
          // fall to a typography branch that no longer exists.
          blocks.push({ kind: "beat", seconds: block.seconds, reason: REASON.NO_OWNED_FOOTAGE });
        }
        continue;
      }
      if (block.kind === "beat") {
        blocks.push({ kind: "beat", seconds: block.seconds, reason: block.reason || REASON.REMAINDER });
        continue;
      }
      // NOTHING ELSE EXISTS. Reaching this line means the planner emitted a
      // kind the builder does not know — a wiring bug, and loud.
      animationFailures.push({ takeId: seg.takeId, type: String(block.kind || "?").toUpperCase(), reason: `no builder for block kind "${block.kind}"` });
    }

    // ── PASS 2: BRIDGE on the resolved blocks — pure arithmetic ─────────────
    bridgeBeats(blocks, {
      max: BEAT_BRIDGE_MAX_SECONDS,
      sceneMax: SCENE_MAX_SECONDS,
      graphicSeconds: seg.graphicSeconds || 0,
      takeId: seg.takeId,
      beatBridges,
    });

    // ── PASS 2b: A LEFTOVER GETS A SECOND FETCH, NOT GEOMETRY ───────────────
    //
    // Run 31808464092: three takes held a MATCHED clip right beside an
    // unbridgeable beat, because the clip had no unseen tail to extend into.
    // The bridge was right to refuse the loop — but surrendering the span to
    // arcs when the stock layer is alive was the wrong surrender. Each
    // over-cap beat that survives bridging becomes a fresh stock window over
    // ITS OWN span: the window arithmetic hands the ladder the words actually
    // spoken during the beat, the no-repeat hashes exclude every clip already
    // used, and a second 7-second clip is a real scene where gold circles are
    // not. One retry per beat, then one re-bridge — a matched retry brings its
    // own graded slack, which is exactly what a neighbouring still-stranded
    // beat needs.
    if (stockLive) {
      let retried = false;
      let cursor = 0;
      for (let bi = 0; bi < blocks.length; bi++) {
        const b = blocks[bi];
        const startAt = cursor;
        cursor = Math.round((cursor + (b.seconds || 0)) * 1000) / 1000;
        if (b.kind !== "beat" || b.seconds <= BEAT_BRIDGE_MAX_SECONDS + 0.05) continue;
        leftoverRetries.asked++;
        const resolved = await resolveStockWindow(
          seg,
          { kind: "stock", seconds: b.seconds, startAt, phase: 900 + bi, retry: true },
          {
            frequencies, lexicon, mapSession, market, visionClient, dir,
            timings, ffmpeg, usedHashes, driveGet, drivePut, stockFetcher,
            index: () => index++,
            stockWindows, stockAttempts, animationFailures, stockCredits, conceptCalls,
          }
        );
        if (resolved.kind !== "beat") {
          leftoverRetries.matched++;
          blocks[bi] = resolved;
          retried = true;
        }
      }
      if (retried) {
        bridgeBeats(blocks, {
          max: BEAT_BRIDGE_MAX_SECONDS,
          sceneMax: SCENE_MAX_SECONDS,
          graphicSeconds: seg.graphicSeconds || 0,
          takeId: seg.takeId,
          beatBridges,
        });
      }
    }

    // ── PASS 3: MATERIALISE files against the final numbers ─────────────────
    const broll = await materialiseBlocks(seg, blocks, {
      dir, ffmpeg, index: () => index++,
      beatPhaseRef: { get: () => beatPhase, advance: () => { beatPhase += 313; } },
      animationFailures,
    });

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
  } catch (err) {
    // A quota exhaustion — or anything else that stops the build mid-ladder —
    // leaves every decision made so far on disk before it propagates. Run
    // 31766707987 died here with thirty-three minutes of ladder decisions in
    // memory and zero artifacts; that class of exit is banned.
    preserveGateEvidence("visual-build-aborted", { error: err.message, ...evidenceSoFar() });
    throw err;
  }

  // ── THE FULL-WINDOW BEAT IS EXTINCT, AND THIS IS WHERE THAT IS ENFORCED ───
  //
  // Not hoped for, not reported into a warning nobody reads — asserted. After
  // the ladder (map, window words, sentence, concept, establishing shot) and a
  // take-wide bridge, a beat still holding more than a bridge means every rung
  // failed for every window of a take, which with stock live means the content
  // genuinely defeated the whole ladder — quota exhaustion now fails earlier,
  // as its own typed error — and the build stops rather than shipping twenty
  // seconds of wordless geometry over the passage that names the video's
  // subject.
  //
  // THE EVIDENCE OUTLIVES THE THROW. Run 31766707987 fired this gate with an
  // error message promising "the per-window reasons are in the stock attempts
  // log above" — and the log had no such thing, because those lines print
  // after this function returns, in a reporting block the throw skipped. Same
  // rule as preserving a failed render: no gate may fail without leaving
  // behind the data that explains it. The full ladder record goes to the
  // diagnostics artifact, and each failing window's last recorded reason goes
  // into the message itself.
  //
  // The dry run — no Pexels key or no vision client — keeps beats by design,
  // and the assertion stands down: enforcement matches capability.
  if (stockLive) {
    const overheld = [];
    for (const seg of segments) {
      for (const b of seg.broll || []) {
        if (b.kind === "beat" && b.seconds > BEAT_BRIDGE_MAX_SECONDS + 0.05) {
          overheld.push({ takeId: seg.takeId, seconds: b.seconds });
        }
      }
    }
    if (overheld.length > 0) {
      const q = stockQuotaStats();
      const lastReasonFor = (takeId) => {
        const rows = stockAttempts.filter((a) => a.takeId === takeId);
        const last = rows.flatMap((r) => r.attempts).slice(-2);
        return last.length
          ? last.map((a) => `${a.stage}: ${String(a.reason).slice(0, 110)}`).join(" | ")
          : "no stock window was ever attempted for this take";
      };
      const detail = overheld
        .map((o) => `${o.takeId} (${o.seconds}s beat) — ${lastReasonFor(o.takeId)}`)
        .join("; ");
      const kept = preserveGateEvidence("full-window-beats", {
        overheld,
        ...evidenceSoFar(),
        coverage: coverageReport(segments),
      });
      throw new Error(
        `full-window beats survived with stock live — ${detail}. ` +
        `Quota this run: ${q.hits429} rate-limit hit(s), ${q.waits} in-run wait(s). ` +
        `Full ladder record: ${kept.reportPath || "COULD NOT BE WRITTEN — " + kept.errors.join("; ")}`
      );
    }
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
    beatBridges,
    conceptCalls,
    leftoverRetries,
    // Drives the map attribution line in the description. Computed from what
    // actually reached the timeline rather than from what was requested: a MAP
    // intent that fell back must not credit a map source for a map the video
    // does not contain.
    mapsUsed: segments.some((s) => (s.broll || []).some((b) => b.visual === MAP)),
    animationFailures,
    stockAttempts,
    stockCredits,
    stockConfigured: stockEnabled(),
    quota: stockQuotaStats(),
    wordTimingCoverage: {
      takes: timings.size,
      withTiming: [...timings.values()].filter(Boolean).length,
    },
    // SCENE STATS. The cadence audit measures motion INSIDE a visual; this
    // measures how often the visual itself changes, which is the thing card 5
    // got wrong while passing every in-graphic check.
    //
    // ADJACENCY COUNTS DISTINCT SOURCES. Two phases of one graphic, or a scene
    // and its continuation cut, are the same visual deliberately shown across a
    // scene boundary — counting them as a "same-kind run" made the number
    // unreadable: card 11 reported 12 while the real complaint was five
    // DIFFERENT cards in a row reading as a slideshow.
    scenes: (() => {
      const all = segments.flatMap((sg) => (sg.broll || []).filter((b) => b.seconds > 0).map((b) => ({
        kind: b.kind || (b.generated ? "generated" : "footage"),
        seconds: b.seconds,
        source: b.sourcePath || b.driveFileId || null,
      })));
      const lengths = all.map((b) => b.seconds);
      const runs = all.reduce((n, b, i) => (
        i > 0 && b.kind === all[i - 1].kind && b.source !== all[i - 1].source ? n + 1 : n
      ), 0);
      return {
        count: all.length,
        averageSeconds: lengths.length ? round2(lengths.reduce((a, b) => a + b, 0) / lengths.length) : 0,
        longestSeconds: lengths.length ? round2(Math.max(...lengths)) : 0,
        overCap: lengths.filter((l) => l > SCENE_MAX_SECONDS + SCENE_GROW_TOLERANCE).length,
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

/**
 * Resolve one stock window: map moment, then the window's own words, then a
 * derived concept, and only then a beat.
 *
 * EACH WINDOW IS ITS OWN SEARCH, AGAINST ITS OWN SENTENCE. Card 7 fetched one
 * clip per take and sliced it, so a take that moved from a hospital to houses
 * from the eighties showed the hospital throughout.
 */
async function resolveStockWindow(seg, block, {
  frequencies, lexicon, mapSession, market, visionClient, dir,
  timings, ffmpeg, usedHashes, driveGet, drivePut, index, stockFetcher = fetchStockClip,
  stockWindows, stockAttempts, animationFailures, stockCredits, conceptCalls,
}) {
  const win = keywordsForWindow(seg, block, {
    frequencies,
    lexicon,
    fallbackKeywords: seg.visualSpec?.keywords || [],
  });
  const attempts = [];
  const windowRow = {
    takeId: seg.takeId,
    phase: block.phase ?? 0,
    startAt: block.startAt ?? 0,
    seconds: block.seconds,
    phrase: win.phrase,
    keywords: win.keywords,
    subject: win.subject,
    dropped: win.dropped,
    source: win.source,
    matched: false,
    // Set on the second-chance window a surviving beat becomes, so the report
    // reads "this span was rescued on retry" rather than looking like a
    // fifteenth ordinary window.
    retry: Boolean(block.retry),
  };

  // ── A PLACE WINDOW IS THE MAP'S TERRITORY ────────────────────────────────
  //
  // When a window's own words yield nothing, it is almost always because the
  // window IS a name: "Stone Oak is the big one", "Shavano Park sits right
  // against it". A named place is a map's subject by definition, and the
  // geometry is already vendored. So the window asks for a map of itself
  // before it asks for stock — and only a place this video has not already
  // drawn, otherwise the same neighbourhood gets introduced three times.
  if (win.placeDominated) {
    const placeSpec = mapSpecForIntent({ places: win.properPhrases, lines: [] }, { market });
    if (placeSpec && !mapSession.coversPlaces(placeSpec)) {
      const mi = index();
      try {
        const r = await renderAnimatedGraphic({
          session: mapSession, type: MAP, spec: placeSpec,
          seconds: block.seconds, words: timings.get(seg.takeId),
          dir, index: mi, ffmpeg, writeFileSync,
        });
        if (r.deadStates.length === 0) {
          stockWindows.push({ ...windowRow, keywords: [], subject: null, source: "map-of-place", matched: true, resolved: "MAP", places: win.properPhrases });
          return { kind: "mapmoment", seconds: block.seconds, path: r.path, renderedSeconds: r.seconds };
        }
        animationFailures.push({ takeId: seg.takeId, type: MAP, reason: `place map rendered ${r.deadStates.length} dead state(s)` });
      } catch (err) {
        animationFailures.push({ takeId: seg.takeId, type: MAP, reason: `place map failed: ${err.message}` });
      }
    }
  }

  const fetchOpts = {
    seconds: block.seconds,
    dir,
    orientation: seg.visualSpec?.orientation || "landscape",
    usedHashes,
    client: visionClient,
    ffmpeg,
    driveGet,
    drivePut,
  };

  // The two searching rungs, as callables so their ORDER can depend on what
  // the window's own derivation produced.
  let clip = null;

  const mechanicalRung = async () => {
    if (clip || win.keywords.length === 0) {
      if (!clip && win.keywords.length === 0) attempts.push({ stage: "keywords", reason: "no searchable concept in this window" });
      return;
    }
    try {
      const r = await stockFetcher({
        keywords: win.keywords,
        // THE SEARCH AND THE CHECK ASK DIFFERENT QUESTIONS. The query is what a
        // stock search can use; the subject is what is actually SPOKEN while
        // the clip is on screen, proper nouns stripped — the check has never
        // been allowed to know a place name and still is not.
        subject: win.verifySubject || win.subject,
        index: index(),
        ...fetchOpts,
      });
      clip = r?.clip || null;
      attempts.push(...(r?.attempts || []));
    } catch (err) {
      // Quota exhaustion is not a rung failure — it is the whole layer gone,
      // and pretending otherwise is how a rate limit became all-beat takes.
      if (err instanceof StockQuotaError) throw err;
      console.warn(`[Visuals] stock lookup threw for ${seg.takeId} window ${block.phase}: ${err.message}`);
      attempts.push({ stage: "error", reason: err.message });
    }
  };

  const conceptRung = async () => {
    if (clip || !visionClient) return;
    conceptCalls.asked++;
    const banned = new Set([
      ...(win.dropped || []).map((w) => String(w).toLowerCase()),
      ...lexicon,
    ]);
    const concept = await deriveConcept({
      phrase: win.phrase,
      takeText: seg.text,
      sectionTitle: seg.section || "",
      banned,
      client: visionClient,
    });
    if (concept) {
      conceptCalls.answered++;
      try {
        const r = await stockFetcher({
          keywords: [concept.query],
          subject: concept.subject,
          index: index(),
          ...fetchOpts,
        });
        if (r?.clip) {
          clip = r.clip;
          windowRow.source = "concept";
          windowRow.keywords = [concept.query];
          windowRow.subject = concept.subject;
        }
        attempts.push(...(r?.attempts || []).map((a) => ({ ...a, stage: `concept-${a.stage}` })));
      } catch (err) {
        if (err instanceof StockQuotaError) throw err;
        attempts.push({ stage: "concept-error", reason: err.message });
      }
    } else {
      attempts.push({ stage: "concept", reason: "no filmable concept derived" });
    }
  };

  // ── RUNG ORDER: THE CONCEPT GOES FIRST WHEN THE SUBJECT IS THE QUERY IN A
  // HAT ─────────────────────────────────────────────────────────────────────
  //
  // A window whose depiction subject could not be formed hands the vision
  // check its own raw bigram — and those are the measured pun-magnets: subject
  // "animal well" accepted a rooster on card 11 AND a second animal clip on
  // run 31808464092; "closest base" accepted a baseball field. A check asked a
  // nonsense question cannot protect the video, so when the derivation
  // degenerates, the model names the subject BEFORE the mechanical query gets
  // to shop with it. The mechanical rung still runs after — a concept miss
  // should not cost a window the search it always had.
  //
  // "matters even if your kids are grown" becomes a family front yard;
  // "five minutes on a normal morning" becomes commute traffic. The concept
  // fails closed, and its output passes the same proper-noun stripping the
  // transcript does — see yt-concept-fallback.js.
  const degenerateSubject = win.keywords.length > 0 && win.subjectDerived === false;
  if (degenerateSubject) {
    await conceptRung();
    await mechanicalRung();
  } else {
    await mechanicalRung();
    await conceptRung();
  }

  stockWindows.push({ ...windowRow, matched: Boolean(clip), contentHash: clip?.contentHash || null, query: clip?.query || null });
  if (attempts.length) stockAttempts.push({ takeId: seg.takeId, phase: block.phase ?? 0, attempts });

  if (clip) {
    conceptCalls.matched += windowRow.source === "concept" ? 1 : 0;
    // NO CLIP TWICE IN ONE VIDEO. `usedHashes` arrives holding what recent
    // videos used; adding here is what makes the rule hold within this video
    // as well.
    usedHashes.add(clip.contentHash);
    stockCredits.push(clip.credit);
    return {
      kind: "stock", seconds: block.seconds, clip,
      // The graded file deliberately runs longer than the window — see
      // STOCK_GRADE_SLACK_SECONDS — and the spare is this block's capacity to
      // absorb a bridged beat with footage the viewer has not seen.
      sourceSeconds: clip.gradedSeconds || block.seconds,
    };
  }

  // Nothing survived for this window. The beat carries it — for now; the
  // bridge caps it and the neighbouring scenes absorb the difference.
  return {
    kind: "beat", seconds: block.seconds,
    reason: win.keywords.length === 0 ? REASON.NO_KEYWORDS : REASON.STOCK_NO_MATCH,
  };
}

/**
 * Cap every wordless beat at a bridge, handing the overflow to real scenes.
 *
 * PURE, and separate from the build loop so the rule can be argued with in a
 * test rather than by rendering a video and watching for circles.
 *
 * WHAT CHANGED FROM CARD 11, each line paid for by a defect in the artifact:
 *
 *   ADJACENT BEATS MERGE FIRST. The floor emits an 17s remainder as 8+4.5+4.5,
 *   and the old bridge then asked each of the three who its neighbours were —
 *   beats, both sides — and gave up on all three while a real scene sat one
 *   slot away. Thirteen of card 11's beats "could NOT be capped" this way.
 *
 *   THE HOST SEARCH IS TAKE-WIDE. A beat bridges to the NEAREST real scene,
 *   preferring the earlier side (extending a shot the viewer is already
 *   watching is invisible), but a beat with beats for immediate neighbours no
 *   longer strands.
 *
 *   HOSTS HAVE CAPACITY, IN CONTENT. A scene can only absorb seconds its
 *   source actually holds — the graphic's one render, the stock clip's graded
 *   slack. The old bridge grew `seconds` unconditionally and `-stream_loop`
 *   papered over the difference by replaying the clip from the start.
 *
 *   THE SCENE CAP HOLDS. Growth past cap+tolerance becomes a CONTINUATION
 *   block — a real cut to later content from the same source — instead of the
 *   18-second scenes the report warned about while the bridge created them.
 *
 * A take with NOTHING else in it keeps its beats and is recorded — there is no
 * neighbour to extend, and a hole in the picture is not an improvement. When
 * stock is live the build then fails loudly upstream, because with the full
 * ladder in place that take means a systemic fetch failure.
 */
export function bridgeBeats(blocks, {
  max,
  sceneMax = SCENE_MAX_SECONDS,
  graphicSeconds = 0,
  takeId = null,
  beatBridges = [],
} = {}) {
  // ── 1. adjacent beats are one beat ────────────────────────────────────────
  for (let i = blocks.length - 1; i > 0; i--) {
    if (blocks[i]?.kind === "beat" && blocks[i - 1]?.kind === "beat") {
      blocks[i - 1].seconds = round2(blocks[i - 1].seconds + blocks[i].seconds);
      blocks[i - 1].reason = blocks[i - 1].reason || blocks[i].reason;
      blocks.splice(i, 1);
    }
  }

  // ── 2. capacity: how many seconds of UNSEEN content each source still has ─
  //
  // Graphics share one render across all their blocks, so their capacity is
  // pooled; a stock or owned block's capacity is its own file's spare tail.
  const graphicDisplayed = blocks.filter((b) => b.kind === "graphic").reduce((n, b) => n + b.seconds, 0);
  let graphicSpare = Math.max(0, round2(graphicSeconds - graphicDisplayed));
  const capacityOf = (b) => {
    if (b.kind === "graphic") return graphicSpare;
    if (b.kind === "stock") return Math.max(0, round2((b.sourceSeconds || b.seconds) - b.seconds - (b.spent || 0)));
    if (b.kind === "owned") return Math.max(0, round2((b.clip?.durationSeconds || b.seconds) - b.seconds - (b.spent || 0)));
    // A map moment is rendered to exactly its window; extending it would loop.
    return 0;
  };
  const spend = (b, take) => {
    if (b.kind === "graphic") graphicSpare = round2(graphicSpare - take);
    else b.spent = round2((b.spent || 0) + take);
  };

  // ── 3. cap each beat, distributing the overflow ───────────────────────────
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (!b || b.kind !== "beat") continue;
    let over = round2((b.seconds || 0) - max);
    if (over <= 0.01) continue;
    b.seconds = round2(max);

    const isReal = (x) => x && x.kind !== "beat" && (x.seconds || 0) > 0;
    // Nearest real block, earlier side winning ties.
    const hostOrder = [];
    for (let d = 1; d < blocks.length; d++) {
      if (i - d >= 0 && isReal(blocks[i - d])) hostOrder.push(blocks[i - d]);
      if (i + d < blocks.length && isReal(blocks[i + d])) hostOrder.push(blocks[i + d]);
    }
    if (hostOrder.length === 0) {
      b.seconds = round2(max + over);
      beatBridges.push({ takeId, seconds: b.seconds, capped: false, reason: "no other visual in this take to extend" });
      continue;
    }

    let gave = 0;
    // Round one: each host takes the overflow either IN PLACE (when it fits
    // under the cap's tolerance) or as a CONTINUATION scene — a real cut to
    // the source's unseen tail, itself cap-sized. Preferring the whole
    // overflow as one continuation over topping a scene up to its limit is
    // what keeps sub-scene stubs from forcing anybody past the cap.
    for (const host of hostOrder) {
      while (over >= 0.01 && capacityOf(host) >= 0.01) {
        const room = round2(sceneMax + SCENE_GROW_TOLERANCE - host.seconds);
        if (over <= room + 0.01) {
          const g = round2(Math.min(over, capacityOf(host)));
          host.seconds = round2(host.seconds + g);
          spend(host, g);
          over = round2(over - g);
          gave = round2(gave + g);
          break;
        }
        if (over >= MIN_BLOCK_SECONDS && capacityOf(host) >= MIN_BLOCK_SECONDS) {
          const take = round2(Math.min(over, capacityOf(host), sceneMax));
          const continuation = { kind: host.kind, seconds: take, continuesFrom: host, continuation: true };
          if (host.kind === "stock" || host.kind === "owned") continuation.clip = host.clip;
          blocks.splice(blocks.indexOf(host) + 1, 0, continuation);
          spend(host, take);
          over = round2(over - take);
          gave = round2(gave + take);
          continue;
        }
        break;
      }
      if (over < 0.01) break;
    }

    // Round two: a stub too short to be a scene of its own. The nearest host
    // with any content left holds it — a shot running a second long is
    // invisible; a beat running a second past its bridge is the thing being
    // retired.
    if (over >= 0.01 && over < MIN_BLOCK_SECONDS) {
      const host = hostOrder.find((h) => capacityOf(h) >= over);
      if (host) {
        host.seconds = round2(host.seconds + over);
        spend(host, over);
        gave = round2(gave + over);
        over = 0;
      }
    }

    if (over >= 0.01) {
      // Every source in the take is out of unseen content. The tail goes back
      // to the beat rather than looping somebody — recorded, so the build's
      // own assertion can decide whether that is fatal.
      b.seconds = round2(b.seconds + over);
      beatBridges.push({ takeId, seconds: b.seconds, capped: false, reason: "every source in this take is out of unseen content" });
      continue;
    }
    beatBridges.push({ takeId, seconds: max, capped: true, gaveSeconds: gave, to: hostOrder[0].kind });
  }
  return blocks;
}

/**
 * Turn the bridged blocks into broll entries pointing at real files.
 *
 * Runs AFTER the bridge, so every `seconds` here is final — which is the whole
 * point of the pass structure. Graphic phases are sliced against a cursor into
 * the one continuous render (a phase opens exactly where the previous one
 * closed, wherever the bridge moved the boundaries); stock continuations are
 * cut from the graded file's spare tail; beats are rendered at their final
 * bridge length and verified before they may enter the timeline.
 */
async function materialiseBlocks(seg, blocks, { dir, ffmpeg, index, beatPhaseRef, animationFailures }) {
  const broll = [];
  let graphicCursor = 0;
  const stockCursor = new Map(); // clip.path -> seconds of the file already scheduled
  const graphicBlocks = blocks.filter((b) => b.kind === "graphic");
  let phaseNo = 0;

  for (const block of blocks) {
    if (block.kind === "graphic" && seg.graphicClip) {
      const from = round2(Math.min(graphicCursor, Math.max(0, (seg.graphicSeconds || 0) - 0.1)));
      const dur = round2(Math.min(block.seconds, Math.max(0.1, (seg.graphicSeconds || block.seconds) - from)));
      graphicCursor = round2(from + dur);
      let phasePath = seg.graphicClip;
      const thisPhase = phaseNo++;
      if (graphicBlocks.length > 1) {
        phasePath = join(dir, `phase-${seg.takeId}-${thisPhase}.mp4`);
        try {
          ffmpeg(phaseArgs(seg.graphicClip, phasePath, from, dur));
        } catch (err) {
          // A failed slice must not cost the segment its picture: fall back to
          // the whole clip, which is the pre-phase behaviour, and say so.
          animationFailures.push({ takeId: seg.takeId, type: seg.visual, reason: `phase ${thisPhase} slice failed (${err.message}) — phase plays from the start` });
          phasePath = seg.graphicClip;
        }
      }
      broll.push({
        generated: true, preRendered: true, kind: "graphic", visual: seg.visual,
        sourcePath: phasePath, seconds: block.seconds, sourceSeconds: dur,
        phase: thisPhase, phaseOf: graphicBlocks.length, fileName: `${seg.visual}.mp4`,
      });
      continue;
    }

    if (block.kind === "mapmoment") {
      broll.push({
        generated: true, preRendered: true, kind: "graphic", visual: MAP,
        sourcePath: block.path, seconds: block.seconds, sourceSeconds: block.renderedSeconds || block.seconds,
        phase: 0, fileName: "MAP.mp4",
      });
      continue;
    }

    if (block.kind === "stock") {
      const clip = block.clip || block.continuesFrom?.clip;
      if (!clip) {
        animationFailures.push({ takeId: seg.takeId, type: "STOCK", reason: "a stock block lost its clip between resolve and materialise" });
        continue;
      }
      const already = stockCursor.get(clip.path) || 0;
      let sourcePath = clip.path;
      let sourceSeconds = round2((clip.gradedSeconds || block.seconds) - already);
      if (block.continuation) {
        // The continuation plays the graded file's unseen tail — a real cut to
        // later footage, not a replay. Sliced here because conform cuts from
        // the head of whatever file it is given.
        const contPath = join(dir, `stockcont-${seg.takeId}-${broll.length}.mp4`);
        try {
          ffmpeg(phaseArgs(clip.path, contPath, already, block.seconds));
          sourcePath = contPath;
          sourceSeconds = block.seconds;
        } catch (err) {
          animationFailures.push({ takeId: seg.takeId, type: "STOCK", reason: `continuation slice failed (${err.message})` });
          continue;
        }
      }
      stockCursor.set(clip.path, round2(already + block.seconds));
      broll.push({
        generated: true, preRendered: true, kind: "stock",
        sourcePath, seconds: block.seconds, sourceSeconds,
        contentHash: clip.contentHash, query: clip.query, fileName: "stock.mp4",
        continuation: Boolean(block.continuation),
      });
      continue;
    }

    if (block.kind === "owned") {
      broll.push({ driveFileId: block.clip.id, fileName: block.clip.name, contentHash: block.clip.contentHash || null, seconds: block.seconds, reused: false });
      continue;
    }

    if (block.kind === "beat") {
      const bi = index();
      try {
        const beat = await renderBeatClip({
          seconds: block.seconds, dir, index: bi, ffmpeg, writeFileSync,
          // Phase carries across the video so two beats are never the same
          // geometry, the way two stock blocks are never the same window.
          startPhase: beatPhaseRef.get(),
        });
        beatPhaseRef.advance();
        // THE BEAT IS VERIFIED LIKE EVERYTHING ELSE. It was the one generated
        // clip that entered the timeline on trust, and card 11 spent 84 frozen
        // seconds finding out what that trust was worth. The assertion reads
        // the encoded file back: right length, and actually moving.
        const verdict = await assertClipCovers(beat.path, { seconds: block.seconds, dir, ffmpeg, index: bi });
        if (!verdict.ok) {
          throw new Error(`beat failed verification: ${verdict.failures.join("; ")}`);
        }
        broll.push({ generated: true, preRendered: true, kind: "beat", sourcePath: beat.path, seconds: block.seconds, sourceSeconds: beat.seconds, fileName: "beat.mp4" });
      } catch (err) {
        animationFailures.push({ takeId: seg.takeId, type: "BEAT", reason: err.message });
        // A beat that cannot render or verify must not silently shorten the
        // picture — that is the exact hole the frozen tails came through. The
        // segment renderer asserts picture-covers-narration and will name this
        // take; the failure above says why.
      }
      continue;
    }
  }
  return broll;
}

/** Milliseconds are enough for a word boundary; more just makes noisy diffs. */
function round2(n) {
  return Math.round(n * 1000) / 1000;
}
