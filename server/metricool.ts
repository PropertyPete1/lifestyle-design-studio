/**
 * Metricool API helper.
 * Docs: https://app.metricool.com/resources/apidocs/index.html
 * Auth: X-Mc-Auth header + blogId + userId query params on every request.
 */

import { ENV } from "./_core/env";
import crypto from "node:crypto";

const BASE = "https://app.metricool.com/api";

/**
 * Upload a video into Metricool's own media library and return a stable,
 * Metricool-hosted CDN URL (https://static.metricool.com/...). This is the
 * ONLY reliable way to attach media: external URLs (IG CDN, signed S3) expire
 * before Metricool ingests them, leaving posts stuck with "Video not available".
 *
 * Flow (validated live):
 *  1. PUT  /v2/media/s3/upload-transactions  with parts[].hash = base64(sha256)
 *  2. PUT  <presignedUrl>  with header x-amz-checksum-sha256 = base64(sha256)
 *  3. PATCH /v2/media/s3/upload-transactions  { simple: { fileUrl } }
 *  -> returns convertedFileUrl on the static.metricool.com CDN.
 *
 * The CRITICAL detail: the transaction part `hash` MUST be the base64-encoded
 * SHA-256 of the bytes. Metricool signs the S3 presigned URL with that exact
 * value as x-amz-checksum-sha256; any other value (e.g. MD5) yields a 403
 * SignatureDoesNotMatch.
 */
export async function uploadVideoToMetricool(
  sourceUrl: string,
  blogId: number = ENV.metricoolBlogId,
  prefetched?: { buf: Buffer; sha256b64: string }
): Promise<string> {
  const auth = authParams(blogId);
  const jsonHeaders = authHeaders();

  // Download the source video bytes (or reuse prefetched bytes across brands).
  let buf: Buffer;
  let sha256b64: string;
  if (prefetched) {
    buf = prefetched.buf;
    sha256b64 = prefetched.sha256b64;
  } else {
    const dl = await fetch(sourceUrl);
    if (!dl.ok) {
      throw new Error(`uploadVideoToMetricool: failed to download source (${dl.status})`);
    }
    buf = Buffer.from(await dl.arrayBuffer());
    sha256b64 = crypto.createHash("sha256").update(buf).digest("base64");
  }
  const size = buf.length;

  // 1. Create the upload transaction (declare sha256-base64 as the part hash).
  let res = await fetch(`${BASE}/v2/media/s3/upload-transactions?${auth}`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({
      resourceType: "planner",
      contentType: "video/mp4",
      fileExtension: "mp4",
      parts: [{ size, startByte: 0, endByte: size, hash: sha256b64 }],
    }),
  });
  if (!res.ok) {
    throw new Error(`uploadVideoToMetricool: create transaction failed ${res.status} ${await res.text()}`);
  }
  const tx = ((await res.json()) as { data: { presignedUrl: string; fileUrl: string } }).data;

  // 2. PUT the bytes to the presigned S3 URL with the matching checksum header.
  const put = await fetch(tx.presignedUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(size),
      "x-amz-checksum-sha256": sha256b64,
    },
    body: new Uint8Array(buf),
  });
  if (!put.ok) {
    throw new Error(`uploadVideoToMetricool: S3 PUT failed ${put.status} ${(await put.text()).slice(0, 200)}`);
  }

  // 3. Complete the transaction; Metricool returns the hosted CDN URL.
  res = await fetch(`${BASE}/v2/media/s3/upload-transactions?${auth}`, {
    method: "PATCH",
    headers: jsonHeaders,
    body: JSON.stringify({ simple: { fileUrl: tx.fileUrl } }),
  });
  if (!res.ok) {
    throw new Error(`uploadVideoToMetricool: complete failed ${res.status} ${await res.text()}`);
  }
  const completed = ((await res.json()) as { data: { convertedFileUrl?: string; fileUrl?: string } }).data;
  const hostedUrl = completed.convertedFileUrl || completed.fileUrl || tx.fileUrl;
  if (!hostedUrl) {
    throw new Error("uploadVideoToMetricool: no hosted URL returned");
  }
  return hostedUrl;
}

function authParams(blogId: number = ENV.metricoolBlogId) {
  return `blogId=${blogId}&userId=${ENV.metricoolUserId}`;
}

/** A Metricool brand/blog and the networks connected to it. */
export interface MetricoolBrand {
  blogId: number;
  label: string;
  networks: string[]; // uppercase: INSTAGRAM, TIKTOK, YOUTUBE, LINKEDIN, FACEBOOK
}

/**
 * Discover ALL brands on the Metricool account and the video-capable networks
 * connected to each. We post each daily reel to every brand that has at least
 * Instagram, so any future IG account connected as a new brand is included
 * automatically with no code change.
 */
export async function getAllBrands(): Promise<MetricoolBrand[]> {
  const url = `${BASE}/admin/simpleProfiles?userId=${ENV.metricoolUserId}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    throw new Error(`Metricool getAllBrands failed: ${res.status} ${await res.text()}`);
  }
  const profiles = (await res.json()) as Record<string, unknown>[];
  const brands: MetricoolBrand[] = [];
  for (const p of profiles) {
    if (p.deleted === true || p.isDemo === true) continue;
    const blogId = Number(p.id ?? p.blogId);
    if (!blogId) continue;
    const networks: string[] = [];
    if (typeof p.instagram === "string" && p.instagram) networks.push("INSTAGRAM");
    if (typeof p.tiktok === "string" && p.tiktok) networks.push("TIKTOK");
    if (typeof p.youtube === "string" && p.youtube) networks.push("YOUTUBE");
    if ((typeof p.linkedin === "string" && p.linkedin) || (typeof p.linkedinCompany === "string" && p.linkedinCompany))
      networks.push("LINKEDIN");
    // Only target brands that can carry a video reel (Instagram at minimum).
    if (!networks.includes("INSTAGRAM")) continue;
    brands.push({ blogId, label: String(p.label ?? p.id ?? blogId), networks });
  }
  return brands;
}

function authHeaders() {
  return {
    "Content-Type": "application/json",
    "X-Mc-Auth": ENV.metricoolApiToken,
  };
}

/**
 * Discover every brand on the account that has LinkedIn connected (profile OR
 * company page). Unlike getAllBrands(), this does NOT require Instagram, since
 * the daily recruiting post is text-only and LinkedIn-specific. Sorted by
 * blogId for a stable, deterministic stagger order.
 */
export async function getLinkedinBrands(): Promise<MetricoolBrand[]> {
  const url = `${BASE}/admin/simpleProfiles?userId=${ENV.metricoolUserId}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    throw new Error(`Metricool getLinkedinBrands failed: ${res.status} ${await res.text()}`);
  }
  const profiles = (await res.json()) as Record<string, unknown>[];
  const brands: MetricoolBrand[] = [];
  for (const p of profiles) {
    if (p.deleted === true || p.isDemo === true) continue;
    const blogId = Number(p.id ?? p.blogId);
    if (!blogId) continue;
    const hasLinkedin =
      (typeof p.linkedin === "string" && p.linkedin) ||
      (typeof p.linkedinCompany === "string" && p.linkedinCompany);
    if (!hasLinkedin) continue;
    brands.push({ blogId, label: String(p.label ?? p.id ?? blogId), networks: ["LINKEDIN"] });
  }
  brands.sort((a, b) => a.blogId - b.blogId);
  return brands;
}

export interface MetricoolNetwork {
  network: string; // "INSTAGRAM" | "TIKTOK" | "FACEBOOK" | "YOUTUBE" | "LINKEDIN" | ...
  id: string;
}

export interface CreatePostOptions {
  /** Public video URL (mp4) */
  videoUrl: string;
  /** Caption / text for the post */
  caption: string;
  /** ISO-8601 datetime string for when to publish, e.g. "2026-06-27T19:00:00" */
  publishAt: string;
  /** Timezone string, e.g. "America/Chicago" */
  timezone?: string;
  /** Optional thumbnail URL */
  thumbnailUrl?: string | null;
  /** Networks to post to. If omitted, posts to all connected networks. */
  networks?: MetricoolNetwork[];
  /**
   * When true (default), the video is first uploaded into Metricool's own media
   * library and the resulting static.metricool.com URL is used in the post.
   * Set false only for tests that already pass a Metricool-hosted URL.
   */
  uploadMedia?: boolean;
}

export interface CreatePostResult {
  ok: boolean;
  postId?: number;
  error?: string;
  raw?: unknown;
  /** Human-readable list of the networks this post was sent to, e.g. "Instagram, TikTok, YouTube, LinkedIn". */
  platforms?: string;
}

/**
 * Fetch the connected social network accounts for this brand.
 * Returns an array of { network, id } objects.
 */
export async function getConnectedNetworks(): Promise<MetricoolNetwork[]> {
  const url = `${BASE}/admin/simpleProfiles?${authParams()}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    throw new Error(`Metricool getConnectedNetworks failed: ${res.status} ${await res.text()}`);
  }
  const profiles = (await res.json()) as Record<string, unknown>[];
  const profile = profiles[0];
  if (!profile) return [];

  // Map the profile fields to network entries
  const networkMap: Record<string, string> = {
    instagram: "INSTAGRAM",
    tiktok: "TIKTOK",
    facebook: "FACEBOOK",
    youtube: "YOUTUBE",
    linkedin: "LINKEDIN",
    linkedinCompany: "LINKEDIN",
    threads: "THREADS",
    bluesky: "BLUESKY",
    twitter: "TWITTER",
  };

  const networks: MetricoolNetwork[] = [];
  for (const [field, network] of Object.entries(networkMap)) {
    const val = profile[field];
    if (val && typeof val === "string") {
      networks.push({ network, id: val });
    }
    // Facebook page id
    if (field === "facebook" && profile.facebookPageId) {
      networks[networks.length - 1] = {
        network: "FACEBOOK",
        id: String(profile.facebookPageId),
      };
    }
  }
  return networks;
}

/**
 * Create a scheduled post in Metricool that auto-publishes to all connected platforms.
 * Uses autoPublish: true so no manual confirmation is needed.
 */
const UPPER_TO_LOWER: Record<string, string> = {
  INSTAGRAM: "instagram",
  TIKTOK: "tiktok",
  YOUTUBE: "youtube",
  LINKEDIN: "linkedin",
  FACEBOOK: "facebook",
};
const NICE_NAMES: Record<string, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  linkedin: "LinkedIn",
  facebook: "Facebook",
};

/**
 * Post one reel to EVERY brand on the Metricool account (fan-out for maximum
 * exposure). The media is uploaded once into each brand's own media library
 * (Metricool media libraries are per-blogId), then a post is created per brand
 * targeting that brand's connected networks. Succeeds if at least one brand
 * publishes; per-brand outcomes are summarized in `platforms`.
 */
export async function createScheduledPost(opts: CreatePostOptions): Promise<CreatePostResult> {
  const { videoUrl } = opts;

  let brands: MetricoolBrand[];
  try {
    brands = await getAllBrands();
  } catch (err) {
    return {
      ok: false,
      error: `Metricool brand discovery failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (brands.length === 0) {
    return { ok: false, error: "No Instagram-capable Metricool brands found" };
  }

  // Download the source bytes ONCE and reuse across brand uploads.
  let prefetched: { buf: Buffer; sha256b64: string } | undefined;
  try {
    const dl = await fetch(videoUrl);
    if (!dl.ok) throw new Error(`source download failed (${dl.status})`);
    const buf = Buffer.from(await dl.arrayBuffer());
    prefetched = { buf, sha256b64: crypto.createHash("sha256").update(buf).digest("base64") };
  } catch (err) {
    return {
      ok: false,
      error: `Metricool media download failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const results: Array<{ brand: string; ok: boolean; postId?: number; networks: string[]; error?: string }> = [];
  for (const brand of brands) {
    const r = await postToBrand(opts, brand, prefetched);
    results.push({ brand: brand.label, ok: r.ok, postId: r.postId, networks: brand.networks, error: r.error });
  }

  const anyOk = results.some(r => r.ok);
  const firstOkPostId = results.find(r => r.ok)?.postId;
  // Human-readable summary like:
  // "lifestyledesignrealtytexas (Instagram, TikTok, YouTube, LinkedIn); propertypete01 (Instagram); ..."
  const summary = results
    .map(r => {
      const nets = r.networks.map(n => NICE_NAMES[n.toLowerCase()] ?? n).join(", ");
      return r.ok ? `${r.brand} (${nets})` : `${r.brand} FAILED: ${r.error}`;
    })
    .join("; ");

  return {
    ok: anyOk,
    postId: typeof firstOkPostId === "number" ? firstOkPostId : undefined,
    error: anyOk ? undefined : `All brands failed. ${summary}`,
    platforms: summary,
    raw: results,
  };
}

/**
 * Create + auto-publish one post on a single brand. Uploads the media into that
 * brand's media library first (per-blogId), then posts to the brand's networks.
 */
async function postToBrand(
  opts: CreatePostOptions,
  brand: MetricoolBrand,
  prefetched: { buf: Buffer; sha256b64: string }
): Promise<CreatePostResult> {
  const {
    videoUrl,
    caption,
    publishAt,
    timezone = "America/Chicago",
    thumbnailUrl,
    uploadMedia = true,
  } = opts;

  // Upload the video into THIS brand's media library (Metricool-hosted CDN URL).
  let mediaUrl = videoUrl;
  if (uploadMedia) {
    try {
      mediaUrl = await uploadVideoToMetricool(videoUrl, brand.blogId, prefetched);
    } catch (err) {
      return {
        ok: false,
        error: `media upload failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // Target every video-friendly network connected to this brand.
  // NOTE: LinkedIn is intentionally EXCLUDED here. LinkedIn is handled by a
  // separate daily text-only recruiting-post pipeline (see linkedinPosts.ts /
  // linkedinPublish endpoints). Pushing reels to LinkedIn is off by design.
  const allowed = ["INSTAGRAM", "TIKTOK", "YOUTUBE"];
  const seen = new Set<string>();
  const providers = brand.networks
    .filter(n => allowed.includes(n) && !seen.has(n) && seen.add(n) !== undefined)
    .map(n => ({ network: UPPER_TO_LOWER[n] ?? n.toLowerCase() }));

  if (providers.length === 0) {
    return { ok: false, error: "no video networks on brand" };
  }

  const body: Record<string, unknown> = {
    text: caption,
    publicationDate: {
      dateTime: publishAt, // e.g. "2026-06-27T19:00:00"
      timezone,
    },
    providers,
    // CRITICAL: media MUST be an array of bare URL STRINGS. Sending
    // [{url,type}] objects makes Metricool silently persist EMPTY media
    // (post then errors "add a picture/video"). Strings work only when the
    // URL is Metricool-hosted (static.metricool.com), which uploadMedia
    // guarantees above.
    media: [mediaUrl],
    autoPublish: true,
    // NOTE: do NOT set saveExternalMediaFiles:true — it makes Metricool try to
    // download the IG CDN video server-side and returns a 500. Leaving it off
    // lets Metricool fetch the media at publish time, which works.
    shortener: false,
    draft: false,
    // Instagram-specific: publish as Reel, show on feed
    instagramData: {
      type: "REEL",
      showReelOnFeed: true,
      autoPublish: true,
    },
    // TikTok-specific: public post
    tiktokData: {
      privacyOption: "PUBLIC_TO_EVERYONE",
    },
    // YouTube-specific: publish as a public Short
    youtubeData: {
      type: "short",
      privacy: "public",
      title: "New build tour",
    },
  };

  if (thumbnailUrl) {
    body.videoThumbnailUrl = thumbnailUrl;
  }

  const url = `${BASE}/v2/scheduler/posts?${authParams(brand.blogId)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });

  const raw = await res.json().catch(() => null);

  if (!res.ok) {
    return {
      ok: false,
      error: `API error ${res.status}: ${JSON.stringify(raw)}`,
      raw,
    };
  }

  // Extract the created post id from the response
  const postId =
    (raw as Record<string, unknown>)?.id ??
    ((raw as Record<string, unknown>)?.data as Record<string, unknown>)?.id;

  const platforms = providers
    .map(p => NICE_NAMES[p.network.toLowerCase()] ?? p.network)
    .filter((v, i, a) => a.indexOf(v) === i)
    .join(", ");

  return {
    ok: true,
    postId: typeof postId === "number" ? postId : undefined,
    raw,
    platforms,
  };
}

/* --------------------------- LinkedIn text posts --------------------------- */

export interface LinkedinTextPostResult {
  ok: boolean;
  postId?: number;
  error?: string;
  raw?: unknown;
}

/**
 * Publish a TEXT-ONLY LinkedIn post (no media) to a specific brand's LinkedIn
 * network via Metricool, auto-published at the given local time. This is
 * separate from the reel pipeline: reels never target LinkedIn (see
 * postToBrand). Peter's daily recruiting posts flow through here.
 *
 * `publishAt` MUST be a wall-clock "YYYY-MM-DDTHH:MM:SS" string in the given
 * timezone (Metricool interprets publicationDate in that timezone). Reuse
 * chicagoLocalDateTime() from scheduledPublish.ts to build it.
 */
export async function publishLinkedinText(opts: {
  blogId: number;
  text: string;
  publishAt: string;
  timezone?: string;
  autoPublish?: boolean;
}): Promise<LinkedinTextPostResult> {
  const { blogId, text, publishAt, timezone = "America/Chicago", autoPublish = true } = opts;

  if (!text || !text.trim()) {
    return { ok: false, error: "empty LinkedIn text" };
  }

  const body: Record<string, unknown> = {
    text,
    publicationDate: { dateTime: publishAt, timezone },
    providers: [{ network: "linkedin" }],
    // No media array at all -> Metricool treats this as a text-only post.
    autoPublish,
    shortener: false,
    draft: false,
    // LinkedIn-specific: publish to the connected profile/page as a normal post.
    linkedinData: {
      publishImagesAsPDF: false,
      documentTitle: "",
    },
  };

  const url = `${BASE}/v2/scheduler/posts?${authParams(blogId)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const raw = await res.json().catch(() => null);

  if (!res.ok) {
    return { ok: false, error: `API error ${res.status}: ${JSON.stringify(raw)}`, raw };
  }
  const postId =
    (raw as Record<string, unknown>)?.id ??
    ((raw as Record<string, unknown>)?.data as Record<string, unknown>)?.id;
  return { ok: true, postId: typeof postId === "number" ? postId : undefined, raw };
}
