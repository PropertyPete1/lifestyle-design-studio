/**
 * Metricool API — check IG posts, upload media, post to all platforms
 */

import { createHash } from "crypto";

const BASE = "https://app.metricool.com/api";

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
 * Get all Instagram-capable brands on the Metricool account.
 */
export async function getAllBrands() {
  const blogId = process.env.METRICOOL_BLOG_ID;
  const userId = process.env.METRICOOL_USER_ID;
  const url = `${BASE}/v2/analytics/brands?blogId=${blogId}&userId=${userId}`;

  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    console.warn(`[Metricool] getAllBrands failed (${res.status})`);
    return [];
  }

  const json = await res.json();
  const brands = [];

  for (const brand of json.data || json || []) {
    if (brand.instagramData || brand.instagram) {
      brands.push({
        blogId: brand.blogId || brand.id,
        label: brand.name || brand.label || `brand-${brand.blogId}`,
      });
    }
  }

  // If no brands found from the API, use the known blog ID
  if (brands.length === 0) {
    brands.push({ blogId: parseInt(blogId), label: "primary" });
  }

  return brands;
}

/**
 * Fetch Instagram reels from the last 30 days via Metricool analytics.
 * Returns array of { reelId, caption, publishedAt }.
 */
export async function getRecentIgPosts(days = 30) {
  const blogId = process.env.METRICOOL_BLOG_ID;
  const userId = process.env.METRICOOL_USER_ID;

  const to = new Date();
  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const url =
    `${BASE}/v2/analytics/reels/instagram?from=${fmtDate(from)}&to=${fmtDate(to)}` +
    `&blogId=${blogId}&userId=${userId}&timezone=America/Chicago`;

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
 */
export async function uploadVideoToMetricool(videoBuffer, fileName) {
  const blogId = process.env.METRICOOL_BLOG_ID;
  const userId = process.env.METRICOOL_USER_ID;

  // Step 1: Create upload transaction
  const hash = createHash("sha256").update(videoBuffer).digest("base64");
  const ext = fileName.split(".").pop() || "mp4";
  const mimeType = ext === "mov" ? "video/quicktime" : "video/mp4";

  const txBody = {
    blogId: parseInt(blogId),
    userId: parseInt(userId),
    parts: [{ partNumber: 1, hash }],
    fileName: `auto-poster-${Date.now()}.${ext}`,
    contentType: mimeType,
  };

  const txRes = await fetch(`${BASE}/v2/media/s3/upload-transactions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(txBody),
  });

  if (!txRes.ok) {
    const err = await txRes.text().then(t => t.slice(0, 300));
    throw new Error(`Metricool upload transaction failed (${txRes.status}): ${err}`);
  }

  const txData = await txRes.json();
  const transactionId = txData.transactionId || txData.id;
  const presignedUrl = txData.parts?.[0]?.url || txData.uploadUrl;

  if (!presignedUrl) {
    throw new Error("No presigned URL returned from Metricool");
  }

  // Step 2: Upload to S3 via presigned URL
  const uploadRes = await fetch(presignedUrl, {
    method: "PUT",
    headers: {
      "Content-Type": mimeType,
      "x-amz-checksum-sha256": hash,
    },
    body: videoBuffer,
  });

  if (!uploadRes.ok) {
    const err = await uploadRes.text().then(t => t.slice(0, 300));
    throw new Error(`S3 upload failed (${uploadRes.status}): ${err}`);
  }

  // Step 3: Complete the transaction
  const completeRes = await fetch(
    `${BASE}/v2/media/s3/upload-transactions/${transactionId}`,
    {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({ status: "COMPLETED" }),
    }
  );

  if (!completeRes.ok) {
    const err = await completeRes.text().then(t => t.slice(0, 300));
    throw new Error(`Metricool complete transaction failed (${completeRes.status}): ${err}`);
  }

  const completeData = await completeRes.json();
  const cdnUrl = completeData.url || completeData.mediaUrl;

  if (!cdnUrl) {
    throw new Error("No CDN URL returned after upload completion");
  }

  console.log(`[Metricool] Video uploaded to CDN: ${cdnUrl.slice(0, 80)}...`);
  return cdnUrl;
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
 * Posts to Instagram, TikTok, YouTube. LinkedIn gets text-only.
 */
export async function createPost(mediaUrl, caption, options = {}) {
  const blogId = process.env.METRICOOL_BLOG_ID;
  const userId = process.env.METRICOOL_USER_ID;
  const { dryRun = false } = options;

  if (dryRun) {
    console.log("[Metricool] DRY RUN — would post to all platforms");
    console.log(`[Metricool] Caption: ${caption.slice(0, 100)}...`);
    console.log(`[Metricool] Media: ${mediaUrl.slice(0, 80)}...`);
    return { ok: true, dryRun: true };
  }

  const body = {
    blogId: parseInt(blogId),
    userId: parseInt(userId),
    text: caption,
    media: [mediaUrl],
    autoPublish: true,
    publicationDate: {
      dateTime: chicagoLocalDateTime(),
      timeZone: "America/Chicago",
    },
    providers: {
      instagram: { postType: "reel" },
      tiktok: {},
      youtube: { title: caption.split("\n")[0].slice(0, 100), privacy: "public" },
      facebook: { postType: "reel" },
    },
    // LinkedIn gets text-only (no video per user preference)
    linkedinData: {
      text: caption,
    },
  };

  const res = await fetch(`${BASE}/v2/posts/schedule`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text().then(t => t.slice(0, 300));
    throw new Error(`Metricool post failed (${res.status}): ${err}`);
  }

  const data = await res.json();
  console.log(`[Metricool] Post created successfully (ID: ${data.id || data.postId || "unknown"})`);
  return { ok: true, postId: data.id || data.postId, data };
}
