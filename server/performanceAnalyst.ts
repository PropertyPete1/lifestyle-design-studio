/**
 * AI cross-platform performance analyst.
 *
 * Runs on a schedule. Each run:
 *  1. Ingests recent per-post metrics across all brands (Instagram reels +
 *     LinkedIn) from Metricool and stores a daily snapshot in post_metrics.
 *  2. Computes each BRAND's own trailing baseline (median views) so a small
 *     account isn't unfairly compared to the flagship — an underperformer is a
 *     post well below its OWN brand's typical reach.
 *  3. Correlates reach with the levers our diagnosis identified (skip rate,
 *     average watch time) and flags under/over-performers with the numbers.
 *  4. Asks the LLM for a concise, ACTIONABLE strategy update (hook, timing,
 *     caption, differentiation) grounded in those numbers.
 *  5. Persists the insight and notifies the owner.
 *
 * Everything is a single inline LLM call, so it runs inside a Heartbeat HTTP
 * handler (no agent needed) on the Node-only Autoscale runtime.
 */

import { invokeLLM } from "./_core/llm";
import { notifyOwner } from "./_core/notification";
import * as db from "./db";
import {
  ingestAllBrandMetrics,
  type NormalizedMetric,
} from "./metricoolAnalytics";
import type { InsertPostMetric } from "../drizzle/schema";

const ANALYST_MODEL = "claude-sonnet-4-6";

function chicagoDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? "01";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

export interface AnalystResult {
  ok: boolean;
  runDate: string;
  ingested: number;
  flaggedCount: number;
  summary: string;
  notified: boolean;
  error?: string;
}

interface FlaggedPost {
  brand: string;
  network: string;
  views: number;
  brandMedian: number;
  ratio: number; // views / brandMedian
  skipRate: number | null;
  avgWatchTimeSec: number | null;
  caption: string;
}

/**
 * Analyze normalized metrics: per-brand median, flag posts under 0.6x their
 * brand median, and surface skip-rate/watch-time correlations.
 */
export function analyzeMetrics(metrics: NormalizedMetric[]) {
  // Instagram is where reach/skip signals live; base the analysis there.
  const ig = metrics.filter(m => m.network === "instagram" && m.views > 0);
  const byBrand = new Map<string, NormalizedMetric[]>();
  for (const m of ig) {
    const arr = byBrand.get(m.brandLabel) ?? [];
    arr.push(m);
    byBrand.set(m.brandLabel, arr);
  }

  const brandMedians: Record<string, number> = {};
  const flagged: FlaggedPost[] = [];
  const topPerformers: FlaggedPost[] = [];

  for (const [brand, posts] of Array.from(byBrand.entries())) {
    const med = median(posts.map((p: NormalizedMetric) => p.views));
    brandMedians[brand] = med;
    for (const p of posts) {
      const ratio = med > 0 ? p.views / med : 1;
      const rec: FlaggedPost = {
        brand,
        network: p.network,
        views: p.views,
        brandMedian: med,
        ratio: Math.round(ratio * 100) / 100,
        skipRate: p.skipRate,
        avgWatchTimeSec: p.avgWatchTimeSec,
        caption: p.captionSnippet,
      };
      if (ratio < 0.6 && posts.length >= 3) flagged.push(rec);
      if (ratio > 1.5 && posts.length >= 3) topPerformers.push(rec);
    }
  }

  // Correlation snapshot: average skip rate of flagged vs top performers.
  const avg = (xs: (number | null)[]) => {
    const v = xs.filter((x): x is number => x != null);
    return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
  };

  return {
    brandMedians,
    flagged: flagged.sort((a, b) => a.ratio - b.ratio),
    topPerformers: topPerformers.sort((a, b) => b.ratio - a.ratio),
    flaggedAvgSkip: avg(flagged.map(f => f.skipRate)),
    topAvgSkip: avg(topPerformers.map(f => f.skipRate)),
    igCount: ig.length,
  };
}

function buildDataForPrompt(analysis: ReturnType<typeof analyzeMetrics>) {
  return {
    brandMedians: analysis.brandMedians,
    flaggedAvgSkipRate: analysis.flaggedAvgSkip,
    topPerformerAvgSkipRate: analysis.topAvgSkip,
    underperformers: analysis.flagged.slice(0, 8).map(f => ({
      brand: f.brand,
      views: f.views,
      brandMedian: f.brandMedian,
      vsMedian: f.ratio,
      skipRate: f.skipRate,
      avgWatchTimeSec: f.avgWatchTimeSec,
      caption: f.caption,
    })),
    topPerformers: analysis.topPerformers.slice(0, 5).map(f => ({
      brand: f.brand,
      views: f.views,
      vsMedian: f.ratio,
      skipRate: f.skipRate,
      caption: f.caption,
    })),
  };
}

async function generateStrategy(
  analysis: ReturnType<typeof analyzeMetrics>
): Promise<string> {
  const data = buildDataForPrompt(analysis);
  const prompt =
    "You are the performance analyst for an Instagram Reels auto-poster that reposts real-estate " +
    "reels for Lifestyle Design Realty across multiple Instagram brands (plus TikTok/YouTube/LinkedIn) " +
    "in San Antonio, Austin, and Dallas-Fort Worth.\n\n" +
    "Goal: increase VIEWS on all platforms. Key facts already established:\n" +
    "- Reach is driven mostly by SKIP RATE (viewers swiping away early) and hook strength, not by the video file bytes.\n" +
    "- Each brand has a different audience size, so judge a post against its OWN brand median (vsMedian), not raw views.\n" +
    "- Captions may be reworded but hashtags and calls-to-action are NEVER changed; the brand prefers 'Comment' CTAs over 'DM'.\n\n" +
    "Here is the latest data (JSON):\n" +
    JSON.stringify(data, null, 2) +
    "\n\nWrite a SHORT owner-facing report in Markdown with these sections:\n" +
    "1. **What's working** (1-2 bullet points, cite numbers).\n" +
    "2. **What's underperforming** (1-2 bullet points, cite skip rate / vsMedian).\n" +
    "3. **Do this next** (2-4 concrete, specific actions to raise views — e.g. hook/first-frame, posting time, caption angle). " +
    "Be specific and practical. No fluff, no hashtags, under 180 words total.";

  try {
    const res = await invokeLLM({
      model: ANALYST_MODEL,
      messages: [{ role: "user", content: prompt }],
      maxTokens: 700,
    });
    const raw = res.choices?.[0]?.message?.content;
    const text = typeof raw === "string" ? raw.trim() : "";
    return text || "No strategy generated.";
  } catch (err) {
    console.error("[analyst] LLM failed:", err);
    // Deterministic fallback so the run still produces a useful report.
    const worst = analysis.flagged[0];
    const parts = [
      "### Performance summary (fallback)",
      `- Tracked ${analysis.igCount} Instagram reels across brands.`,
      analysis.flaggedAvgSkip != null
        ? `- Underperformers average a ${analysis.flaggedAvgSkip}% skip rate vs ${analysis.topAvgSkip ?? "?"}% for top performers.`
        : "",
      worst
        ? `- Weakest recent reel: ${worst.brand} at ${worst.views} views (${Math.round(worst.ratio * 100)}% of its median).`
        : "",
      "- Next: tighten the first 1-2 seconds (stronger hook / cleaner opening frame) to lower skip rate; keep posting at 2/3/4 PM CDT.",
    ].filter(Boolean);
    return parts.join("\n");
  }
}

/**
 * Full analyst run: ingest -> persist -> analyze -> LLM strategy -> save -> notify.
 * `days` controls the lookback window.
 */
export async function runPerformanceAnalyst(days = 5): Promise<AnalystResult> {
  const runDate = chicagoDate();
  try {
    const metrics = await ingestAllBrandMetrics(days);

    // Persist a daily snapshot for every post.
    for (const m of metrics) {
      const row: InsertPostMetric = {
        network: m.network,
        blogId: m.blogId,
        brandLabel: m.brandLabel,
        networkPostId: m.networkPostId,
        captionSnippet: m.captionSnippet,
        publishedAt: m.publishedAtMs ?? undefined,
        views: m.views,
        reach: m.reach,
        likes: m.likes,
        comments: m.comments,
        shares: m.shares,
        saved: m.saved,
        skipRate: m.skipRate ?? undefined,
        avgWatchTimeSec: m.avgWatchTimeSec ?? undefined,
        isAutoPost: 0,
        capturedOn: runDate,
      };
      await db.upsertPostMetric(row);
    }

    const analysis = analyzeMetrics(metrics);
    const summary = await generateStrategy(analysis);

    await db.saveAnalystInsight({
      runDate,
      summary,
      data: JSON.stringify(buildDataForPrompt(analysis)),
    });

    let notified = false;
    try {
      notified = await notifyOwner({
        title: `Reels performance report — ${runDate}`,
        content: summary,
      });
    } catch (err) {
      console.warn("[analyst] notifyOwner failed:", err);
    }

    return {
      ok: true,
      runDate,
      ingested: metrics.length,
      flaggedCount: analysis.flagged.length,
      summary,
      notified,
    };
  } catch (err) {
    const e = err as Error;
    return {
      ok: false,
      runDate,
      ingested: 0,
      flaggedCount: 0,
      summary: "",
      notified: false,
      error: e.message,
    };
  }
}
