/**
 * Drive Pre-processing — Morning Job
 *
 * After picks are generated and auto-confirmed, this module:
 * 1. Syncs the Drive index (so new videos are discoverable)
 * 2. For each confirmed pick that doesn't yet have a driveVideoUrl:
 *    a. Finds the matching Drive original via AI vision
 *    b. Downloads the original from Drive (via gws CLI)
 *    c. Applies the videoVariant fingerprint change
 *    d. Uploads the variant to S3 storage
 *    e. Stores the signed URL on the pick row
 *
 * This ensures the 2/3/4 PM publish step is instant (just grabs the URL).
 *
 * If a match is not found for a pick, that pick is FAILED (no fallback to IG copy).
 * The pick stays confirmed but without a driveVideoUrl — publishNow will REJECT
 * it with a 422 error. Instagram copies are NEVER used as a video source.
 */

import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { syncDriveIndex } from "./driveIndex";
import { findDriveMatch } from "./driveMatcher";
import { makeDifferentiatedVariant } from "./videoVariant";
import * as db from "./db";
import { getCdtPickDate } from "./selection";
import { storageGetSignedUrl } from "./storage";
import { getDriveToken as getTokenFromAuth } from "./driveAuth";

const TMP_DIR = "/tmp/drive-downloads";

/**
 * Get the Google Drive OAuth token.
 * Uses the auto-refreshing OAuth2 flow from driveAuth.ts.
 */
async function getDriveToken(): Promise<string> {
  return getTokenFromAuth();
}

/**
 * Download a file from Google Drive by its file ID.
 * Uses gws CLI (which has a fresh OAuth token) as primary method.
 * Falls back to REST API with GOOGLE_DRIVE_TOKEN if gws is unavailable.
 * Returns the local file path, or null on failure.
 */
async function downloadDriveFile(fileId: string, fileName: string): Promise<string | null> {
  try {
    if (!existsSync(TMP_DIR)) {
      mkdirSync(TMP_DIR, { recursive: true });
    }

    const localPath = join(TMP_DIR, `${fileId}_${Date.now()}.mp4`);

    // Try gws CLI first (has fresh OAuth token)
    try {
      const gswOutputDir = join(TMP_DIR, `gws-${Date.now()}`);
      mkdirSync(gswOutputDir, { recursive: true });
      const outputFile = join(gswOutputDir, 'video.mp4');
      // Use the gws wrapper at its known path. gws requires --output to be
      // relative to cwd, so we cd into the output dir first.
      const gwsBin = '/home/ubuntu/.local/share/pnpm/bin/gws';
      const paramsJson = JSON.stringify({ fileId, alt: 'media' });
      const cmd = `${gwsBin} drive files get --params '${paramsJson}' --output video.mp4`;
      execSync(cmd, {
        timeout: 120000,
        stdio: 'pipe',
        cwd: gswOutputDir,
        env: { ...process.env, HOME: '/home/ubuntu' },
      });

      if (existsSync(outputFile)) {
        const stats = require('fs').statSync(outputFile);
        if (stats.size > 1024) {
          // Move to our standard path
          require('fs').renameSync(outputFile, localPath);
          console.log(`[DrivePreprocess] Downloaded via gws: ${fileName} (${(stats.size / 1024 / 1024).toFixed(1)} MB)`);
          // Cleanup temp dir
          try { require('fs').rmdirSync(gswOutputDir); } catch {}
          return localPath;
        }
      }
      console.warn(`[DrivePreprocess] gws download produced no/small file, trying REST API fallback`);
    } catch (gswErr: any) {
      const stderr = gswErr?.stderr?.toString?.()?.slice(0, 500) || '';
      const stdout = gswErr?.stdout?.toString?.()?.slice(0, 500) || '';
      console.warn(`[DrivePreprocess] gws CLI failed, trying REST API fallback:`, (gswErr as Error).message?.slice(0, 200));
      if (stderr) console.warn(`[DrivePreprocess] gws stderr:`, stderr);
      if (stdout) console.warn(`[DrivePreprocess] gws stdout:`, stdout);
    }

    // Fallback: REST API with auto-refreshing OAuth2 token
    const token = await getDriveToken();
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[DrivePreprocess] Drive download error (${res.status}): ${errText.slice(0, 300)}`);
      return null;
    }

    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    if (buffer.length < 1024) {
      console.error(`[DrivePreprocess] Downloaded file too small (${buffer.length} bytes): ${fileName}`);
      return null;
    }

    writeFileSync(localPath, buffer);
    console.log(`[DrivePreprocess] Downloaded ${fileName} (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
    return localPath;
  } catch (err) {
    console.error(`[DrivePreprocess] Failed to download ${fileName}:`, err);
    return null;
  }
}

/**
 * Clean up a temporary file (best-effort).
 */
function cleanup(path: string) {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch { /* ignore */ }
}

export interface PreprocessResult {
  pickId: number;
  city: string;
  matched: boolean;
  driveFileId?: string;
  fileName?: string;
  confidence?: string;
  uploaded?: boolean;
  error?: string;
}

/**
 * Pre-process a single pick: match → download → variant → upload.
 * Reads from ig_reels table via the reel's igMediaId (stored as postId on the pick).
 */
async function preprocessPick(pick: {
  id: number;
  city: string;
  postId: string;
  refreshedCaption: string | null;
}): Promise<PreprocessResult> {
  // Look up the IG reel by its igMediaId (stored as postId on the pick)
  const reel = await db.getReelByIgMediaId(pick.postId);
  if (!reel) {
    return { pickId: pick.id, city: pick.city, matched: false, error: "reel not found in ig_reels" };
  }

  // Step 1: Find the matching Drive original using AI vision
  // thumbnailStorageKey is a storage key — generate a signed URL for the AI vision model
  let thumbnailUrl = "";
  if (reel.thumbnailStorageKey) {
    try {
      thumbnailUrl = await storageGetSignedUrl(reel.thumbnailStorageKey);
    } catch {
      // If we can't get a signed URL, try using the key as a relative path
      thumbnailUrl = `/manus-storage/${reel.thumbnailStorageKey}`;
    }
  }

  const match = await findDriveMatch({
    igThumbnailUrl: thumbnailUrl,
    igCaption: reel.caption,
    igDurationMs: null, // ig_reels table doesn't store duration; rely on AI vision
  });

  if (!match) {
    return { pickId: pick.id, city: pick.city, matched: false, error: "no Drive match found" };
  }

  console.log(`[DrivePreprocess] Pick ${pick.id} (${pick.city}) matched to Drive file: ${match.fileName} (${match.confidence})`);

  // Step 2: Download the original from Drive
  const localPath = await downloadDriveFile(match.matchedFileId, match.fileName);
  if (!localPath) {
    return {
      pickId: pick.id,
      city: pick.city,
      matched: true,
      driveFileId: match.matchedFileId,
      fileName: match.fileName,
      confidence: match.confidence,
      uploaded: false,
      error: "download failed",
    };
  }

  try {
    // Step 3: Read the file and apply variant (fingerprint change)
    const sourceBytes = readFileSync(localPath);

    // Step 4: Upload the variant to S3 via makeDifferentiatedVariant
    // We pass sourceBytes directly so it doesn't re-download
    const variant = await makeDifferentiatedVariant({
      sourceUrl: "unused-when-sourceBytes-provided",
      postId: pick.postId,
      salt: `drive-${match.matchedFileId.slice(0, 12)}`,
      sourceBytes: sourceBytes as unknown as Buffer,
    });

    if (!variant.ok || !variant.storageKey) {
      return {
        pickId: pick.id,
        city: pick.city,
        matched: true,
        driveFileId: match.matchedFileId,
        fileName: match.fileName,
        confidence: match.confidence,
        uploaded: false,
        error: `variant upload failed: ${variant.error}`,
      };
    }

    // Step 5: Store the S3 storage KEY (not signed URL) on the pick row.
    // At publish time, publishNow generates a fresh signed URL from this key.
    await db.updateDailyPick(pick.id, {
      driveVideoUrl: variant.storageKey!,
      driveMatchConfidence: match.confidence,
    });

    console.log(`[DrivePreprocess] Pick ${pick.id} (${pick.city}) → Drive original uploaded. URL stored.`);
    return {
      pickId: pick.id,
      city: pick.city,
      matched: true,
      driveFileId: match.matchedFileId,
      fileName: match.fileName,
      confidence: match.confidence,
      uploaded: true,
    };
  } finally {
    cleanup(localPath);
  }
}

/**
 * Run the full Drive pre-processing pipeline for today's picks.
 * Called by the morning generation job AFTER picks are generated and confirmed.
 *
 * 4K-ONLY POLICY: If a pick's Drive original can't be matched or downloaded,
 * we swap it for the next best eligible reel (respecting 30-day rule) and retry.
 * We keep trying until we find one with a successful Drive download.
 * There are 400+ videos in Drive, so there's always a match available.
 *
 * Returns a summary of results per pick.
 */
/**
 * Pre-process a SINGLE pick without any swap/retry logic.
 * Used by publishNow's Drive retry — at publish time we NEVER swap the pick
 * to a different reel. Either we find the Drive original for THIS reel or we fail.
 */
export async function preprocessSinglePick(pick: {
  id: number;
  city: string;
  postId: string;
  refreshedCaption: string | null;
}): Promise<PreprocessResult> {
  // Sync Drive index first (in case new files were added)
  try {
    await syncDriveIndex();
  } catch (err) {
    console.error("[DrivePreprocess] Drive index sync failed during single-pick retry:", err);
  }
  // Try to preprocess just this one pick — no swapping
  return preprocessPick(pick);
}

export async function preprocessDriveOriginals(): Promise<{
  ok: boolean;
  indexSynced: number;
  results: PreprocessResult[];
}> {
  // Step 0: Sync the Drive index (discover new files)
  let indexSynced = 0;
  try {
    const syncResult = await syncDriveIndex();
    indexSynced = syncResult.synced;
  } catch (err) {
    console.error("[DrivePreprocess] Drive index sync failed:", err);
    // Continue anyway — we might have stale-but-usable index data
  }

  // Step 1: Get today's confirmed picks that don't yet have a driveVideoUrl
  const pickDate = getCdtPickDate();
  const picks = await db.getDailyPicks(pickDate);
  const needsProcessing = picks.filter(
    p => p.status === "confirmed" && !p.driveVideoUrl
  );

  if (needsProcessing.length === 0) {
    console.log("[DrivePreprocess] All picks already have Drive URLs or none are confirmed");
    return { ok: true, indexSynced, results: [] };
  }

  // Step 2: Process each pick, retrying with alternate reels if Drive fails
  const results: PreprocessResult[] = [];
  for (const pick of needsProcessing) {
    const result = await preprocessPickWithRetry(pick, pickDate, picks);
    results.push(result);
  }

  const successCount = results.filter(r => r.uploaded).length;
  console.log(`[DrivePreprocess] Completed: ${successCount}/${results.length} picks got Drive originals`);

  return { ok: true, indexSynced, results };
}

/**
 * Try to preprocess a pick. If the Drive match/download fails, swap the pick
 * to the next best eligible reel for that city and retry (up to MAX_RETRIES).
 */
async function preprocessPickWithRetry(
  pick: { id: number; city: string; postId: string; refreshedCaption: string | null },
  pickDate: string,
  allPicks: Awaited<ReturnType<typeof db.getDailyPicks>>
): Promise<PreprocessResult> {
  const MAX_RETRIES = 10;
  const triedPostIds = new Set<string>();
  // Collect all postIds already chosen today (to avoid double-picking)
  const todayPostIds = new Set(allPicks.map(p => p.postId));

  let currentPick = pick;
  triedPostIds.add(currentPick.postId);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await preprocessPick(currentPick);
      if (result.uploaded) {
        return result;
      }
      // Drive match/download failed for this reel
      console.warn(
        `[DrivePreprocess] Attempt ${attempt + 1}/${MAX_RETRIES + 1} failed for pick ${currentPick.id} (${currentPick.city}): ${result.error}`
      );
    } catch (err) {
      const e = err as Error;
      console.warn(
        `[DrivePreprocess] Attempt ${attempt + 1}/${MAX_RETRIES + 1} threw for pick ${currentPick.id} (${currentPick.city}): ${e.message}`
      );
    }

    // If we've exhausted retries, stop
    if (attempt >= MAX_RETRIES) break;

    // Find the next best eligible reel for this city
    const { selectReelForCity } = await import("./selection");
    const { getLastPostByIgMediaId, getReelsByCity, updateDailyPick } = await import("./db");
    const { refreshCaption } = await import("./captionRefresh");
    const { optimizeHook } = await import("./hookOptimizer");

    const cityReels = await getReelsByCity(currentPick.city as "austin" | "san_antonio" | "dallas");
    const lastPostMap = await getLastPostByIgMediaId();
    const excludeIds = new Set([...Array.from(todayPostIds), ...Array.from(triedPostIds)]);

    const nextPick = selectReelForCity(cityReels, lastPostMap, excludeIds);
    if (!nextPick) {
      console.warn(`[DrivePreprocess] No more eligible reels for ${currentPick.city} after ${attempt + 1} attempts`);
      break;
    }

    triedPostIds.add(nextPick.reel.igMediaId);
    todayPostIds.add(nextPick.reel.igMediaId);

    // Generate refreshed caption for the new reel
    const refreshed = await refreshCaption(nextPick.reel.caption ?? "");
    const optimized = await optimizeHook(refreshed);

    // Update the pick in the database to point to the new reel
    await updateDailyPick(currentPick.id, {
      videoId: nextPick.reel.id,
      postId: nextPick.reel.igMediaId,
      refreshedCaption: optimized.caption,
      selectionMode: nextPick.mode,
    });

    // Also sync the associated repost row so it matches the new postId
    const { syncRepostForPick } = await import("./db");
    await syncRepostForPick(currentPick.id, nextPick.reel.igMediaId);

    console.log(
      `[DrivePreprocess] Swapped pick ${currentPick.id} (${currentPick.city}) to reel ${nextPick.reel.igMediaId} (attempt ${attempt + 2})`
    );

    currentPick = {
      ...currentPick,
      postId: nextPick.reel.igMediaId,
      refreshedCaption: optimized.caption,
    };
  }

  return {
    pickId: currentPick.id,
    city: currentPick.city,
    matched: false,
    error: `All ${MAX_RETRIES + 1} attempts failed to get a Drive original`,
  };
}
