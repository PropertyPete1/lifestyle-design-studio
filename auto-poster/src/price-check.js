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
 * Extract price from a caption string.
 * Returns the first price found (e.g. "$507,000", "$440K", "$389,900") or null.
 */
export function extractPriceFromCaption(caption) {
  if (!caption) return null;
  // Match patterns like $440,000 or $507K or $389,900 or $400s or from the $400s
  const pricePatterns = [
    /\$[\d,]+(?:\.\d{2})?/g,           // $440,000 or $389,900.00
    /\$\d+[Kk]/g,                       // $507K
    /(?:from |starting at )?\$[\d,]+/gi, // from $440,000
  ];

  for (const pattern of pricePatterns) {
    const matches = caption.match(pattern);
    if (matches && matches.length > 0) {
      return matches[0];
    }
  }
  return null;
}

/**
 * Normalize a price string to a numeric value for comparison.
 * "$440,000" → 440000, "$507K" → 507000, "$389,900" → 389900
 */
function normalizePrice(priceStr) {
  if (!priceStr) return null;
  let cleaned = priceStr.replace(/[^0-9.kK]/g, "");
  if (/[kK]$/.test(cleaned)) {
    cleaned = cleaned.replace(/[kK]$/, "");
    return parseFloat(cleaned) * 1000;
  }
  return parseFloat(cleaned) || null;
}

/**
 * Compare video price vs caption price.
 * Returns { matches: boolean, videoPrice, captionPrice, correction } 
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

  // Allow 5% tolerance (rounding differences)
  const tolerance = 0.05;
  const diff = Math.abs(videoNum - captionNum) / Math.max(videoNum, captionNum);

  if (diff <= tolerance) {
    return { matches: true, videoPrice, captionPrice, correction: null };
  }

  // MISMATCH — video price is ground truth
  console.log(`[PriceCheck] ⚠️ PRICE MISMATCH: caption says ${captionPrice} (${captionNum}), video shows ${videoPrice} (${videoNum})`);
  return {
    matches: false,
    videoPrice,
    captionPrice,
    correction: videoPrice,
    videoPriceNum: videoNum,
    captionPriceNum: captionNum,
  };
}

/**
 * Replace the price in a caption with the corrected price from video.
 * Preserves the format of the original price mention.
 */
export function correctCaptionPrice(caption, oldPrice, newPrice) {
  if (!caption || !oldPrice || !newPrice) return caption;
  // Replace the old price with the new one
  const corrected = caption.replace(oldPrice, newPrice);
  console.log(`[PriceCheck] Corrected caption price: "${oldPrice}" → "${newPrice}"`);
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
export async function runPriceConsistencyCheck(videoPath, caption, existingFrames = null) {
  console.log("[PriceCheck] Running price-consistency check...");

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
      console.log("[PriceCheck] ✓ Prices consistent (or no conflict)");
      return { caption, corrected: false, log: "consistent" };
    }

    // Step 4: Correct the caption
    const correctedCaption = correctCaptionPrice(caption, comparison.captionPrice, comparison.correction);
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
