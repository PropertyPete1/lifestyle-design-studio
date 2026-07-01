/**
 * Light per-repost video differentiation.
 *
 * Instagram fingerprints video files. Re-uploading a byte-identical .mp4 that
 * already exists on the account is detected as duplicate content and its reach
 * is floored to (roughly) followers-only. Manually reposting worked in the past
 * partly because small edits/re-encodes produced a NON-identical file.
 *
 * This module downloads the source reel and applies a light, visually-negligible
 * ffmpeg transform (tiny center zoom/crop, full metadata strip, re-encode) so the
 * resulting file has a different fingerprint while looking the
 * same to a human viewer. The differentiated file is uploaded to storage and its
 * public URL is handed to Metricool instead of the raw source URL.
 *
 * If anything fails (download, ffmpeg, upload) the caller can fall back to the
 * original URL rather than blocking the post — differentiation is an
 * enhancement, not a hard requirement for publishing.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storageGetSignedUrl, storagePut } from "./storage";

export interface VariantResult {
  ok: boolean;
  /** Public URL of the differentiated video (when ok). */
  url?: string;
  error?: string;
}

/** Run ffmpeg with the given args, resolving on exit code 0. */
function runFfmpeg(args: string[], timeoutMs = 120_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("ffmpeg timed out"));
    }, timeoutMs);
    proc.stderr.on("data", d => {
      stderr += d.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    proc.on("error", err => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
    });
  });
}

/**
 * Build the ffmpeg filter for a light, human-imperceptible differentiation.
 * A ~2% center zoom (scale up then crop back to original WxH) changes every
 * frame's pixels enough to defeat exact-file fingerprinting while keeping the
 * composition intact. We do NOT crop the edges aggressively to preserve any
 * on-screen text / the Lifestyle Design Realty watermark.
 */
function buildVideoFilter(zoom = 1.02): string {
  // scale up by `zoom`, then crop back to the original dimensions (centered).
  return `scale=iw*${zoom}:ih*${zoom},crop=iw/${zoom}:ih/${zoom}`;
}

/**
 * Download a source video URL to disk.
 */
async function downloadTo(url: string, path: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1024) throw new Error("downloaded file too small");
  await writeFile(path, buf);
}

export interface MakeVariantOptions {
  /** Public URL of the source .mp4 */
  sourceUrl: string;
  /** Instagram postId, used only to name the output key. */
  postId: string;
  /** Center-zoom factor (default 1.02 = 2%). */
  zoom?: number;
}

/**
 * Produce a lightly-differentiated variant of the source video and upload it.
 * Returns the public URL of the new file, or an error (caller falls back).
 */
export async function makeDifferentiatedVariant(
  opts: MakeVariantOptions
): Promise<VariantResult> {
  const { sourceUrl, postId, zoom = 1.02 } = opts;
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), "reel-variant-"));
    const inPath = join(dir, "in.mp4");
    const outPath = join(dir, "out.mp4");

    await downloadTo(sourceUrl, inPath);

    const args = [
      "-y",
      "-i",
      inPath,
      "-vf",
      buildVideoFilter(zoom),
      // Re-encode video + audio so the container/stream bytes differ from source.
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      // Strip ALL metadata (source fingerprint hints, original encoder tags, etc.)
      "-map_metadata",
      "-1",
      "-movflags",
      "+faststart",
    ];
    args.push(outPath);

    await runFfmpeg(args);

    const outBuf = await readFile(outPath);
    if (outBuf.length < 1024) throw new Error("ffmpeg produced empty output");

    const stamp = Date.now();
    const { key } = await storagePut(
      `reel-variants/${postId}_${stamp}.mp4`,
      outBuf,
      "video/mp4"
    );
    // Metricool must fetch the media from a public absolute URL. The signed S3
    // GET URL is directly reachable (the /manus-storage proxy is relative to the
    // app and not guaranteed to be resolvable by Metricool's fetchers).
    const url = await storageGetSignedUrl(key);
    return { ok: true, url };
  } catch (err) {
    const e = err as Error;
    return { ok: false, error: e.message };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
