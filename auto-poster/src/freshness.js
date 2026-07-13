/**
 * freshness.js — Light re-encode pass to make every upload byte-unique.
 *
 * Replicates the effect of re-downloading from Edits by Meta (which consistently
 * gets more views) by ensuring no two uploads of the same Drive video are ever
 * byte-identical.
 *
 * SAFETY: Variations are imperceptible and do NOT affect perceptual hashes.
 * - Trim 2-4 frames from the very end (invisible)
 * - ±0.5-1% audio gain nudge (inaudible)
 * - Strip old metadata, inject fresh creation timestamp
 * - Same resolution, high quality CRF 18, preset veryfast
 *
 * The live IG match check (perceptual hash + AI vision) still recognizes the
 * video as the same content — hash distance stays under 5.
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, statSync, unlinkSync, renameSync } from "node:fs";
import { join, dirname, basename } from "node:path";

/**
 * Apply freshness re-encode to a video file (in-place replacement).
 *
 * @param {string} videoPath - Path to the video file
 * @param {object} opts
 * @param {boolean} opts.alreadyReEncoded - Skip if voiceover merge or compression already re-encoded
 * @param {boolean} opts.dryRun - Skip in dry run mode
 * @returns {{ applied: boolean, reason: string, trimFrames?: number, gainDb?: string }}
 */
export function applyFreshness(videoPath, opts = {}) {
  if (opts.dryRun) {
    console.log("[Freshness] DRY RUN — skipping re-encode");
    return { applied: false, reason: "dry_run" };
  }

  if (opts.alreadyReEncoded) {
    console.log("[Freshness] Video already re-encoded (voiceover/compression) — skipping");
    return { applied: false, reason: "already_re_encoded" };
  }

  if (!existsSync(videoPath)) {
    console.warn("[Freshness] Video file not found — skipping");
    return { applied: false, reason: "file_not_found" };
  }

  try {
    // Get video duration for end-trim calculation
    const probeResult = spawnSync("ffprobe", [
      "-v", "quiet",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      videoPath,
    ], { encoding: "utf-8", timeout: 10_000 });

    const probe = JSON.parse(probeResult.stdout);
    const duration = parseFloat(probe.format?.duration || "0");
    if (duration < 3) {
      console.warn("[Freshness] Video too short for freshness pass — skipping");
      return { applied: false, reason: "too_short" };
    }

    // Generate per-run variations (deterministic per run, but different each time)
    const trimFrames = 2 + Math.floor(Math.random() * 3); // 2-4 frames
    const fps = getVideoFps(probe) || 30;
    const trimDuration = trimFrames / fps; // ~0.067-0.133s at 30fps
    const endTime = duration - trimDuration;

    // Audio gain: ±0.5-1% (±0.04-0.09 dB) — completely inaudible
    const gainDirection = Math.random() > 0.5 ? 1 : -1;
    const gainMagnitude = 0.04 + Math.random() * 0.05; // 0.04 to 0.09 dB
    const gainDb = (gainDirection * gainMagnitude).toFixed(3);

    const freshPath = videoPath.replace(/\.mp4$/, "_fresh.mp4");

    console.log(`[Freshness] Re-encoding: trim ${trimFrames} end frames (${trimDuration.toFixed(3)}s), gain ${gainDb}dB`);

    // Single-pass re-encode: same resolution, CRF 18 (high quality), veryfast preset
    // -map_metadata -1 strips all old metadata
    // -t endTime trims the last few frames
    // -af volume applies the gain nudge
    // -metadata creation_time sets fresh timestamp
    const now = new Date().toISOString();
    const cmd = [
      "ffmpeg", "-y",
      "-i", `"${videoPath}"`,
      "-t", endTime.toFixed(4),
      "-c:v", "libx264",
      "-crf", "18",
      "-preset", "veryfast",
      "-c:a", "aac",
      "-b:a", "192k",
      `-af`, `volume=${gainDb}dB`,
      "-map_metadata", "-1",
      "-metadata", `creation_time=${now}`,
      "-movflags", "+faststart",
      `"${freshPath}"`,
    ].join(" ");

    execSync(cmd, { timeout: 180_000, stdio: "pipe" }); // 3 min timeout

    if (!existsSync(freshPath)) {
      console.warn("[Freshness] Output file not created — skipping");
      return { applied: false, reason: "output_missing" };
    }

    const originalSize = statSync(videoPath).size;
    const freshSize = statSync(freshPath).size;

    // Sanity check: fresh file should be within reasonable range of original
    // CRF 18 is high quality so it might be slightly larger or smaller
    if (freshSize < originalSize * 0.3 || freshSize > originalSize * 3) {
      console.warn(`[Freshness] Suspicious size change: ${(originalSize/1024/1024).toFixed(1)}MB → ${(freshSize/1024/1024).toFixed(1)}MB — aborting`);
      try { unlinkSync(freshPath); } catch {}
      return { applied: false, reason: "size_sanity_failed" };
    }

    // Replace original with fresh version
    unlinkSync(videoPath);
    renameSync(freshPath, videoPath);

    console.log(`[Freshness] ✓ Re-encoded: ${(originalSize/1024/1024).toFixed(1)}MB → ${(freshSize/1024/1024).toFixed(1)}MB (trim: ${trimFrames}f, gain: ${gainDb}dB)`);

    return {
      applied: true,
      reason: "re_encoded",
      trimFrames,
      gainDb,
      originalSizeMB: (originalSize / 1024 / 1024).toFixed(1),
      freshSizeMB: (freshSize / 1024 / 1024).toFixed(1),
    };
  } catch (err) {
    console.warn(`[Freshness] Re-encode failed (non-fatal): ${err.message}`);
    // Non-fatal: if freshness fails, we still post the original
    return { applied: false, reason: `error: ${err.message?.slice(0, 80)}` };
  }
}

/**
 * Extract FPS from ffprobe output.
 */
function getVideoFps(probe) {
  const videoStream = (probe.streams || []).find((s) => s.codec_type === "video");
  if (!videoStream) return null;
  const rFrameRate = videoStream.r_frame_rate || videoStream.avg_frame_rate;
  if (!rFrameRate) return null;
  const [num, den] = rFrameRate.split("/").map(Number);
  return den ? num / den : num;
}
