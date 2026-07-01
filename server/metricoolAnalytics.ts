/**
 * Metricool analytics ingest for the AI performance analyst.
 *
 * Pulls per-post performance for a date window from Metricool's analytics
 * endpoints, across ALL brands on the account, and normalizes them into a
 * common shape the analyst + post_metrics table can consume.
 *
 * Endpoints (verified against swagger + live):
 *   GET /v2/analytics/reels/instagram?from&to&blogId&userId&timezone
 *       -> data[] of InstagramReel { reelId, publishedAt, content, views, reach,
 *          likes, comments, shares, saved, reelsSkipRate, averageWatchTime, ... }
 *   GET /v2/analytics/posts/linkedin?from&to&blogId&userId  -> LinkedIn posts
 * TikTok analytics is CSV-only on this account tier, so we skip it for ingest
 * (IG is the primary reach signal anyway).
 */

import { ENV } from "./_core/env";
import { getAllBrands } from "./metricool";

const BASE = "https://app.metricool.com/api";

function authHeaders() {
  return {
    "Content-Type": "application/json",
    "X-Mc-Auth": ENV.metricoolApiToken,
  };
}

export interface NormalizedMetric {
  network: string;
  blogId: number;
  brandLabel: string;
  networkPostId: string;
  captionSnippet: string;
  publishedAtMs: number | null;
  views: number;
  reach: number;
  likes: number;
  comments: number;
  shares: number;
  saved: number;
  skipRate: number | null;
  avgWatchTimeSec: number | null;
}

function toMs(publishedAt: unknown): number | null {
  if (!publishedAt) return null;
  if (typeof publishedAt === "string") {
    const t = Date.parse(publishedAt);
    return Number.isNaN(t) ? null : t;
  }
  if (typeof publishedAt === "object") {
    const dt = (publishedAt as Record<string, unknown>).dateTime;
    if (typeof dt === "string") {
      const t = Date.parse(dt);
      return Number.isNaN(t) ? null : t;
    }
  }
  return null;
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 19);
}

/** Fetch Instagram reel metrics for one brand over [from, to]. */
async function fetchInstagramReels(
  blogId: number,
  brandLabel: string,
  from: Date,
  to: Date
): Promise<NormalizedMetric[]> {
  const url =
    `${BASE}/v2/analytics/reels/instagram?from=${fmtDate(from)}&to=${fmtDate(to)}` +
    `&blogId=${blogId}&userId=${ENV.metricoolUserId}&timezone=America/Chicago`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) return [];
  const json = (await res.json()) as { data?: Record<string, unknown>[] };
  const data = json.data ?? [];
  return data.map(x => ({
    network: "instagram",
    blogId,
    brandLabel,
    networkPostId: String(x.reelId ?? ""),
    captionSnippet: String(x.content ?? "").replace(/\s+/g, " ").slice(0, 120),
    publishedAtMs: toMs(x.publishedAt),
    views: Number(x.views ?? 0),
    reach: Number(x.reach ?? 0),
    likes: Number(x.likes ?? 0),
    comments: Number(x.comments ?? 0),
    shares: Number(x.shares ?? 0),
    saved: Number(x.saved ?? 0),
    skipRate: x.reelsSkipRate != null ? Math.round(Number(x.reelsSkipRate)) : null,
    avgWatchTimeSec: x.averageWatchTime != null ? Math.round(Number(x.averageWatchTime)) : null,
  }));
}

/** Fetch LinkedIn post metrics for one brand over [from, to]. */
async function fetchLinkedinPosts(
  blogId: number,
  brandLabel: string,
  from: Date,
  to: Date
): Promise<NormalizedMetric[]> {
  const url =
    `${BASE}/v2/analytics/posts/linkedin?from=${fmtDate(from)}&to=${fmtDate(to)}` +
    `&blogId=${blogId}&userId=${ENV.metricoolUserId}&timezone=America/Chicago`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) return [];
  const json = (await res.json()) as { data?: Record<string, unknown>[] };
  const data = json.data ?? [];
  return data.map(x => ({
    network: "linkedin",
    blogId,
    brandLabel,
    networkPostId: String(x.id ?? x.postId ?? x.shareId ?? ""),
    captionSnippet: String(x.content ?? x.text ?? "").replace(/\s+/g, " ").slice(0, 120),
    publishedAtMs: toMs(x.publishedAt ?? x.date),
    views: Number(x.views ?? x.impressions ?? 0),
    reach: Number(x.reach ?? x.impressions ?? 0),
    likes: Number(x.likes ?? x.reactions ?? 0),
    comments: Number(x.comments ?? 0),
    shares: Number(x.shares ?? 0),
    saved: 0,
    skipRate: null,
    avgWatchTimeSec: null,
  })).filter(m => m.networkPostId);
}

/**
 * Ingest metrics across ALL brands for the last `days` days. Instagram reels are
 * the primary signal; LinkedIn is included best-effort. Returns the normalized
 * rows (caller persists + analyzes).
 */
export async function ingestAllBrandMetrics(days = 5): Promise<NormalizedMetric[]> {
  const brands = await getAllBrands();
  const to = new Date();
  const from = new Date(Date.now() - days * 24 * 3600 * 1000);
  const all: NormalizedMetric[] = [];
  for (const b of brands) {
    try {
      const ig = await fetchInstagramReels(b.blogId, b.label, from, to);
      all.push(...ig);
    } catch (err) {
      console.warn(`[analytics] IG reels failed for ${b.label}:`, err);
    }
    if (b.networks.includes("LINKEDIN")) {
      try {
        const li = await fetchLinkedinPosts(b.blogId, b.label, from, to);
        all.push(...li);
      } catch (err) {
        console.warn(`[analytics] LinkedIn failed for ${b.label}:`, err);
      }
    }
  }
  return all.filter(m => m.networkPostId);
}
