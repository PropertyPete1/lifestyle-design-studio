/**
 * LinkedIn analytics sync for the self-improving recruiting-post writer.
 *
 * Pulls per-post engagement from Metricool for EVERY LinkedIn brand, matches
 * each analytics row back to the day's stored post (by the LinkedIn post URN we
 * saved in linkedin_posts.brandResults[].postId), sums impressions / reactions
 * / comments / shares across all brands, and writes the totals onto that day's
 * linkedin_posts row. The writer (linkedinAuthor.ts) then uses those real
 * numbers to gently favor the angles that perform best.
 *
 * Metricool endpoint (verified live):
 *   GET /v2/analytics/posts/linkedin?from&to&blogId&userId&timezone
 *   -> data[] of { postId (urn), created.dateTime, impressions, uniqueImpressions,
 *      engagement, reactions?, comments?, shares?, comment (text) }
 * New brands with no history return { data: [] }.
 */

import { ENV } from "./_core/env";
import { getLinkedinBrands } from "./metricool";
import * as db from "./db";

const BASE = "https://app.metricool.com/api";

function authHeaders() {
  return {
    "Content-Type": "application/json",
    "X-Mc-Auth": ENV.metricoolApiToken,
  };
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 19);
}

/** One normalized LinkedIn analytics row for a single brand's single post. */
export interface LinkedinMetricRow {
  blogId: number;
  brandLabel: string;
  postUrn: string;
  impressions: number;
  reactions: number;
  comments: number;
  shares: number;
}

/**
 * Read engagement numbers from a raw Metricool LinkedIn analytics record,
 * tolerating the several shapes the API uses as a post accrues engagement.
 */
function readEngagement(x: Record<string, unknown>): Omit<LinkedinMetricRow, "blogId" | "brandLabel" | "postUrn"> {
  const num = (...keys: string[]): number => {
    for (const k of keys) {
      const v = x[k];
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
    }
    return 0;
  };
  return {
    impressions: Math.round(num("impressions", "uniqueImpressions", "views")),
    reactions: Math.round(num("reactions", "likes", "totalReactions")),
    comments: Math.round(num("comments", "commentCount")),
    shares: Math.round(num("shares", "shareCount", "reposts")),
  };
}

function extractUrn(x: Record<string, unknown>): string {
  return String(x.postId ?? x.id ?? x.shareId ?? "").trim();
}

/** Fetch LinkedIn analytics for one brand over [from, to]. Best-effort. */
async function fetchBrandLinkedin(
  blogId: number,
  brandLabel: string,
  from: Date,
  to: Date
): Promise<LinkedinMetricRow[]> {
  const url =
    `${BASE}/v2/analytics/posts/linkedin?from=${fmtDate(from)}&to=${fmtDate(to)}` +
    `&blogId=${blogId}&userId=${ENV.metricoolUserId}&timezone=America/Chicago`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) return [];
  const json = (await res.json().catch(() => null)) as { data?: Record<string, unknown>[] } | null;
  const data = json?.data ?? [];
  const rows: LinkedinMetricRow[] = [];
  for (const x of data) {
    const postUrn = extractUrn(x);
    if (!postUrn) continue;
    rows.push({ blogId, brandLabel, postUrn, ...readEngagement(x) });
  }
  return rows;
}

/** The postId (urn) shape stored per brand in linkedin_posts.brandResults. */
interface StoredBrandResult {
  blogId: number;
  label: string;
  ok: boolean;
  postId?: string | null;
  publishAt?: string;
  error?: string;
}

function parseBrandResults(raw: string | null | undefined): StoredBrandResult[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as StoredBrandResult[]) : [];
  } catch {
    return [];
  }
}

export interface LinkedinSyncSummary {
  brandsChecked: number;
  analyticsRows: number;
  postsUpdated: number;
  details: Array<{
    postDate: string;
    matchedBrands: number;
    impressions: number;
    reactions: number;
    comments: number;
    shares: number;
  }>;
}

/**
 * Sync engagement for recent LinkedIn posts. Looks back `days` days, fetches
 * analytics for every LinkedIn brand, then for each stored post row sums the
 * engagement of its per-brand URNs and writes the totals back. Idempotent:
 * re-running simply refreshes the numbers to the latest snapshot.
 */
export async function syncLinkedinAnalytics(days = 60): Promise<LinkedinSyncSummary> {
  const brands = await getLinkedinBrands();
  const to = new Date();
  const from = new Date(Date.now() - days * 24 * 3600 * 1000);

  // 1) Pull analytics for every brand and index by postUrn.
  const byUrn = new Map<string, LinkedinMetricRow>();
  let analyticsRows = 0;
  for (const b of brands) {
    try {
      const rows = await fetchBrandLinkedin(b.blogId, b.label, from, to);
      analyticsRows += rows.length;
      for (const r of rows) byUrn.set(r.postUrn, r);
    } catch (err) {
      console.warn(`[linkedin-analytics] fetch failed for ${b.label}:`, err);
    }
  }

  // 2) For each recent stored post, sum engagement across its brand URNs.
  const posts = await db.getRecentLinkedinPosts(Math.max(30, days));
  const details: LinkedinSyncSummary["details"] = [];
  let postsUpdated = 0;

  for (const post of posts) {
    const brandResults = parseBrandResults(post.brandResults);
    const urns = brandResults.map(br => (br.postId ? String(br.postId).trim() : "")).filter(Boolean);
    if (urns.length === 0) continue;

    let impressions = 0;
    let reactions = 0;
    let comments = 0;
    let shares = 0;
    let matchedBrands = 0;
    for (const urn of urns) {
      const m = byUrn.get(urn);
      if (!m) continue;
      matchedBrands += 1;
      impressions += m.impressions;
      reactions += m.reactions;
      comments += m.comments;
      shares += m.shares;
    }
    if (matchedBrands === 0) continue;

    // Only write if something changed (avoid needless updates).
    if (
      post.impressions !== impressions ||
      post.reactions !== reactions ||
      post.comments !== comments ||
      post.shares !== shares
    ) {
      await db.updateLinkedinPost(post.id, { impressions, reactions, comments, shares });
      postsUpdated += 1;
    }
    details.push({ postDate: post.postDate, matchedBrands, impressions, reactions, comments, shares });
  }

  return {
    brandsChecked: brands.length,
    analyticsRows,
    postsUpdated,
    details,
  };
}
