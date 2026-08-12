/**
 * Social analytics collector.
 *
 * Same failure this suite exists to prevent as social-telemetry.test.mjs — a
 * confident wrong number — but the pressure comes from a different direction.
 * The telemetry writer reads files this repo wrote. This one reads a third
 * party's API, which answers 200 to things it cannot actually report, spells
 * the same metric four ways across four networks, and omits fields entirely on
 * platforms that do not have them. Every one of those is an opportunity to
 * write a zero that nobody measured.
 *
 * THE ROW FIXTURES BELOW ARE REAL. They are bytes captured from
 * scripts/probe-social-analytics.mjs against the live account on 2026-08-12,
 * trimmed but not reshaped — including the awkward parts: `publishedAt` as a
 * Europe/Madrid wall clock, TikTok's `viewCount` spelling and total absence of
 * a saves field, and the YouTube rows that carry no `videoType`. A fixture I
 * invented would agree with whatever the normaliser happens to do.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  num,
  instantFrom,
  normalizeInstagramRow,
  normalizeTikTokRow,
  normalizeYouTubeRow,
  buildDailySeries,
  mergeRecentPosts,
  mergeDailySeries,
  buildAnalytics,
  keyOfPost,
  MAX_DAILY_DAYS,
  writeSocialAnalytics,
  collectFromApi,
  ANALYTICS_FILENAME,
  UNAVAILABLE,
  MAX_RECENT_POSTS,
} from "../src/social-analytics.js";

const NOW = new Date("2026-08-12T20:00:00.000Z");

// ── Real captured rows ──────────────────────────────────────────────────────

const IG_REEL_ROW = {
  reelId: "18003853694779811",
  content: "I got tired of doing everything manually… so I built my own employee. 🧠\n\nMeet Lifestyle! the AI brain I engineered from scratch.",
  publishedAt: { dateTime: "2026-08-12T02:53:13", timezone: "Europe/Madrid" },
  views: 505,
  impressionsTotal: 505,
  reach: 346,
  likes: 12,
  comments: 0,
  shares: 2,
  saved: 0,
  interactions: 14,
  engagement: 4.046242774566474,
  averageWatchTime: 8.071,
  durationSeconds: 42,
  reelsSkipRate: 65.7,
  videoViewTotalTime: 2841.184,
  url: "https://www.instagram.com/reel/Db662o-McMN/",
  type: "REELS_VIDEO",
  userId: "Peter Allen",
};

const TIKTOK_ROW = {
  videoId: "7672942722776386830",
  createTime: "2026-08-12T02:56:46+0200",
  viewCount: 146,
  likeCount: 2,
  commentCount: 0,
  shareCount: 0,
  duration: 41,
  engagement: 1.36986301369863,
  videoDescription: "I got tired of doing everything manually… so I built my own employee. 🧠",
  title: "I got tired of doing everything manually…",
  shareUrl: "https://www.tiktok.com/@lifestyledesignrealtytx/video/7672942722776386830?utm_campaign=tt4d_open_api&utm_source=awwuexz9",
  type: "VIDEO",
  impressionSources: { forYou: null, follow: null, hashtag: null, sound: null, personalProfile: null, search: null },
  width: 1080,
  height: 1920,
};

const YOUTUBE_SHORT_ROW = {
  videoId: "qvJs5tIPJME",
  title: "this is what new construction is supposed to feel like",
  description: "new construction like this moves fast. builder incentives are limited.",
  publishedAt: { dateTime: "2026-08-03T21:50:03", timezone: "Europe/Madrid" },
  views: 21,
  likes: 0,
  comments: 0,
  shares: 0,
  dislikes: 0,
  watchMinutes: 1.2842666666666667,
  averageViewDuration: 3.6693333333333333,
  durationSeconds: 36,
  videoType: "SHORT",
  watchUrl: "https://www.youtube.com/watch?v=qvJs5tIPJME",
  hasRevenueData: false,
};

// 136 of the 234 rows the live account returned looked like this: no videoType
// at all. Format unknown — not "not a Short".
const YOUTUBE_UNTYPED_ROW = { ...YOUTUBE_SHORT_ROW, videoId: "AAAAAAAAAAA" };
delete YOUTUBE_UNTYPED_ROW.videoType;

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "social-analytics-"));
  mkdirSync(join(dir, "status"), { recursive: true });
  return dir;
}

/**
 * A fake fetch that routes on URL substring. Anything not matched 404s, so a
 * test only has to describe the endpoints it cares about — and a normaliser
 * that starts calling a new endpoint fails loudly rather than silently.
 */
function fakeFetch(routes) {
  return async (url) => {
    for (const [needle, handler] of Object.entries(routes)) {
      if (url.includes(needle)) {
        const r = typeof handler === "function" ? await handler(url) : handler;
        if (r instanceof Error) throw r;
        return {
          ok: r.status === undefined ? true : r.status >= 200 && r.status < 300,
          status: r.status ?? 200,
          json: async () => r.body,
          text: async () => JSON.stringify(r.body ?? ""),
        };
      }
    }
    return { ok: false, status: 404, json: async () => null, text: async () => "not found" };
  };
}

const ONE_BRAND = [{ id: 111, label: "lifestyledesignrealtytexas", instagram: "ig", tiktok: "tt", youtube: "yt" }];

// ── num ─────────────────────────────────────────────────────────────────────

describe("num — the counted-zero boundary", () => {
  test("a real zero survives as zero", () => {
    // The whole point. The API said 0 comments; that is a measurement.
    assert.equal(num(0), 0);
    assert.equal(num("0"), 0);
  });

  test("absence in every spelling becomes undefined, never zero", () => {
    for (const absent of [null, undefined, "", NaN, "abc", {}, [], true, false]) {
      assert.equal(num(absent), undefined, `${JSON.stringify(absent)} must not become a number`);
    }
  });

  test("numeric strings are read — some Metricool surfaces quote their counts", () => {
    assert.equal(num("42"), 42);
    assert.equal(num("3.5"), 3.5);
  });
});

// ── instantFrom ─────────────────────────────────────────────────────────────

describe("instantFrom — Metricool's wall-clock-plus-zone dates", () => {
  test("reads a Europe/Madrid wall clock as the instant it names", () => {
    // August, so Madrid is CEST (UTC+2). Treating the string as UTC would put
    // this post two hours late — and on the wrong Chicago day.
    const at = instantFrom({ dateTime: "2026-08-12T02:53:13", timezone: "Europe/Madrid" });
    assert.equal(at.toISOString(), "2026-08-12T00:53:13.000Z");
  });

  test("a winter date uses the winter offset, not August's", () => {
    // CET (UTC+1). A fixed-offset shortcut would be an hour out here.
    const at = instantFrom({ dateTime: "2026-01-15T10:00:00", timezone: "Europe/Madrid" });
    assert.equal(at.toISOString(), "2026-01-15T09:00:00.000Z");
  });

  test("TikTok's offset-bearing string is parsed as-is", () => {
    assert.equal(instantFrom("2026-08-12T02:56:46+0200").toISOString(), "2026-08-12T00:56:46.000Z");
  });

  test("unreadable dates are null, so `published` goes absent rather than wrong", () => {
    assert.equal(instantFrom(null), null);
    assert.equal(instantFrom({}), null);
    assert.equal(instantFrom({ dateTime: "not a date", timezone: "Europe/Madrid" }), null);
    assert.equal(instantFrom("nonsense"), null);
  });
});

// ── Normalisers ─────────────────────────────────────────────────────────────

describe("normalizeInstagramRow", () => {
  test("maps the real reel row, saves included", () => {
    const post = normalizeInstagramRow(IG_REEL_ROW, { account: "texas", kind: "reel" });
    assert.equal(post.platform, "instagram");
    assert.equal(post.account, "texas");
    assert.equal(post.post_id, "18003853694779811");
    assert.equal(post.published, "2026-08-12T00:53:13Z");
    assert.equal(post.metrics.views, 505);
    assert.equal(post.metrics.reach, 346);
    assert.equal(post.metrics.likes, 12);
    assert.equal(post.metrics.shares, 2);
    // `saved` in, `saves` out — and both the zeros here are measured.
    assert.equal(post.metrics.saves, 0);
    assert.equal(post.metrics.comments, 0);
  });

  test("the slug is the opening line, not the whole caption", () => {
    const post = normalizeInstagramRow(IG_REEL_ROW, { account: "texas", kind: "reel" });
    assert.equal(post.slug, "I got tired of doing everything manually… so I built my own employee. 🧠");
  });

  test("null metrics are omitted, not zeroed", () => {
    const post = normalizeInstagramRow(
      { ...IG_REEL_ROW, views: null, saved: null, reach: undefined },
      { account: "texas", kind: "reel" }
    );
    assert.ok(!("views" in post.metrics), "a null view count must not become 0");
    assert.ok(!("saves" in post.metrics));
    assert.ok(!("reach" in post.metrics));
    assert.equal(post.metrics.likes, 12, "the metrics that WERE reported still come through");
  });

  test("a row with no id is dropped — there is nothing to key it by", () => {
    assert.equal(normalizeInstagramRow({ ...IG_REEL_ROW, reelId: undefined }, { account: "a", kind: "reel" }), null);
    assert.equal(normalizeInstagramRow(null, { account: "a", kind: "reel" }), null);
  });

  test("feed posts key off postId and are marked as feed", () => {
    const row = { postId: "17903376672531580", content: "Texas sellers are cutting prices", publishedAt: IG_REEL_ROW.publishedAt, views: 1169, likes: 10, saved: 3 };
    const post = normalizeInstagramRow(row, { account: "texas", kind: "feed" });
    assert.equal(post.post_id, "17903376672531580");
    assert.equal(post.kind, "feed");
    assert.equal(post.metrics.views, 1169);
  });
});

describe("normalizeTikTokRow", () => {
  test("maps TikTok's own metric spellings", () => {
    const post = normalizeTikTokRow(TIKTOK_ROW, { account: "texas" });
    assert.equal(post.platform, "tiktok");
    assert.equal(post.post_id, "7672942722776386830");
    assert.equal(post.metrics.views, 146, "viewCount → views");
    assert.equal(post.metrics.likes, 2);
    assert.equal(post.metrics.comments, 0);
    assert.equal(post.metrics.shares, 0);
  });

  test("saves and reach are ABSENT — TikTok has no such field", () => {
    const post = normalizeTikTokRow(TIKTOK_ROW, { account: "texas" });
    assert.ok(!("saves" in post.metrics), "a 0 here would claim nobody saved the video");
    assert.ok(!("reach" in post.metrics));
  });

  test("the tracking query string is stripped from the url", () => {
    const post = normalizeTikTokRow(TIKTOK_ROW, { account: "texas" });
    assert.equal(post.url, "https://www.tiktok.com/@lifestyledesignrealtytx/video/7672942722776386830");
  });
});

describe("normalizeYouTubeRow — Shorts only, and only when it says so", () => {
  test("collects a row marked SHORT", () => {
    const post = normalizeYouTubeRow(YOUTUBE_SHORT_ROW, { account: "texas" });
    assert.equal(post.platform, "youtube_shorts");
    assert.equal(post.post_id, "qvJs5tIPJME");
    assert.equal(post.published, "2026-08-03T19:50:03Z");
    assert.equal(post.metrics.views, 21);
    assert.equal(post.metrics.likes, 0);
    assert.equal(post.metrics.watch_minutes, 1.2842666666666667);
  });

  test("a row with NO videoType is skipped — unknown format is not a Short", () => {
    assert.equal(normalizeYouTubeRow(YOUTUBE_UNTYPED_ROW, { account: "texas" }), null);
  });

  test("long-form is skipped", () => {
    assert.equal(normalizeYouTubeRow({ ...YOUTUBE_SHORT_ROW, videoType: "VIDEO" }, { account: "texas" }), null);
  });

  test("saves is absent here too", () => {
    const post = normalizeYouTubeRow(YOUTUBE_SHORT_ROW, { account: "texas" });
    assert.ok(!("saves" in post.metrics));
  });
});

// ── Daily series ────────────────────────────────────────────────────────────

describe("buildDailySeries", () => {
  const post = (published, views, id) => ({
    platform: "instagram", account: "a", post_id: id, published,
    metrics: views === undefined ? {} : { views },
  });

  test("buckets by Chicago-local day, not UTC", () => {
    // 00:53Z on the 12th is 19:53 on the 11th in Chicago. A UTC bucket would
    // file this post on the wrong day and misalign it with social_stats.json.
    const { daily } = buildDailySeries([post("2026-08-12T00:53:13Z", 505, "1")]);
    assert.equal(daily.length, 1);
    assert.equal(daily[0].date, "2026-08-11");
  });

  test("counts posts and sums views, and says how many posts the sum covers", () => {
    const { daily } = buildDailySeries([
      post("2026-08-12T18:00:00Z", 100, "1"),
      post("2026-08-12T19:00:00Z", 50, "2"),
    ]);
    assert.equal(daily[0].posts, 2);
    assert.equal(daily[0].views, 150);
    assert.equal(daily[0].views_from_posts, 2);
  });

  test("a partial sum declares itself", () => {
    // Two posts, one without a view count. 100 is not the day's total and the
    // file must not imply it is.
    const { daily } = buildDailySeries([
      post("2026-08-12T18:00:00Z", 100, "1"),
      post("2026-08-12T19:00:00Z", undefined, "2"),
    ]);
    assert.equal(daily[0].posts, 2);
    assert.equal(daily[0].views, 100);
    assert.equal(daily[0].views_from_posts, 1, "1 of 2 — the consumer can see the sum is partial");
  });

  test("a day where nothing reported views has no views key at all", () => {
    const { daily } = buildDailySeries([post("2026-08-12T18:00:00Z", undefined, "1")]);
    assert.equal(daily[0].posts, 1);
    assert.ok(!("views" in daily[0]), "0 would read as 'nobody watched'");
  });

  test("undated posts are counted, never silently dropped or dated", () => {
    const { daily, undated } = buildDailySeries([
      { platform: "instagram", account: "a", post_id: "1", metrics: { views: 5 } },
      post("2026-08-12T18:00:00Z", 100, "2"),
    ]);
    assert.equal(undated, 1);
    assert.equal(daily.length, 1);
  });

  test("newest day first", () => {
    const { daily } = buildDailySeries([
      post("2026-08-10T18:00:00Z", 1, "1"),
      post("2026-08-12T18:00:00Z", 2, "2"),
    ]);
    assert.deepEqual(daily.map((d) => d.date), ["2026-08-12", "2026-08-10"]);
  });
});

// ── Merge ───────────────────────────────────────────────────────────────────

describe("mergeRecentPosts", () => {
  const p = (platform, account, id, views, published = "2026-08-12T00:00:00Z") => ({
    platform, account, post_id: id, published, metrics: { views },
  });

  test("the same post on two brands stays two rows", () => {
    // The bug social-telemetry.js documents: one reel fans out to four IG
    // accounts, and keying on post_id alone would dedupe three real
    // publications away.
    const merged = mergeRecentPosts([], [
      p("instagram", "propertypete01", "X", 10),
      p("instagram", "austintx", "X", 99),
    ]);
    assert.equal(merged.length, 2);
    assert.deepEqual(merged.map((x) => x.metrics.views).sort((a, b) => a - b), [10, 99]);
  });

  test("fresh readings replace stale ones for the same post", () => {
    // Metrics keep moving for days after publication.
    const merged = mergeRecentPosts([p("instagram", "a", "X", 10)], [p("instagram", "a", "X", 250)]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].metrics.views, 250);
  });

  test("history older than the API window survives", () => {
    // The API only reaches back 30 days. An overwrite would truncate the file
    // to a rolling month forever.
    const old = p("instagram", "a", "OLD", 1, "2026-01-01T00:00:00Z");
    const merged = mergeRecentPosts([old], [p("instagram", "a", "NEW", 2)]);
    assert.equal(merged.length, 2);
    assert.ok(merged.some((x) => x.post_id === "OLD"));
  });

  test("newest first, and capped", () => {
    const many = Array.from({ length: MAX_RECENT_POSTS + 25 }, (_, i) =>
      p("instagram", "a", `id${i}`, i, `2026-08-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`));
    const merged = mergeRecentPosts([], many);
    assert.equal(merged.length, MAX_RECENT_POSTS);
    assert.ok(merged[0].published >= merged[merged.length - 1].published);
  });

  test("junk on disk is discarded rather than propagated", () => {
    const merged = mergeRecentPosts(
      [null, "nope", { platform: "myspace", post_id: "1" }, { platform: "instagram" }],
      [p("instagram", "a", "X", 1)]
    );
    assert.equal(merged.length, 1);
  });

  test("identity is platform + account + id", () => {
    assert.equal(keyOfPost({ platform: "instagram", account: "a", post_id: "X" }), "instagram a X");
  });
});

describe("mergeDailySeries — history must not be rewritten by trimming", () => {
  const WINDOW_START = "2026-07-13";

  test("inside the window, the fresh row wins — it was fully re-fetched", () => {
    const merged = mergeDailySeries(
      [{ date: "2026-08-11", posts: 18, views: 3000, views_from_posts: 18 }],
      [{ date: "2026-08-11", posts: 20, views: 4300, views_from_posts: 20 }],
      { windowStart: WINDOW_START }
    );
    assert.equal(merged.length, 1);
    assert.equal(merged[0].posts, 20, "metrics keep moving; the newer reading is the better one");
    assert.equal(merged[0].views, 4300);
  });

  /**
   * The bug this function exists to prevent.
   *
   * recent_posts is capped, so months later a recompute finds only a handful of
   * the posts that were on an old day. Without this rule the stored 20 would be
   * overwritten by that remnant and the day would appear to shrink.
   */
  test("outside the window, stored history beats a thinned recompute", () => {
    const merged = mergeDailySeries(
      [{ date: "2026-05-02", posts: 20, views: 5000, views_from_posts: 20 }],
      [{ date: "2026-05-02", posts: 3, views: 400, views_from_posts: 3 }],
      { windowStart: WINDOW_START }
    );
    assert.equal(merged[0].posts, 20, "a measured day must not silently shrink");
    assert.equal(merged[0].views, 5000);
  });

  test("outside the window, a first sighting is still recorded", () => {
    // Nothing stored for that date — this is new information, not a contradiction.
    const merged = mergeDailySeries([], [{ date: "2026-05-02", posts: 3, views: 400, views_from_posts: 3 }], { windowStart: WINDOW_START });
    assert.equal(merged.length, 1);
    assert.equal(merged[0].posts, 3);
  });

  test("days neither side knows about are left alone; newest first", () => {
    const merged = mergeDailySeries(
      [{ date: "2026-01-01", posts: 1 }],
      [{ date: "2026-08-11", posts: 2 }],
      { windowStart: WINDOW_START }
    );
    assert.deepEqual(merged.map((d) => d.date), ["2026-08-11", "2026-01-01"]);
  });

  test("junk rows on disk are dropped", () => {
    const merged = mergeDailySeries([null, { posts: 3 }, { date: "2026-08-01" }], [], { windowStart: WINDOW_START });
    assert.equal(merged.length, 0);
  });

  test("capped", () => {
    const many = Array.from({ length: MAX_DAILY_DAYS + 10 }, (_, i) => ({ date: `2025-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`, posts: 1 }));
    assert.ok(mergeDailySeries(many, [], { windowStart: WINDOW_START }).length <= MAX_DAILY_DAYS);
  });
});

// ── Document assembly ───────────────────────────────────────────────────────

describe("buildAnalytics — degradation is visible", () => {
  const okSource = (platform, account, endpoint) => ({ platform, account, endpoint, ok: true, rows: 1, collected: 1 });

  test("a platform whose every source failed says so, with no empty series", () => {
    const doc = buildAnalytics({
      posts: [],
      sources: [{ platform: "tiktok", account: "texas", endpoint: "/v2/analytics/posts/tiktok", ok: false, reason: "HTTP 403" }],
      now: NOW,
    });
    assert.equal(doc.platforms.tiktok.unavailable, "every source for this platform failed");
    assert.ok(!("daily" in doc.platforms.tiktok), "an empty series would read as 'we looked, there was nothing'");
    assert.match(doc.platforms.tiktok.failures[0].reason, /403/);
  });

  test("a failed platform keeps the history it already measured", () => {
    // The days were real when they were written. Losing them because today's
    // fetch failed would destroy measured facts; `unavailable` is what marks
    // them stale.
    const previous = { platforms: { tiktok: { daily: [{ date: "2026-08-10", posts: 4, views: 900, views_from_posts: 4 }] } } };
    const doc = buildAnalytics({
      posts: [],
      sources: [{ platform: "tiktok", account: "texas", endpoint: "/v2/analytics/posts/tiktok", ok: false, reason: "HTTP 500" }],
      now: NOW,
      previous,
    });
    assert.equal(doc.platforms.tiktok.unavailable, "every source for this platform failed");
    assert.deepEqual(doc.platforms.tiktok.daily, previous.platforms.tiktok.daily);
  });

  test("a platform nobody has connected is unavailable, not zero", () => {
    const doc = buildAnalytics({ posts: [], sources: [], now: NOW });
    assert.match(doc.platforms.instagram.unavailable, /no connected account/);
  });

  test("partial coverage is flagged and the working half still reports", () => {
    const posts = [{ platform: "instagram", account: "good", post_id: "1", published: "2026-08-12T00:00:00Z", metrics: { views: 5 } }];
    const doc = buildAnalytics({
      posts,
      sources: [
        okSource("instagram", "good", "/v2/analytics/reels/instagram"),
        { platform: "instagram", account: "bad", endpoint: "/v2/analytics/reels/instagram", ok: false, reason: "HTTP 500" },
      ],
      now: NOW,
    });
    assert.equal(doc.platforms.instagram.partial, true);
    assert.equal(doc.platforms.instagram.posts_recorded, 1);
    assert.equal(doc.platforms.instagram.failures.length, 1);
  });

  test("unclassified YouTube rows are reported, not swallowed", () => {
    const doc = buildAnalytics({
      posts: [],
      sources: [okSource("youtube_shorts", "texas", "/v2/analytics/posts/youtube")],
      now: NOW,
      unclassifiedYouTube: 136,
    });
    assert.equal(doc.platforms.youtube_shorts.unclassified_rows, 136);
  });

  test("the unavailable list ships in the file, so the dashboard can say why", () => {
    const doc = buildAnalytics({ posts: [], sources: [], now: NOW });
    const metrics = doc.unavailable.map((u) => u.metric);
    assert.ok(metrics.includes("followers"));
    assert.ok(metrics.includes("follower_delta"));
    assert.ok(metrics.includes("saves"));
    // The reason has to carry the evidence, not just the verdict.
    const followers = doc.unavailable.find((u) => u.metric === "followers");
    assert.match(followers.reason, /stats\/timeline/);
    assert.ok(followers.probed);
  });

  test("no follower field is ever emitted on a platform block", () => {
    const doc = buildAnalytics({
      posts: [{ platform: "instagram", account: "a", post_id: "1", published: "2026-08-12T00:00:00Z", metrics: { views: 1 } }],
      sources: [okSource("instagram", "a", "/v2/analytics/reels/instagram")],
      now: NOW,
    });
    const serialized = JSON.stringify(doc.platforms);
    assert.ok(!/"followers"/.test(serialized), "followers must never appear as a platform metric");
  });
});

// ── collectFromApi ──────────────────────────────────────────────────────────

describe("collectFromApi — only asks for what is connected", () => {
  test("skips endpoints for networks a brand does not have", async () => {
    const asked = [];
    const fetchImpl = async (url) => {
      asked.push(url.split("?")[0].replace(/.*\/api/, ""));
      return { ok: true, status: 200, json: async () => (url.includes("simpleProfiles") ? [{ id: 222, label: "ig-only", instagram: "x" }] : { data: [] }), text: async () => "" };
    };
    await collectFromApi({ token: "t", userId: "u", blogId: "1", fetchImpl, now: NOW });
    assert.ok(asked.some((u) => u.includes("/reels/instagram")));
    assert.ok(!asked.some((u) => u.includes("/posts/tiktok")), "no TikTok on this brand — do not ask");
    assert.ok(!asked.some((u) => u.includes("/posts/youtube")));
  });

  test("one failing endpoint degrades only itself", async () => {
    const fetchImpl = fakeFetch({
      simpleProfiles: { body: ONE_BRAND },
      "/reels/instagram": { body: { data: [IG_REEL_ROW] } },
      "/posts/instagram": { status: 500, body: { detail: "boom" } },
      "/posts/tiktok": { body: { data: [TIKTOK_ROW] } },
      "/posts/youtube": { body: { data: [YOUTUBE_SHORT_ROW, YOUTUBE_UNTYPED_ROW] } },
    });
    const { posts, sources, unclassifiedYouTube } = await collectFromApi({ token: "t", userId: "u", blogId: "1", fetchImpl, now: NOW });

    assert.equal(posts.filter((p) => p.platform === "instagram").length, 1);
    assert.equal(posts.filter((p) => p.platform === "tiktok").length, 1);
    assert.equal(posts.filter((p) => p.platform === "youtube_shorts").length, 1);
    assert.equal(unclassifiedYouTube, 1, "the untyped YouTube row is counted, not forgotten");
    assert.equal(sources.filter((s) => !s.ok).length, 1);
  });

  test("a fetch that throws is a failed source, not a crash", async () => {
    const fetchImpl = fakeFetch({
      simpleProfiles: { body: ONE_BRAND },
      "/reels/instagram": new Error("ECONNRESET"),
      "/posts/instagram": { body: { data: [] } },
      "/posts/tiktok": { body: { data: [] } },
      "/posts/youtube": { body: { data: [] } },
    });
    const { sources } = await collectFromApi({ token: "t", userId: "u", blogId: "1", fetchImpl, now: NOW });
    const failed = sources.find((s) => !s.ok);
    assert.match(failed.reason, /ECONNRESET/);
  });
});

// ── writeSocialAnalytics ────────────────────────────────────────────────────

describe("writeSocialAnalytics", () => {
  test("writes the file on a healthy run", async () => {
    const repoRoot = tempRepo();
    const fetchImpl = fakeFetch({
      simpleProfiles: { body: ONE_BRAND },
      "/reels/instagram": { body: { data: [IG_REEL_ROW] } },
      "/posts/instagram": { body: { data: [] } },
      "/posts/tiktok": { body: { data: [TIKTOK_ROW] } },
      "/posts/youtube": { body: { data: [YOUTUBE_SHORT_ROW] } },
    });

    const res = await writeSocialAnalytics({ repoRoot, token: "t", userId: "u", blogId: "1", fetchImpl, now: NOW });
    assert.equal(res.ok, true);

    const written = JSON.parse(readFileSync(join(repoRoot, "status", ANALYTICS_FILENAME), "utf-8"));
    assert.equal(written.recent_posts.length, 3);
    assert.equal(written.platforms.instagram.posts_recorded, 1);
    assert.equal(written.platforms.tiktok.posts_recorded, 1);
    assert.equal(written.platforms.youtube_shorts.posts_recorded, 1);
    assert.equal(written.window_days, 30);
    assert.deepEqual(written.unavailable, UNAVAILABLE);
  });

  /**
   * THE CASE THE SPEC NAMES. Every endpoint down at once.
   *
   * The tempting behaviour is to write an empty document — the run "succeeded",
   * after all. That would replace a good reading with a file saying every
   * platform has no posts and no views, which is a claim nobody measured.
   */
  test("all endpoints down: reports failure and does not write", async () => {
    const repoRoot = tempRepo();
    const fetchImpl = fakeFetch({
      simpleProfiles: { body: ONE_BRAND },
      "/reels/instagram": { status: 503, body: { detail: "unavailable" } },
      "/posts/instagram": { status: 503, body: { detail: "unavailable" } },
      "/posts/tiktok": { status: 503, body: { detail: "unavailable" } },
      "/posts/youtube": { status: 503, body: { detail: "unavailable" } },
    });

    const res = await writeSocialAnalytics({ repoRoot, token: "t", userId: "u", blogId: "1", fetchImpl, now: NOW });

    assert.equal(res.ok, false);
    assert.match(res.error, /every analytics source failed/);
    assert.ok(res.failures.length > 0);
    assert.ok(res.failures.every((f) => /503/.test(f.reason)));
    assert.equal(existsSync(join(repoRoot, "status", ANALYTICS_FILENAME)), false, "no file invented from nothing");
  });

  test("all endpoints down: an existing good file is left exactly as it was", async () => {
    const repoRoot = tempRepo();
    const path = join(repoRoot, "status", ANALYTICS_FILENAME);
    const previous = { generated_at: "2026-08-11T14:00:00Z", platforms: {}, recent_posts: [], window_days: 30 };
    writeFileSync(path, JSON.stringify(previous, null, 2));

    const fetchImpl = fakeFetch({
      simpleProfiles: { body: ONE_BRAND },
      "/reels/instagram": { status: 500, body: {} },
      "/posts/instagram": { status: 500, body: {} },
      "/posts/tiktok": { status: 500, body: {} },
      "/posts/youtube": { status: 500, body: {} },
    });

    const res = await writeSocialAnalytics({ repoRoot, token: "t", userId: "u", blogId: "1", fetchImpl, now: NOW });
    assert.equal(res.ok, false);

    // A stale generated_at is the truth. An overwritten one is not.
    assert.deepEqual(JSON.parse(readFileSync(path, "utf-8")), previous);
  });

  test("the brand list being unreachable is a clean failure, not a crash", async () => {
    const repoRoot = tempRepo();
    const fetchImpl = fakeFetch({ simpleProfiles: { status: 401, body: { detail: "bad token" } } });
    const res = await writeSocialAnalytics({ repoRoot, token: "t", userId: "u", blogId: "1", fetchImpl, now: NOW });
    assert.equal(res.ok, false);
    assert.match(res.error, /brand list could not be read/);
    assert.equal(existsSync(join(repoRoot, "status", ANALYTICS_FILENAME)), false);
  });

  test("missing credentials return a reason instead of throwing", async () => {
    const repoRoot = tempRepo();
    const res = await writeSocialAnalytics({ repoRoot, token: "", userId: "", fetchImpl: fakeFetch({}) });
    assert.equal(res.ok, false);
    assert.match(res.error, /credentials/);
  });

  test("NEVER THROWS — even when fetch itself explodes", async () => {
    const repoRoot = tempRepo();
    const res = await writeSocialAnalytics({
      repoRoot, token: "t", userId: "u", blogId: "1",
      fetchImpl: async () => { throw new Error("network is on fire"); },
      now: NOW,
    });
    assert.equal(res.ok, false);
  });

  test("NEVER THROWS — even on malformed JSON", async () => {
    const repoRoot = tempRepo();
    const fetchImpl = async () => ({
      ok: true, status: 200,
      json: async () => { throw new SyntaxError("Unexpected token <"); },
      text: async () => "<html>",
    });
    const res = await writeSocialAnalytics({ repoRoot, token: "t", userId: "u", blogId: "1", fetchImpl, now: NOW });
    assert.equal(res.ok, false);
  });

  test("a corrupt file on disk does not stop this run writing a good one", async () => {
    const repoRoot = tempRepo();
    const path = join(repoRoot, "status", ANALYTICS_FILENAME);
    writeFileSync(path, "{ not json at all");

    const fetchImpl = fakeFetch({
      simpleProfiles: { body: ONE_BRAND },
      "/reels/instagram": { body: { data: [IG_REEL_ROW] } },
      "/posts/instagram": { body: { data: [] } },
      "/posts/tiktok": { body: { data: [] } },
      "/posts/youtube": { body: { data: [] } },
    });
    const res = await writeSocialAnalytics({ repoRoot, token: "t", userId: "u", blogId: "1", fetchImpl, now: NOW });
    assert.equal(res.ok, true);
    assert.equal(JSON.parse(readFileSync(path, "utf-8")).recent_posts.length, 1);
  });

  test("a second run merges rather than replacing", async () => {
    const repoRoot = tempRepo();
    const path = join(repoRoot, "status", ANALYTICS_FILENAME);
    writeFileSync(path, JSON.stringify({
      generated_at: "2026-01-01T00:00:00Z",
      recent_posts: [{ platform: "instagram", account: "texas", post_id: "ANCIENT", published: "2026-01-01T00:00:00Z", metrics: { views: 7 } }],
    }));

    const fetchImpl = fakeFetch({
      simpleProfiles: { body: ONE_BRAND },
      "/reels/instagram": { body: { data: [IG_REEL_ROW] } },
      "/posts/instagram": { body: { data: [] } },
      "/posts/tiktok": { body: { data: [] } },
      "/posts/youtube": { body: { data: [] } },
    });
    const res = await writeSocialAnalytics({ repoRoot, token: "t", userId: "u", blogId: "1", fetchImpl, now: NOW });

    assert.equal(res.ok, true);
    const ids = JSON.parse(readFileSync(path, "utf-8")).recent_posts.map((p) => p.post_id);
    assert.ok(ids.includes("ANCIENT"), "history outside the API window survives");
    assert.ok(ids.includes("18003853694779811"));
  });

  test("the written file is valid JSON at every instant — temp then rename", async () => {
    const repoRoot = tempRepo();
    const fetchImpl = fakeFetch({
      simpleProfiles: { body: ONE_BRAND },
      "/reels/instagram": { body: { data: [IG_REEL_ROW] } },
      "/posts/instagram": { body: { data: [] } },
      "/posts/tiktok": { body: { data: [] } },
      "/posts/youtube": { body: { data: [] } },
    });
    await writeSocialAnalytics({ repoRoot, token: "t", userId: "u", blogId: "1", fetchImpl, now: NOW });
    const raw = readFileSync(join(repoRoot, "status", ANALYTICS_FILENAME), "utf-8");
    assert.doesNotThrow(() => JSON.parse(raw));
    assert.ok(raw.endsWith("\n"));
  });
});
