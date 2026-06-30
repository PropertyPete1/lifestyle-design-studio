/**
 * Metricool API helper.
 * Docs: https://app.metricool.com/resources/apidocs/index.html
 * Auth: X-Mc-Auth header + blogId + userId query params on every request.
 */

import { ENV } from "./_core/env";

const BASE = "https://app.metricool.com/api";

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
}

export interface CreatePostResult {
  ok: boolean;
  postId?: number;
  error?: string;
  raw?: unknown;
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
  } = opts;

  // Resolve which networks to post to
  let providers: Array<{ network: string; id: string; status: string }>;
  if (networks && networks.length > 0) {
    providers = networks.map(n => ({ ...n, status: "PENDING" }));
  } else {
    const connected = await getConnectedNetworks();
    // Post to video-friendly platforms that are confirmed connected for this brand:
    // Instagram, TikTok, YouTube (Facebook is NOT connected in Metricool for this brand)
    const videoNetworks = connected.filter(n =>
      ["INSTAGRAM", "TIKTOK", "YOUTUBE"].includes(n.network)
    );
    providers = videoNetworks.map(n => ({ ...n, status: "PENDING" }));
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
    media: [videoUrl],
    autoPublish: true,
    saveExternalMediaFiles: true,
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

  return {
    ok: true,
    postId: typeof postId === "number" ? postId : undefined,
    raw,
  };
}
