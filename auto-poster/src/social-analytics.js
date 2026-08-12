/**
 * social-analytics.js — what the posts actually DID, for LIFESTYLE.
 *
 * Writes one file at the REPO ROOT:
 *
 *     status/social_analytics.json
 *
 * per-platform daily series + a recent_posts array carrying real per-post
 * metrics, pulled from Metricool's analytics API on a daily cadence.
 *
 * READ-ONLY BY CONSTRUCTION. Every call this module makes is a GET against
 * analytics endpoints. It never posts, uploads, schedules or deletes; a bug in
 * it can make a dashboard wrong, never a social account.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RULE, INHERITED FROM social-telemetry.js: NEVER INVENT A NUMBER
 *
 * A key that is PRESENT is a measured fact. A key that is ABSENT is "we do not
 * know". Zero means the API reported zero. Those three states are not
 * interchangeable, and here the pressure to blur them is stronger than in the
 * telemetry writer, because an analytics API answers 200 far more often than it
 * answers usefully.
 *
 * WHAT THE PROBE FOUND (auto-poster/scripts/probe-social-analytics.mjs, run
 * against the live account on 2026-08-12 — see ANALYTICS-COVERAGE.md):
 *
 *   AVAILABLE, with real numbers on real posts:
 *     /v2/analytics/reels/instagram   views reach likes comments shares saved
 *     /v2/analytics/posts/instagram   the same fields, for non-reel feed posts
 *     /v2/analytics/posts/tiktok      viewCount likeCount commentCount shareCount
 *     /v2/analytics/posts/youtube     views likes comments shares + videoType
 *
 *   NOT AVAILABLE, and therefore ABSENT FROM THE OUTPUT rather than zeroed:
 *     follower count and delta — see FOLLOWERS below, it is the sharp one
 *     saves on tiktok and youtube — no such field exists in either response
 *     reach on tiktok and youtube — likewise
 *     facebook (403, not connected) and instagram stories (empty)
 *
 * FOLLOWERS, AND WHY THERE IS NO FOLLOWER FIELD IN THIS FILE.
 *
 * Issue #83 asks for follower count and delta. This account cannot supply them,
 * and the way it cannot is a trap worth spelling out, because the obvious
 * implementation succeeds and produces garbage:
 *
 *     GET /stats/timeline/followers   →  200  [["20260812","0"]]
 *     GET /stats/timeline/shares      →  200  [["20260812","0"]]
 *     GET /stats/timeline/Community   →  200  [["20260812","0"]]
 *     GET /stats/timeline/fans        →  200  [["20260812","0"]]
 *
 * Byte-identical, for every metric name tried including ones invented on the
 * spot. That endpoint acknowledges a request; it does not report a number. The
 * alternatives are all dead: /v2/analytics/<network>/profile is 404 on all four
 * networks, the network-scoped timeline paths are 404, /admin/simpleProfiles
 * carries 89 keys and not one of them is follower-ish, and the competitor
 * surface answers {"data":[]} because no competitors are configured.
 *
 * So a follower reading would have to come from that 200, and it would be a
 * confident `0` for every platform every day — a dashboard saying the accounts
 * have no followers and are not growing. The metric is omitted, and the
 * omission is recorded IN the file (`unavailable[]`) so the dashboard can say
 * "not available" instead of drawing a flat line through zero.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * UNITS AND FAN-OUT
 *
 * The poster fans one video out to every connected brand, so the same reel
 * genuinely exists on four Instagram accounts with four different view counts.
 * Every row therefore carries `account`, and identity is (platform, account,
 * post_id) — never post_id alone. social-telemetry.js learned this the hard
 * way: on 2026-08-11 a carousel published to two Instagram accounts and the log
 * deduped one of them away.
 *
 * `posts` in the daily series counts PLATFORM-LEVEL post-instances, the same
 * unit social_stats.json uses, so the two files can be read against each other.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The file is written temp-then-rename, and merged rather than overwritten: the
 * API window only reaches back 30 days, so an overwrite would silently truncate
 * history that is already on disk.
 */
import { join } from "node:path";
import {
  PLATFORMS,
  isoZ,
  todayInChicago,
  atomicWriteJson,
  readJsonOr,
  STATUS_DIRNAME,
} from "./social-telemetry.js";

export const ANALYTICS_FILENAME = "social_analytics.json";

/** The API's reach. Asking for more returns nothing older anyway. */
export const WINDOW_DAYS = 30;

/**
 * Bound on the rolling post array. At four brands the 30-day window is ~500
 * rows, so this is headroom rather than a limit that bites — but the file is
 * merged forever and something has to stop it growing without end.
 */
export const MAX_RECENT_POSTS = 750;

const BASE = "https://app.metricool.com/api";
const SLUG_MAX_CHARS = 120;

/**
 * When the capability probe was last run against the live account. The
 * `unavailable` reasons below are findings with a date on them, not permanent
 * truths — if Metricool ships a follower endpoint this stamp is what tells a
 * reader the claim is stale.
 */
export const PROBED_ON = "2026-08-12";

/**
 * What was looked for, not found, and why — copied into every written file.
 *
 * This is the part of the spec that says "omit and document, never fake". The
 * documentation lives in the artifact rather than only in this comment, because
 * the dashboard is what has to decide between "0" and "we cannot know".
 */
export const UNAVAILABLE = [
  {
    metric: "followers",
    platforms: ["instagram", "tiktok", "youtube_shorts"],
    reason:
      "No per-platform follower endpoint on this account tier. /stats/timeline/<metric> " +
      "answers 200 with an identical one-row stub ([[\"<today>\",\"0\"]]) for every metric " +
      "name including invented ones; /v2/analytics/<network>/profile is 404; the " +
      "network-scoped timeline paths are 404; /admin/simpleProfiles exposes no follower " +
      "field; /v2/analytics/competitors/<network> returns an empty list. Reading the 200 " +
      "would publish a confident zero.",
    probed: PROBED_ON,
  },
  {
    metric: "follower_delta",
    platforms: ["instagram", "tiktok", "youtube_shorts"],
    reason: "Derived from followers, which is unavailable — see the followers entry.",
    probed: PROBED_ON,
  },
  {
    metric: "saves",
    platforms: ["tiktok", "youtube_shorts"],
    reason:
      "No saves-equivalent field exists in /v2/analytics/posts/tiktok or " +
      "/v2/analytics/posts/youtube. Instagram reports it as `saved` and it is collected there.",
    probed: PROBED_ON,
  },
  {
    metric: "reach",
    platforms: ["tiktok", "youtube_shorts"],
    reason:
      "No reach field in either response. Instagram reports reach separately from views " +
      "and it is collected there.",
    probed: PROBED_ON,
  },
];

// ── Small helpers ───────────────────────────────────────────────────────────

function clip(text, max) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max - 1).trimEnd() + "…";
}

/**
 * A finite number, or undefined. Strings that look numeric are accepted —
 * Metricool quotes its counts on some surfaces — but nothing else is.
 *
 * The allow-list is deliberate rather than defensive. `Number()` is happy to
 * turn several kinds of nothing into a confident zero: Number([]) is 0,
 * Number("") is 0, Number(false) is 0, Number(" ") is 0. Any of those reaching
 * a metric would publish a measurement nobody took, which is the one thing this
 * module exists to prevent — so only numbers and non-blank numeric strings get
 * through, and everything else is "we do not know".
 */
export function num(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

/** How far `timeZone` is from UTC at `instant`, in ms. */
function offsetMs(instant, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(instant);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const asUTC = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUTC - instant.getTime();
}

/**
 * Metricool dates the posts it returns as `{ dateTime, timezone }` — a wall
 * clock with no offset, plus the zone to read it in (ours come back stamped
 * Europe/Madrid, Metricool's own). Turning that into an instant needs the zone
 * applied; treating the string as UTC would shift every post by an hour or two
 * and drop some of them into the wrong day.
 *
 * Returns a Date, or null when the value cannot be read — null becomes an
 * ABSENT published field, never a guessed one.
 */
export function instantFrom(value) {
  if (!value) return null;

  // TikTok: a real ISO string with an offset. Date parses it correctly.
  if (typeof value === "string") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const wall = value.dateTime;
  if (typeof wall !== "string" || !wall) return null;

  const zone = typeof value.timezone === "string" && value.timezone ? value.timezone : "UTC";
  const guess = new Date(`${wall.replace(" ", "T")}Z`);
  if (Number.isNaN(guess.getTime())) return null;

  try {
    // Two passes: the first offset is measured at the wrong instant whenever the
    // guess lands on the far side of a DST change, the second corrects it.
    let ms = guess.getTime() - offsetMs(guess, zone);
    ms = guess.getTime() - offsetMs(new Date(ms), zone);
    const out = new Date(ms);
    return Number.isNaN(out.getTime()) ? null : out;
  } catch {
    // An unknown zone name. The wall clock is still better than nothing, but it
    // is not an instant we can claim precision about — treat it as UTC and let
    // the daily bucket be approximately right rather than absent.
    return guess;
  }
}

/** Something a human can recognise the post by: its opening line. */
function slugFrom(...candidates) {
  for (const c of candidates) {
    if (typeof c !== "string" || !c.trim()) continue;
    const firstLine = c.split("\n").find((l) => l.trim());
    if (firstLine) return clip(firstLine, SLUG_MAX_CHARS);
  }
  return "";
}

/** Drop undefined values so an absent metric is genuinely absent from the JSON. */
function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

// ── Normalising one API row into one post record ────────────────────────────

/**
 * Instagram — both /reels/instagram and /posts/instagram. They return the same
 * metric vocabulary and they are DISJOINT: the probe found 46 reels and 1 feed
 * carousel over the same window, no overlap. Both are read, because a dashboard
 * missing the carousels would be missing real publications.
 */
export function normalizeInstagramRow(row, { account, kind }) {
  if (!row || typeof row !== "object") return null;
  const postId = row.reelId ?? row.postId;
  if (postId === undefined || postId === null || postId === "") return null;

  const published = instantFrom(row.publishedAt);

  const metrics = compact({
    views: num(row.views),
    reach: num(row.reach),
    impressions: num(row.impressionsTotal),
    likes: num(row.likes),
    comments: num(row.comments),
    shares: num(row.shares),
    saves: num(row.saved),
    interactions: num(row.interactions),
    engagement_rate: num(row.engagement),
    // Reels-only, and genuinely useful for the retention question the
    // long-form work cares about. Absent on feed posts, which is correct.
    avg_watch_seconds: num(row.averageWatchTime),
    duration_seconds: num(row.durationSeconds),
    skip_rate: num(row.reelsSkipRate),
  });

  return compact({
    platform: "instagram",
    account,
    kind,
    post_id: String(postId),
    published: published ? isoZ(published) : undefined,
    slug: slugFrom(row.content) || undefined,
    url: typeof row.url === "string" && row.url ? row.url : undefined,
    metrics,
  });
}

/**
 * TikTok — /v2/analytics/posts/tiktok. Different spelling for every metric
 * (viewCount, not views), and NO saves and NO reach field at all. Those are
 * omitted here and declared in UNAVAILABLE; mapping them to 0 would claim
 * nobody ever saved a TikTok.
 */
export function normalizeTikTokRow(row, { account }) {
  if (!row || typeof row !== "object") return null;
  const postId = row.videoId;
  if (postId === undefined || postId === null || postId === "") return null;

  const published = instantFrom(row.createTime);

  const metrics = compact({
    views: num(row.viewCount),
    likes: num(row.likeCount),
    comments: num(row.commentCount),
    shares: num(row.shareCount),
    engagement_rate: num(row.engagement),
    duration_seconds: num(row.duration),
  });

  return compact({
    platform: "tiktok",
    account,
    post_id: String(postId),
    published: published ? isoZ(published) : undefined,
    slug: slugFrom(row.videoDescription, row.title) || undefined,
    url: typeof row.shareUrl === "string" && row.shareUrl ? row.shareUrl.split("?")[0] : undefined,
    metrics,
  });
}

/**
 * YouTube — /v2/analytics/posts/youtube, which works despite YouTube not
 * appearing in Metricool's published list of post-analytics networks.
 *
 * SHORTS ONLY, AND CAREFULLY. The dashboard's contract is `youtube_shorts`, and
 * the channel now carries long-form too, so the two must not be added together.
 * Metricool marks Shorts with `videoType: "SHORT"` — but the probe found that
 * key present on only 98 of 234 rows. A row with no videoType is a row whose
 * format we do not know, and this repo's own posting path is not proof (it
 * posts Shorts, but so does nothing else in that response necessarily).
 *
 * So: only "SHORT" counts. Unlabelled rows are skipped and COUNTED, and the
 * count is reported on the platform block as `unclassified_rows`, so a reader
 * can see the series is narrower than the channel rather than assuming it is
 * the whole story.
 */
export function normalizeYouTubeRow(row, { account }) {
  if (!row || typeof row !== "object") return null;
  const postId = row.videoId;
  if (postId === undefined || postId === null || postId === "") return null;
  if (String(row.videoType || "").toUpperCase() !== "SHORT") return null;

  const published = instantFrom(row.publishedAt);

  const metrics = compact({
    views: num(row.views),
    likes: num(row.likes),
    comments: num(row.comments),
    shares: num(row.shares),
    watch_minutes: num(row.watchMinutes),
    avg_watch_seconds: num(row.averageViewDuration),
    duration_seconds: num(row.durationSeconds),
  });

  return compact({
    platform: "youtube_shorts",
    account,
    post_id: String(postId),
    published: published ? isoZ(published) : undefined,
    slug: slugFrom(row.title, row.description) || undefined,
    url: typeof row.watchUrl === "string" && row.watchUrl ? row.watchUrl : undefined,
    metrics,
  });
}

// ── Daily series ────────────────────────────────────────────────────────────

/**
 * Collapse posts into one row per Chicago-local day.
 *
 * `posts` is a counted fact: how many post-instances we have metrics for that
 * day. `views` is a SUM, and a sum over a partially-reporting set is a lie
 * unless it says so — hence `views_from_posts`, the number of posts that
 * actually carried a views figure. When that is 0 the views key is omitted
 * entirely rather than written as 0.
 *
 * Posts with no readable publish date are not dated, so they cannot join a
 * daily row. They stay in recent_posts and are counted in `undated_posts`.
 */
export function buildDailySeries(posts) {
  const byDate = new Map();
  let undated = 0;

  for (const post of posts) {
    if (!post?.published) {
      undated += 1;
      continue;
    }
    const at = new Date(post.published);
    if (Number.isNaN(at.getTime())) {
      undated += 1;
      continue;
    }
    const date = todayInChicago(at);
    if (!byDate.has(date)) byDate.set(date, { date, posts: 0, views: 0, views_from_posts: 0 });
    const row = byDate.get(date);
    row.posts += 1;
    const views = post.metrics ? num(post.metrics.views) : undefined;
    if (views !== undefined) {
      row.views += views;
      row.views_from_posts += 1;
    }
  }

  const daily = [...byDate.values()]
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .map((row) => (row.views_from_posts === 0
      ? { date: row.date, posts: row.posts }
      : { date: row.date, posts: row.posts, views: row.views, views_from_posts: row.views_from_posts }));

  return { daily, undated };
}

// ── Fetching ────────────────────────────────────────────────────────────────

function authHeaders(token) {
  return { "Content-Type": "application/json", "X-Mc-Auth": token };
}

/**
 * One GET. Returns a result object rather than throwing, because a single
 * platform failing must degrade that platform and nothing else.
 */
async function get(url, { token, fetchImpl }) {
  try {
    const res = await fetchImpl(url, { headers: authHeaders(token) });
    if (!res.ok) {
      let detail = "";
      try { detail = clip(await res.text(), 160); } catch { /* body already consumed or absent */ }
      return { ok: false, reason: `HTTP ${res.status}${detail ? `: ${detail}` : ""}` };
    }
    const json = await res.json();
    const rows = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : null;
    if (!rows) return { ok: false, reason: "response carried no row array" };
    return { ok: true, rows };
  } catch (err) {
    return { ok: false, reason: clip(err?.message || String(err), 160) };
  }
}

/** The brands this account posts to, and what is connected to each. */
export async function fetchBrands({ token, userId, blogId, fetchImpl = fetch }) {
  const res = await get(`${BASE}/admin/simpleProfiles?userId=${userId}`, { token, fetchImpl });
  if (!res.ok) return { ok: false, reason: res.reason, brands: [] };

  const brands = [];
  for (const p of res.rows) {
    if (!p || p.deleted === true || p.isDemo === true) continue;
    const id = Number(p.id ?? p.blogId);
    if (!id) continue;
    const networks = [];
    for (const n of ["instagram", "tiktok", "youtube"]) {
      if (typeof p[n] === "string" && p[n]) networks.push(n);
    }
    brands.push({ blogId: id, label: String(p.label || id), networks });
  }

  // A reachable API that lists nothing is not the same as an unreachable one,
  // but for our purposes both mean "collect against the configured blog only".
  if (brands.length === 0 && blogId) {
    return { ok: true, brands: [{ blogId: Number(blogId), label: "default", networks: ["instagram", "tiktok", "youtube"] }] };
  }
  return { ok: true, brands };
}

/**
 * Pull every available source for every brand.
 *
 * Returns posts plus a per-source record of what happened, so the writer can
 * tell "this platform reported nothing" from "we could not ask".
 */
export async function collectFromApi({
  token, userId, blogId, fetchImpl = fetch, now = new Date(), windowDays = WINDOW_DAYS,
} = {}) {
  const to = new Date(now);
  const from = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const stamp = (d) => d.toISOString().slice(0, 19);
  const window = `from=${stamp(from)}&to=${stamp(to)}&timezone=America/Chicago`;

  const posts = [];
  const sources = [];
  let unclassifiedYouTube = 0;

  const brandsRes = await fetchBrands({ token, userId, blogId, fetchImpl });
  if (!brandsRes.ok) {
    return {
      posts, sources,
      brandsError: brandsRes.reason,
      unclassifiedYouTube,
    };
  }

  const run = async ({ platform, account, blogId: bid, path, normalize }) => {
    const url = `${BASE}${path}?${window}&blogId=${bid}&userId=${userId}`;
    const res = await get(url, { token, fetchImpl });
    if (!res.ok) {
      sources.push({ platform, account, endpoint: path, ok: false, reason: res.reason });
      return;
    }
    let kept = 0;
    for (const row of res.rows) {
      const post = normalize(row);
      if (post) {
        posts.push(post);
        kept += 1;
      }
    }
    sources.push({ platform, account, endpoint: path, ok: true, rows: res.rows.length, collected: kept });
    if (platform === "youtube_shorts") unclassifiedYouTube += res.rows.length - kept;
  };

  for (const brand of brandsRes.brands) {
    const account = brand.label;
    if (brand.networks.includes("instagram")) {
      await run({
        platform: "instagram", account, blogId: brand.blogId,
        path: "/v2/analytics/reels/instagram",
        normalize: (row) => normalizeInstagramRow(row, { account, kind: "reel" }),
      });
      await run({
        platform: "instagram", account, blogId: brand.blogId,
        path: "/v2/analytics/posts/instagram",
        normalize: (row) => normalizeInstagramRow(row, { account, kind: "feed" }),
      });
    }
    if (brand.networks.includes("tiktok")) {
      await run({
        platform: "tiktok", account, blogId: brand.blogId,
        path: "/v2/analytics/posts/tiktok",
        normalize: (row) => normalizeTikTokRow(row, { account }),
      });
    }
    if (brand.networks.includes("youtube")) {
      await run({
        platform: "youtube_shorts", account, blogId: brand.blogId,
        path: "/v2/analytics/posts/youtube",
        normalize: (row) => normalizeYouTubeRow(row, { account }),
      });
    }
  }

  return { posts, sources, unclassifiedYouTube };
}

// ── Assembling the document ─────────────────────────────────────────────────

/** Identity for a post-instance. Never post_id alone — see the header. */
export function keyOfPost(p) {
  return `${p.platform} ${p.account || ""} ${p.post_id}`;
}

function validPost(p) {
  if (!p || typeof p !== "object") return false;
  if (!PLATFORMS.includes(p.platform)) return false;
  return typeof p.post_id === "string" && p.post_id !== "";
}

/**
 * Union of what is on disk and what this run fetched — NOT an append, and not
 * an overwrite.
 *
 * The API window reaches back 30 days. An overwrite would delete day 31 from a
 * file that already had it, so the series would never grow past a month.
 * `fresh` wins a collision, because metrics on a post keep moving for days
 * after it publishes and the newer reading is the better one.
 */
export function mergeRecentPosts(existing, fresh, limit = MAX_RECENT_POSTS) {
  const merged = new Map();
  for (const p of Array.isArray(existing) ? existing : []) {
    if (validPost(p)) merged.set(keyOfPost(p), p);
  }
  for (const p of Array.isArray(fresh) ? fresh : []) {
    if (validPost(p)) merged.set(keyOfPost(p), p);
  }
  return [...merged.values()]
    .sort((a, b) => {
      const at = a.published || "";
      const bt = b.published || "";
      if (at === bt) return keyOfPost(a).localeCompare(keyOfPost(b));
      return at < bt ? 1 : -1;
    })
    .slice(0, limit);
}

/**
 * Build the document from a merged post set and this run's source records.
 *
 * A platform appears with a `daily` series ONLY when at least one source for it
 * answered. When every source for a platform failed, the platform carries
 * `unavailable` and the reasons instead — never an empty series, which would
 * read as "we looked and there was nothing".
 */
export function buildAnalytics({ posts, sources, now = new Date(), windowDays = WINDOW_DAYS, unclassifiedYouTube = 0, brandsError = null }) {
  const platforms = {};

  for (const platform of PLATFORMS) {
    const mine = sources.filter((s) => s.platform === platform);
    const ok = mine.filter((s) => s.ok);
    const failed = mine.filter((s) => !s.ok);

    if (mine.length === 0) {
      platforms[platform] = {
        unavailable: brandsError
          ? `brand list could not be read: ${brandsError}`
          : "no connected account for this platform on any brand",
      };
      continue;
    }

    if (ok.length === 0) {
      platforms[platform] = {
        unavailable: "every source for this platform failed",
        failures: failed.map((s) => ({ account: s.account, endpoint: s.endpoint, reason: s.reason })),
      };
      continue;
    }

    const minePosts = posts.filter((p) => p.platform === platform);
    const { daily, undated } = buildDailySeries(minePosts);

    const block = {
      accounts: [...new Set(ok.map((s) => s.account))].sort(),
      posts_in_window: minePosts.length,
      daily,
    };
    if (undated > 0) block.undated_posts = undated;
    // Partial coverage is still coverage, but it has to be visible.
    if (failed.length > 0) {
      block.partial = true;
      block.failures = failed.map((s) => ({ account: s.account, endpoint: s.endpoint, reason: s.reason }));
    }
    if (platform === "youtube_shorts" && unclassifiedYouTube > 0) {
      block.unclassified_rows = unclassifiedYouTube;
      block.unclassified_note =
        "rows returned by /v2/analytics/posts/youtube carrying no videoType; format unknown, so excluded from the Shorts series rather than assumed";
    }

    platforms[platform] = block;
  }

  return {
    generated_at: isoZ(now),
    window_days: windowDays,
    source: "metricool",
    platforms,
    recent_posts: posts,
    unavailable: UNAVAILABLE,
  };
}

// ── Writing ─────────────────────────────────────────────────────────────────

/**
 * Fetch, merge, write. Returns what happened; NEVER THROWS.
 *
 * Same contract as writeSocialTelemetry, for the same reason: this runs in a
 * scheduled job whose commit step must not be taken down by a dashboard file. A
 * failure returns { ok: false, error } and the caller decides — and the caller
 * deliberately does not treat it as a red run.
 */
export async function writeSocialAnalytics({
  repoRoot,
  token = process.env.METRICOOL_API_TOKEN,
  userId = process.env.METRICOOL_USER_ID,
  blogId = process.env.METRICOOL_BLOG_ID,
  fetchImpl = fetch,
  now = new Date(),
  windowDays = WINDOW_DAYS,
} = {}) {
  try {
    if (!token || !userId) {
      return { ok: false, error: "missing Metricool credentials (METRICOOL_API_TOKEN / METRICOOL_USER_ID)" };
    }

    const path = join(repoRoot, STATUS_DIRNAME, ANALYTICS_FILENAME);

    const { posts, sources, unclassifiedYouTube, brandsError } = await collectFromApi({
      token, userId, blogId, fetchImpl, now, windowDays,
    });

    // Every source down is not a reason to overwrite a good file with an empty
    // one. Say so, leave the last good reading in place, and let the run go
    // green — the dashboard shows a stale generated_at, which is the truth.
    if (sources.length > 0 && sources.every((s) => !s.ok)) {
      return {
        ok: false,
        error: "every analytics source failed — existing file left untouched",
        failures: sources.map((s) => ({ platform: s.platform, account: s.account, endpoint: s.endpoint, reason: s.reason })),
      };
    }
    if (sources.length === 0 && brandsError) {
      return { ok: false, error: `brand list could not be read: ${brandsError} — existing file left untouched` };
    }

    const existing = readJsonOr(path, null);
    const merged = mergeRecentPosts(existing?.recent_posts, posts);
    const doc = buildAnalytics({ posts: merged, sources, now, windowDays, unclassifiedYouTube, brandsError });

    atomicWriteJson(path, doc);

    return { ok: true, doc, path, sources, collected: posts.length, total: merged.length };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}
