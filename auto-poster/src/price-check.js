/**
 * Price-Consistency Check — AI Vision reads text overlays from video frames
 * and validates/corrects caption prices against what's visible in the video.
 * 
 * Video text is ground truth (original IG captions go stale when builders change prices).
 */
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, existsSync, unlinkSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";

let anthropicClient = null;
function getClient() {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropicClient;
}

/**
 * Extract frames from the first 5 seconds of a video (where price overlays typically appear).
 * Returns: thumbnail (first frame) + 2-3 frames from 0-5s range.
 */
export function extractPriceCheckFrames(videoPath) {
  const id = createHash("md5").update(videoPath + Date.now().toString()).digest("hex").slice(0, 8);
  const frameDir = join(tmpdir(), "price_frames");
  try { execSync(`mkdir -p "${frameDir}"`, { stdio: "pipe" }); } catch {}

  // Get video duration
  let duration = 30;
  try {
    const d = execSync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${videoPath}"`, { encoding: "utf-8", timeout: 10000 }).trim();
    duration = parseFloat(d) || 30;
  } catch {}

  // Extract: frame at 0.5s (thumbnail), 1.5s, 3s, and 4.5s (all in first 5 seconds)
  const timestamps = [0.5, 1.5, 3.0, Math.min(4.5, duration * 0.15)];
  const framePaths = [];

  for (let i = 0; i < timestamps.length; i++) {
    const ts = timestamps[i].toFixed(2);
    const outPath = join(frameDir, `price_${id}_${i}.png`);
    try {
      // Scale to 720px wide for API (readable text, manageable size)
      execSync(
        `ffmpeg -y -ss ${ts} -i "${videoPath}" -frames:v 1 -vf "scale='min(720,iw)':-2" -q:v 2 "${outPath}"`,
        { timeout: 15000, stdio: "pipe" }
      );
      if (existsSync(outPath)) framePaths.push(outPath);
    } catch {}
  }

  return framePaths;
}

/**
 * Send frames to Claude Vision to read text overlays.
 * Returns: { price, city, bedsBaths, rawText } or null if no text found.
 */
export async function readVideoOverlays(framePaths) {
  if (!framePaths || framePaths.length === 0) return null;

  const images = framePaths.map(fp => {
    const buf = readFileSync(fp);
    return {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: buf.toString("base64") },
    };
  });

  try {
    const response = await getClient().messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      messages: [{
        role: "user",
        content: [
          {
            type: "text",
            text: `Read any text overlays visible in these video frames. These are from a real estate video.
Extract the following if visible (return null for anything not shown):
- price: The listed price (e.g. "starting at $440,000", "$389,900", "from the $400s")
- city: City or location name if shown
- beds_baths: Bedroom/bathroom count if shown (e.g. "4 bed / 3 bath")
- community: Community or subdivision name if shown

Return ONLY valid JSON:
{"price": "...", "city": "...", "beds_baths": "...", "community": "...", "raw_text": "all visible text"}

If no text overlays are visible at all, return: {"price": null, "city": null, "beds_baths": null, "community": null, "raw_text": null}`
          },
          ...images,
        ],
      }],
    });

    const text = response.content[0]?.text || "";
    const jsonMatch = text.match(/\{[\s\S]*?\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      console.log(`[PriceCheck] Video overlays: price=${parsed.price || "none"}, city=${parsed.city || "none"}`);
      return parsed;
    }
  } catch (err) {
    console.warn(`[PriceCheck] Vision read failed: ${err.message?.slice(0, 100)}`);
  }

  return null;
}

/**
 * Extract ALL price mentions from a caption string.
 * Returns array of matches (e.g. ["$507K", "$507K"]) or empty array.
 * Single combined regex captures K/k suffix, "s" suffix ("$400s"), and full prices.
 */
export function extractAllPrices(caption) {
  if (!caption) return [];
  // Single regex: $ + digits/commas + optional decimal + optional K/k/s suffix (NO trailing space)
  // The [Kks] is directly after the number — no space between "507" and "K"
  const priceRegex = /\$[\d,]+(?:\.\d+)?[Kks]?/g;
  const matches = caption.match(priceRegex) || [];
  // Filter out matches that are just "$" followed by nothing meaningful
  return matches.filter(m => /\$\d/.test(m));
}

/**
 * Extract the first price from a caption (convenience wrapper).
 */
export function extractPriceFromCaption(caption) {
  const prices = extractAllPrices(caption);
  return prices.length > 0 ? prices[0] : null;
}

/**
 * Normalize a price string to a numeric value for comparison.
 * "$440,000" → 440000, "$507K" → 507000, "$389,900" → 389900, "$400s" → 400000
 */
export function normalizePrice(priceStr) {
  if (!priceStr) return null;
  const trimmed = priceStr.trim();
  let cleaned = trimmed.replace(/[^0-9.kKs]/g, "");

  // Handle K/k suffix: $507K → 507 * 1000 = 507000
  if (/[kK]$/.test(cleaned)) {
    cleaned = cleaned.replace(/[kK]$/, "");
    return parseFloat(cleaned) * 1000;
  }

  // Handle "s" suffix: $400s → 400 * 1000 = 400000 ("from the $400s" means ~$400,000)
  if (/s$/.test(cleaned)) {
    cleaned = cleaned.replace(/s$/, "");
    const val = parseFloat(cleaned);
    // If under 10000, it's shorthand for thousands (e.g. $400s = $400,000 range)
    if (val && val < 10000) return val * 1000;
    return val || null;
  }

  return parseFloat(cleaned) || null;
}

/**
 * Compare video price vs caption price.
 * Returns { matches: boolean, videoPrice, captionPrice, correction }
 * 
 * Special handling for "$400s" style: if caption uses shorthand thousands format
 * and video shows a specific price in that range, treat as consistent rather than
 * trying to replace vague language with a specific number.
 */
export function comparePrices(videoOverlays, captionText) {
  const videoPrice = videoOverlays?.price || null;
  const captionPrice = extractPriceFromCaption(captionText);

  if (!videoPrice) {
    // No price visible in video — leave caption as-is
    return { matches: true, videoPrice: null, captionPrice, correction: null };
  }

  if (!captionPrice) {
    // Video has price but caption doesn't mention one — no conflict
    return { matches: true, videoPrice, captionPrice: null, correction: null };
  }

  // Both have prices — compare numerically
  const videoNum = normalizePrice(videoPrice);
  const captionNum = normalizePrice(captionPrice);

  if (!videoNum || !captionNum) {
    // Can't parse one of them — flag for review but don't block
    return { matches: true, videoPrice, captionPrice, correction: null };
  }

  // Special case: "$400s" style is a range, not a precise price.
  // If caption uses "s" suffix (e.g. "$400s") and video price falls in that range,
  // skip correction — replacing "$400s" with "$440,000" changes the tone.
  // If they DON'T match even at range level, skip correction too (log only) to avoid mangling.
  if (/\$[\d,]+s/i.test(captionPrice)) {
    // "$400s" = 400k range. Check if video price is in same hundreds-of-thousands bucket.
    const captionBucket = Math.floor(captionNum / 100000);
    const videoBucket = Math.floor(videoNum / 100000);
    if (captionBucket === videoBucket) {
      return { matches: true, videoPrice, captionPrice, correction: null };
    }
    // Different bucket — log but don't correct (would mangle the format)
    console.log(`[PriceCheck] ⚠️ Range mismatch: caption "${captionPrice}" vs video "${videoPrice}" — logging only, not correcting`);
    return { matches: true, videoPrice, captionPrice, correction: null, logOnly: `range mismatch: caption ${captionPrice} vs video ${videoPrice}` };
  }

  // Allow 5% tolerance (rounding differences)
  const tolerance = 0.05;
  const diff = Math.abs(videoNum - captionNum) / Math.max(videoNum, captionNum);

  if (diff <= tolerance) {
    return { matches: true, videoPrice, captionPrice, correction: null };
  }

  // MISMATCH — video price is ground truth
  // Extract just the numeric price from the video overlay (e.g. "Starting at $440,000" → "$440,000")
  const videoPriceExtracted = extractPriceFromCaption(videoPrice) || videoPrice;
  console.log(`[PriceCheck] ⚠️ PRICE MISMATCH: caption says ${captionPrice} (${captionNum}), video shows ${videoPriceExtracted} (${videoNum})`);
  return {
    matches: false,
    videoPrice,
    captionPrice,
    correction: videoPriceExtracted,
    videoPriceNum: videoNum,
    captionPriceNum: captionNum,
  };
}

/**
 * Replace ALL occurrences of a price in a caption with the corrected price.
 * Captions often repeat the price in hook + bullets — must replace globally.
 * 
 * After correction, runs a sanity check: re-extracts the price from the result
 * and verifies it matches the video price. If mangled, falls back to original.
 */
export function correctCaptionPrice(caption, oldPrice, newPrice, videoPriceNum) {
  if (!caption || !oldPrice || !newPrice) return caption;

  // Escape special regex chars in the old price string
  const escaped = oldPrice.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const corrected = caption.replace(new RegExp(escaped, "g"), newPrice);

  // Sanity guard: re-extract price from corrected caption and verify it parses correctly
  const verifyPrice = extractPriceFromCaption(corrected);
  const verifyNum = normalizePrice(verifyPrice);

  if (verifyNum && videoPriceNum) {
    const verifyDiff = Math.abs(verifyNum - videoPriceNum) / Math.max(verifyNum, videoPriceNum);
    if (verifyDiff > 0.05) {
      // Correction produced a mangled result — fall back to original
      console.warn(`[PriceCheck] Sanity check FAILED: corrected caption parses to ${verifyNum}, expected ~${videoPriceNum}. Keeping original.`);
      return caption;
    }
  }

  const count = (caption.match(new RegExp(escaped, "g")) || []).length;
  console.log(`[PriceCheck] Corrected ${count} occurrence(s): "${oldPrice}" → "${newPrice}"`);
  return corrected;
}

/**
 * Full price-consistency pipeline.
 * Call AFTER caption is generated but BEFORE posting.
 * 
 * @param {string} videoPath - Path to the video file
 * @param {string} caption - The generated caption
 * @param {string[]} existingFrames - Optional pre-extracted frames (reuse from QC)
 * @returns {{ caption: string, corrected: boolean, log: string }}
 */
export async function runPriceConsistencyCheck(videoPath, caption, existingFrames = null, preReadOverlays = null) {
  console.log("[PriceCheck] Running price-consistency check...");

  // If overlays were already read upstream (e.g. for community KB lookup), reuse them
  if (preReadOverlays) {
    console.log("[PriceCheck] Using pre-read overlays (skipping duplicate vision call)");
    if (!preReadOverlays.price) {
      console.log("[PriceCheck] No price visible in video — caption unchanged");
      return { caption, corrected: false, log: "no_video_price" };
    }
    const comparison = comparePrices(preReadOverlays, caption);
    if (comparison.matches) {
      const logMsg = comparison.logOnly || "consistent";
      console.log(`[PriceCheck] \u2713 Prices consistent (or no conflict)`);
      return { caption, corrected: false, log: logMsg };
    }
    const correctedCaption = correctCaptionPrice(
      caption,
      comparison.captionPrice,
      comparison.correction,
      comparison.videoPriceNum
    );
    const logMsg = `caption said ${comparison.captionPrice}, video shows ${comparison.videoPrice}, corrected`;
    console.log(`[PriceCheck] \u2713 Caption corrected: ${logMsg}`);
    return { caption: correctedCaption, corrected: true, log: logMsg };
  }

  // Step 1: Extract frames from first 5 seconds (or reuse existing)
  let framePaths = existingFrames;
  let ownedFrames = false;
  if (!framePaths || framePaths.length === 0) {
    framePaths = extractPriceCheckFrames(videoPath);
    ownedFrames = true;
  }

  if (framePaths.length === 0) {
    console.log("[PriceCheck] No frames extracted — skipping check");
    return { caption, corrected: false, log: "no_frames" };
  }

  try {
    // Step 2: Read video overlays via AI vision
    const overlays = await readVideoOverlays(framePaths);

    if (!overlays || !overlays.price) {
      console.log("[PriceCheck] No price visible in video — caption unchanged");
      return { caption, corrected: false, log: "no_video_price" };
    }

    // Step 3: Compare prices
    const comparison = comparePrices(overlays, caption);

    if (comparison.matches) {
      const logMsg = comparison.logOnly || "consistent";
      console.log(`[PriceCheck] ✓ Prices consistent (or no conflict)`);
      return { caption, corrected: false, log: logMsg };
    }

    // Step 4: Correct the caption (global replace + sanity check)
    const correctedCaption = correctCaptionPrice(
      caption,
      comparison.captionPrice,
      comparison.correction,
      comparison.videoPriceNum
    );
    const logMsg = `caption said ${comparison.captionPrice}, video shows ${comparison.videoPrice}, corrected`;
    console.log(`[PriceCheck] ✓ Caption corrected: ${logMsg}`);

    return { caption: correctedCaption, corrected: true, log: logMsg };
  } finally {
    // Cleanup frames if we created them
    if (ownedFrames) {
      for (const fp of framePaths) {
        try { unlinkSync(fp); } catch {}
      }
    }
  }
}
