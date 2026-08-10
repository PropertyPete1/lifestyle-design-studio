/**
 * Trial Variant Generation Pipeline
 * 
 * Generates variant reels for Instagram Trial Reels (posted natively by owner).
 * Each variant gets a DIFFERENT hook angle from the original, fresh voiceover,
 * burned captions, and freshness micro-variations.
 * 
 * Source videos are selected from the top-performing reels (by views) from the
 * last 90 days, cross-referenced with the posted-log to find the Drive file ID.
 * 
 * Hook angles rotate per source video: price_hook, payment_tease, feature_callout,
 * question_hook, bold_claim. Once all angles are exhausted on a video, move to next.
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { downloadVideo } from "./drive.js";
import { processVoiceover } from "./voiceover.js";
import { processBurnedCaptions } from "./burned-captions.js";
import { generateCaption } from "./caption.js";
import { readVideoOverlays, extractPriceCheckFrames } from "./price-check.js";
import { loadLog } from "./state.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HISTORY_PATH = join(__dirname, "..", "trial-variants.json");

const HOOK_ANGLES = ["price_hook", "payment_tease", "feature_callout", "question_hook", "bold_claim"];

const TOP_N = 5; // Cycle through top 5 highest-view reels

// ─── History Management ──────────────────────────────────────────────────────

export function loadTrialHistory() {
  if (!existsSync(HISTORY_PATH)) {
    return { variants: [], sourceRotation: [] };
  }
  return JSON.parse(readFileSync(HISTORY_PATH, "utf-8"));
}

export function saveTrialHistory(history) {
  writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
}

/**
 * Check if a variant was already generated for today's window.
 * Returns true if we should skip (idempotency guard).
 */
export function hasGeneratedToday(history, window) {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" }); // YYYY-MM-DD
  return history.variants.some(v => v.date === today && v.window === window);
}

/**
 * Does this skip deserve Peter's inbox, or only the run page?
 *
 * A skip must always be reported — a silent no-op is how a pipeline stops
 * working without anyone noticing. But "the cron skipped" is not by itself
 * evidence of a fault: a human running the slot early fills the window
 * legitimately, and the cron then finding it filled is correct behaviour.
 *
 * The genuine fault is the cron finding a window the CRON already filled. That
 * is a replayed run, or a window/date computation stuck on an already-served
 * slot — the shape a permanent silent no-op would take.
 *
 * Records written before `trigger` existed are read as cron-filled, which is
 * the cautious direction: a false alert is recoverable, a missed one is what
 * this whole module exists to prevent.
 */
export function shouldEscalateSkip({ scheduled, existing }) {
  if (!scheduled) return false;
  return (existing?.trigger || "schedule") === "schedule";
}

/**
 * Get the next hook angle for a source video that hasn't been used yet.
 * Returns null if all angles are exhausted for this video.
 */
export function getNextAngle(sourceVideoId, history) {
  const usedAngles = history.variants
    .filter(v => v.sourceVideoId === sourceVideoId)
    .map(v => v.hookAngle);
  const available = HOOK_ANGLES.filter(a => !usedAngles.includes(a));
  return available.length > 0 ? available[0] : null;
}

/**
 * Count how many variants have been generated for a source video.
 */
export function getVariantNumber(sourceVideoId, history) {
  return history.variants.filter(v => v.sourceVideoId === sourceVideoId).length + 1;
}

// ─── Source Video Selection ──────────────────────────────────────────────────

/**
 * Pick the top N highest-view reels from the posted-log (last 90 days).
 * We use the posted-log as the source of truth since it has driveFileId
 * and we know these videos exist in Drive.
 * 
 * Returns array of { driveFileId, fileName, city, caption, timestamp, views }
 * sorted by views descending.
 */
export function getTopReelsFromLog(log, days = 90) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  // Get all successful video posts (not linkedin, not trial_variant, not manual_confirm)
  const videoPosts = log.posts.filter(p => 
    p.driveFileId &&
    p.success &&
    !p.type &&
    p.platform !== "instagram_main_native" &&
    new Date(p.timestamp).getTime() > cutoff
  );
  // Deduplicate by driveFileId (keep the one with most platforms = most reach)
  const byId = new Map();
  for (const p of videoPosts) {
    if (!byId.has(p.driveFileId) || (p.platforms || []).length > (byId.get(p.driveFileId).platforms || []).length) {
      byId.set(p.driveFileId, p);
    }
  }
  // Sort by timestamp (most recent first as proxy for views — we don't have view counts in the log)
  // Actually: we'll use the posted-log entries and sort by recency as a proxy.
  // The REAL top-view selection happens via Metricool analytics cross-referenced below.
  return Array.from(byId.values());
}

/**
 * Fetch top-performing reels from Metricool analytics (last 90 days)
 * and cross-reference with posted-log to get Drive file IDs.
 * 
 * Strategy: Metricool returns reel URLs. The posted-log stores driveFileId + timestamp.
 * We match by timestamp proximity (within 2 hours) since the post time and log time are close.
 */
export async function pickSourceVideo(history) {
  const BASE = "https://app.metricool.com/backend/api";
  const blogId = process.env.METRICOOL_BLOG_ID;
  const token = process.env.METRICOOL_API_TOKEN;
  
  if (!blogId || !token) {
    console.log("[TrialVariant] Metricool credentials not available — falling back to posted-log selection");
    return pickSourceVideoFromLog(history);
  }

  // Fetch 90 days of reel analytics
  const to = new Date();
  const from = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const fmtDate = (d) => d.toISOString().split("T")[0];
  const url = `${BASE}/v2/analytics/reels/instagram?from=${fmtDate(from)}&to=${fmtDate(to)}&blogId=${blogId}&timezone=America/Chicago`;
  
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      console.warn(`[TrialVariant] Metricool analytics fetch failed (${res.status}) — falling back to log`);
      return pickSourceVideoFromLog(history);
    }
    const json = await res.json();
    const reels = json.data || [];
    
    if (reels.length === 0) {
      console.warn("[TrialVariant] No reels from Metricool — falling back to log");
      return pickSourceVideoFromLog(history);
    }

    // Sort by views descending
    reels.sort((a, b) => (b.views || 0) - (a.views || 0));
    console.log(`[TrialVariant] Fetched ${reels.length} reels from Metricool. Top 5 by views:`);
    reels.slice(0, 5).forEach((r, i) => console.log(`  ${i + 1}. ${r.views} views — ${(r.content || "").slice(0, 50)}...`));

    // Cross-reference with posted-log to find Drive file IDs
    const log = loadLog();
    const videoPosts = log.posts.filter(p => 
      p.driveFileId && p.success && !p.type && p.platform !== "instagram_main_native"
    );

    // Match reels to posted-log entries by publish timestamp proximity
    const matched = [];
    for (const reel of reels) {
      const reelTime = new Date(reel.publishedAt || reel.date).getTime();
      // Find the posted-log entry closest in time (within 4 hours)
      let bestMatch = null;
      let bestDiff = Infinity;
      for (const post of videoPosts) {
        const postTime = new Date(post.timestamp).getTime();
        const diff = Math.abs(reelTime - postTime);
        if (diff < 4 * 60 * 60 * 1000 && diff < bestDiff) {
          bestDiff = diff;
          bestMatch = post;
        }
      }
      if (bestMatch) {
        matched.push({
          driveFileId: bestMatch.driveFileId,
          fileName: bestMatch.fileName,
          city: bestMatch.city,
          views: reel.views || 0,
          caption: bestMatch.caption,
          timestamp: bestMatch.timestamp,
        });
      }
    }

    if (matched.length === 0) {
      console.warn("[TrialVariant] No Metricool reels matched to posted-log — falling back to log");
      return pickSourceVideoFromLog(history);
    }

    console.log(`[TrialVariant] Matched ${matched.length} reels to Drive files`);
    
    // Take top N and find one with available angles
    const topN = matched.slice(0, TOP_N);
    return selectFromTopN(topN, history);
    
  } catch (err) {
    console.warn(`[TrialVariant] Metricool fetch error: ${err.message} — falling back to log`);
    return pickSourceVideoFromLog(history);
  }
}

/**
 * Fallback: pick source video directly from posted-log (sorted by recency as proxy for performance).
 */
function pickSourceVideoFromLog(history) {
  const log = loadLog();
  const posts = getTopReelsFromLog(log, 90);
  
  if (posts.length === 0) {
    return null;
  }

  // Sort by recency (newest first — recent posts tend to have more views)
  posts.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  
  const topN = posts.slice(0, TOP_N).map(p => ({
    driveFileId: p.driveFileId,
    fileName: p.fileName,
    city: p.city,
    views: 0, // Unknown from log
    caption: p.caption,
    timestamp: p.timestamp,
  }));

  return selectFromTopN(topN, history);
}

/**
 * From the top N candidates, select the next one that has available hook angles.
 * If all angles are exhausted on all N, refresh the list (return first with reset).
 */
function selectFromTopN(topN, history) {
  // Check each in order for available angles
  for (const candidate of topN) {
    const angle = getNextAngle(candidate.driveFileId, history);
    if (angle) {
      console.log(`[TrialVariant] Selected source: ${candidate.fileName} (${candidate.views} views, city=${candidate.city})`);
      console.log(`[TrialVariant] Next angle: ${angle} (variant #${getVariantNumber(candidate.driveFileId, history)})`);
      return { ...candidate, nextAngle: angle };
    }
  }

  // All angles exhausted on all top N — signal refresh needed
  console.log("[TrialVariant] All angles exhausted on top 5 — refreshing rotation (resetting angle history for these videos)");
  // Reset angle history for the top N videos so we can cycle again
  const topIds = new Set(topN.map(c => c.driveFileId));
  history.variants = history.variants.filter(v => !topIds.has(v.sourceVideoId));
  
  // Now pick the first one
  const candidate = topN[0];
  const angle = getNextAngle(candidate.driveFileId, history);
  console.log(`[TrialVariant] After refresh — Selected: ${candidate.fileName}, angle: ${angle}`);
  return { ...candidate, nextAngle: angle };
}

// ─── Angle-Specific Prompt Instructions ──────────────────────────────────────

const ANGLE_INSTRUCTIONS = {
  price_hook: `HOOK ANGLE: PRICE HOOK
Open with the exact price spoken as words. Make the viewer stop scrolling because the price seems too good.
Example opening: "Three hundred ninety thousand for brand new construction in [city]..."
The hook must contain the price in the first sentence.`,

  payment_tease: `HOOK ANGLE: PAYMENT TEASE
Open with a payment TEASE using ONLY figures literally visible on the video overlay (price, rate, or monthly amount shown on screen). NEVER compute or state a monthly payment number yourself.
If the overlay shows a monthly payment amount, you may speak that exact figure. If it only shows price or rate, tease around those without calculating a payment.
If no payment/rate figures appear on the overlay, tease without any number: e.g. "the monthly payment on this one is lower than most people guess."
NEVER estimate rates or calculate payments — the exact breakdown is what the viewer gets when they engage.`,

  feature_callout: `HOOK ANGLE: FEATURE CALLOUT
Open by calling out ONE specific standout feature visible in the video (open floor plan, quartz counters, covered patio, etc.).
Example opening: "Look at this kitchen island. Forty two inch cabinets, quartz waterfall counters..."
Pick the most visually impressive feature.`,

  question_hook: `HOOK ANGLE: QUESTION HOOK
Open with a provocative question that makes the viewer want to see the answer.
Example opening: "What does three hundred thousand actually get you in [city] right now?"
The question must relate to the specific property/price shown.`,

  bold_claim: `HOOK ANGLE: BOLD CLAIM
Open with a bold, slightly controversial statement about the market or the deal.
Example opening: "This is the best value I've seen in [city] all month and it just hit the market..."
Be confident but not dishonest. Back it up with the price/features.`,
};

/**
 * Get the angle-specific instruction for the voiceover script prompt.
 */
export function getAngleInstruction(angle) {
  return ANGLE_INSTRUCTIONS[angle] || ANGLE_INSTRUCTIONS.price_hook;
}

// ─── Variant Generation ──────────────────────────────────────────────────────

/**
 * Generate a complete trial variant: download → voiceover → burned captions → freshness.
 * Returns { videoPath, caption, angle, variantNumber, sourceVideoId, city }.
 */
export async function generateVariant(source, angle, dryRun = false) {
  const { driveFileId, city } = source;
  const variantNum = getVariantNumber(driveFileId, loadTrialHistory());
  
  console.log(`[TrialVariant] Generating variant #${variantNum} for ${source.fileName}`);
  console.log(`[TrialVariant] Angle: ${angle}, City: ${city}`);

  // Step 1: Download source video from Drive
  const buffer = await downloadVideo(driveFileId, source.fileName);
  const videoPath = join(dirname(fileURLToPath(import.meta.url)), `../tmp-trial-source-${Date.now()}.mp4`);
  writeFileSync(videoPath, buffer);
  console.log(`[TrialVariant] Downloaded source video to: ${videoPath} (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);

  // Step 2: Extract overlays for context (price, community, etc.)
  let videoOverlays = null;
  try {
    const frames = await extractPriceCheckFrames(videoPath);
    if (frames && frames.length > 0) {
      videoOverlays = await readVideoOverlays(frames);
      console.log(`[TrialVariant] Overlays: price=${videoOverlays?.price || "none"}, city=${videoOverlays?.city || "none"}`);
    }
  } catch (err) {
    console.warn(`[TrialVariant] Overlay extraction failed (non-fatal): ${err.message}`);
  }

  // Step 3: Generate voiceover with angle-specific hook
  // We ALWAYS add voiceover for trial variants (that's the point — different angle)
  const voResult = await processVoiceover(videoPath, city, dryRun, videoOverlays, {
    forceVoiceover: true,
    angleInstruction: getAngleInstruction(angle),
  });
  const processedPath = voResult?.mergedPath || videoPath;
  const voAudioPath = voResult?.audioPath || null;
  const voScript = voResult?.script || null;
  console.log(`[TrialVariant] Voiceover ${voResult?.mergedPath ? "added" : "skipped (unexpected)"}`);
  // Step 4: Burn captions
  const burnResult = await processBurnedCaptions(processedPath, voAudioPath, voScript);
  const captionBurnedPath = burnResult.videoPath;
  console.log(`[TrialVariant] Captions: ${burnResult.captions_burned ? "burned ✓" : "skipped"}`);

  // Step 5: Skip freshness — caption burn (different voiceover + burned text) already
  // makes every variant file unique. No second encode needed.
  console.log(`[TrialVariant] Freshness skipped (caption burn already provides byte-uniqueness)`);

  // Step 6: Generate fresh caption with different hook style
  const caption = await generateCaption(city, videoOverlays, {
    trialAngle: angle,
    avoidHookStyle: source.caption ? "original" : null,
  });
  console.log(`[TrialVariant] Caption generated (${caption.length} chars)`);

  return {
    videoPath: captionBurnedPath,
    caption,
    angle,
    variantNumber: variantNum,
    sourceVideoId: driveFileId,
    sourceFileName: source.fileName,
    city,
    views: source.views,
  };
}
