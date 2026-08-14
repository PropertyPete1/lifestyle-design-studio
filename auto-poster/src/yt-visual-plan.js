/**
 * yt-visual-plan.js — deciding what covers every second of every voiceover take.
 *
 * THE MODEL INVERTED, and this file is where that lands.
 *
 * Revision 2: footage was the picture, and a graphic was SPLICED into the front
 * of it. That is why `selectGeneratedVisuals` skipped any segment whose footage
 * total was zero — with no footage there was nothing to splice into, so the
 * graphic was silently dropped. Point that code at an empty footage folder and
 * every segment comes back with no picture at all.
 *
 * Revision 3: the generated visual IS the picture, and footage is one of the
 * things that can serve a segment rather than the substrate all of them sit on.
 * So this module does not "select" visuals against a budget. It COVERS: every
 * voiceover second gets a block, from whichever layer can serve it, and
 * a wordless brand beat is the floor that guarantees the covering is total.
 *
 * THE ORDER OF PREFERENCE, per segment:
 *   1. the writer's graphic intent      — animated, timed to the narration
 *   2. the writer's FOOTAGE intent      — stock, if keywords and a clip survive
 *   3. owned long-form footage          — if Peter has put any in the folder
 *   4. a wordless brand beat            — always available, therefore the floor
 *
 * Every fall from one rung to the next is RECORDED WITH ITS REASON. A video
 * where nine segments quietly became beats because the Pexels key expired
 * looks, in the finished file, exactly like a video where the writer asked for
 * a beat nine times. Only one of those is a bug, and the difference has to
 * survive into the build report.
 */

import { GRAPHIC_TYPES, FOOTAGE, attachIntents } from "./yt-visual-intent.js";
import { SCENE_MAX_SECONDS } from "./yt-config.js";

/**
 * The longest a single animated graphic should carry alone.
 *
 * Not the old MAX_VISUAL_SECONDS, and not for the old reason. That cap existed
 * because a STATIC card past ~10s violates the cadence rule; an animated one
 * changes state every couple of seconds and does not. What remains is an
 * editorial limit: one diagram is one idea, and a single card carrying forty
 * seconds of narration has stopped being a diagram and become a document.
 */
export const MAX_GRAPHIC_SECONDS = 22;

/** A block shorter than this is a flash. Fold it into its neighbour instead. */
export const MIN_BLOCK_SECONDS = 1.6;

/** Owned footage cuts at this cadence, as before. */
export const FOOTAGE_BLOCK_SECONDS = 6;

/**
 * Why a segment ended up with the layer it did.
 *
 * Strings rather than an enum because they go straight into the build report
 * and a human reads them there.
 */
export const REASON = {
  REQUESTED: "the writer asked for it",
  NO_INTENT: "no visualIntent on this take",
  GRAPHIC_REJECTED: "the graphic spec could not be rendered",
  GRAPHIC_FAILED: "the graphic rendered but failed verification",
  NO_KEYWORDS: "FOOTAGE intent carried no search keywords",
  STOCK_UNAVAILABLE: "stock is not configured",
  STOCK_NO_MATCH: "no stock clip passed the vision check",
  NO_OWNED_FOOTAGE: "the long-form footage folder is empty",
  REMAINDER: "filling the rest of the take",
  // A DESIGNED decline, not a failure. MAP's reveal unit is a route drawing,
  // which the card reveal model does not express, so it is not animated and
  // says so rather than fake-animating. Approved by Peter, 2026-08-10.
  // A MAP whose spec named nothing at all. Distinct from "named things we have
  // no geometry for", which reports the names so the gap is actionable.
  MAP_EMPTY_SPEC: "MAP intent named no places or roads",
};

/**
 * Plan the visual coverage of one voiceover segment.
 *
 * PURE. Takes what each layer said it could do and returns the blocks; it does
 * not fetch, render or encode anything. That is what lets the whole decision
 * table be argued with in a test rather than by watching a render — which is
 * the same reason yt-timeline.js is pure, and the same payoff.
 *
 * @param {object} seg              the segment, with `visual` and `visualSpec` attached
 * @param {object} available
 * @param {boolean} available.graphicOk    the graphic rendered and verified
 * @param {number}  available.stockSeconds seconds of stock that passed the vision check
 * @param {number}  available.ownedSeconds seconds of owned footage the allocator gave us
 * @returns {{ blocks, primary, fellBack, reason }}
 */
/**
 * Fill `total` seconds by CHAINING sources, none owning more than the scene cap.
 *
 * `sources` is preference order, primary first. Nothing may follow itself, so a
 * long take becomes graphic → stock → graphic → beat rather than one
 * held shot. Typography is always last in the list and never exhausts, which is
 * what makes the chain always completable and a blank segment still impossible.
 *
 * `startAfter` is the kind that ended the PREVIOUS segment, so the no-repeat rule
 * holds across take boundaries too — a stock clip ending one take and opening the
 * next is the same visual owning the screen through a cut nobody sees.
 */
function chainBlocks(total, sources, { sceneMax, startAfter = null }) {
  const budget = new Map(sources.map((s) => [s.kind, s.seconds]));
  const blocks = [];
  let remaining = round(total);
  let last = startAfter;

  while (remaining >= MIN_BLOCK_SECONDS) {
    // The first source that is not what just played and still has time in it.
    let pick = sources.find((s) => s.kind !== last && (budget.get(s.kind) ?? 0) >= MIN_BLOCK_SECONDS);
    // Everything else is spent: the beat carries the rest rather than
    // repeating a source, and if even that is somehow the last kind we accept the
    // repeat over leaving the screen empty.
    if (!pick) pick = sources.find((s) => (budget.get(s.kind) ?? 0) >= MIN_BLOCK_SECONDS) || sources[sources.length - 1];

    const available = budget.get(pick.kind) ?? Infinity;
    const take = round(Math.min(sceneMax, remaining, available));
    if (take < MIN_BLOCK_SECONDS) break;

    blocks.push({ ...pick.block, kind: pick.kind, seconds: take });
    if (Number.isFinite(available)) budget.set(pick.kind, round(available - take));
    remaining = round(remaining - take);
    last = pick.kind;
  }

  // A stub too short to be its own scene joins the last block. It cannot push
  // that block past the cap by more than MIN_BLOCK_SECONDS, which is under a
  // fifth of the default and not a held shot.
  if (remaining > 0 && blocks.length > 0) {
    blocks[blocks.length - 1].seconds = round(blocks[blocks.length - 1].seconds + remaining);
    remaining = 0;
  }
  return { blocks, remaining };
}

export function planSegmentCoverage(seg, { graphicOk = false, stockSeconds = 0, ownedSeconds = 0, stockReason = null, graphicReason = null, sceneMax = SCENE_MAX_SECONDS, startAfter = null } = {}) {
  const total = Math.max(0, seg.seconds || 0);
  if (total <= 0) return { blocks: [], primary: null, fellBack: false, reason: "segment has no duration" };

  const blocks = [];
  let remaining = total;
  let primary = null;
  let fellBack = false;
  let reason = REASON.REQUESTED;

  const isGraphic = GRAPHIC_TYPES.includes(seg.visual);

  // The chain, in preference order. Whatever the writer asked for leads; the rest
  // are what the scene cap hands the screen to when the lead has had its 8
  // seconds. Typography is always present and never runs out.
  const sources = [];
  // GRAPHIC PHASES. The budget is the whole graphic allowance, spent across
  // several blocks of at most one scene each.
  //
  // This only became safe once the renderer started SLICING one clip instead of
  // replaying it. Revision 6 capped the graphic at a single scene precisely
  // because a second graphic block re-rendered the same animation from its first
  // state — the table would build, cut away, and build again from nothing. The
  // cost of that cap was the regression it caused: graphic share fell from 63% to
  // 27% and filler rose to 60%, so a thirty-second take got eight seconds of
  // the thing that teaches it and twenty-two seconds of its own words restated.
  //
  // Now each graphic block carries a WINDOW into one continuous render, so
  // phase 2 resumes where phase 1 stopped.
  if (isGraphic && graphicOk) sources.push({ kind: "graphic", seconds: MAX_GRAPHIC_SECONDS, block: { visual: seg.visual, animated: true } });
  if (stockSeconds > 0) sources.push({ kind: "stock", seconds: stockSeconds, block: {} });
  if (ownedSeconds > 0) sources.push({ kind: "owned", seconds: ownedSeconds, block: {} });
  // THE FLOOR IS A WORDLESS BEAT, not the narration set as prose.
  //
  // Typography-as-filler is removed entirely: the video burns a caption of every
  // word, so a sentence slide duplicated the text underneath it — and in card 7
  // the slide and the caption spelled the same sentence differently, which is a
  // screen disagreeing with itself. Brand geometry holds the frame instead, and
  // carries no claim that could contradict anything.
  sources.push({ kind: "beat", seconds: Infinity, block: { reason: REASON.REMAINDER } });

  if (isGraphic && graphicOk) {
    const chained = chainBlocks(remaining, sources, { sceneMax, startAfter });
    blocks.push(...chained.blocks);
    remaining = chained.remaining;
    primary = "graphic";
  } else if (isGraphic && !graphicOk) {
    fellBack = true;
    // The SPECIFIC reason when the renderer gave one. Collapsing everything to
    // GRAPHIC_FAILED told the first live build that nine MAP takes had
    // "rendered but failed verification" when no map was ever rendered — they
    // are not animated yet and decline immediately. A report that misattributes
    // a designed fall to a verification failure sends the reader hunting for a
    // bug that is not there.
    reason = graphicReason || REASON.GRAPHIC_FAILED;
    // A FAILED GRAPHIC FALLS TO STOCK, NOT PAST IT. Card 11's four worst
    // stretches — 14 to 22 seconds of wordless geometry — were all takes whose
    // graphic declined and whose coverage then went straight to the beat floor,
    // because stock was only ever offered to FOOTAGE intents. The footage layer
    // sat configured and idle while the one visual that says nothing carried
    // the take. The fall is still recorded with the graphic's reason; what
    // changes is where the fall LANDS.
    if (stockSeconds > 0) {
      const chained = chainBlocks(remaining, sources, { sceneMax, startAfter });
      blocks.push(...chained.blocks);
      remaining = chained.remaining;
      primary = "stock";
    }
  } else if (seg.visual === FOOTAGE) {
    if (stockSeconds > 0) {
      const chained = chainBlocks(remaining, sources, { sceneMax, startAfter });
      blocks.push(...chained.blocks);
      remaining = chained.remaining;
      primary = "stock";
    } else if (ownedSeconds > 0) {
      // Owned footage is cut into readable shots rather than held whole, the
      // same rule the reels allocator used and for the same reason.
      const take = Math.min(ownedSeconds, remaining);
      pushFootageBlocks(blocks, take);
      remaining = round(remaining - take);
      primary = "owned";
    } else {
      fellBack = true;
      reason = stockReason || ((seg.visualSpec?.keywords || []).length === 0 ? REASON.NO_KEYWORDS : REASON.STOCK_NO_MATCH);
    }
  } else {
    // No intent at all. Stock if it can serve (same argument as the failed
    // graphic above), then owned footage, then the beat — and either way this
    // is a take the writer said nothing about, which is worth reporting even
    // though the picture will be fine.
    fellBack = true;
    reason = REASON.NO_INTENT;
    if (stockSeconds > 0) {
      const chained = chainBlocks(remaining, sources, { sceneMax, startAfter });
      blocks.push(...chained.blocks);
      remaining = chained.remaining;
      primary = "stock";
    } else if (ownedSeconds > 0) {
      const take = Math.min(ownedSeconds, remaining);
      pushFootageBlocks(blocks, take);
      remaining = round(remaining - take);
      primary = "owned";
    }
  }

  // THE FLOOR. Whatever is left — the whole segment, or the tail of a graphic
  // that could only carry twenty seconds of a thirty-second take — is
  // a beat. This is the line that makes a blank segment impossible.
  if (remaining >= MIN_BLOCK_SECONDS) {
    // THE FLOOR OBEYS THE CAP TOO — no exceptions, which is the whole point of a
    // cap. This line used to push the entire remainder as ONE block
    // and bypass the chain completely, which is how revision 6 shipped a 20.92s
    // scene while reporting an 8s cap. A segment with no graphic and no stock
    // reaches here holding its whole length.
    let left = round(remaining);
    let n = 0;
    while (left >= MIN_BLOCK_SECONDS) {
      const take = round(Math.min(sceneMax, left));
      blocks.push({ kind: "beat", seconds: take, reason: primary ? REASON.REMAINDER : reason, phase: n++ });
      left = round(left - take);
    }
    // A stub under one block joins the last scene rather than flashing.
    if (left > 0 && blocks.length > 0) blocks[blocks.length - 1].seconds = round(blocks[blocks.length - 1].seconds + left);
    if (!primary) primary = "beat";
    remaining = 0;
  } else if (remaining > 0 && blocks.length > 0) {
    // Too short to be its own block: give it to the last one.
    blocks[blocks.length - 1].seconds = round(blocks[blocks.length - 1].seconds + remaining);
    remaining = 0;
  } else if (remaining > 0) {
    // A segment shorter than MIN_BLOCK_SECONDS with nothing else in it. Still
    // gets a beat — a 1.2s take is a real take and a black 1.2s is a hole.
    blocks.push({ kind: "beat", seconds: round(remaining), reason });
    primary = "beat";
    remaining = 0;
  }

  // EVERY BLOCK LEARNS WHERE IT SITS INSIDE THE TAKE.
  //
  // Needed the moment a segment can hold more than one block of the same kind.
  // Typography sets phrases FROM THE NARRATION, and every block used to be handed
  // the whole take — which was harmless while there was at most one, and would
  // have shown a 30-second take the same phrases three times over once the scene
  // cap started chaining them. `startAt` is what lets each block set only the
  // words spoken while it is on screen.
  // NO SCENE OVER THE CAP, INCLUDING THE STUB MERGE.
  //
  // A leftover shorter than one block joins the previous scene rather than
  // flashing, which on a 9s take produced a single 9s scene: 8 plus a 1s stub
  // that was too short to stand alone. That is a real exception to a rule stated
  // without exceptions, so instead of merging past the cap the two share the
  // time — 9s becomes 4.5 + 4.5, both under it and neither a flash.
  //
  // The second half becomes a BEAT when the kind cannot safely repeat. A
  // graphic splits into phases and a beat walks its geometry, but stock
  // and owned footage point at one clip, so two adjacent blocks would replay it
  // from the start — the very loop phases were built to stop.
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.seconds <= sceneMax) continue;
    const half = round(b.seconds / 2);
    const rest = round(b.seconds - half);
    b.seconds = half;
    const repeatable = b.kind === "graphic" || b.kind === "beat";
    blocks.splice(i + 1, 0, repeatable
      ? { ...b, seconds: rest }
      : { kind: "beat", seconds: rest, reason: REASON.REMAINDER });
  }

  let at = 0;
  const phaseCount = {};
  for (const b of blocks) {
    b.startAt = round(at);
    // Phase index per kind, so the renderer can slice a graphic's second window
    // out of the same clip its first window came from.
    b.phase = phaseCount[b.kind] = (phaseCount[b.kind] ?? -1) + 1;
    at = round(at + b.seconds);
  }
  const graphicBlocks = blocks.filter((b) => b.kind === "graphic");
  for (const b of graphicBlocks) b.phaseOf = graphicBlocks.length;

  return { blocks, primary, fellBack, reason: fellBack ? reason : REASON.REQUESTED };
}

function pushFootageBlocks(blocks, seconds) {
  let left = seconds;
  while (left > 0) {
    const take = Math.min(FOOTAGE_BLOCK_SECONDS, left);
    // Never leave a stub too short to read as a shot.
    if (take < MIN_BLOCK_SECONDS && blocks.length > 0) {
      blocks[blocks.length - 1].seconds = round(blocks[blocks.length - 1].seconds + take);
      break;
    }
    blocks.push({ kind: "owned", seconds: round(take) });
    left = round(left - take);
  }
}

/**
 * Coverage report across the whole video.
 *
 * This is what Peter reads instead of scrubbing a twelve-minute file: how much
 * of the runtime each layer carried, and every fall with its reason. The
 * per-layer seconds are the answer to "is this a graphics video or a beat
 * video", which is the judgement revision 3 is actually asking him to make.
 */
export function coverageReport(planned) {
  const bySource = { graphic: 0, beat: 0, stock: 0, owned: 0 };
  const fallbacks = [];
  let voiceoverSeconds = 0;
  let uncovered = 0;

  for (const seg of planned) {
    if (seg.kind !== "voiceover") continue;
    voiceoverSeconds += seg.seconds || 0;
    const covered = (seg.visualBlocks || []).reduce((n, b) => n + b.seconds, 0);
    // Floating point, not a real hole — but a real hole must not hide in the
    // rounding, so the tolerance is one frame rather than "close enough".
    if (Math.abs(covered - (seg.seconds || 0)) > 0.05) {
      uncovered += Math.max(0, (seg.seconds || 0) - covered);
    }
    for (const b of seg.visualBlocks || []) {
      bySource[b.kind] = round((bySource[b.kind] || 0) + b.seconds);
    }
    if (seg.visualFellBack) {
      fallbacks.push({
        takeId: seg.takeId,
        asked: seg.visual || "nothing",
        got: seg.visualPrimary,
        reason: seg.visualReason,
      });
    }
  }

  const pct = (n) => (voiceoverSeconds > 0 ? Math.round((n / voiceoverSeconds) * 100) : 0);
  return {
    voiceoverSeconds: round(voiceoverSeconds),
    uncoveredSeconds: round(uncovered),
    bySource,
    byPct: {
      graphic: pct(bySource.graphic),
      beat: pct(bySource.beat),
      stock: pct(bySource.stock),
      owned: pct(bySource.owned),
    },
    fallbacks,
    fallbackCount: fallbacks.length,
  };
}

/**
 * Attach intents and plan coverage for every segment.
 *
 * The async layers (rendering a graphic, fetching stock) are supplied as
 * callbacks rather than imported, so this module stays testable without a
 * network, an API key, or ffmpeg — the scenario matrix drives all of it through
 * these two functions.
 */
/**
 * STOCK IS PLANNED BEFORE IT IS FETCHED, which is a reversal.
 *
 * It used to be fetched here: one clip per take, and the coverage was planned
 * around how many seconds of it survived. That ordering is what forced every
 * window of a take to share one clip, because by the time the windows existed
 * the fetch had already happened and there was only one result to slice.
 *
 * Now the planner asks only whether stock is AVAILABLE and lays out the windows;
 * the builder then fetches one clip per window against that window's own words.
 * A window whose fetch fails is downgraded to a beat there, and the coverage
 * report is recomputed afterwards — which is why `coverageReport` is exported
 * and called twice rather than being folded into this function's return.
 *
 * The NO_KEYWORDS fall is gone as a consequence, and its absence is the point:
 * a FOOTAGE take whose writer supplied no keywords is no longer skipped, because
 * each window now derives its own from the transcript.
 */
export async function planVisuals(segments, {
  renderGraphic = async () => ({ ok: false }),
  stockAvailable = () => 0,
  ownedFor = () => 0,
} = {}) {
  const { segments: withIntents, report: intentReport } = attachIntents(segments || []);
  const out = [];

  // The source kind that closed the previous segment, for the no-repeat rule.
  let lastKind = null;
  for (const seg of withIntents) {
    if (seg.kind !== "voiceover") { out.push(seg); continue; }

    let graphicOk = false;
    let graphic = null;
    if (GRAPHIC_TYPES.includes(seg.visual)) {
      const r = await renderGraphic(seg);
      graphicOk = Boolean(r?.ok);
      graphic = r?.ok ? r : null;
      if (r && !r.ok && r.reason) seg.graphicFailure = r.reason;
    }

    let stockSeconds = 0;
    let stockReason = null;
    // ANY take without a working graphic may draw on stock — FOOTAGE intents,
    // failed graphics, and takes with no intent at all. Stock was gated to
    // FOOTAGE intents only, which is how card 11's failed-graphic takes went
    // straight to the beat floor with the footage layer configured and idle.
    if (!graphicOk) {
      stockSeconds = (await stockAvailable(seg)) || 0;
      if (!stockSeconds && seg.visual === FOOTAGE) stockReason = REASON.STOCK_UNAVAILABLE;
    }

    const ownedSeconds = ownedFor(seg) || 0;
    // VARIETY ACROSS THE CUT. The kind that closed the previous segment is handed
    // forward, so a stock clip ending one take cannot open the next — from the
    // viewer's side that is one visual owning the screen through a boundary they
    // never see, which is the thing the scene cap exists to prevent.
    const coverage = planSegmentCoverage(seg, {
      graphicOk, stockSeconds, ownedSeconds, stockReason,
      graphicReason: seg.graphicFailure || null,
      startAfter: lastKind,
    });
    if (coverage.blocks.length > 0) lastKind = coverage.blocks[coverage.blocks.length - 1].kind;

    out.push({
      ...seg,
      visualBlocks: coverage.blocks,
      visualPrimary: coverage.primary,
      visualFellBack: coverage.fellBack,
      visualReason: coverage.reason,
      graphicClip: graphic?.path || null,
      // How long the one render actually is, so a phase window can be clamped to
      // it rather than asking ffmpeg for time that does not exist.
      graphicSeconds: graphic?.renderedSeconds || 0,
      graphicTiming: graphic?.timing || null,
    });
  }

  return {
    segments: out,
    intents: intentReport,
    coverage: coverageReport(out),
  };
}

function round(n) {
  return Math.round(n * 100) / 100;
}
