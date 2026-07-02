import { describe, it, expect } from "vitest";
import {
  engagementScore,
  pickTopicForDate,
  topicForDate,
  WEIGHTING_MIN_POSTS,
} from "./linkedinAuthor";
import { LINKEDIN_TOPICS } from "../shared/const";

const KEYS = LINKEDIN_TOPICS.map(t => t.key);

describe("engagementScore", () => {
  it("weights comments and shares far above impressions", () => {
    const passive = engagementScore({ impressions: 1000, reactions: 0, comments: 0, shares: 0 });
    const active = engagementScore({ impressions: 0, reactions: 0, comments: 3, shares: 1 });
    expect(active).toBeGreaterThan(passive);
  });

  it("treats null/undefined engagement as zero", () => {
    expect(engagementScore({})).toBe(0);
    expect(engagementScore({ impressions: null, reactions: null, comments: null, shares: null })).toBe(0);
  });
});

describe("pickTopicForDate — thin data guard", () => {
  it("falls back to the even rotation when there is not enough engagement data", () => {
    // No history at all -> identical to the deterministic rotation.
    const date = "2026-07-10";
    expect(pickTopicForDate(date, []).key).toBe(topicForDate(date).key);
  });

  it("still uses even rotation when posts exist but none have engagement", () => {
    const history = KEYS.map((topic, i) => ({
      topic,
      impressions: 0,
      reactions: 0,
      comments: 0,
      shares: 0,
      _i: i,
    }));
    const date = "2026-08-01";
    expect(pickTopicForDate(date, history).key).toBe(topicForDate(date).key);
  });
});

describe("pickTopicForDate — engagement weighting with a floor", () => {
  // Build a history where one angle is a clear winner but every angle has data.
  const winner = KEYS[2];
  const history = [
    ...Array.from({ length: 4 }, () => ({ topic: winner, impressions: 5000, reactions: 200, comments: 80, shares: 40 })),
    ...KEYS.filter(k => k !== winner).map(k => ({ topic: k, impressions: 100, reactions: 2, comments: 0, shares: 0 })),
  ];
  // Ensure we clear the min-data guard.
  expect(history.filter(p => p.reactions > 0 || p.comments > 0).length).toBeGreaterThanOrEqual(WEIGHTING_MIN_POSTS);

  it("is deterministic per date (idempotent generation)", () => {
    const a = pickTopicForDate("2026-09-15", history).key;
    const b = pickTopicForDate("2026-09-15", history).key;
    expect(a).toBe(b);
  });

  it("favors the winning angle more often than any single other angle over a year", () => {
    const counts: Record<string, number> = {};
    for (let d = 1; d <= 365; d++) {
      const date = `2027-01-${String(((d - 1) % 28) + 1).padStart(2, "0")}`;
      // vary month to get 365 distinct day indices
      const month = String(((Math.floor((d - 1) / 28)) % 12) + 1).padStart(2, "0");
      const key = pickTopicForDate(`2027-${month}-${String(((d - 1) % 28) + 1).padStart(2, "0")}`, history).key;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    const winnerCount = counts[winner] ?? 0;
    const others = KEYS.filter(k => k !== winner).map(k => counts[k] ?? 0);
    // Winner should beat every other individual angle.
    expect(winnerCount).toBeGreaterThan(Math.max(...others));
  });

  it("never drops any angle entirely (floor keeps all 6 in rotation)", () => {
    const counts: Record<string, number> = {};
    for (let m = 1; m <= 12; m++) {
      for (let d = 1; d <= 28; d++) {
        const key = pickTopicForDate(
          `2028-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
          history
        ).key;
        counts[key] = (counts[key] ?? 0) + 1;
      }
    }
    for (const k of KEYS) {
      expect(counts[k] ?? 0).toBeGreaterThan(0);
    }
  });
});
