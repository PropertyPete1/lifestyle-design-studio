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
 * If a match is not found for a pick, that pick is skipped (no fallback to IG copy).
 * The pick stays confirmed but without a driveVideoUrl — publishNow will skip it.
 */

import { execSync } from "child_process";
import { existsSync, readFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { syncDriveIndex } from "./driveIndex";
import { findDriveMatch } from "./driveMatcher";
import { makeDifferentiatedVariant } from "./videoVariant";
import * as db from "./db";
import { getCdtPickDate } from "./selection";

const TMP_DIR = "/tmp/drive-downloads";

/**
 * Download a file from Google Drive by its file ID using gws CLI.
 * Returns the local file path, or null on failure.
 */
async function downloadDriveFile(fileId: string, fileName: string): Promise<string | null> {
  try {
    if (!existsSync(TMP_DIR)) {
      mkdirSync(TMP_DIR, { recursive: true });
    }

    const localPath = join(TMP_DIR, `${fileId}_${Date.now()}.mp4`);

    // Use gws drive files get with alt=media to download the file content
    execSync(
      `gws drive files get --params '{"fileId": "${fileId}", "alt": "media"}' -o '${localPath}'`,
      { timeout: 120_000, stdio: "pipe" }
    );

    if (!existsSync(localPath)) {
      console.error(`[DrivePreprocess] Download produced no file: ${fileName}`);
      return null;
    }

    const stat = require("fs").statSync(localPath);
    if (stat.size < 1024) {
      console.error(`[DrivePreprocess] Downloaded file too small (${stat.size} bytes): ${fileName}`);
      unlinkSync(localPath);
      return null;
    }

    console.log(`[DrivePreprocess] Downloaded ${fileName} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
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
 */
async function preprocessPick(pick: {
  id: number;
  city: string;
  videoId: number;
  postId: string;
  refreshedCaption: string | null;
}): Promise<PreprocessResult> {
  const video = await db.getVideoById(pick.videoId);
  if (!video) {
    return { pickId: pick.id, city: pick.city, matched: false, error: "video not found in library" };
  }

  // Step 1: Find the matching Drive original
  const match = await findDriveMatch({
    igThumbnailUrl: video.thumbnailUrl ?? "",
    igCaption: video.caption,
    igDurationMs: null, // We don't store IG reel duration in our videos table; rely on vision
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
 * Returns a summary of results per pick.
 */
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

  // Step 2: Process each pick sequentially (to avoid overwhelming Drive API)
  const results: PreprocessResult[] = [];
  for (const pick of needsProcessing) {
    try {
      const result = await preprocessPick({
        id: pick.id,
        city: pick.city,
        videoId: pick.videoId,
        postId: pick.postId,
        refreshedCaption: pick.refreshedCaption ?? null,
      });
      results.push(result);
    } catch (err) {
      const e = err as Error;
      results.push({
        pickId: pick.id,
        city: pick.city,
        matched: false,
        error: `unexpected error: ${e.message}`,
      });
    }
  }

  const successCount = results.filter(r => r.uploaded).length;
  console.log(`[DrivePreprocess] Completed: ${successCount}/${results.length} picks got Drive originals`);

  return { ok: true, indexSynced, results };
}
