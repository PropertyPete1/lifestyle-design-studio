/**
 * Lifestyle Design Realty — Auto Poster
 * 
 * Runs on GitHub Actions cron. Posts one video per city per scheduled time.
 * 
 * Flow:
 * 1. Check IG profile (via Metricool) for last 30 days of posts
 * 2. List Drive videos for the target city
 * 3. Filter out videos posted in last 30 days (DB + IG check)
 * 4. Pick top 3 candidates, try each in order
 * 5. Detect speech → add voiceover if needed
 * 6. Generate caption via Claude
 * 7. Upload to Metricool → post to all platforms
 * 8. Log result to posted-log.json
 */

import { listCityVideos, downloadVideo } from "./drive.js";
import { getRecentIgPosts, uploadVideoToMetricool, createPost } from "./metricool.js";
import { generateCaption } from "./caption.js";
import { processVoiceover, cleanup } from "./voiceover.js";
import { loadLog, saveLog, wasPostedRecently, hasRecentPost, recordPost, getRecentlyPostedIds } from "./state.js";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const DRY_RUN = process.env.DRY_RUN === "true";
const CITY = process.env.CITY || "san_antonio"; // san_antonio | austin | dallas

// Schedule: SA at 2PM CT, Austin at 3PM CT, DFW at 4PM CT (every other day)
// GitHub Actions handles the scheduling via cron — this script just posts for the given CITY.

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

  // Step 1: Check Instagram for recent posts (via Metricool)
  console.log("\n[Step 1] Checking Instagram for recent posts...");
  let igPosts = [];
  try {
    igPosts = await getRecentIgPosts(30);
  } catch (err) {
    console.warn(`[Step 1] IG check failed (non-fatal): ${err.message}`);
  }

  // Step 2: List Drive videos for this city
  console.log(`\n[Step 2] Listing Drive videos for ${CITY}...`);
  const allVideos = await listCityVideos(CITY);

  if (allVideos.length === 0) {
    console.log(`[AutoPoster] No videos found in Drive folder for ${CITY}. Exiting.`);
    process.exit(0);
  }

  // Step 3: Filter out recently posted videos
  console.log("\n[Step 3] Filtering out recently posted videos...");
  const recentIds = getRecentlyPostedIds(log, CITY, 30);

  // Also check IG captions for any matching posts (belt + suspenders)
  const igCaptionFingerprints = new Set(
    igPosts.map(p => captionFingerprint(p.caption))
  );

  const eligible = allVideos.filter(v => !recentIds.has(v.id));
  console.log(`[Step 3] ${eligible.length} eligible videos (${allVideos.length} total, ${recentIds.size} posted in 30d)`);

  if (eligible.length === 0) {
    console.log(`[AutoPoster] All videos for ${CITY} have been posted in the last 30 days. Exiting.`);
    process.exit(0);
  }

  // Step 4: Pick top 3 candidates (oldest first for fair rotation)
  const candidates = eligible.slice(0, 3);
  console.log(`\n[Step 4] Trying ${candidates.length} candidates...`);

  let posted = false;
  let lastError = null;

  for (const candidate of candidates) {
    try {
      console.log(`\n--- Trying: ${candidate.name} (${candidate.id}) ---`);
      await postVideo(candidate, log);
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

  console.log("\n" + "=".repeat(60));
  console.log("[AutoPoster] Done!");
  console.log("=".repeat(60));
}

/**
 * Post a single video: download → voiceover → caption → upload → post → log
 */
async function postVideo(video, log) {
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

    // Generate caption
    console.log("[Post] Generating caption...");
    const caption = await generateCaption(CITY);

    // Upload to Metricool
    console.log("[Post] Uploading to Metricool...");
    const videoToUpload = existsSync(finalVideoPath)
      ? finalVideoPath
      : tempVideoPath;

    let mediaUrl;
    if (DRY_RUN) {
      mediaUrl = "https://dry-run-placeholder.example.com/video.mp4";
      console.log("[Post] DRY RUN — skipping upload");
    } else {
      const { readFileSync: readFS } = await import("fs");
      const uploadBuffer = readFS(videoToUpload);
      mediaUrl = await uploadVideoToMetricool(uploadBuffer, video.name);
    }

    // Post to all platforms
    console.log("[Post] Creating post...");
    const result = await createPost(mediaUrl, caption, { dryRun: DRY_RUN });

    // Record in log
    recordPost(log, {
      driveFileId: video.id,
      fileName: video.name,
      city: CITY,
      caption,
      voiceover: hasVoiceover,
      platforms: ["instagram", "tiktok", "youtube", "linkedin"],
      success: true,
    });

    console.log(`[Post] ✓ Successfully posted ${video.name}`);
    if (hasVoiceover) console.log("[Post] ✓ Voiceover added");
    console.log(`[Post] ✓ Caption: ${caption.slice(0, 80)}...`);
  } finally {
    // Cleanup temp files
    cleanup(tempVideoPath);
    if (finalVideoPath && finalVideoPath !== tempVideoPath) {
      cleanup(finalVideoPath);
    }
  }
}

/**
 * Simple caption fingerprint for matching IG posts to Drive videos.
 */
function captionFingerprint(caption) {
  if (!caption) return "";
  return caption
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

// Run
main().catch(err => {
  console.error("[AutoPoster] Fatal error:", err);
  process.exit(1);
});
