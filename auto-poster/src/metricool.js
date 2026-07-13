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

function authParams(blogId = process.env.METRICOOL_BLOG_ID) {
  return `blogId=${blogId}&userId=${process.env.METRICOOL_USER_ID}`;
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
 * Discover ALL brands on the Metricool account that have Instagram connected.
 * Each brand = a different IG account. We post to every one.
 * Uses /admin/simpleProfiles endpoint.
 */
export async function getAllBrands() {
  const url = `${BASE}/admin/simpleProfiles?userId=${process.env.METRICOOL_USER_ID}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    console.warn(`[Metricool] getAllBrands failed (${res.status}) — falling back to default brand`);
    return [{ blogId: process.env.METRICOOL_BLOG_ID, label: "default", networks: ["INSTAGRAM", "TIKTOK", "YOUTUBE"] }];
  }
  const profiles = await res.json();
  const brands = [];
  for (const p of profiles) {
    if (p.deleted === true || p.isDemo === true) continue;
    const blogId = Number(p.id || p.blogId);
    if (!blogId) continue;
    const networks = [];
    if (typeof p.instagram === "string" && p.instagram) networks.push("INSTAGRAM");
    if (typeof p.facebook === "string" && p.facebook) networks.push("FACEBOOK");
    if (typeof p.tiktok === "string" && p.tiktok) networks.push("TIKTOK");
    if (typeof p.youtube === "string" && p.youtube) networks.push("YOUTUBE");
    // Only include brands that have Instagram connected
    if (!networks.includes("INSTAGRAM")) continue;
    brands.push({ blogId, label: String(p.label || p.id || blogId), networks });
  }
  console.log(`[Metricool] Discovered ${brands.length} IG brands: ${brands.map(b => b.label).join(", ")}`);
  return brands.length > 0 ? brands : [{ blogId: process.env.METRICOOL_BLOG_ID, label: "default", networks: ["INSTAGRAM", "TIKTOK", "YOUTUBE"] }];
}

/**
 * Upload a video buffer to a specific brand's Metricool media library.
 * Returns the hosted CDN URL.
 * 
 * If prefetched is provided (buf + sha256b64), reuses those bytes.
 */
async function uploadToBrand(blogId, prefetched) {
  const { buf, sha256b64 } = prefetched;
  const size = buf.length;

  // Step 1: Create upload transaction
  const txRes = await fetch(`${BASE}/v2/media/s3/upload-transactions?${authParams(blogId)}`, {
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

  // Step 2: PUT the bytes to the presigned S3 URL
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

  // Step 3: Complete the transaction
  const completeRes = await fetch(`${BASE}/v2/media/s3/upload-transactions?${authParams(blogId)}`, {
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

  return hostedUrl;
}

/**
 * Upload a video buffer to Metricool's media library (S3 presigned flow).
 * Handles compression if needed. Returns { buf, sha256b64 } for reuse across brands.
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

  // Upload to the default brand first (for backwards compat)
  const defaultBlogId = process.env.METRICOOL_BLOG_ID;
  const hostedUrl = await uploadToBrand(defaultBlogId, { buf, sha256b64 });

  console.log(`[Metricool] Video uploaded: ${hostedUrl.slice(0, 80)}...`);
  // Return both the URL and the prefetched data for multi-brand reuse
  return { hostedUrl, prefetched: { buf, sha256b64 } };
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
 * Create a scheduled post on Metricool — MULTI-BRAND FAN-OUT.
 * Discovers all IG-connected brands and posts to each one separately.
 * Each brand gets its own upload + post (Metricool media libraries are per-blogId).
 * 
 * Posts to Instagram (Reel), TikTok, YouTube per brand. LinkedIn excluded.
 * 
 * Returns { ok, brands: [{ label, ok, networks, error? }], platforms }
 */
export async function createPost(mediaUrl, caption, options = {}) {
  const { dryRun = false, prefetched = null, mainBrandSkipIG = false } = options;

  // Discover all brands
  const brands = await getAllBrands();

  if (dryRun) {
    console.log(`[Metricool] DRY RUN — would post to ${brands.length} brands: ${brands.map(b => b.label).join(", ")}`);
    console.log(`[Metricool] Caption: ${caption.slice(0, 100)}...`);
    console.log(`[Metricool] Media: ${String(mediaUrl).slice(0, 80)}...`);
    return { ok: true, dryRun: true, brands: brands.map(b => ({ label: b.label, ok: true, networks: b.networks })) };
  }

  const NETWORK_MAP = { INSTAGRAM: "instagram", FACEBOOK: "facebook", TIKTOK: "tiktok", YOUTUBE: "youtube" };
  const NICE_NAMES = { instagram: "Instagram", facebook: "Facebook", tiktok: "TikTok", youtube: "YouTube" };
  const publishAt = chicagoLocalDateTime();

  // The default brand was already uploaded in uploadVideoToMetricool() — reuse that URL
  const defaultBlogId = Number(process.env.METRICOOL_BLOG_ID);
  const results = [];

  for (const brand of brands) {
    try {
      // Upload to this brand's media library (skip default brand — already uploaded)
      let brandMediaUrl;
      if (brand.blogId === defaultBlogId && mediaUrl) {
        // Reuse the URL from the initial upload — saves ~90MB of duplicate transfer
        brandMediaUrl = mediaUrl;
        console.log(`[Metricool] Reusing initial upload for brand: ${brand.label} (${brand.blogId})`);
      } else if (prefetched) {
        console.log(`[Metricool] Uploading to brand: ${brand.label} (${brand.blogId})...`);
        brandMediaUrl = await uploadToBrand(brand.blogId, prefetched);
      } else {
        // No prefetched data and not the default brand — skip
        results.push({ label: brand.label, ok: false, networks: brand.networks, error: "no upload data available" });
        continue;
      }

      // Filter to video-friendly networks only (no LinkedIn)
      let allowed = ["INSTAGRAM", "FACEBOOK", "TIKTOK", "YOUTUBE"];
      // Manual-assist mode: skip Instagram for the MAIN brand (owner posts natively)
      if (mainBrandSkipIG && brand.blogId === defaultBlogId) {
        allowed = allowed.filter(n => n !== "INSTAGRAM");
        console.log(`[Metricool] Manual-assist: skipping Instagram for main brand ${brand.label} (owner will post natively)`);
      }

      const providers = brand.networks
        .filter(n => allowed.includes(n))
        .map(n => ({ network: NETWORK_MAP[n] || n.toLowerCase() }));

      if (providers.length === 0) {
        results.push({ label: brand.label, ok: false, networks: [], error: "no video networks" });
        continue;
      }

      const body = {
        text: caption,
        publicationDate: {
          dateTime: publishAt,
          timezone: "America/Chicago",
        },
        providers,
        media: [brandMediaUrl],
        autoPublish: true,
        shortener: false,
        draft: false,
        instagramData: {
          type: "REEL",
          showReelOnFeed: true,
          autoPublish: true,
        },
        tiktokData: {
          privacyOption: "PUBLIC_TO_EVERYONE",
          autoPublish: true,
          contentType: "VIDEO",
        },
        youtubeData: {
          type: "short",
          privacy: "public",
          title: caption
            ? caption.replace(/#\S+/g, "").trim().slice(0, 100) || "New property tour"
            : "New property tour",
        },
        facebookData: {
          type: "REEL",
        },
      };

      const url = `${BASE}/v2/scheduler/posts?${authParams(brand.blogId)}`;
      const res = await fetch(url, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(body),
      });

      const raw = await res.json().catch(() => null);

      if (!res.ok) {
        const errMsg = `API error ${res.status}: ${JSON.stringify(raw).slice(0, 200)}`;
        console.warn(`[Metricool] ✗ Brand ${brand.label} failed: ${errMsg}`);
        results.push({ label: brand.label, ok: false, networks: brand.networks, error: errMsg });
      } else {
        const postId = raw?.id || raw?.postId || "unknown";
        console.log(`[Metricool] ✓ Brand ${brand.label} posted (ID: ${postId}) — ${providers.map(p => NICE_NAMES[p.network] || p.network).join(", ")}`);
        results.push({ label: brand.label, ok: true, networks: brand.networks, postId, blogId: brand.blogId });
      }
    } catch (err) {
      console.warn(`[Metricool] ✗ Brand ${brand.label} error: ${err.message?.slice(0, 200)}`);
      results.push({ label: brand.label, ok: false, networks: brand.networks, error: err.message });
    }
  }

  const anyOk = results.some(r => r.ok);
  const summary = results
    .map(r => {
      const nets = r.networks.map(n => NICE_NAMES[n.toLowerCase()] || n).join(", ");
      return r.ok ? `${r.label} (${nets})` : `${r.label} FAILED`;
    })
    .join("; ");

  if (!anyOk) {
    throw new Error(`All brands failed: ${results.map(r => `${r.label}: ${r.error}`).join("; ")}`);
  }

  console.log(`[Metricool] Post created on ${results.filter(r => r.ok).length}/${brands.length} brands: ${summary}`);
  return { ok: true, brands: results, platforms: summary };
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

/**
 * Verify that a scheduled post was actually published on all providers.
 * Calls GET /v2/scheduler/posts/{postId} and checks each provider's status.
 * 
 * @param {string|number} postId - The Metricool post ID
 * @param {number} blogId - The brand's blogId
 * @returns {{ verified: boolean, anyFailed: boolean, providers: Array, raw: object }}
 */
export async function verifyPostStatus(postId, blogId = process.env.METRICOOL_BLOG_ID) {
  const url = `${BASE}/v2/scheduler/posts/${postId}?${authParams(blogId)}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    console.warn(`[Metricool] verifyPostStatus failed (${res.status}) for post ${postId}`);
    return { verified: false, anyFailed: false, providers: [], error: `HTTP ${res.status}`, raw: null };
  }
  const json = await res.json();
  const data = json?.data;
  if (!data) {
    return { verified: false, anyFailed: false, providers: [], error: "No data in response", raw: json };
  }
  const providers = (data.providers || []).map(p => ({
    network: p.network,
    status: p.status,
    detailedStatus: p.detailedStatus,
    publicUrl: p.publicUrl || p.id || null,
  }));
  // A post is verified if ALL providers have status "PUBLISHED"
  const allPublished = providers.length > 0 && providers.every(p => p.status === "PUBLISHED");
  // Check for any failures
  const anyFailed = providers.some(p => p.status === "FAILED" || p.status === "ERROR");
  return { verified: allPublished, anyFailed, providers, raw: data };
}
