/**
 * Lifestyle Design Realty — Auto Poster
 * 
 * Runs on GitHub Actions cron. Posts one video per city per scheduled time.
 * 
 * IG-FIRST FLOW:
 * 1. Check IG profile (via Metricool) — get last 30 days of posts with thumbnails + duration
 * 2. List Drive videos for the target city
 * 3. For each Drive video, check if it matches any IG post from last 30 days
 *    using perceptual hash matching (duration filter + thumbnail comparison)
 * 4. Pick 3 candidates that are NOT on IG in last 30 days, sorted by oldest-last-post
 * 5. Try each in order: download → voiceover → caption → upload → post
 * 6. Caption: reuse original IG caption (restructured) if matched, else generate fresh
 * 7. Log result to posted-log.json
 */

import { listCityVideos, downloadVideo } from "./drive.js";
import { getRecentIgPosts, uploadVideoToMetricool, createPost } from "./metricool.js";
import { generateCaption, generateCaptionFromOriginal } from "./caption.js";
import { processVoiceover, cleanup } from "./voiceover.js";
import { loadLog, saveLog, hasRecentPost, recordPost, getRecentlyPostedIds } from "./state.js";
import { loadMatches, saveMatches, getVideoHashes, getIgPostHash, hammingDistance, getLocalDuration } from "./matcher.js";
import { writeFileSync, unlinkSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const DRY_RUN = process.env.DRY_RUN === "true";
const CITY = process.env.CITY || "san_antonio";

// Match threshold: distance < 18 = strong match (same video)
const MATCH_THRESHOLD = 18;

async function main() {
  console.log("=".repeat(60));
  console.log(`[AutoPoster] Starting for city: ${CITY}`);
  console.log(`[AutoPoster] Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log(`[AutoPoster] Time: ${new Date().toLocaleString("en-US", { timeZone: "America/Chicago" })} CT`);
  console.log("=".repeat(60));

  // Load state
  const log = loadLog();

  // Idempotency guard: don't double-post if cron fires twice
  if (!DRY_RUN && hasRecentPost(log, CITY, 20)) {
    console.log(`[AutoPoster] Already posted for ${CITY} in the last 20 hours. Exiting.`);
    process.exit(0);
  }

  // Step 1: Check Instagram for recent posts (via Metricool) — get 30 days with full data
  console.log("\n[Step 1] Checking Instagram for recent posts (30 days)...");
  let igPosts = [];
  try {
    igPosts = await getRecentIgPosts(30);
  } catch (err) {
    console.warn(`[Step 1] IG check failed (non-fatal): ${err.message}`);
    console.warn("[Step 1] Falling back to posted-log.json only");
  }

  // Pre-compute IG thumbnail hashes for matching
  console.log("[Step 1] Computing IG thumbnail hashes for matching...");
  const igWithHashes = [];
  for (const post of igPosts) {
    if (!post.thumbnailUrl || !post.duration) {
      igWithHashes.push({ ...post, thumbHash: null });
      continue;
    }
    const hash = await getIgPostHash(post.thumbnailUrl);
    igWithHashes.push({ ...post, thumbHash: hash });
  }
  const hashCount = igWithHashes.filter(p => p.thumbHash).length;
  console.log(`[Step 1] Got ${hashCount}/${igPosts.length} IG thumbnail hashes`);

  // Step 2: List Drive videos for this city
  console.log(`\n[Step 2] Listing Drive videos for ${CITY}...`);
  const allVideos = await listCityVideos(CITY);

  if (allVideos.length === 0) {
    console.log(`[AutoPoster] No videos found in Drive folder for ${CITY}. Exiting.`);
    process.exit(0);
  }

  // Step 3: Filter — remove videos that match IG posts from last 30 days
  console.log("\n[Step 3] Filtering videos against IG profile (30-day rule)...");
  
  // Also check posted-log.json as belt-and-suspenders
  const recentLogIds = getRecentlyPostedIds(log, CITY, 30);
  console.log(`[Step 3] ${recentLogIds.size} videos in posted-log from last 30 days`);

  // Load cached matches
  const matchCache = loadMatches();

  // Find eligible videos (not posted in last 30 days)
  const eligible = [];
  const blocked = [];

  for (const video of allVideos) {
    // Check posted-log first (fast)
    if (recentLogIds.has(video.id)) {
      blocked.push({ video, reason: "posted-log" });
      continue;
    }

    // Check if we have a cached match to a recent IG post
    const cached = matchCache[video.id];
    if (cached && cached.length > 0) {
      const matchedPost = cached[0];
      const postedDate = parsePublishedAt(matchedPost.publishedAt);
      const daysSince = (Date.now() - postedDate.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince < 30) {
        blocked.push({ video, reason: `matched IG post from ${daysSince.toFixed(0)} days ago` });
        continue;
      }
    }

    eligible.push(video);
  }

  console.log(`[Step 3] ${eligible.length} eligible, ${blocked.length} blocked`);
  if (blocked.length > 0) {
    console.log(`[Step 3] Blocked videos:`);
    blocked.slice(0, 5).forEach(b => console.log(`  - ${b.video.name}: ${b.reason}`));
    if (blocked.length > 5) console.log(`  ... and ${blocked.length - 5} more`);
  }

  if (eligible.length === 0) {
    console.log(`[AutoPoster] All videos for ${CITY} have been posted in the last 30 days. Exiting.`);
    process.exit(0);
  }

  // Step 4: Pick top 3 candidates
  // Sort by: videos with known old matches first (true rotation), then unmatched
  const sorted = eligible.sort((a, b) => {
    const aMatch = matchCache[a.id];
    const bMatch = matchCache[b.id];
    const aDate = aMatch?.[0]?.publishedAt ? parsePublishedAt(aMatch[0].publishedAt).getTime() : 0;
    const bDate = bMatch?.[0]?.publishedAt ? parsePublishedAt(bMatch[0].publishedAt).getTime() : 0;
    // Oldest last-post first (0 = never matched = lowest priority after known old ones)
    if (aDate === 0 && bDate === 0) return 0;
    if (aDate === 0) return 1; // unmatched goes after known old
    if (bDate === 0) return -1;
    return aDate - bDate; // oldest first
  });

  const candidates = sorted.slice(0, 3);
  console.log(`\n[Step 4] Top ${candidates.length} candidates:`);
  candidates.forEach((c, i) => {
    const m = matchCache[c.id];
    const lastPost = m?.[0]?.publishedAt ? parsePublishedAt(m[0].publishedAt).toLocaleDateString() : "never matched";
    console.log(`  ${i + 1}. ${c.name} (last posted: ${lastPost})`);
  });

  // Step 5: Try each candidate
  let posted = false;
  let lastError = null;

  for (const candidate of candidates) {
    try {
      console.log(`\n${"─".repeat(50)}`);
      console.log(`[Trying] ${candidate.name} (${candidate.id})`);
      
      // Live IG match check: download partial, hash, compare against current IG posts
      // This catches any posts made since the last backfill
      const isBlockedLive = await liveIgMatchCheck(candidate, igWithHashes, matchCache);
      if (isBlockedLive) {
        console.log(`[Trying] BLOCKED by live IG check — this video was posted in last 30 days`);
        continue;
      }

      await postVideo(candidate, log, igWithHashes, matchCache);
      posted = true;
      break;
    } catch (err) {
      lastError = err;
      console.error(`[AutoPoster] Failed for ${candidate.name}: ${err.message}`);
      console.log("[AutoPoster] Trying next candidate...");
    }
  }

  if (!posted) {
    console.error(`\n[AutoPoster] All candidates failed. Last error: ${lastError?.message}`);
    process.exit(1);
  }

  // Save updated match cache
  saveMatches(matchCache);

  console.log("\n" + "=".repeat(60));
  console.log("[AutoPoster] Done!");
  console.log("=".repeat(60));
}

/**
 * Live IG match check: download first 5MB of video, extract frame, hash, compare.
 * Returns true if video matches an IG post from last 30 days.
 */
async function liveIgMatchCheck(video, igWithHashes, matchCache) {
  // Skip if we already have a cached match that's older than 30 days (already cleared)
  const cached = matchCache[video.id];
  if (cached && cached.length > 0) {
    const postedDate = parsePublishedAt(cached[0].publishedAt);
    const daysSince = (Date.now() - postedDate.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince >= 30) return false; // Known old match, safe
  }

  // If no IG posts with hashes, can't do live check — allow it
  if (igWithHashes.filter(p => p.thumbHash).length === 0) return false;

  // Download full video for accurate matching
  console.log("[LiveCheck] Downloading for IG match verification...");
  const tmpPath = join(tmpdir(), `livecheck_${video.id.slice(0, 8)}.mp4`);
  
  try {
    const buffer = await downloadVideo(video.id, video.name);
    writeFileSync(tmpPath, buffer);

    const duration = getLocalDuration(tmpPath);
    if (duration <= 0) return false;

    // Duration pre-filter
    const candidates = igWithHashes.filter(p => 
      p.thumbHash && p.duration && Math.abs(p.duration - duration) <= 2
    );

    if (candidates.length === 0) return false;

    // Get frame hashes
    const driveHashes = await getVideoHashes(tmpPath, duration);
    if (driveHashes.length === 0) return false;

    // Find best match
    let bestMatch = null;
    let bestDist = 64;
    for (const ig of candidates) {
      for (const dh of driveHashes) {
        const dist = hammingDistance(dh, ig.thumbHash);
        if (dist < bestDist) {
          bestDist = dist;
          bestMatch = ig;
        }
      }
    }

    if (bestMatch && bestDist < MATCH_THRESHOLD) {
      // Update cache with this match
      matchCache[video.id] = [{
        igPostId: bestMatch.reelId,
        publishedAt: bestMatch.publishedAt,
        caption: bestMatch.caption,
        matchMethod: "perceptual_hash_live",
        confidence: 1 - (bestDist / 64),
        city: CITY,
      }];

      const postedDate = parsePublishedAt(bestMatch.publishedAt);
      const daysSince = (Date.now() - postedDate.getTime()) / (1000 * 60 * 60 * 24);
      console.log(`[LiveCheck] Matched to IG post from ${daysSince.toFixed(0)} days ago (dist: ${bestDist})`);
      return daysSince < 30;
    }

    return false;
  } finally {
    try { unlinkSync(tmpPath); } catch {}
  }
}

/**
 * Post a single video: download → voiceover → caption → upload → post → log
 */
async function postVideo(video, log, igWithHashes, matchCache) {
  const tempVideoPath = join(tmpdir(), `autoposter_${Date.now()}.mp4`);
  let finalVideoPath = null;

  try {
    // Download from Drive
    console.log("[Post] Downloading from Drive...");
    const buffer = await downloadVideo(video.id, video.name);
    writeFileSync(tempVideoPath, buffer);

    // Voiceover pipeline
    console.log("[Post] Running voiceover detection...");
    const voResult = await processVoiceover(tempVideoPath, CITY, DRY_RUN);
    finalVideoPath = voResult.videoPath;
    const hasVoiceover = !voResult.skipped;

    // Generate caption — try to reuse original if we have a match
    console.log("[Post] Generating caption...");
    let caption;
    const cachedMatch = matchCache[video.id];
    if (cachedMatch && cachedMatch.length > 0 && cachedMatch[0].caption) {
      console.log("[Post] Found original caption from previous IG post — restructuring for engagement");
      caption = await generateCaptionFromOriginal(cachedMatch[0].caption, CITY);
    } else {
      console.log("[Post] No original caption found — generating fresh");
      caption = await generateCaption(CITY);
    }

    // Upload to Metricool
    console.log("[Post] Uploading to Metricool...");
    const videoToUpload = existsSync(finalVideoPath) ? finalVideoPath : tempVideoPath;

    let mediaUrl;
    if (DRY_RUN) {
      mediaUrl = "https://dry-run-placeholder.example.com/video.mp4";
      console.log("[Post] DRY RUN — skipping upload");
    } else {
      const uploadBuffer = readFileSync(videoToUpload);
      mediaUrl = await uploadVideoToMetricool(uploadBuffer, video.name);
    }

    // Post to all platforms
    console.log("[Post] Creating post...");
    const result = await createPost(mediaUrl, caption, { dryRun: DRY_RUN });

    // Record in log (skip in dry-run mode)
    if (!DRY_RUN) {
      recordPost(log, {
        driveFileId: video.id,
        fileName: video.name,
        city: CITY,
        caption,
        voiceover: hasVoiceover,
        platforms: ["instagram", "tiktok", "youtube"],
        success: true,
      });
    } else {
      console.log("[Post] DRY RUN — skipping log entry");
    }

    console.log(`[Post] ✓ Successfully posted ${video.name}`);
    if (hasVoiceover) console.log("[Post] ✓ Voiceover added");
    console.log(`[Post] ✓ Caption (${caption.length} chars): ${caption.slice(0, 100)}...`);
  } finally {
    cleanup(tempVideoPath);
    if (finalVideoPath && finalVideoPath !== tempVideoPath) {
      cleanup(finalVideoPath);
    }
  }
}

/**
 * Parse Metricool's publishedAt format: { dateTime: "2026-07-10T02:16:11", timezone: "Europe/Madrid" }
 */
function parsePublishedAt(publishedAt) {
  if (!publishedAt) return new Date(0);
  if (typeof publishedAt === "string") return new Date(publishedAt);
  if (publishedAt.dateTime) {
    // Metricool returns dateTime in the specified timezone
    // For comparison purposes, treat as UTC (close enough for 30-day window)
    return new Date(publishedAt.dateTime + "Z");
  }
  return new Date(0);
}

// Run
main().catch(err => {
  console.error("[AutoPoster] Fatal error:", err);
  process.exit(1);
});
