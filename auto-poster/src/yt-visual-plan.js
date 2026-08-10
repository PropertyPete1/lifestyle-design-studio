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
 * typography is the floor that guarantees the covering is total.
 *
 * THE ORDER OF PREFERENCE, per segment:
 *   1. the writer's graphic intent      — animated, timed to the narration
 *   2. the writer's FOOTAGE intent      — stock, if keywords and a clip survive
 *   3. owned long-form footage          — if Peter has put any in the folder
 *   4. kinetic typography               — always available, therefore the floor
 *
 * Every fall from one rung to the next is RECORDED WITH ITS REASON. A video
 * where nine segments quietly became typography because the Pexels key expired
 * looks, in the finished file, exactly like a video where the writer asked for
 * typography nine times. Only one of those is a bug, and the difference has to
 * survive into the build report.
 */

import { GRAPHIC_TYPES, TYPOGRAPHY, FOOTAGE, attachIntents } from "./yt-visual-intent.js";

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
export function planSegmentCoverage(seg, { graphicOk = false, stockSeconds = 0, ownedSeconds = 0, stockReason = null, graphicReason = null } = {}) {
  const total = Math.max(0, seg.seconds || 0);
  if (total <= 0) return { blocks: [], primary: null, fellBack: false, reason: "segment has no duration" };

  const blocks = [];
  let remaining = total;
  let primary = null;
  let fellBack = false;
  let reason = REASON.REQUESTED;

  const isGraphic = GRAPHIC_TYPES.includes(seg.visual);

  if (isGraphic && graphicOk) {
    const take = Math.min(MAX_GRAPHIC_SECONDS, remaining);
    blocks.push({ kind: "graphic", visual: seg.visual, seconds: round(take), animated: true });
    remaining = round(remaining - take);
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
  } else if (seg.visual === TYPOGRAPHY) {
    primary = "typography";
  } else if (seg.visual === FOOTAGE) {
    if (stockSeconds > 0) {
      const take = Math.min(stockSeconds, remaining);
      blocks.push({ kind: "stock", seconds: round(take) });
      remaining = round(remaining - take);
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
    // No intent at all. Owned footage if it exists, typography otherwise —
    // and either way this is a take the writer said nothing about, which is
    // worth reporting even though the picture will be fine.
    fellBack = true;
    reason = REASON.NO_INTENT;
    if (ownedSeconds > 0) {
      const take = Math.min(ownedSeconds, remaining);
      pushFootageBlocks(blocks, take);
      remaining = round(remaining - take);
      primary = "owned";
    }
  }

  // THE FLOOR. Whatever is left — the whole segment, or the tail of a graphic
  // that could only carry twenty seconds of a thirty-second take — is
  // typography. This is the line that makes a blank segment impossible.
  if (remaining >= MIN_BLOCK_SECONDS) {
    blocks.push({ kind: "typography", seconds: round(remaining), reason: primary ? REASON.REMAINDER : reason });
    if (!primary) primary = "typography";
    remaining = 0;
  } else if (remaining > 0 && blocks.length > 0) {
    // Too short to be its own block: give it to the last one.
    blocks[blocks.length - 1].seconds = round(blocks[blocks.length - 1].seconds + remaining);
    remaining = 0;
  } else if (remaining > 0) {
    // A segment shorter than MIN_BLOCK_SECONDS with nothing else in it. Still
    // gets typography — a 1.2s take is a real take and a black 1.2s is a hole.
    blocks.push({ kind: "typography", seconds: round(remaining), reason });
    primary = "typography";
    remaining = 0;
  }

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
 * per-layer seconds are the answer to "is this a graphics video or a typography
 * video", which is the judgement revision 3 is actually asking him to make.
 */
export function coverageReport(planned) {
  const bySource = { graphic: 0, typography: 0, stock: 0, owned: 0 };
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
      typography: pct(bySource.typography),
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
export async function planVisuals(segments, {
  renderGraphic = async () => ({ ok: false }),
  fetchStock = async () => ({ clip: null, attempts: [] }),
  ownedFor = () => 0,
} = {}) {
  const { segments: withIntents, report: intentReport } = attachIntents(segments || []);
  const out = [];
  const stockCredits = [];
  const stockAttempts = [];

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
    let stock = null;
    let stockReason = null;
    if (seg.visual === FOOTAGE && !graphicOk) {
      const keywords = seg.visualSpec?.keywords || [];
      if (keywords.length === 0) {
        stockReason = REASON.NO_KEYWORDS;
      } else {
        const r = await fetchStock(seg);
        if (r?.clip) {
          stock = r.clip;
          stockSeconds = r.clip.seconds || seg.seconds;
          stockCredits.push(r.clip.credit);
        } else {
          stockReason = REASON.STOCK_NO_MATCH;
        }
        if (r?.attempts?.length) stockAttempts.push({ takeId: seg.takeId, attempts: r.attempts });
      }
    }

    const ownedSeconds = ownedFor(seg) || 0;
    const coverage = planSegmentCoverage(seg, { graphicOk, stockSeconds, ownedSeconds, stockReason, graphicReason: seg.graphicFailure || null });

    out.push({
      ...seg,
      visualBlocks: coverage.blocks,
      visualPrimary: coverage.primary,
      visualFellBack: coverage.fellBack,
      visualReason: coverage.reason,
      graphicClip: graphic?.path || null,
      graphicTiming: graphic?.timing || null,
      stockClip: stock?.path || null,
      stockCredit: stock?.credit || null,
      stockContentHash: stock?.contentHash || null,
    });
  }

  return {
    segments: out,
    intents: intentReport,
    coverage: coverageReport(out),
    stockCredits,
    stockAttempts,
  };
}

function round(n) {
  return Math.round(n * 100) / 100;
}
