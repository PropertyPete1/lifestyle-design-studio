/**
 * The learn step — join, score, rank, brief.
 *
 * The property under test throughout is HONESTY: an absent metric never
 * becomes a zero, a post with no analytics is reported rather than scored,
 * an axis value with too little data is never ranked and never killed, and
 * the brief says out loud what was inferred versus measured.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeLine,
  linesMatch,
  joinPostsToAnalytics,
  scoreRow,
  scoreJoinedPost,
  rankAxis,
  killListFrom,
  buildBrief,
  renderBriefEmail,
  generationFor,
  MIN_SAMPLE,
} from "../src/learn.js";

const NOW = new Date("2026-08-29T12:00:00.000Z");

const entry = (over = {}) => ({
  driveFileId: "f1",
  fileName: "a.mp4",
  city: "san_antonio",
  slot: "am",
  caption: "would you believe this is brand new construction in San Antonio?\n\nbody text",
  timestamp: "2026-08-25T16:05:00.000Z",
  success: true,
  ...over,
});

const igRow = (over = {}, metrics = {}) => ({
  platform: "instagram",
  account: "acct_main",
  kind: "reel",
  post_id: "111",
  published: "2026-08-25T16:10:00.000Z",
  slug: "would you believe this is brand new construction in San Antonio?",
  url: "https://instagram.com/reel/x",
  metrics: {
    views: 1000, reach: 800, likes: 20, comments: 2, shares: 4, saves: 6,
    interactions: 32, avg_watch_seconds: 10, duration_seconds: 20,
    ...metrics,
  },
  ...over,
});

describe("line matching", () => {
  test("normalization strips the clip ellipsis and punctuation variance", () => {
    assert.equal(
      normalizeLine("I've never seen finishes like this…"),
      normalizeLine("I've never seen finishes like this")
    );
  });

  test("a clipped slug prefix-matches the full first line", () => {
    const full = "I've never seen finishes like this at this price point in San Antonio. New construction starting at $309,990 doesn't sit";
    const clipped = "I've never seen finishes like this at this price point in San Antonio. New construction starting at $309,990 doesn't si…";
    assert.ok(linesMatch(full, clipped));
  });

  test("short lines must match exactly, not by prefix", () => {
    assert.ok(!linesMatch("wait for it", "wait for it and the rest of a much longer caption line"));
  });

  test("different captions do not match", () => {
    assert.ok(!linesMatch(
      "would you believe this is brand new construction?",
      "this might be the best new build I've toured"
    ));
  });
});

describe("the join", () => {
  test("a row joins its entry by first line + time window", () => {
    const log = { posts: [entry()] };
    const analytics = { recent_posts: [igRow()] };
    const { joined, unjoined_entries } = joinPostsToAnalytics({ log, analytics, now: NOW });
    assert.equal(joined.length, 1);
    assert.equal(joined[0].rows.length, 1);
    assert.equal(unjoined_entries.length, 0);
  });

  test("a matching line OUTSIDE the time window does not join (caption reuse)", () => {
    const log = { posts: [entry({ timestamp: "2026-08-25T16:05:00.000Z" })] };
    const analytics = { recent_posts: [igRow({ published: "2026-08-10T16:10:00.000Z" })] };
    const { joined, unjoined_entries, unattributed_rows } = joinPostsToAnalytics({ log, analytics, now: NOW });
    assert.equal(joined.length, 0);
    assert.equal(unjoined_entries.length, 1);
    assert.equal(unattributed_rows, 1);
  });

  test("with two entries sharing a first line, a row joins the NEAREST in time", () => {
    const early = entry({ driveFileId: "early", timestamp: "2026-08-22T16:00:00.000Z" });
    const late = entry({ driveFileId: "late", timestamp: "2026-08-25T16:00:00.000Z" });
    const log = { posts: [early, late] };
    const analytics = { recent_posts: [igRow({ published: "2026-08-25T16:20:00.000Z" })] };
    const { joined } = joinPostsToAnalytics({ log, analytics, now: NOW });
    const winner = joined.find((jp) => jp.rows.length === 1);
    assert.equal(winner.entry.driveFileId, "late");
  });

  test("a posted reel with no rows is reported unjoined, never scored", () => {
    const log = { posts: [entry()] };
    const analytics = { recent_posts: [] };
    const { joined, unjoined_entries } = joinPostsToAnalytics({ log, analytics, now: NOW });
    assert.equal(joined.length, 0);
    assert.equal(unjoined_entries.length, 1);
    assert.match(unjoined_entries[0].reason, /no analytics rows/);
  });

  test("linkedin entries, receipts and failed posts are not candidates", () => {
    const log = {
      posts: [
        entry({ type: "linkedin" }),
        entry({ platform: "instagram_main_native", city: null, slot: null }),
        entry({ success: false }),
      ],
    };
    const { joined, unjoined_entries } = joinPostsToAnalytics({ log, analytics: { recent_posts: [] }, now: NOW });
    assert.equal(joined.length + unjoined_entries.length, 0);
  });
});

describe("generation provenance", () => {
  test("a tagged entry answers from its tag", () => {
    const g = generationFor(entry({ generation: { hook_style: "stat", caption_length_bucket: "short" } }));
    assert.deepEqual(g, { provenance: "tagged", hook_style: "stat", caption_length_bucket: "short", hook_plate_burned: null });
  });

  test("a legacy-tagged style maps to canonical but stays 'tagged'", () => {
    const g = generationFor(entry({ generation: { hook_style: "vibe" } }));
    assert.equal(g.hook_style, "pov");
    assert.equal(g.provenance, "tagged");
  });

  test("an untagged entry is classified from its caption and marked inferred", () => {
    const g = generationFor(entry());
    assert.equal(g.provenance, "inferred");
    assert.equal(g.hook_style, "question");
    assert.equal(g.caption_length_bucket, null);
  });

  test("an unclassifiable untagged entry yields null, not a guess", () => {
    const g = generationFor(entry({ caption: "brand new construction available now\nbody" }));
    assert.equal(g.hook_style, null);
  });
});

describe("scoring honesty", () => {
  test("full metrics: retention factor applies and nothing is missing except nothing", () => {
    const s = scoreRow(igRow());
    // base = 1000 + 20*5 + 2*10 + 4*15 + 6*8 = 1228; retention 10/20=0.5 → factor 1.0
    assert.equal(s.retention_factor, 1.0);
    assert.equal(s.score, 1228);
    assert.equal(s.partial, false);
  });

  test("absent watch time means factor exactly 1 and 'retention' listed missing", () => {
    const s = scoreRow(igRow({}, { avg_watch_seconds: undefined }));
    assert.equal(s.retention_factor, 1);
    assert.ok(s.missing.includes("retention"));
    assert.equal(s.partial, true);
  });

  test("a TikTok-shaped row (no saves, no reach) scores without inventing them", () => {
    const row = {
      platform: "tiktok",
      slug: "x",
      published: "2026-08-25T16:00:00.000Z",
      metrics: { views: 200, likes: 4, comments: 0, shares: 0, duration_seconds: 20 },
    };
    const s = scoreRow(row);
    assert.equal(s.score, 220); // 200 + 4*5, no saves term, no retention factor
    assert.ok(s.missing.includes("saves"));
    assert.ok(s.missing.includes("retention"));
    assert.equal(s.engagement_per_reach, null);
  });

  test("retention factor is clamped: watch time beyond 1.5× duration caps at 2.0", () => {
    const s = scoreRow(igRow({}, { avg_watch_seconds: 60, duration_seconds: 20 }));
    assert.equal(s.retention_factor, 2.0);
  });
});

describe("post-level scoring", () => {
  test("the headline is the MEDIAN across Instagram accounts", () => {
    const jp = {
      rows: [
        igRow({ account: "a" }, { views: 100, likes: 0, comments: 0, shares: 0, saves: 0, avg_watch_seconds: 10, duration_seconds: 20 }),
        igRow({ account: "b" }, { views: 300, likes: 0, comments: 0, shares: 0, saves: 0, avg_watch_seconds: 10, duration_seconds: 20 }),
        igRow({ account: "c" }, { views: 10000, likes: 0, comments: 0, shares: 0, saves: 0, avg_watch_seconds: 10, duration_seconds: 20 }),
      ],
    };
    const { headline, basis } = scoreJoinedPost(jp);
    assert.equal(basis, "instagram_median");
    assert.equal(headline, 300); // the 10k outlier account does not drag the mean
  });

  test("with no IG rows, TikTok carries the headline and says so", () => {
    const jp = {
      rows: [{ platform: "tiktok", metrics: { views: 200, likes: 4, comments: 0, shares: 0 } }],
    };
    const { headline, basis } = scoreJoinedPost(jp);
    assert.equal(basis, "tiktok_median");
    assert.equal(headline, 220);
  });
});

describe("ranking", () => {
  const posts = (pairs) => pairs.map(([value, score]) => ({ value, score }));

  test(`below ${MIN_SAMPLE} samples a value is insufficient_sample — never ranked, never killed`, () => {
    const table = rankAxis(posts([
      ["question", 1000], ["question", 900], ["question", 1100],
      ["stat", 1],
    ]));
    assert.equal(table.stat.verdict, "insufficient_sample");
    assert.equal(table.question.verdict, "winner");
  });

  test("a sufficiently-sampled value far below the median is killed", () => {
    const table = rankAxis(posts([
      ["question", 1000], ["question", 1000], ["question", 1000],
      ["pov", 10], ["pov", 20], ["pov", 30],
    ]));
    assert.equal(table.pov.verdict, "kill");
    assert.equal(table.question.verdict, "winner");
  });

  test("an uncontrolled axis (posting slots) never produces a kill", () => {
    const table = rankAxis(posts([
      ["am", 1000], ["am", 1000], ["am", 1000],
      ["pm", 10], ["pm", 20], ["pm", 30],
    ]), { controlled: false });
    assert.notEqual(table.pm.verdict, "kill");
  });

  test("null axis values are dropped, not grouped", () => {
    const table = rankAxis(posts([[null, 500], ["question", 800], ["question", 700], ["question", 900]]));
    assert.deepEqual(Object.keys(table), ["question"]);
  });

  test("killListFrom names the axis and carries the sample size", () => {
    const table = rankAxis(posts([
      ["question", 1000], ["question", 1000], ["question", 1000],
      ["pov", 10], ["pov", 20], ["pov", 30],
    ]));
    const kills = killListFrom(table, "hook_style");
    assert.equal(kills.length, 1);
    assert.equal(kills[0].value, "pov");
    assert.equal(kills[0].n, 3);
    assert.match(kills[0].reason, /below/);
  });
});

describe("the brief", () => {
  const makeLogAndAnalytics = () => {
    const posts = [];
    const rows = [];
    const styles = ["question", "bold_claim", "stat"];
    for (let i = 0; i < 9; i++) {
      const style = styles[i % 3];
      const line = `hook number ${i} for style ${style} with plenty of overlap text`;
      const ts = `2026-08-${String(10 + i).padStart(2, "0")}T16:00:00.000Z`;
      posts.push(entry({
        driveFileId: `f${i}`,
        caption: `${line}\nbody`,
        timestamp: ts,
        generation: { hook_style: style, caption_length_bucket: "short", caption_source: "fresh" },
      }));
      rows.push(igRow(
        { post_id: `p${i}`, slug: line, published: ts.replace("16:00", "16:10") },
        { views: style === "stat" ? 2000 : 100 }
      ));
    }
    return {
      log: { posts },
      analytics: { recent_posts: rows, unavailable: [{ metric: "followers", platforms: ["instagram"], reason: "x", probed: "2026-08-12" }] },
    };
  };

  test("shape, winner, and unavailable metrics carried forward", () => {
    const { log, analytics } = makeLogAndAnalytics();
    const brief = buildBrief({ brand: "lifestyle", log, analytics, now: NOW });
    assert.equal(brief.brand, "lifestyle");
    assert.equal(brief.sample.posts_scored, 9);
    assert.equal(brief.sample.provenance.tagged, 9);
    assert.equal(brief.hook_styles.stat.verdict, "winner");
    assert.equal(brief.posting_slots.analyzed_only, true);
    assert.deepEqual(brief.unavailable, [{ metric: "followers", platforms: ["instagram"] }]);
    assert.equal(brief.guidance.exploit_ratio, 0.7);
    assert.ok(brief.top_hooks.length > 0);
    assert.ok(brief.top_hooks[0].hook.includes("stat"), "top hook verbatim comes from the winning posts");
  });

  test("caveats state sample thresholds and the cron-owned slots", () => {
    const { log, analytics } = makeLogAndAnalytics();
    const brief = buildBrief({ brand: "lifestyle", log, analytics, now: NOW });
    assert.ok(brief.caveats.some((c) => c.includes("insufficient_sample")));
    assert.ok(brief.caveats.some((c) => c.includes("cron")));
  });

  test("inferred posts are counted separately and produce a caveat", () => {
    const { log, analytics } = makeLogAndAnalytics();
    delete log.posts[0].generation; // now inferred (unclassifiable line → null style)
    const brief = buildBrief({ brand: "lifestyle", log, analytics, now: NOW });
    assert.equal(brief.sample.provenance.inferred, 1);
    assert.ok(brief.caveats.some((c) => c.includes("inferred")));
  });

  test("the rendered email is one page, names the kill list, and states 70/30", () => {
    const { log, analytics } = makeLogAndAnalytics();
    const brief = buildBrief({ brand: "lifestyle", log, analytics, now: NOW });
    const email = renderBriefEmail(brief);
    assert.ok(email.includes("WHAT'S WORKING"));
    assert.ok(email.includes("KILL LIST"));
    assert.ok(email.includes("70%"));
    assert.ok(email.includes("CAVEATS"));
    assert.ok(email.includes("NOT MEASURABLE"));
    assert.ok(email.split("\n").length < 80, "the brief stays one page");
  });
});
