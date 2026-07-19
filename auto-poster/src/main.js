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
 * 6. Caption: reuse original IG caption (restructured) if HIGH-CONFIDENCE match, else generate fresh
 * 7. Log result to posted-log.json
 * 
 * MATCHING RULES (asymmetric confidence):
 * - BLOCKING a video: hash distance < 10 = auto-block (definite match)
 *   hash distance 10-17 = requires AI vision confirmation (too many false positives
 *   from similar-looking real estate videos in different cities)
 * - REUSING a caption (risky direction): requires distance < 10 AND city consistency check
 *   Falls back to fresh caption if confidence is insufficient.
 */

import { listCityVideos, downloadVideo, getAccessToken } from "./drive.js";
import { getRecentIgPosts, uploadVideoToMetricool, createPost, verifyPostStatus } from "./metricool.js";
import { generateCaption, generateCaptionFromOriginal, findCommunity } from "./caption.js";
import { processVoiceover, cleanup } from "./voiceover.js";
import { runPriceConsistencyCheck, readVideoOverlays, extractPriceCheckFrames } from "./price-check.js";
import { processBurnedCaptions } from "./burned-captions.js";
import { prePostQualityCheck } from "./quality-check.js";
import { applyFreshness } from "./freshness.js";
import { deliverToOwner } from "./delivery.js";
import { runWeeklyAnalytics, loadWeights } from "./analytics.js";
import { loadLog, saveLog, hasRecentPost, recordPost, getRecentlyPostedIds, loadBlocklist, blocklistVideo, isBlocklisted } from "./state.js";
import { postToLinkedin } from "./linkedin.js";
import { loadMatches, saveMatches, getVideoHashes, getIgPostHash, hammingDistance, getLocalDuration, aiVisionCompare, extractFrames } from "./matcher.js";
import { writeFileSync, unlinkSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Prevent unhandled EPIPE crashes from Anthropic SDK's keepalive agent.
// These occur when a stale TLS socket is reused after a failed request (e.g., 413).
process.on("uncaughtException", (err) => {
  if (err.code === "EPIPE" || err.code === "ECONNRESET") {
    console.warn(`[Process] Suppressed ${err.code} on socket — retrying operation will use a fresh connection`);
    return; // Don't crash — the retry logic in the SDK will handle it
  }
  // Re-throw anything else
  console.error("[Process] Uncaught exception:", err);
  process.exit(1);
});

const DRY_RUN = process.env.DRY_RUN === "true";
const CITY = process.env.CITY || "san_antonio";
const FORCE = process.env.FORCE === "true"; // Manual override to bypass every-other-day check
const TEST_DELIVERY_ONLY = process.env.TEST_DELIVERY_ONLY === "true"; // Test delivery pipeline only — no social posts, no log entry
const FORCE_VIDEO_ID = process.env.FORCE_VIDEO_ID || ""; // Pin a specific Drive file ID for testing

// Match thresholds (asymmetric):
// BLOCKING: distance < 10 = definite same video, block immediately
// distance 10-17 = ambiguous zone, requires AI vision confirmation before blocking
const BLOCK_THRESHOLD = 18;
const AI_CONFIRM_THRESHOLD = 10; // Below this = auto-block; 10-17 = AI vision check
// CAPTION REUSE: distance < 5 = auto-reuse (extremely high confidence)
// distance 5-9 = requires AI vision confirmation before reusing caption
// (risky direction: wrong caption looks bad to followers — worse than wrong block)
const CAPTION_REUSE_THRESHOLD = 10; // Overall threshold: above this = never reuse
const CAPTION_AUTO_REUSE_THRESHOLD = 5; // Below this = auto-reuse without AI check

// City keywords for cross-city caption detection
const CITY_KEYWORDS = {
  san_antonio: ["san antonio", "sanantonio", "sa ", "alamo"],
  austin: ["austin", "hill country", "round rock", "cedar park", "pflugerville"],
  dallas: ["dallas", "dfw", "fort worth", "frisco", "plano", "mckinney"],
};

/**
 * Check if a caption clearly references a DIFFERENT city than the posting city.
 * Returns true if the caption should NOT be reused for this city.
 */
function captionCityMismatch(caption, postingCity) {
  if (!caption) return false;
  const lower = caption.toLowerCase();

  // Check if caption references a different city
  for (const [city, keywords] of Object.entries(CITY_KEYWORDS)) {
    if (city === postingCity) continue; // Skip our own city
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        // Also check if it references our city too (some captions mention multiple)
        const ourKeywords = CITY_KEYWORDS[postingCity] || [];
        const mentionsOurCity = ourKeywords.some(k => lower.includes(k));
        if (!mentionsOurCity) {
          return true; // References another city but NOT ours
        }
      }
    }
  }
  return false;
}

/**
 * Fetch the LIVE posted-log.json from GitHub's raw API (main branch)
 * and check if this city has posted in the last 20 hours.
 * This catches race conditions where another concurrent run already posted
 * but hasn't committed yet (or committed after our checkout).
 * Returns true if a conflict is detected (should abort).
 */
async function checkRemoteLog(city) {
  try {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      console.warn("[RemoteCheck] No GITHUB_TOKEN — skipping remote log check");
      return false;
    }
    // Use GitHub Contents API — NOT raw.githubusercontent.com (which is CDN-cached ~5 min)
    const url = `https://api.github.com/repos/PropertyPete1/lifestyle-design-studio/contents/auto-poster/posted-log.json?ref=main&t=${Date.now()}`;
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.raw",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!resp.ok) {
      console.warn(`[RemoteCheck] GitHub API returned ${resp.status} — skipping check (fail-open)`);
      return false;
    }
    const remoteLog = await resp.json();
    const cutoff = Date.now() - 20 * 60 * 60 * 1000;
    const conflict = (remoteLog.posts || []).some(
      p => p.city === city && new Date(p.timestamp).getTime() > cutoff
    );
    if (conflict) {
      console.log(`[RemoteCheck] ⚠️ CONFLICT: Remote posted-log shows ${city} was posted in last 20h`);
    } else {
      console.log(`[RemoteCheck] ✓ No conflict — remote log clear for ${city}`);
    }
    return conflict;
  } catch (err) {
    console.warn(`[RemoteCheck] Error checking remote log: ${err.message} — proceeding anyway (fail-open)`);
    return false;
  }
}

async function main() {
  console.log("=".repeat(60));
  console.log(`[AutoPoster] Starting for city: ${CITY}`);
  console.log(`[AutoPoster] Mode: ${TEST_DELIVERY_ONLY ? "TEST DELIVERY ONLY (no social posts)" : DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log(`[AutoPoster] Time: ${new Date().toLocaleString("en-US", { timeZone: "America/Chicago" })} CT`);
  console.log("=".repeat(60));

  // DFW every-other-day check (applies to external-cron triggers too)
  // FORCE=true bypasses this (for manual runs from GitHub UI)
  if (CITY === "dallas" && !DRY_RUN && !FORCE) {
    const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
    if (dayOfYear % 2 !== 0) {
      console.log(`[AutoPoster] DFW posts every other day — skipping today (day ${dayOfYear} is odd)`);
      process.exit(0);
    }
    console.log(`[AutoPoster] DFW posting today (day ${dayOfYear} is even)`);
  }

  // Run weekly analytics feedback loop (if stale or missing)
  try {
    const weights = loadWeights();
    const lastUpdate = weights.lastUpdated ? new Date(weights.lastUpdated) : null;
    const daysSinceUpdate = lastUpdate ? (Date.now() - lastUpdate.getTime()) / 86400000 : Infinity;
    if (daysSinceUpdate >= 7) {
      console.log(`[AutoPoster] Performance weights stale (${Math.round(daysSinceUpdate)}d old) — running analytics...`);
      await runWeeklyAnalytics(7);
    } else {
      console.log(`[AutoPoster] Performance weights fresh (updated ${Math.round(daysSinceUpdate)}d ago)`);
    }
  } catch (err) {
    console.warn(`[AutoPoster] Analytics update failed (non-fatal): ${err.message}`);
  }

  // Load state
  const log = loadLog();

  // Idempotency guard: don't double-post if cron fires twice
  if (!DRY_RUN && !TEST_DELIVERY_ONLY && hasRecentPost(log, CITY, 20)) {
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
  // NOTE: Hash ALL posts with thumbnails, even without duration.
  // Duration is only used as a pre-filter optimization; the hash is the real discriminator.
  // Metricool doesn't return durationSeconds for ~55% of reels (API limitation).
  console.log("[Step 1] Computing IG thumbnail hashes for matching...");
  const igWithHashes = [];
  const unmatchable = [];
  for (const post of igPosts) {
    if (!post.thumbnailUrl) {
      igWithHashes.push({ ...post, thumbHash: null });
      unmatchable.push(post);
      continue;
    }
    const hash = await getIgPostHash(post.thumbnailUrl);
    if (hash) {
      igWithHashes.push({ ...post, thumbHash: hash });
    } else {
      igWithHashes.push({ ...post, thumbHash: null });
      unmatchable.push(post);
    }
  }
  const hashCount = igWithHashes.filter(p => p.thumbHash).length;
  console.log(`[Step 1] Got ${hashCount}/${igPosts.length} IG thumbnail hashes`);

  // Log unmatchable posts for visibility
  if (unmatchable.length > 0) {
    console.log(`[Step 1] ${unmatchable.length} unmatchable IG posts (no thumbnail/duration/hash):`);
    unmatchable.slice(0, 5).forEach(p => {
      const reason = !p.thumbnailUrl ? "no thumbnail" : !p.duration ? "no duration (image post?)" : "hash failed";
      const date = p.publishedAt?.dateTime || "unknown date";
      console.log(`  - ${p.reelId} (${date}): ${reason}`);
    });
    if (unmatchable.length > 5) console.log(`  ... and ${unmatchable.length - 5} more`);
  }

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

  // Load QC blocklist
  const blocklist = loadBlocklist();
  const blocklistCount = Object.keys(blocklist.blockedDriveIds).length;
  if (blocklistCount > 0) {
    console.log(`[Step 3] QC blocklist: ${blocklistCount} permanently blocked videos`);
  }

  // Find eligible videos (not posted in last 30 days, not blocklisted, not too short)
  const eligible = [];
  const blocked = [];
  let durationFilterCount = 0;

  for (const video of allVideos) {
    // Check QC blocklist first (instant)
    if (isBlocklisted(blocklist, video.id)) {
      blocked.push({ video, reason: `qc-blocklist: ${blocklist.blockedDriveIds[video.id].reason.slice(0, 50)}` });
      continue;
    }

    // Pre-filter: skip videos shorter than 5 seconds (via Drive metadata)
    const durationMs = video.videoMediaMetadata?.durationMillis;
    if (durationMs && parseInt(durationMs) < 5000) {
      blocked.push({ video, reason: `too short: ${(parseInt(durationMs) / 1000).toFixed(1)}s (Drive metadata)` });
      // Auto-add to blocklist for permanent exclusion
      blocklistVideo(blocklist, video.id, video.name, `Too short: ${(parseInt(durationMs) / 1000).toFixed(1)}s (minimum 5s)`);
      durationFilterCount++;
      continue;
    }

    // Check posted-log (fast)
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

  if (durationFilterCount > 0) {
    console.log(`[Step 3] Pre-filtered ${durationFilterCount} videos under 5s (added to blocklist)`);
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
  // NEW: If unmatchable IG posts exist, prefer confirmed-old matches over never-matched
  // (never-matched MIGHT be a near-match to an unmatchable post we can't verify)
  const hasUnmatchable = unmatchable.length > 0;
  const sorted = eligible.sort((a, b) => {
    const aMatch = matchCache[a.id];
    const bMatch = matchCache[b.id];
    const aDate = aMatch?.[0]?.publishedAt ? parsePublishedAt(aMatch[0].publishedAt).getTime() : 0;
    const bDate = bMatch?.[0]?.publishedAt ? parsePublishedAt(bMatch[0].publishedAt).getTime() : 0;

    // Both have known old matches: oldest first
    if (aDate > 0 && bDate > 0) return aDate - bDate;

    // If unmatchable posts exist, prefer known-old over never-matched
    if (hasUnmatchable) {
      if (aDate > 0 && bDate === 0) return -1; // a has known history, prefer it
      if (aDate === 0 && bDate > 0) return 1;  // b has known history, prefer it
    }

    // Both unmatched or no unmatchable concern
    if (aDate === 0 && bDate === 0) return 0;
    if (aDate === 0) return 1;
    if (bDate === 0) return -1;
    return aDate - bDate;
  });

  // Use ALL eligible candidates (not just top 3) — iterate until one passes
  const candidates = sorted;
  console.log(`\n[Step 4] ${candidates.length} candidates (sorted by rotation priority):`);
  // Show top 5 for logging
  candidates.slice(0, 5).forEach((c, i) => {
    const m = matchCache[c.id];
    const lastPost = m?.[0]?.publishedAt ? parsePublishedAt(m[0].publishedAt).toLocaleDateString() : "never matched";
    console.log(`  ${i + 1}. ${c.name} (last posted: ${lastPost})`);
  });
  if (candidates.length > 5) console.log(`  ... and ${candidates.length - 5} more`);
  if (hasUnmatchable) {
    console.log(`  [Note: ${unmatchable.length} unmatchable IG posts exist — preferring confirmed-old candidates]`);
  }

    // Step 5: Try each candidate
  // FORCE_VIDEO_ID override: skip rotation and use a specific Drive file
  if (FORCE_VIDEO_ID) {
    const forced = allVideos.find(v => v.id === FORCE_VIDEO_ID);
    if (!forced) {
      console.error(`[FORCE_VIDEO_ID] File ${FORCE_VIDEO_ID} not found in Drive folder for ${CITY}. Trying direct metadata...`);
      // Try to get file metadata directly from Drive
      const { getFileMetadata } = await import("./drive.js");
      const meta = await getFileMetadata(FORCE_VIDEO_ID);
      if (meta) {
        candidates.length = 0;
        candidates.push({ id: FORCE_VIDEO_ID, name: meta.name, mimeType: meta.mimeType });
        console.log(`[FORCE_VIDEO_ID] Resolved: ${meta.name}`);
      } else {
        console.error(`[FORCE_VIDEO_ID] Could not resolve file. Aborting.`);
        process.exit(1);
      }
    } else {
      candidates.length = 0;
      candidates.push(forced);
      console.log(`[FORCE_VIDEO_ID] Pinned: ${forced.name} (${forced.id})`);
    }
  }
  let posted = false;
  let lastError = null;
  let postedBrands = [];
  for (const candidate of candidates) {
    try {
      console.log(`\n${"─".repeat(50)}`);
      console.log(`[Trying] ${candidate.name} (${candidate.id})`);
      
      // Live IG match check: download video, hash, compare against current IG posts
      // Returns { blocked, videoPath } — keeps file on disk if not blocked
      const liveResult = await liveIgMatchCheck(candidate, igWithHashes, matchCache);
      if (liveResult.blocked) {
        console.log(`[Trying] BLOCKED by live IG check — this video was posted in last 30 days`);
        continue;
      }

      // Pass the already-downloaded video path to avoid double download
      const postResult = await postVideo(candidate, log, igWithHashes, matchCache, liveResult.videoPath);
      posted = true;
      // Store post result for verification
      if (postResult && postResult.brands) {
        postedBrands = postResult.brands.filter(b => b.ok && b.postId && b.postId !== "unknown");
      }
      break;
    } catch (err) {
      lastError = err;
      console.error(`[AutoPoster] Failed for ${candidate.name}: ${err.message}`);

      // Auto-blocklist videos that fail for inherent reasons (won't pass on retry)
      const msg = err.message || "";
      const isInherent = msg.includes("Too short") || msg.includes("Too long") ||
        msg.includes("Not vertical") || msg.includes("corrupted") ||
        msg.includes("No video stream") || msg.includes("AI vision:") ||
        msg.includes("File too small");
      if (isInherent) {
        blocklistVideo(blocklist, candidate.id, candidate.name, msg.replace(/^\[QC\] FAILED: /, ""));
        console.log(`[AutoPoster] Added ${candidate.name} to QC blocklist (inherent failure)`);
      }

      console.log("[AutoPoster] Trying next candidate...");
    }
  }

  // Save updated match cache and blocklist (even if video posting failed)
  saveMatches(matchCache);

  // LinkedIn: post text-only recruiting content (DECOUPLED from video success)
  // Only fires on the san_antonio run to avoid duplicates across city runs.
  // Has its own 20-hour idempotency guard so manual re-runs can't double-post.
  if (CITY === "san_antonio" && !TEST_DELIVERY_ONLY) {
    const hasRecentLinkedin = log.posts.some(
      p => p.type === "linkedin" && (Date.now() - new Date(p.timestamp).getTime()) < 20 * 60 * 60 * 1000
    );

    if (hasRecentLinkedin) {
      console.log("\n[LinkedIn] Already posted in last 20 hours — skipping");
    } else {
      try {
        console.log("\n[LinkedIn] Generating daily recruiting post...");
        const liResult = await postToLinkedin({ dryRun: DRY_RUN });
        if (liResult.ok) {
          console.log(`[LinkedIn] ✓ Recruiting post published (topic: ${liResult.topic})`);
          // Log LinkedIn post for idempotency
          if (!DRY_RUN) {
            log.posts.push({
              type: "linkedin",
              topic: liResult.topic,
              brands: liResult.brands.map(b => ({ label: b.label, publishAt: b.publishAt })),
              timestamp: new Date().toISOString(),
              success: true,
            });
            saveLog(log);
          }
        }
      } catch (err) {
        // LinkedIn failure is non-fatal in both directions
        console.error(`[LinkedIn] ✗ Failed (non-fatal): ${err.message}`);
      }
    }
  }

  // Exit with error if video posting failed (after LinkedIn has had its chance)
  if (!posted) {
    console.error(`\n[AutoPoster] All video candidates failed. Last error: ${lastError?.message}`);
    process.exit(1);
  }

  // ═══════════════════════════════════════════════════════════════
  // POST VERIFICATION: Wait and confirm posts are actually PUBLISHED
  // ═══════════════════════════════════════════════════════════════
  if (posted && !DRY_RUN && !TEST_DELIVERY_ONLY && postedBrands.length > 0) {
    const VERIFY_DELAY_MS = 7 * 60 * 1000; // 7 minutes
    console.log(`\n[Verify] Waiting ${VERIFY_DELAY_MS / 60000} minutes before verifying post status...`);
    await new Promise(r => setTimeout(r, VERIFY_DELAY_MS));

    console.log(`[Verify] Checking ${postedBrands.length} brand(s)...`);
    let allVerified = true;
    const verificationResults = [];

    for (const brand of postedBrands) {
      try {
        const result = await verifyPostStatus(brand.postId, brand.blogId);
        const statusSummary = result.providers.map(p => `${p.network}=${p.status}`).join(", ");
        console.log(`[Verify] Brand ${brand.label} (post ${brand.postId}): ${statusSummary}`);

        if (result.verified) {
          console.log(`[Verify] ✓ Brand ${brand.label}: ALL PUBLISHED`);
        } else if (result.anyFailed) {
          console.error(`[Verify] ✗ Brand ${brand.label}: FAILED on some providers`);
          allVerified = false;
        } else {
          // Still pending — not necessarily a failure, but flag it
          console.warn(`[Verify] ⚠ Brand ${brand.label}: still pending (not yet PUBLISHED)`);
          allVerified = false;
        }

        verificationResults.push({
          label: brand.label,
          postId: brand.postId,
          verified: result.verified,
          anyFailed: result.anyFailed,
          providers: result.providers,
        });
      } catch (err) {
        console.error(`[Verify] ✗ Brand ${brand.label}: verification error: ${err.message}`);
        allVerified = false;
        verificationResults.push({
          label: brand.label,
          postId: brand.postId,
          verified: false,
          error: err.message,
        });
      }
    }

    // Update the log with verification status
    // Find the MOST RECENT video post for this city (not LinkedIn entries)
    const videoPost = [...log.posts].reverse().find(
      p => p.city === CITY && !p.type
    );
    if (videoPost) {
      videoPost.verification = {
        checkedAt: new Date().toISOString(),
        allVerified,
        results: verificationResults,
      };
      saveLog(log);
    }

    if (!allVerified) {
      console.error("\n" + "!".repeat(60));
      console.error("[Verify] POST VERIFICATION FAILED");
      console.error("[Verify] One or more brands did NOT reach PUBLISHED status.");
      console.error("[Verify] Check Metricool dashboard for details.");
      console.error("!".repeat(60));
      process.exit(1);
    }
    console.log(`[Verify] ✓ All ${postedBrands.length} brand(s) verified PUBLISHED`);
  }

  console.log("\n" + "=".repeat(60));
  console.log("[AutoPoster] Done!");
  console.log("=".repeat(60));
}

/**
 * Live IG match check: download video, hash, compare against current IG posts.
 * Returns { blocked: boolean, videoPath: string | null }
 * 
 * If not blocked, keeps the downloaded file on disk so postVideo can reuse it
 * (eliminates the double-download problem).
 */
async function liveIgMatchCheck(video, igWithHashes, matchCache) {
  // Skip if we already have a cached match that's older than 30 days (already cleared)
  const cached = matchCache[video.id];
  if (cached && cached.length > 0) {
    const postedDate = parsePublishedAt(cached[0].publishedAt);
    const daysSince = (Date.now() - postedDate.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince >= 30) return { blocked: false, videoPath: null }; // Known old match, safe
  }

  // If no IG posts with hashes, can't do live check — allow it
  if (igWithHashes.filter(p => p.thumbHash).length === 0) return { blocked: false, videoPath: null };

  // Download full video for accurate matching (kept on disk for reuse)
  console.log("[LiveCheck] Downloading for IG match verification...");
  const tmpPath = join(tmpdir(), `livecheck_${video.id.slice(0, 8)}_${Date.now()}.mp4`);
  
  const buffer = await downloadVideo(video.id, video.name);
  writeFileSync(tmpPath, buffer);

  const duration = getLocalDuration(tmpPath);
  if (duration <= 0) return { blocked: false, videoPath: tmpPath };

  // Duration pre-filter: use duration when available, but include posts without duration
  // (Metricool doesn't return durationSeconds for ~55% of reels)
  const candidates = igWithHashes.filter(p => {
    if (!p.thumbHash) return false;
    // If IG post has duration, use it as a pre-filter (within 2s)
    if (p.duration) return Math.abs(p.duration - duration) <= 2;
    // If no duration data, include it — hash comparison will discriminate
    return true;
  });

  if (candidates.length === 0) return { blocked: false, videoPath: tmpPath };

  // Get frame hashes
  const driveHashes = await getVideoHashes(tmpPath, duration);
  if (driveHashes.length === 0) return { blocked: false, videoPath: tmpPath };

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

  if (bestMatch && bestDist < BLOCK_THRESHOLD) {
    const postedDate = parsePublishedAt(bestMatch.publishedAt);
    const daysSince = (Date.now() - postedDate.getTime()) / (1000 * 60 * 60 * 24);
    console.log(`[LiveCheck] Hash match: dist=${bestDist}, IG post from ${daysSince.toFixed(0)} days ago`);

    // AI VISION CONFIRMATION for ambiguous zone (dist 10-17)
    // Below AI_CONFIRM_THRESHOLD (< 10) = auto-block (very high confidence)
    // Between 10-17 = ask AI vision to confirm it's truly the same property
    let confirmed = bestDist < AI_CONFIRM_THRESHOLD;
    if (!confirmed && daysSince < 30) {
      console.log(`[LiveCheck] Distance ${bestDist} is in ambiguous zone (10-17). Running AI vision confirmation...`);
      try {
        const framePaths = extractFrames(tmpPath, duration);
        if (framePaths.length > 0 && bestMatch.thumbnailUrl) {
          const visionResult = await aiVisionCompare(framePaths, bestMatch.thumbnailUrl);
          console.log(`[LiveCheck] AI vision says: same_video=${visionResult.isSame}, confidence=${visionResult.confidence}`);
          confirmed = visionResult.isSame && visionResult.confidence >= 0.7;
          // Clean up extracted frames
          framePaths.forEach(fp => { try { unlinkSync(fp); } catch {} });
        } else {
          console.log(`[LiveCheck] Could not extract frames or no thumbnail URL — skipping AI check, allowing video`);
        }
      } catch (err) {
        console.warn(`[LiveCheck] AI vision failed: ${err.message?.slice(0, 100)} — allowing video (fail-open)`);
      }
    }

    if (confirmed && daysSince < 30) {
      // Update cache with this confirmed match
      matchCache[video.id] = [{
        igPostId: bestMatch.reelId,
        publishedAt: bestMatch.publishedAt,
        caption: bestMatch.caption,
        thumbnailUrl: bestMatch.thumbnailUrl || null,
        matchMethod: bestDist < AI_CONFIRM_THRESHOLD ? "perceptual_hash_live" : "perceptual_hash_live+ai_vision",
        confidence: 1 - (bestDist / 64),
        hashDistance: bestDist,
        city: CITY,
      }];
      // Blocked — clean up the file since we won't use it
      console.log(`[LiveCheck] BLOCKED: confirmed same video (dist=${bestDist}, method=${bestDist < AI_CONFIRM_THRESHOLD ? 'hash-only' : 'hash+AI'})`);
      try { unlinkSync(tmpPath); } catch {}
      return { blocked: true, videoPath: null };
    } else if (daysSince < 30 && !confirmed) {
      console.log(`[LiveCheck] AI vision says DIFFERENT property — allowing video despite hash dist=${bestDist}`);
    }

    // If daysSince >= 30 or not confirmed, update cache but don't block
    if (confirmed) {
      matchCache[video.id] = [{
        igPostId: bestMatch.reelId,
        publishedAt: bestMatch.publishedAt,
        caption: bestMatch.caption,
        thumbnailUrl: bestMatch.thumbnailUrl || null,
        matchMethod: "perceptual_hash_live",
        confidence: 1 - (bestDist / 64),
        hashDistance: bestDist,
        city: CITY,
      }];
    }
  }

  return { blocked: false, videoPath: tmpPath };
}

/**
 * Post a single video: voiceover → caption → upload → post → log
 * 
 * Accepts an optional pre-downloaded videoPath from liveIgMatchCheck to avoid
 * downloading the same file twice.
 */
async function postVideo(video, log, igWithHashes, matchCache, existingVideoPath = null) {
  let tempVideoPath;
  let finalVideoPath = null;

  // Reuse the already-downloaded file from liveIgMatchCheck if available
  if (existingVideoPath && existsSync(existingVideoPath)) {
    tempVideoPath = existingVideoPath;
    console.log("[Post] Reusing already-downloaded video from live check");
  } else {
    // Download from Drive (only if not already downloaded)
    console.log("[Post] Downloading from Drive...");
    tempVideoPath = join(tmpdir(), `autoposter_${Date.now()}.mp4`);
    const buffer = await downloadVideo(video.id, video.name);
    writeFileSync(tempVideoPath, buffer);
  }

  try {
    // Extract video overlays FIRST — needed for voiceover script generation (payment tease)
    // Must read from original downloaded video (before any re-encode)
    let videoOverlays = null;
    try {
      const overlayFrames = extractPriceCheckFrames(tempVideoPath);
      if (overlayFrames.length > 0) {
        videoOverlays = await readVideoOverlays(overlayFrames);
        overlayFrames.forEach(fp => { try { unlinkSync(fp); } catch {} });
        if (videoOverlays?.community) {
          console.log(`[Post] Video overlay community: ${videoOverlays.community}`);
        }
        if (videoOverlays?.price) {
          console.log(`[Post] Video overlay price: ${videoOverlays.price}`);
        }
        if (videoOverlays?.city) {
          console.log(`[Post] Video overlay city: ${videoOverlays.city}`);
          // Log mismatch between overlay city and run city
          const { cleanOverlayCity } = await import("./caption.js");
          const overlayClean = cleanOverlayCity(videoOverlays.city);
          const runCityName = { san_antonio: "San Antonio", austin: "Austin", dallas: "Dallas / DFW" }[CITY] || CITY;
          if (overlayClean && overlayClean.toLowerCase() !== runCityName.toLowerCase()) {
            console.log(`[Post] ⚠️ City mismatch: overlay="${overlayClean}" vs run_city="${runCityName}" — using overlay as ground truth`);
          }
        }
      }
    } catch (err) {
      console.warn(`[Post] Overlay extraction failed (non-fatal): ${err.message}`);
    }

    // Voiceover pipeline (now receives videoOverlays for payment-tease script)
    console.log("[Post] Running voiceover detection...");
    const voResult = await processVoiceover(tempVideoPath, CITY, DRY_RUN, videoOverlays);
    finalVideoPath = voResult.videoPath;
    const hasVoiceover = !voResult.skipped;
    // Build voiceover reason for audit trail
    // New reasons: speech_confirmed, whisper_error_failsafe, hallucination_override_add_voiceover,
    // lyrics_override_add_voiceover, music_only_add_voiceover, silent_add_voiceover
    let voiceoverReason = voResult.reason || "added";
    if (voResult.skipped) {
      voiceoverReason = voResult.reason || "speech_confirmed";
    }
    const voiceoverTranscript = voResult.detection?.transcript
      ? voResult.detection.transcript.split(/\s+/).slice(0, 10).join(" ")
      : null;

    // Burned-in captions: only when voiceover was added (not skipped)
    // processBurnedCaptions now returns { videoPath, captions_burned, captions_error }
    let captionsBurned = false;
    let captionsError = null;
    if (hasVoiceover && voResult.audioPath && voResult.script && !DRY_RUN) {
      console.log("[Post] Burning synced captions onto video...");
      const captionResult = await processBurnedCaptions(finalVideoPath, voResult.audioPath, voResult.script);
      captionsBurned = captionResult.captions_burned;
      captionsError = captionResult.captions_error;
      if (captionResult.videoPath !== finalVideoPath) {
        // Clean up the pre-caption merged video
        cleanup(finalVideoPath);
        finalVideoPath = captionResult.videoPath;
      }
      if (captionsBurned) {
        console.log("[Post] ✓ Captions burned onto video");
      } else {
        console.warn(`[Post] Captions NOT burned (non-fatal): ${captionsError}`);
      }
      // Clean up TTS audio file (no longer needed after caption burn)
      cleanup(voResult.audioPath);
    } else if (voResult.audioPath) {
      // Clean up TTS audio if voiceover was added but captions skipped (e.g. dry run)
      cleanup(voResult.audioPath);
    }
    // Pre-post quality check (after voiceover, before upload — may compress oversized files in-place)
    const videoToCheck = existsSync(finalVideoPath) ? finalVideoPath : tempVideoPath;
    const qcResult = await prePostQualityCheck(videoToCheck);
    if (!qcResult.ok) {
      throw new Error(`[QC] FAILED: ${qcResult.reason}`);
    }
    // Freshness pass: light re-encode to make every upload byte-unique
    // Skip if voiceover or compression already re-encoded the video
    const alreadyReEncoded = hasVoiceover || (qcResult.details?.fileSize?.includes('compressed'));
    const freshnessResult = applyFreshness(
      existsSync(finalVideoPath) ? finalVideoPath : tempVideoPath,
      { alreadyReEncoded, dryRun: DRY_RUN }
    );
    if (freshnessResult.applied) {
      console.log(`[Post] Freshness pass applied: trim ${freshnessResult.trimFrames}f, gain ${freshnessResult.gainDb}dB`);
    }
    // Generate caption — ASYMMETRIC CONFIDENCE for reuse
    console.log("[Post] Generating caption...");

    let caption;
    const cachedMatch = matchCache[video.id];
    
    if (cachedMatch && cachedMatch.length > 0 && cachedMatch[0].caption) {
      const matchDist = cachedMatch[0].hashDistance ?? Math.round((1 - (cachedMatch[0].confidence || 0)) * 64);
      const matchCaption = cachedMatch[0].caption;
      const cityMismatch = captionCityMismatch(matchCaption, CITY);

      if (cityMismatch) {
        console.log(`[Post] Matched caption references a DIFFERENT city — generating fresh caption`);
        caption = await generateCaption(CITY, videoOverlays);
      } else if (matchDist < CAPTION_AUTO_REUSE_THRESHOLD) {
        // Distance 0-4: extremely high confidence, auto-reuse
        console.log(`[Post] Very high-confidence match (dist: ${matchDist} < ${CAPTION_AUTO_REUSE_THRESHOLD}) — restructuring original caption`);
        caption = await generateCaptionFromOriginal(matchCaption, CITY);
      } else if (matchDist < CAPTION_REUSE_THRESHOLD) {
        // Distance 5-9: needs AI vision confirmation before reusing caption
        // (wrong caption = publishing another property's details = very bad)
        console.log(`[Post] Near-threshold match (dist: ${matchDist}) — running AI vision before caption reuse...`);
        let visionConfirmed = false;
        try {
          const matchThumb = cachedMatch[0].thumbnailUrl;
          if (matchThumb && existsSync(tempVideoPath)) {
            const vidDuration = getLocalDuration(tempVideoPath);
            const framePaths = await extractFrames(tempVideoPath, vidDuration);
            if (framePaths.length > 0) {
              const visionResult = await aiVisionCompare(framePaths, matchThumb);
              visionConfirmed = visionResult.isSame === true && (visionResult.confidence || 0) >= 0.7;
              console.log(`[Post] AI vision for caption reuse: isSame=${visionResult.isSame}, confidence=${visionResult.confidence}`);
              // Clean up frame files
              for (const fp of framePaths) { try { unlinkSync(fp); } catch {} }
            }
          } else {
            console.log(`[Post] No thumbnail or video for AI vision check — skipping caption reuse`);
          }
        } catch (err) {
          console.warn(`[Post] AI vision check failed: ${err.message} — skipping caption reuse`);
        }
        if (visionConfirmed) {
          console.log(`[Post] AI confirms same property — restructuring original caption`);
          caption = await generateCaptionFromOriginal(matchCaption, CITY);
        } else {
          console.log(`[Post] AI did NOT confirm same property — generating fresh caption (safety)`);
          caption = await generateCaption(CITY, videoOverlays);
        }
      } else {
        // Distance 10+: not confident enough to reuse caption
        console.log(`[Post] Match distance ${matchDist} >= ${CAPTION_REUSE_THRESHOLD} — not confident enough to reuse caption, generating fresh`);
        caption = await generateCaption(CITY, videoOverlays);
      }
    } else {
      console.log("[Post] No original caption found — generating fresh");
      caption = await generateCaption(CITY, videoOverlays);
    }

    // Log full caption in DRY_RUN mode for testing/approval
    if (caption && DRY_RUN) {
      console.log("[DRY_RUN] ═══════ GENERATED CAPTION ═══════");
      console.log(caption);
      console.log("[DRY_RUN] ═══════ END CAPTION ═══════");
      console.log(`[DRY_RUN] Caption length: ${caption.length} chars`);
      console.log(`[DRY_RUN] Community KB used: ${videoOverlays?.community || 'NONE (no match)'}`);
    }

    // Price-consistency check: verify caption price against video overlay text
    // Video text is ground truth — original IG captions go stale when builders change prices
    if (caption && !DRY_RUN) {
      try {
        const priceResult = await runPriceConsistencyCheck(tempVideoPath, caption, null, videoOverlays);
        if (priceResult.corrected) {
          console.log(`[Post] ⚠️ Price corrected: ${priceResult.log}`);
          caption = priceResult.caption;
        }
      } catch (err) {
        console.warn(`[Post] Price check failed (non-fatal): ${err.message}`);
      }
    }

    // Upload to Metricool (compress once, reuse across all brands)
    console.log("[Post] Uploading to Metricool...");
    const videoToUpload = existsSync(finalVideoPath) ? finalVideoPath : tempVideoPath;

    let mediaUrl;
    let prefetched = null;
    if (DRY_RUN || TEST_DELIVERY_ONLY) {
      mediaUrl = "https://test-delivery-placeholder.example.com/video.mp4";
      console.log(`[Post] ${TEST_DELIVERY_ONLY ? "TEST_DELIVERY_ONLY" : "DRY RUN"} — skipping Metricool upload`);
    } else {
      const uploadBuffer = readFileSync(videoToUpload);
      const uploadResult = await uploadVideoToMetricool(uploadBuffer, video.name);
      mediaUrl = uploadResult.hostedUrl;
      prefetched = uploadResult.prefetched;
    }

    // BELT-AND-SUSPENDERS: Re-check the LIVE remote posted-log before posting.
    // This catches races where another workflow run posted after our checkout.
    if (!DRY_RUN && !TEST_DELIVERY_ONLY) {
      const remotePostConflict = await checkRemoteLog(CITY);
      if (remotePostConflict) {
        console.log(`[Post] ABORT — remote posted-log shows ${CITY} was already posted in the last 20h (race detected). Exiting cleanly.`);
        process.exit(0);
      }
    }

    // Post to ALL brands (multi-IG fan-out)
    // Manual-assist: skip Instagram on main brand — owner posts natively for FB crosspost + merged views
    let result = { brands: [], platforms: "skipped (TEST_DELIVERY_ONLY)" };
    if (TEST_DELIVERY_ONLY) {
      console.log("[Post] TEST_DELIVERY_ONLY — skipping createPost (no social posts will be made)");
    } else {
      console.log("[Post] Creating post on all brands (main IG withheld for manual post)...");
      result = await createPost(mediaUrl, caption, { dryRun: DRY_RUN, prefetched, mainBrandSkipIG: true });
    }

    // MANUAL-ASSIST DELIVERY: upload finished video to Drive and notify owner
    // NO auto-publish fallback — main IG is NEVER posted via Metricool (owner posts natively)
    // Delivery is bulletproof: 3x retries + email backup + manifest fallback
    let deliveryResult = null;
    if (!DRY_RUN) {
      try {
        const driveToken = await getAccessToken();
        deliveryResult = await deliverToOwner(driveToken, videoToUpload, CITY, caption);
        console.log(`[Delivery] ✓ Delivered successfully`);
      } catch (err) {
        // deliverToOwner already retries 3x internally and sends email backup.
        // If we're here, BOTH channels failed — workflow exits red.
        console.error(`[Delivery] CRITICAL FAILURE — all channels exhausted: ${err.message}`);
        console.error(`[Delivery] Video is preserved in Drive "Ready to Post" folder (manifest written).`);
        console.error(`[Delivery] Main IG will NOT be auto-published — owner must post natively.`);
        // Exit with non-zero so GitHub Actions shows red X (owner gets email alert from GitHub)
        process.exitCode = 1;
      }
    }

    // Record in log (skip in dry-run mode and TEST_DELIVERY_ONLY mode)
    if (!DRY_RUN && !TEST_DELIVERY_ONLY) {
      const brandSummary = result.brands
        ? result.brands.filter(b => b.ok).map(b => b.label).join(", ")
        : "unknown";
      // Compute spoken_city for audit trail
      const { cleanOverlayCity: _cleanCity } = await import("./caption.js");
      const _spokenCity = _cleanCity(videoOverlays?.city) || ({ san_antonio: "San Antonio", austin: "Austin", dallas: "Dallas / DFW" }[CITY] || CITY);
      recordPost(log, {
        driveFileId: video.id,
        fileName: video.name,
        city: CITY,
        spoken_city: _spokenCity,
        caption,
        voiceover: hasVoiceover,
        voiceover_reason: voiceoverReason,
        voiceover_transcript: voiceoverTranscript,
        captions_burned: captionsBurned,
        captions_error: captionsError,
        freshness: freshnessResult.applied ? "re_encoded" : freshnessResult.reason,
        platforms: ["tiktok", "youtube", "satellite_ig"],
        mainIgDelivery: deliveryResult ? "delivered" : "delivery_failed_owner_must_post",
        deliveryDriveLink: deliveryResult?.driveLink || null,
        brands: brandSummary,
        success: true,
      });
    } else if (TEST_DELIVERY_ONLY) {
      console.log("[Post] TEST_DELIVERY_ONLY — skipping posted-log entry (this is a test, not a real post)");
    } else {
      console.log("[Post] DRY RUN — skipping log entry");
    }
    console.log(`[Post] ✓ Successfully posted ${video.name}`);
    if (result.platforms) console.log(`[Post] ✓ Brands: ${result.platforms}`);
    if (hasVoiceover) console.log("[Post] ✓ Voiceover added");
    console.log(`[Post] ✓ Caption (${caption.length} chars): ${caption.slice(0, 100)}...`);
    // Return post IDs for verification
    return result;
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
