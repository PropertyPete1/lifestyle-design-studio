/**
 * One-time Backfill Script
 * 
 * Matches the full Drive video library against 90+ days of IG history.
 * Persists results to video-matches.json.
 * 
 * Strategy:
 * 1. Fetch 90 days of IG posts (with duration + thumbnail)
 * 2. For each city folder, list all Drive videos
 * 3. For each Drive video: get duration via partial download, then compare
 *    thumbnail perceptual hash against IG post thumbnails (duration-filtered)
 * 4. Save all matches to video-matches.json
 * 
 * Usage: CITY=all node src/backfill.js
 *   or:  CITY=san_antonio node src/backfill.js
 */

import { listCityVideos, downloadVideo } from "./drive.js";
import { getRecentIgPosts } from "./metricool.js";
import { loadMatches, saveMatches, getLocalDuration, getVideoHashes, getIgPostHash, hammingDistance, computePhash, extractFrames, MATCHES_PATH } from "./matcher.js";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";

const CITY = process.env.CITY || "all";
const cities = CITY === "all" ? ["san_antonio", "austin", "dallas"] : [CITY];

async function backfill() {
  console.log("=".repeat(60));
  console.log("[Backfill] Starting video matching backfill");
  console.log(`[Backfill] Cities: ${cities.join(", ")}`);
  console.log("=".repeat(60));

  // Step 1: Fetch 90 days of IG posts
  console.log("\n[Step 1] Fetching IG post history (90 days)...");
  const igPosts = await getRecentIgPosts(90);
  console.log(`[Step 1] Got ${igPosts.length} IG posts`);

  // Pre-compute IG thumbnail hashes
  console.log("\n[Step 2] Computing IG thumbnail hashes...");
  const igPostsWithHashes = [];
  for (const post of igPosts) {
    if (!post.thumbnailUrl) {
      igPostsWithHashes.push({ ...post, thumbHash: null });
      continue;
    }
    const hash = await getIgPostHash(post.thumbnailUrl);
    igPostsWithHashes.push({ ...post, thumbHash: hash });
    if (hash) {
      process.stdout.write(".");
    } else {
      process.stdout.write("x");
    }
  }
  console.log(`\n[Step 2] Computed ${igPostsWithHashes.filter(p => p.thumbHash).length}/${igPosts.length} thumbnail hashes`);

  // Load existing matches
  const matches = loadMatches();
  let totalMatched = 0;
  let totalUnmatched = 0;
  let totalSkipped = 0;

  for (const city of cities) {
    console.log(`\n${"=".repeat(40)}`);
    console.log(`[Backfill] Processing ${city}...`);

    // List all Drive videos
    const videos = await listCityVideos(city);
    console.log(`[Backfill] ${videos.length} videos in ${city} folder`);

    for (let i = 0; i < videos.length; i++) {
      const video = videos[i];
      const key = video.id;

      // Skip if already matched
      if (matches[key] && matches[key].length > 0) {
        totalSkipped++;
        continue;
      }

      console.log(`\n[${i + 1}/${videos.length}] ${video.name} (${video.id})`);

      try {
        // Download video (we need it for duration + frame extraction)
        // For backfill, download the full file to get accurate duration + frames
        const tmpPath = join(tmpdir(), `backfill_${video.id.slice(0, 8)}.mp4`);
        
        console.log("  Downloading...");
        const buffer = await downloadVideo(video.id, video.name);
        writeFileSync(tmpPath, buffer);

        // Get duration
        const duration = getLocalDuration(tmpPath);
        console.log(`  Duration: ${duration.toFixed(1)}s`);

        if (duration <= 0) {
          console.log("  SKIP: Could not determine duration");
          unlinkSync(tmpPath);
          totalUnmatched++;
          matches[key] = [];
          continue;
        }

        // Duration pre-filter: find IG posts within 1.5 seconds
        const durationCandidates = igPostsWithHashes.filter(p => {
          if (!p.duration) return false;
          return Math.abs(p.duration - duration) <= 1.5;
        });

        console.log(`  Duration candidates: ${durationCandidates.length} (within 1.5s of ${duration.toFixed(1)}s)`);

        if (durationCandidates.length === 0) {
          console.log("  NO MATCH: No IG posts with matching duration");
          unlinkSync(tmpPath);
          totalUnmatched++;
          matches[key] = [];
          continue;
        }

        // Extract first frame from Drive video for hash comparison
        const driveHashes = await getVideoHashes(tmpPath, duration);
        if (driveHashes.length === 0) {
          console.log("  SKIP: Could not extract frames");
          unlinkSync(tmpPath);
          totalUnmatched++;
          matches[key] = [];
          continue;
        }

        // Compare against duration-filtered IG posts
        let bestMatch = null;
        let bestDistance = 64;

        for (const igPost of durationCandidates) {
          if (!igPost.thumbHash) continue;

          // Compare first frame hash to IG thumbnail
          const dist = hammingDistance(driveHashes[0], igPost.thumbHash);
          if (dist < bestDistance) {
            bestDistance = dist;
            bestMatch = igPost;
          }
        }

        if (bestMatch && bestDistance < 18) {
          const confidence = 1 - (bestDistance / 64);
          console.log(`  MATCHED: ${bestMatch.reelId} (distance: ${bestDistance}, confidence: ${confidence.toFixed(2)})`);
          console.log(`  Caption: ${bestMatch.caption.slice(0, 80)}...`);
          console.log(`  Posted: ${JSON.stringify(bestMatch.publishedAt)}`);

          matches[key] = [{
            igPostId: bestMatch.reelId,
            publishedAt: bestMatch.publishedAt,
            caption: bestMatch.caption,
            matchMethod: bestDistance < 8 ? "perceptual_hash" : "perceptual_hash_weak",
            confidence,
            durationDiff: Math.abs((bestMatch.duration || 0) - duration),
            city,
          }];
          totalMatched++;
        } else {
          console.log(`  NO MATCH: Best distance was ${bestDistance} (threshold: 12)`);
          matches[key] = [];
          totalUnmatched++;
        }

        // Cleanup
        unlinkSync(tmpPath);

        // Save periodically (every 5 videos)
        if ((i + 1) % 5 === 0) {
          saveMatches(matches);
          console.log(`  [Saved progress: ${totalMatched} matched, ${totalUnmatched} unmatched, ${totalSkipped} skipped]`);
        }

      } catch (err) {
        console.error(`  ERROR: ${err.message}`);
        totalUnmatched++;
        matches[key] = [];
      }
    }
  }

  // Final save
  saveMatches(matches);

  // Report
  console.log("\n" + "=".repeat(60));
  console.log("[Backfill] COMPLETE");
  console.log(`  Matched: ${totalMatched}`);
  console.log(`  Unmatched: ${totalUnmatched}`);
  console.log(`  Skipped (already matched): ${totalSkipped}`);
  console.log(`  Match rate: ${((totalMatched / (totalMatched + totalUnmatched)) * 100).toFixed(1)}%`);
  console.log(`  Results saved to: ${MATCHES_PATH}`);
  console.log("=".repeat(60));

  // List unmatched items
  const unmatchedIds = Object.entries(matches)
    .filter(([_, v]) => v.length === 0)
    .map(([k]) => k);
  
  if (unmatchedIds.length > 0) {
    console.log(`\n[Unmatched Drive files] (${unmatchedIds.length} total):`);
    unmatchedIds.forEach(id => console.log(`  - ${id}`));
  }
}

backfill().catch(err => {
  console.error("[Backfill] Fatal error:", err);
  process.exit(1);
});
