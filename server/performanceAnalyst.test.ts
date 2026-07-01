import { describe, it, expect } from "vitest";
import { analyzeMetrics } from "./performanceAnalyst";
import type { NormalizedMetric } from "./metricoolAnalytics";

function m(partial: Partial<NormalizedMetric>): NormalizedMetric {
  return {
    network: "instagram",
    blogId: 1,
    brandLabel: "brandA",
    networkPostId: Math.random().toString(36).slice(2),
    captionSnippet: "caption",
    publishedAtMs: Date.now(),
    views: 100,
    reach: 90,
    likes: 5,
    comments: 0,
    shares: 0,
    saved: 0,
    skipRate: 65,
    avgWatchTimeSec: 4,
    ...partial,
  };
}

describe("analyzeMetrics", () => {
  it("computes a per-brand median from that brand's own posts", () => {
    const metrics = [
      m({ brandLabel: "big", views: 1000 }),
      m({ brandLabel: "big", views: 2000 }),
      m({ brandLabel: "big", views: 3000 }),
      m({ brandLabel: "small", views: 100 }),
      m({ brandLabel: "small", views: 150 }),
      m({ brandLabel: "small", views: 200 }),
    ];
    const a = analyzeMetrics(metrics);
    expect(a.brandMedians.big).toBe(2000);
    expect(a.brandMedians.small).toBe(150);
  });

  it("flags a post well below its OWN brand median (not the flagship's)", () => {
    const metrics = [
      m({ brandLabel: "big", views: 4000 }),
      m({ brandLabel: "big", views: 4000 }),
      m({ brandLabel: "big", views: 4000 }),
      // small brand: median 150; a 40-view post is 0.27x -> flagged.
      m({ brandLabel: "small", views: 150 }),
      m({ brandLabel: "small", views: 150 }),
      m({ brandLabel: "small", views: 40, networkPostId: "weak" }),
    ];
    const a = analyzeMetrics(metrics);
    // The 40-view small-brand post is flagged; the 150-view small posts are NOT
    // flagged even though they're far below the big brand.
    expect(a.flagged.some(f => f.networkPostId === "weak" || f.views === 40)).toBe(true);
    expect(a.flagged.some(f => f.brand === "big")).toBe(false);
  });

  it("does not flag brands with fewer than 3 posts (insufficient baseline)", () => {
    const metrics = [
      m({ brandLabel: "tiny", views: 10 }),
      m({ brandLabel: "tiny", views: 1000 }),
    ];
    const a = analyzeMetrics(metrics);
    expect(a.flagged.length).toBe(0);
  });

  it("surfaces top performers above 1.5x their brand median", () => {
    const metrics = [
      m({ brandLabel: "big", views: 500 }),
      m({ brandLabel: "big", views: 500 }),
      m({ brandLabel: "big", views: 500 }),
      m({ brandLabel: "big", views: 5000, networkPostId: "hit" }),
    ];
    const a = analyzeMetrics(metrics);
    expect(a.topPerformers.some(t => t.views === 5000)).toBe(true);
  });

  it("ignores posts with zero views and non-instagram networks", () => {
    const metrics = [
      m({ brandLabel: "b", views: 0 }),
      m({ brandLabel: "b", network: "linkedin", views: 999 }),
    ];
    const a = analyzeMetrics(metrics);
    expect(a.igCount).toBe(0);
  });
});
