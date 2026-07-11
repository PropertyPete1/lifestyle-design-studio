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
    caption: String(reel.content || "").slice(0, 500),
    publishedAt: reel.publishedAt,
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
 * Compress a video with ffmpeg to fit under maxBytes while keeping 4K resolution.
 * Tries CRF values from 26 to 32 (higher = smaller file, slight quality loss).
 * CRF 26-28 is visually indistinguishable from original at 4K.
 */
function compressVideoToFit(sourceBuffer, maxBytes) {
  const tmpDir = "/tmp/metricool-compress";
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });

  const inputPath = join(tmpDir, `input_${Date.now()}.mp4`);
  const outputPath = join(tmpDir, `output_${Date.now()}.mp4`);

  fsWriteSync(inputPath, sourceBuffer);

  const crfValues = [26, 28, 30, 32];

  for (const crf of crfValues) {
    try {
      if (existsSync(outputPath)) unlinkSync(outputPath);

      execSync(
        `ffmpeg -y -i "${inputPath}" -c:v libx264 -preset fast -crf ${crf} -c:a aac -b:a 128k -movflags +faststart "${outputPath}"`,
        { timeout: 300_000, stdio: "pipe" }
      );

      if (existsSync(outputPath)) {
        const compressed = fsReadSync(outputPath);
        if (compressed.length > 1024 && compressed.length <= maxBytes) {
          const fileSizeMb = parseFloat((compressed.length / 1024 / 1024).toFixed(2));
          console.log(`[Metricool] Compression succeeded at CRF ${crf}: ${fileSizeMb} MB`);
          try { unlinkSync(inputPath); } catch {}
          try { unlinkSync(outputPath); } catch {}
          return { buffer: compressed, fileSizeMb, crfValue: crf };
        }
        console.log(`[Metricool] CRF ${crf} produced ${(compressed.length / 1024 / 1024).toFixed(1)} MB — still too large, trying higher CRF...`);
      }
    } catch (err) {
      console.warn(`[Metricool] ffmpeg CRF ${crf} failed: ${err.message?.slice(0, 200)}`);
    }
  }

  // Cleanup
  try { unlinkSync(inputPath); } catch {}
  try { unlinkSync(outputPath); } catch {}

  console.error(`[Metricool] All compression attempts failed — video is ${(sourceBuffer.length / 1024 / 1024).toFixed(1)} MB`);
  return null;
}
