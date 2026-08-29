/**
 * learn.js — the weekly learn step: join, score, rank, and say what's working.
 *
 * Pure functions over two files that already exist and are already honest:
 *
 *   auto-poster/posted-log.json          what was posted, with the variation
 *                                        engine's decision tags (generation)
 *   status/social_analytics.json         what the posts actually did, per
 *                                        platform per account, absent-not-zero
 *
 * scripts/run-learning-loop.mjs orchestrates: it calls these functions, writes
 * learning/brief-<brand>.json (which src/variation.js reads at generation
 * time), and emails the one-page brief. Everything here is side-effect free so
 * the whole pass is testable without a network.
 *
 * ─── THE JOIN ───────────────────────────────────────────────────────────────
 *
 * Neither file was designed to reference the other, so the join uses what both
 * genuinely carry: the caption's first line (posted-log stores the caption's
 * first 200 chars; analytics rows carry `slug`, the first line clipped to 120)
 * plus publication time. A row joins an entry when the normalized lines
 * prefix-match with real overlap AND the timestamps are within four days —
 * both conditions, because caption reuse means the same first line can recur
 * weeks apart. Each analytics row joins AT MOST ONE entry (the nearest in
 * time). A post with no rows is reported as unjoined, never scored as zero.
 *
 * ─── SCORING — retention-weighted, reach-aware, honest ──────────────────────
 *
 *   engagement = likes*5 + comments*10 + shares*15 + saves*8   (present only)
 *   base       = views + engagement
 *   score      = base × retention_factor
 *
 * retention_factor = 0.5 + clamp(avg_watch/duration, 0, 1.5) when BOTH fields
 * are present (so 0.5×..2.0×), and exactly 1 when either is absent — an
 * absent watch time must not silently punish or reward a post. Rows also
 * carry engagement_per_reach when reach is present (Instagram only; TikTok
 * and YouTube have no reach field, per ANALYTICS-COVERAGE.md).
 *
 * A post's headline score is the MEDIAN of its Instagram rows — the same reel
 * genuinely exists on four IG accounts, and a median is robust to one account
 * having a follower base the others don't. TikTok/YouTube scores are kept per
 * platform, never averaged into the IG number (their scales differ by orders
 * of magnitude).
 *
 * ─── RANKING — min-sample thresholds and the kill list ──────────────────────
 *
 * An axis value needs MIN_SAMPLE posts to be ranked at all; below that it is
 * verdict "insufficient_sample" — visible, never killed, never crowned. With
 * enough samples: "kill" when the value's mean score is below KILL_FACTOR ×
 * the median of all sufficiently-sampled means, "winner" for the top values,
 * "mid" otherwise. Only axes generation actually controls (hook_style,
 * caption_length) can produce kill-list entries; posting slots are analyzed
 * for the brief but marked analyzed-only, because the cron owns them.
 */

import { classifyCanonicalStyle, toCanonicalStyle } from "./hook-styles.js";
import { validPosts } from "./state.js";
import { DEFAULT_BRAND } from "./variation.js";

export const MIN_SAMPLE = 3;
export const KILL_FACTOR = 0.5;
export const JOIN_WINDOW_DAYS = 4;
export const MIN_LINE_OVERLAP = 20;
export const DEFAULT_LOOKBACK_DAYS = 28;

/** Normalize a caption line / slug for matching. */
export function normalizeLine(text) {
  return String(text ?? "")
    .replace(/…$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9$%]+/g, " ")
    .trim();
}

/** Do two normalized first lines refer to the same caption? */
export function linesMatch(a, b) {
  const x = normalizeLine(a);
  const y = normalizeLine(b);
  if (!x || !y) return false;
  const shorter = x.length <= y.length ? x : y;
  const longer = x.length <= y.length ? y : x;
  if (shorter.length < MIN_LINE_OVERLAP) return x === y;
  return longer.startsWith(shorter);
}

/**
 * Reel entries eligible for learning, newest-last, scoped to ONE brand.
 *
 * Brand scoping: legacy entries carry no `brand` field and belong to the
 * default brand; brand-lane entries are stamped (brand:"ldt"). A lane's clip
 * posts are its reels — they carry a type (`ldt_clip`) so every realty guard
 * ignores them, which is why the type exclusion here admits `*_clip` and the
 * brand filter does the separating. One brand's brief never scores another
 * brand's posts.
 */
export function reelEntries(log, { brand = DEFAULT_BRAND, days = DEFAULT_LOOKBACK_DAYS, now = new Date() } = {}) {
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  return validPosts(log).filter((p) => {
    if ((p.brand || DEFAULT_BRAND) !== brand) return false;
    const isBrandClip = typeof p.type === "string" && p.type.endsWith("_clip");
    if ((p.type && !isBrandClip) || p.platform === "instagram_main_native") return false;
    if (!p.city || !p.slot || !p.caption) return false;
    if (p.success === false) return false;
    const ts = new Date(p.timestamp).getTime();
    return Number.isFinite(ts) && ts > cutoff;
  });
}

/**
 * The generation tags for an entry, with provenance.
 *
 * Tagged entries (written by the variation engine) answer directly. Legacy
 * entries are classified from the stored caption and marked "inferred" —
 * an inferred style is a judgment, and the brief counts the two separately.
 */
export function generationFor(entry) {
  if (entry.generation?.hook_style) {
    return {
      provenance: "tagged",
      hook_style: toCanonicalStyle(entry.generation.hook_style) || entry.generation.hook_style,
      caption_length_bucket: entry.generation.caption_length_bucket || null,
    };
  }
  const classified = classifyCanonicalStyle(entry.caption);
  return {
    provenance: "inferred",
    hook_style: classified === "unknown" ? null : classified,
    caption_length_bucket: null,
  };
}

/**
 * Join posted-log entries to analytics rows. See the module header for the
 * matching rules. Returns { joined, unjoined_entries, unattributed_rows }.
 */
export function joinPostsToAnalytics({ log, analytics, brand = DEFAULT_BRAND, days = DEFAULT_LOOKBACK_DAYS, now = new Date() } = {}) {
  const entries = reelEntries(log, { brand, days, now });
  const rows = Array.isArray(analytics?.recent_posts) ? analytics.recent_posts : [];
  const windowMs = JOIN_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  const byEntry = new Map(entries.map((e) => [e, []]));
  let unattributed = 0;

  for (const row of rows) {
    if (!row?.slug || !row?.published) { unattributed++; continue; }
    const published = new Date(row.published).getTime();
    if (!Number.isFinite(published)) { unattributed++; continue; }

    let best = null;
    let bestDelta = Infinity;
    for (const entry of entries) {
      const ts = new Date(entry.timestamp).getTime();
      const delta = Math.abs(published - ts);
      if (delta > windowMs) continue;
      if (!linesMatch(entry.caption.split("\n")[0], row.slug)) continue;
      if (delta < bestDelta) { best = entry; bestDelta = delta; }
    }
    if (best) byEntry.get(best).push(row);
    else unattributed++;
  }

  const joined = [];
  const unjoined = [];
  for (const entry of entries) {
    const entryRows = byEntry.get(entry);
    const generation = generationFor(entry);
    if (entryRows.length === 0) {
      unjoined.push({ entry, generation, reason: "no analytics rows matched (posted too recently, or first line diverged)" });
      continue;
    }
    joined.push({ entry, generation, rows: entryRows });
  }
  return { joined, unjoined_entries: unjoined, unattributed_rows: unattributed };
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/**
 * Score one analytics row. Absent metrics contribute nothing and are named in
 * `missing` — a score built on partial data says so instead of pretending.
 */
export function scoreRow(row) {
  const m = row?.metrics || {};
  const missing = [];
  const take = (key) => {
    const v = m[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    missing.push(key);
    return null;
  };

  const views = take("views");
  const likes = take("likes");
  const comments = take("comments");
  const shares = take("shares");
  const saves = typeof m.saves === "number" ? m.saves : null;
  if (saves === null) missing.push("saves");

  const engagement = (likes ?? 0) * 5 + (comments ?? 0) * 10 + (shares ?? 0) * 15 + (saves ?? 0) * 8;
  const base = (views ?? 0) + engagement;

  let retentionFactor = 1;
  let retention = null;
  if (typeof m.avg_watch_seconds === "number" && typeof m.duration_seconds === "number" && m.duration_seconds > 0) {
    retention = m.avg_watch_seconds / m.duration_seconds;
    retentionFactor = 0.5 + clamp(retention, 0, 1.5);
  } else {
    missing.push("retention");
  }

  let engagementPerReach = null;
  if (typeof m.reach === "number" && m.reach > 0 && typeof m.interactions === "number") {
    engagementPerReach = m.interactions / m.reach;
  }

  return {
    score: base * retentionFactor,
    views,
    retention,
    retention_factor: retentionFactor,
    engagement_per_reach: engagementPerReach,
    partial: missing.length > 0,
    missing,
  };
}

const median = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * Score a joined post. Headline = median of IG row scores; other platforms
 * are reported alongside, never blended in.
 */
export function scoreJoinedPost(joinedPost) {
  const perPlatform = {};
  for (const row of joinedPost.rows) {
    const platform = row.platform || "unknown";
    (perPlatform[platform] ||= []).push({ row, scored: scoreRow(row) });
  }
  const igScores = (perPlatform.instagram || []).map((r) => r.scored.score);
  let headline = median(igScores);
  let basis = "instagram_median";
  if (headline === null) {
    for (const platform of ["tiktok", "youtube_shorts"]) {
      const scores = (perPlatform[platform] || []).map((r) => r.scored.score);
      if (scores.length > 0) { headline = median(scores); basis = `${platform}_median`; break; }
    }
  }
  return { headline, basis, perPlatform };
}

/**
 * Rank one axis across scored posts.
 *
 * `posts` — [{ value, score }] where value is the axis value for that post
 * (null values are dropped: an unclassifiable post is not evidence).
 * `controlled` — only controlled axes may produce "kill" verdicts.
 */
export function rankAxis(posts, { minSample = MIN_SAMPLE, controlled = true, killFactor = KILL_FACTOR } = {}) {
  const groups = new Map();
  for (const { value, score } of posts) {
    if (value === null || value === undefined || score === null) continue;
    (groups.get(value) || groups.set(value, []).get(value)).push(score);
  }

  const table = {};
  const sufficientMeans = [];
  for (const [value, scores] of groups) {
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    table[value] = { n: scores.length, score: Math.round(mean), median: Math.round(median(scores)) };
    if (scores.length >= minSample) sufficientMeans.push(mean);
  }

  const overallMedian = median(sufficientMeans);
  let bestValue = null;
  let bestScore = -Infinity;
  for (const [value, row] of Object.entries(table)) {
    if (row.n < minSample) {
      row.verdict = "insufficient_sample";
      continue;
    }
    if (controlled && overallMedian !== null && row.score < overallMedian * killFactor) {
      row.verdict = "kill";
      continue;
    }
    row.verdict = "mid";
    if (row.score > bestScore) { bestScore = row.score; bestValue = value; }
  }
  if (bestValue !== null) table[bestValue].verdict = "winner";
  return table;
}

/** kill_list entries for one ranked axis table. */
export function killListFrom(table, axis) {
  return Object.entries(table)
    .filter(([, row]) => row.verdict === "kill")
    .map(([value, row]) => ({
      axis,
      value,
      n: row.n,
      score: row.score,
      reason: `mean score ${row.score} over ${row.n} posts is below ${KILL_FACTOR}× the median of ranked ${axis} values`,
    }));
}

/**
 * Build a brand's brief from the log + analytics. The orchestrator writes the
 * result to learning/brief-<brand>.json and emails renderBriefEmail(brief).
 */
export function buildBrief({ brand, log, analytics, days = DEFAULT_LOOKBACK_DAYS, now = new Date() }) {
  const { joined, unjoined_entries, unattributed_rows } = joinPostsToAnalytics({ log, analytics, brand, days, now });

  const scored = joined
    .map((jp) => ({ ...jp, scoring: scoreJoinedPost(jp) }))
    .filter((jp) => jp.scoring.headline !== null);

  const styleRows = scored.map((jp) => ({ value: jp.generation.hook_style, score: jp.scoring.headline }));
  const lengthRows = scored.map((jp) => ({ value: jp.generation.caption_length_bucket, score: jp.scoring.headline }));
  const slotRows = scored.map((jp) => ({ value: `${jp.entry.slot}`, score: jp.scoring.headline }));
  const cityRows = scored.map((jp) => ({ value: jp.entry.city, score: jp.scoring.headline }));

  const hookStyles = rankAxis(styleRows, { controlled: true });
  const captionLengths = rankAxis(lengthRows, { controlled: true });
  const postingSlots = rankAxis(slotRows, { controlled: false });
  const cities = rankAxis(cityRows, { controlled: false });

  const killList = [...killListFrom(hookStyles, "hook_style"), ...killListFrom(captionLengths, "caption_length")];

  const topHooks = [...scored]
    .sort((a, b) => b.scoring.headline - a.scoring.headline)
    .slice(0, 5)
    .map((jp) => {
      const igRows = jp.scoring.perPlatform.instagram || [];
      const views = igRows.map((r) => r.scored.views).filter((v) => v !== null);
      return {
        hook: jp.entry.caption.split("\n")[0].slice(0, 140),
        hook_style: jp.generation.hook_style,
        provenance: jp.generation.provenance,
        score: Math.round(jp.scoring.headline),
        score_basis: jp.scoring.basis,
        ig_views_median: views.length ? Math.round(median(views)) : null,
        city: jp.entry.city,
        posted: jp.entry.timestamp,
      };
    });

  const tagged = scored.filter((jp) => jp.generation.provenance === "tagged").length;
  const inferred = scored.length - tagged;

  const caveats = [];
  caveats.push(`${scored.length} posts scored over the last ${days} days; values with fewer than ${MIN_SAMPLE} posts are marked insufficient_sample and never ranked or killed.`);
  if (inferred > 0) {
    caveats.push(`${inferred} of ${scored.length} posts predate decision tagging — their hook style was inferred from the published caption (legacy styles mapped: vibe→pov, wait_tease→pattern_interrupt, reaction→story_open). Treat those groupings as approximate.`);
  }
  if (unjoined_entries.length > 0) {
    caveats.push(`${unjoined_entries.length} posted reels had no matching analytics rows (usually: posted within the last day, before metrics exist). They are excluded, not zeroed.`);
  }
  caveats.push("Posting slots are set by the cron, not chosen per post — the slot table is analysis, not a controlled experiment.");
  caveats.push("Scores are not comparable across platforms; the headline score is the median across the brand's Instagram accounts.");

  return {
    brand,
    engine: "learn-v1",
    generated_at: now.toISOString(),
    window_days: days,
    sample: {
      posts_scored: scored.length,
      posts_unjoined: unjoined_entries.length,
      analytics_rows_joined: scored.reduce((n, jp) => n + jp.rows.length, 0),
      analytics_rows_unattributed: unattributed_rows,
      provenance: { tagged, inferred },
    },
    hook_styles: hookStyles,
    caption_lengths: captionLengths,
    posting_slots: { analyzed_only: true, table: postingSlots },
    cities: { analyzed_only: true, table: cities },
    top_hooks: topHooks,
    kill_list: killList,
    guidance: { exploit_ratio: 0.7, explore_ratio: 0.3 },
    unavailable: Array.isArray(analytics?.unavailable) ? analytics.unavailable.map((u) => ({ metric: u.metric, platforms: u.platforms })) : [],
    caveats,
  };
}

const VERDICT_ICON = { winner: "★", mid: "•", kill: "✗", insufficient_sample: "…" };

function axisLines(table, labelFor = (v) => v) {
  return Object.entries(table)
    .sort((a, b) => (b[1].score ?? -1) - (a[1].score ?? -1))
    .map(([value, row]) =>
      `  ${VERDICT_ICON[row.verdict] || "•"} ${labelFor(value)} — score ${row.score} over ${row.n} post${row.n === 1 ? "" : "s"}` +
      (row.verdict === "insufficient_sample" ? " (too few to rank)" : row.verdict === "kill" ? " (KILLED)" : row.verdict === "winner" ? " (winner)" : "")
    );
}

/**
 * The one-page brief email. Plain text, honest numbers, caveats stated in the
 * body rather than implied.
 */
export function renderBriefEmail(brief) {
  const lines = [];
  lines.push(`WHAT'S WORKING — ${brief.brand} — week of ${brief.generated_at.slice(0, 10)}`);
  lines.push("");
  lines.push(`${brief.sample.posts_scored} posts scored (last ${brief.window_days} days). ` +
    `${brief.sample.provenance.tagged} carried decision tags, ${brief.sample.provenance.inferred} were classified after the fact.`);
  lines.push("");

  lines.push("HOOK STYLES");
  lines.push(...axisLines(brief.hook_styles));
  lines.push("");

  const lengthEntries = Object.keys(brief.caption_lengths);
  lines.push("CAPTION LENGTHS");
  if (lengthEntries.length === 0) {
    lines.push("  (no length-tagged posts in the window yet — the first tagged week fills this in)");
  } else {
    lines.push(...axisLines(brief.caption_lengths));
  }
  lines.push("");

  lines.push("POSTING SLOTS (analysis only — the cron owns the schedule)");
  lines.push(...axisLines(brief.posting_slots.table, (v) => v.toUpperCase()));
  lines.push("");

  lines.push("TOP HOOKS, VERBATIM");
  for (const h of brief.top_hooks) {
    lines.push(`  "${h.hook}"`);
    lines.push(`      style ${h.hook_style || "unknown"}${h.provenance === "inferred" ? " (inferred)" : ""}, score ${h.score}, IG median views ${h.ig_views_median ?? "n/a"}, ${h.city}`);
  }
  lines.push("");

  lines.push("KILL LIST");
  if (brief.kill_list.length === 0) {
    lines.push("  (empty — nothing has enough data AND performs badly enough to stop using)");
  } else {
    for (const k of brief.kill_list) {
      lines.push(`  ✗ ${k.axis}=${k.value} — ${k.reason}`);
    }
  }
  lines.push("");

  lines.push("HOW GENERATION USES THIS: 70% of picks lean into the winners above, 30% keep exploring everything not killed. No two consecutive posts share a hook style.");
  lines.push("");

  if (brief.unavailable.length > 0) {
    lines.push("NOT MEASURABLE ON THIS ACCOUNT (omitted, never estimated): " +
      brief.unavailable.map((u) => `${u.metric} (${u.platforms.join("/")})`).join("; "));
    lines.push("");
  }

  lines.push("CAVEATS");
  for (const c of brief.caveats) lines.push(`  - ${c}`);
  return lines.join("\n");
}
