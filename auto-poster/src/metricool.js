/**
 * Metricool API — check IG posts, upload media, post to all platforms
 * 
 * Upload flow (validated live in production):
 *  1. PUT  /v2/media/s3/upload-transactions?blogId=...&userId=...  with parts[].hash = base64(sha256)
 *  2. PUT  <presignedUrl>  with header x-amz-checksum-sha256 = base64(sha256)
 *  3. PATCH /v2/media/s3/upload-transactions?blogId=...&userId=...  { simple: { fileUrl } }
 *  -> returns convertedFileUrl on the static.metricool.com CDN.
 *
 * CRITICAL: the transaction part `hash` MUST be the base64-encoded SHA-256 of the bytes.
 * Metricool signs the S3 presigned URL with that exact value; any other value yields 403.
 */

import { createHash } from "crypto";
import { execSync } from "child_process";
import { writeFileSync as fsWriteSync, readFileSync as fsReadSync, unlinkSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const BASE = "https://app.metricool.com/api";
const MAX_UPLOAD_BYTES = 95 * 1024 * 1024; // 95MB safety margin (Metricool limit is 100MB)

function authParams() {
  return `blogId=${process.env.METRICOOL_BLOG_ID}&userId=${process.env.METRICOOL_USER_ID}`;
}

function authHeaders() {
  return {
    "Content-Type": "application/json",
    "X-Mc-Auth": process.env.METRICOOL_API_TOKEN,
  };
}

function fmtDate(d) {
  return d.toISOString().slice(0, 19);
}

/**
 * Fetch Instagram reels from the last 30 days via Metricool analytics.
 * Returns array of { reelId, caption, publishedAt }.
 */
export async function getRecentIgPosts(days = 30) {
  const to = new Date();
  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const url =
    `${BASE}/v2/analytics/reels/instagram?from=${fmtDate(from)}&to=${fmtDate(to)}` +
    `&${authParams()}&timezone=America/Chicago`;

  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    console.warn(`[Metricool] getRecentIgPosts failed (${res.status})`);
    return [];
  }

  const json = await res.json();
  const data = json.data || [];

  const posts = data.map(reel => ({
    reelId: String(reel.reelId || ""),
    caption: String(reel.content || ""),
    publishedAt: reel.publishedAt,
    duration: reel.durationSeconds || 0,
    thumbnailUrl: reel.imageUrl || null,
    url: reel.url || null,
  }));

  console.log(`[Metricool] Found ${posts.length} IG posts in last ${days} days`);
  return posts;
}

/**
 * Upload a video buffer to Metricool's media library (S3 presigned flow).
 * Returns the hosted CDN URL.
 * 
 * Uses PUT method for creating transaction (NOT POST).
 * Auth is passed as query params, not in the body.
 */
export async function uploadVideoToMetricool(videoBuffer, fileName) {
  // Compress if over 95MB (Metricool has 100MB per-part limit)
  let buf = videoBuffer;
  if (buf.length > MAX_UPLOAD_BYTES) {
    console.log(`[Metricool] Video is ${(buf.length / 1024 / 1024).toFixed(1)} MB — compressing to fit 100MB limit (keeping 4K)...`);
    const compressed = compressVideoToFit(buf, MAX_UPLOAD_BYTES);
    if (compressed) {
      buf = compressed.buffer;
      console.log(`[Metricool] Compressed to ${compressed.fileSizeMb} MB (CRF ${compressed.crfValue})`);
    } else {
      console.warn(`[Metricool] Compression failed — attempting upload with original size`);
    }
  }

  const sha256b64 = createHash("sha256").update(buf).digest("base64");
  const size = buf.length;

  console.log(`[Metricool] Uploading ${(size / 1024 / 1024).toFixed(1)} MB...`);

  // Step 1: Create upload transaction (PUT, not POST)
  const txRes = await fetch(`${BASE}/v2/media/s3/upload-transactions?${authParams()}`, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify({
      resourceType: "planner",
      contentType: "video/mp4",
      fileExtension: "mp4",
      parts: [{ size, startByte: 0, endByte: size, hash: sha256b64 }],
    }),
  });

  if (!txRes.ok) {
    const err = await txRes.text().then(t => t.slice(0, 300));
    throw new Error(`Metricool create transaction failed (${txRes.status}): ${err}`);
  }

  const txJson = await txRes.json();
  const tx = txJson.data;

  if (!tx || !tx.presignedUrl) {
    throw new Error(`No presigned URL returned from Metricool: ${JSON.stringify(txJson).slice(0, 200)}`);
  }

  // Step 2: PUT the bytes to the presigned S3 URL with matching checksum header
  console.log("[Metricool] Uploading to S3...");
  const putRes = await fetch(tx.presignedUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(size),
      "x-amz-checksum-sha256": sha256b64,
    },
    body: new Uint8Array(buf),
  });

  if (!putRes.ok) {
    const err = await putRes.text().then(t => t.slice(0, 200));
    throw new Error(`S3 upload failed (${putRes.status}): ${err}`);
  }

  // Step 3: Complete the transaction (PATCH)
  console.log("[Metricool] Completing transaction...");
  const completeRes = await fetch(`${BASE}/v2/media/s3/upload-transactions?${authParams()}`, {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify({ simple: { fileUrl: tx.fileUrl } }),
  });

  if (!completeRes.ok) {
    const err = await completeRes.text().then(t => t.slice(0, 300));
    throw new Error(`Metricool complete transaction failed (${completeRes.status}): ${err}`);
  }

  const completed = await completeRes.json();
  const hostedUrl = completed.data?.convertedFileUrl || completed.data?.fileUrl || tx.fileUrl;

  if (!hostedUrl) {
    throw new Error("No hosted URL returned after upload completion");
  }

  console.log(`[Metricool] Video uploaded: ${hostedUrl.slice(0, 80)}...`);
  return hostedUrl;
}

/**
 * Get the current Chicago local datetime string for Metricool scheduling.
 */
function chicagoLocalDateTime() {
  const now = new Date();
  const chicagoStr = now.toLocaleString("en-US", { timeZone: "America/Chicago" });
  const chicago = new Date(chicagoStr);
  const y = chicago.getFullYear();
  const m = String(chicago.getMonth() + 1).padStart(2, "0");
  const d = String(chicago.getDate()).padStart(2, "0");
  const h = String(chicago.getHours()).padStart(2, "0");
  const min = String(chicago.getMinutes()).padStart(2, "0");
  const s = String(chicago.getSeconds()).padStart(2, "0");
  return `${y}-${m}-${d}T${h}:${min}:${s}`;
}

/**
 * Create a scheduled post on Metricool (posts immediately if scheduled for now).
 * Posts to Instagram (Reel), TikTok, YouTube. LinkedIn excluded per user preference.
 */
export async function createPost(mediaUrl, caption, options = {}) {
  const { dryRun = false } = options;

  if (dryRun) {
    console.log("[Metricool] DRY RUN — would post to all platforms");
    console.log(`[Metricool] Caption: ${caption.slice(0, 100)}...`);
    console.log(`[Metricool] Media: ${mediaUrl.slice(0, 80)}...`);
    return { ok: true, dryRun: true };
  }

  const body = {
    text: caption,
    publicationDate: {
      dateTime: chicagoLocalDateTime(),
      timezone: "America/Chicago",
    },
    providers: [
      { network: "instagram" },
      { network: "tiktok" },
      { network: "youtube" },
    ],
    // CRITICAL: media MUST be an array of bare URL STRINGS
    media: [mediaUrl],
    autoPublish: true,
    shortener: false,
    draft: false,
    // Instagram-specific: publish as Reel
    instagramData: {
      type: "REEL",
      showReelOnFeed: true,
      autoPublish: true,
    },
    // TikTok-specific
    tiktokData: {
      privacyOption: "PUBLIC_TO_EVERYONE",
      autoPublish: true,
      contentType: "VIDEO",
    },
    // YouTube-specific: publish as Short
    youtubeData: {
      type: "short",
      privacy: "public",
      title: caption
        ? caption.replace(/#\S+/g, "").trim().slice(0, 100) || "New property tour"
        : "New property tour",
    },
  };

  const url = `${BASE}/v2/scheduler/posts?${authParams()}`;
  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });

  const raw = await res.json().catch(() => null);

  if (!res.ok) {
    throw new Error(`Metricool post failed (${res.status}): ${JSON.stringify(raw).slice(0, 300)}`);
  }

  const postId = raw?.id || raw?.postId || "unknown";
  console.log(`[Metricool] Post created successfully (ID: ${postId})`);
  return { ok: true, postId, data: raw };
}

/**
 * Compress a video with ffmpeg to maximize quality within the upload limit.
 * 
 * Strategy:
 * 1. Two-pass encode targeting ~90MB (uses full bitrate budget for best quality)
 * 2. If two-pass fails or overshoots, falls back to CRF ladder starting at 18
 * 
 * Keeps original resolution (4K), audio at 192k AAC.
 */
function compressVideoToFit(sourceBuffer, maxBytes) {
  const tmpDir = "/tmp/metricool-compress";
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });

  const ts = Date.now();
  const inputPath = join(tmpDir, `input_${ts}.mp4`);
  const outputPath = join(tmpDir, `output_${ts}.mp4`);
  const passLogFile = join(tmpDir, `passlog_${ts}`);

  fsWriteSync(inputPath, sourceBuffer);

  const AUDIO_BITRATE_KBPS = 192;

  // Get video duration via ffprobe
  let durationSec = 0;
  try {
    const probeOut = execSync(
      `ffprobe -v error -show_entries format=duration -of csv=p=0 "${inputPath}"`,
      { timeout: 30_000, stdio: ["pipe", "pipe", "pipe"] }
    ).toString().trim();
    durationSec = parseFloat(probeOut);
  } catch (err) {
    console.warn(`[Metricool] ffprobe duration failed: ${err.message?.slice(0, 100)}`);
  }

  // Two-pass approach: target 90MB for maximum quality within 95MB limit
  if (durationSec > 0) {
    const targetSizes = [90, 85]; // Try 90MB first, then 85MB if overshoot

    for (const targetMB of targetSizes) {
      const targetBytes = targetMB * 1024 * 1024;
      const targetBitsTotal = targetBytes * 8;
      const audioBitsTotal = AUDIO_BITRATE_KBPS * 1000 * durationSec;
      const videoBitrate = Math.floor((targetBitsTotal - audioBitsTotal) / durationSec);

      if (videoBitrate < 500_000) {
        console.warn(`[Metricool] Computed video bitrate too low (${(videoBitrate/1000).toFixed(0)}k) for ${targetMB}MB target, skipping two-pass`);
        break;
      }

      const videoBitrateK = `${Math.floor(videoBitrate / 1000)}k`;
      console.log(`[Metricool] Two-pass encode: target ${targetMB}MB, video bitrate ${videoBitrateK}, duration ${durationSec.toFixed(1)}s`);

      try {
        if (existsSync(outputPath)) unlinkSync(outputPath);

        // Pass 1
        execSync(
          `ffmpeg -y -i "${inputPath}" -c:v libx264 -preset slow -b:v ${videoBitrateK} -pass 1 -passlogfile "${passLogFile}" -an -f null /dev/null`,
          { timeout: 600_000, stdio: "pipe" }
        );

        // Pass 2
        execSync(
          `ffmpeg -y -i "${inputPath}" -c:v libx264 -preset slow -b:v ${videoBitrateK} -pass 2 -passlogfile "${passLogFile}" -c:a aac -b:a ${AUDIO_BITRATE_KBPS}k -movflags +faststart "${outputPath}"`,
          { timeout: 600_000, stdio: "pipe" }
        );

        if (existsSync(outputPath)) {
          const compressed = fsReadSync(outputPath);
          if (compressed.length > 1024 && compressed.length <= maxBytes) {
            const fileSizeMb = parseFloat((compressed.length / 1024 / 1024).toFixed(2));
            console.log(`[Metricool] Two-pass succeeded: ${fileSizeMb} MB (target was ${targetMB}MB)`);
            cleanup(inputPath, outputPath, passLogFile);
            return { buffer: compressed, fileSizeMb, crfValue: 0, method: "two-pass" };
          }
          console.log(`[Metricool] Two-pass at ${targetMB}MB target produced ${(compressed.length / 1024 / 1024).toFixed(1)} MB — over limit, retrying...`);
        }
      } catch (err) {
        console.warn(`[Metricool] Two-pass encode failed: ${err.message?.slice(0, 200)}`);
      }
    }
    console.log(`[Metricool] Two-pass approach exhausted, falling back to CRF ladder...`);
  }

  // Fallback: CRF ladder starting at 18 for high quality, preset slow
  const crfValues = [18, 20, 22, 24, 26];

  for (const crf of crfValues) {
    try {
      if (existsSync(outputPath)) unlinkSync(outputPath);

      execSync(
        `ffmpeg -y -i "${inputPath}" -c:v libx264 -preset slow -crf ${crf} -c:a aac -b:a ${AUDIO_BITRATE_KBPS}k -movflags +faststart "${outputPath}"`,
        { timeout: 600_000, stdio: "pipe" }
      );

      if (existsSync(outputPath)) {
        const compressed = fsReadSync(outputPath);
        if (compressed.length > 1024 && compressed.length <= maxBytes) {
          const fileSizeMb = parseFloat((compressed.length / 1024 / 1024).toFixed(2));
          console.log(`[Metricool] CRF ${crf} succeeded: ${fileSizeMb} MB`);
          cleanup(inputPath, outputPath, passLogFile);
          return { buffer: compressed, fileSizeMb, crfValue: crf, method: "crf" };
        }
        console.log(`[Metricool] CRF ${crf} produced ${(compressed.length / 1024 / 1024).toFixed(1)} MB — still too large, trying higher CRF...`);
      }
    } catch (err) {
      console.warn(`[Metricool] ffmpeg CRF ${crf} failed: ${err.message?.slice(0, 200)}`);
    }
  }

  cleanup(inputPath, outputPath, passLogFile);
  console.error(`[Metricool] All compression attempts failed — video is ${(sourceBuffer.length / 1024 / 1024).toFixed(1)} MB`);
  return null;
}

function cleanup(inputPath, outputPath, passLogFile) {
  try { unlinkSync(inputPath); } catch {}
  try { unlinkSync(outputPath); } catch {}
  // ffmpeg creates passlog files with suffixes like -0.log and -0.log.mbtree
  try { unlinkSync(`${passLogFile}-0.log`); } catch {}
  try { unlinkSync(`${passLogFile}-0.log.mbtree`); } catch {}
}
