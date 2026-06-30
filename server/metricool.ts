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
export async function uploadVideoToMetricool(sourceUrl: string): Promise<string> {
  const auth = authParams();
  const jsonHeaders = authHeaders();

  // Download the source video bytes.
  const dl = await fetch(sourceUrl);
  if (!dl.ok) {
    throw new Error(`uploadVideoToMetricool: failed to download source (${dl.status})`);
  }
  const buf = Buffer.from(await dl.arrayBuffer());
  const size = buf.length;
  const sha256b64 = crypto.createHash("sha256").update(buf).digest("base64");

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
    body: buf,
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

function authParams() {
  return `blogId=${ENV.metricoolBlogId}&userId=${ENV.metricoolUserId}`;
}

function authHeaders() {
  return {
    "Content-Type": "application/json",
    "X-Mc-Auth": ENV.metricoolApiToken,
  };
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
export async function createScheduledPost(opts: CreatePostOptions): Promise<CreatePostResult> {
  const {
    videoUrl,
    caption,
    publishAt,
    timezone = "America/Chicago",
    thumbnailUrl,
    networks,
    uploadMedia = true,
  } = opts;

  // Upload the video into Metricool's media library so it is hosted on their
  // CDN. External URLs (IG CDN / signed S3) expire and leave the post with no
  // media ("Video not available"), so this step is mandatory for reliability.
  let mediaUrl = videoUrl;
  if (uploadMedia) {
    try {
      mediaUrl = await uploadVideoToMetricool(videoUrl);
    } catch (err) {
      return {
        ok: false,
        error: `Metricool media upload failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // Resolve which networks to post to. Metricool expects LOWERCASE network
  // names in `providers` and does NOT want a `status`/`id` field on create
  // (sending those causes a 500 insert error). We only send { network }.
  const upperToLower: Record<string, string> = {
    INSTAGRAM: "instagram",
    TIKTOK: "tiktok",
    YOUTUBE: "youtube",
    LINKEDIN: "linkedin",
    FACEBOOK: "facebook",
  };
  let providers: Array<{ network: string }>;
  if (networks && networks.length > 0) {
    providers = networks.map(n => ({ network: upperToLower[n.network] ?? n.network.toLowerCase() }));
  } else {
    const connected = await getConnectedNetworks();
    // Post to every video-friendly platform connected for this brand:
    // Instagram, TikTok, YouTube, and LinkedIn. (Facebook is NOT connected.)
    const allowed = ["INSTAGRAM", "TIKTOK", "YOUTUBE", "LINKEDIN"];
    const seen = new Set<string>();
    providers = connected
      .filter(n => {
        if (!allowed.includes(n.network)) return false;
        if (seen.has(n.network)) return false;
        seen.add(n.network);
        return true;
      })
      .map(n => ({ network: upperToLower[n.network] ?? n.network.toLowerCase() }));
  }

  if (providers.length === 0) {
    return { ok: false, error: "No connected video networks found in Metricool" };
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

  const url = `${BASE}/v2/scheduler/posts?${authParams()}`;
  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });

  const raw = await res.json().catch(() => null);

  if (!res.ok) {
    return {
      ok: false,
      error: `Metricool API error ${res.status}: ${JSON.stringify(raw)}`,
      raw,
    };
  }

  // Extract the created post id from the response
  const postId =
    (raw as Record<string, unknown>)?.id ??
    ((raw as Record<string, unknown>)?.data as Record<string, unknown>)?.id;

  const niceNames: Record<string, string> = {
    instagram: "Instagram",
    tiktok: "TikTok",
    youtube: "YouTube",
    linkedin: "LinkedIn",
    facebook: "Facebook",
  };
  const platforms = providers
    .map(p => niceNames[p.network.toLowerCase()] ?? p.network)
    .filter((v, i, a) => a.indexOf(v) === i)
    .join(", ");

  return {
    ok: true,
    postId: typeof postId === "number" ? postId : undefined,
    raw,
    platforms,
  };
}
