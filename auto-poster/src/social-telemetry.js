/**
 * social-telemetry.js — the poster reporting on itself, for LIFESTYLE.
 *
 * Writes two files at the REPO ROOT so the dashboard has live numbers instead
 * of a blank panel:
 *
 *     status/social_stats.json   five scalars, a whole snapshot every run
 *     status/social_log.json     the 100 most recent platform-level events
 *
 * READ-ONLY BY CONSTRUCTION. Every number here is derived from JSON the
 * posting run already wrote (posted-log.json, carousel-log.json). This module
 * never posts, uploads, schedules or deletes; a bug in it can make a dashboard
 * wrong, never a social account.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RULE: NEVER INVENT A NUMBER
 *
 * A key that is PRESENT is a counted fact. A key that is ABSENT is "we do not
 * know". Zero means we looked and counted zero. Those three states are not
 * interchangeable, and the difference is the whole point of this file — a
 * dashboard that confidently prints "TikTok: 4" on a day TikTok rejected every
 * upload is worse than one that prints nothing.
 *
 * This matters here more than it looks, because AN ENTRY CAN CARRY EITHER REAL
 * EVIDENCE OR NONE, and the two must not read alike:
 *
 *   - BOTH pipelines now verify. carousel-verify.js and reel-verify.js poll
 *     Metricool after the post settles and stamp each distribution row with a
 *     per-network `verdict` — published / failed / pending / unknown. When those
 *     rows are on an entry they are the outcome, they are what this writer
 *     counts, and instagram/tiktok/youtube_shorts report real publication
 *     numbers off them.
 *
 *   - main.js ALSO writes `platforms: ["tiktok","youtube","satellite_ig"]` as a
 *     HARDCODED LITERAL (in the recordPost call). It is written whenever the run
 *     reaches that line, whatever the providers actually did. It records INTENT,
 *     not outcome, and is never read here as an outcome — a verified entry's
 *     rows REPLACE it rather than being counted alongside it.
 *
 *   - An entry with NO verdict rows is either older than the verification
 *     wiring or was written by a run whose verification never got to look. For
 *     those, `brands` — the comma-joined labels whose scheduler call returned
 *     200 — is the only evidence there is, so "scheduled" is a fact and
 *     "published" stays unknowable. That is still the truth for them, and the
 *     writer keeps saying exactly that.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * UNITS
 *
 * posts_scheduled and the posts_published_today counts are PLATFORM-LEVEL: one
 * reel fanned out to TikTok and YouTube Shorts is 2, not 1. The two fields are
 * counted the same way so they can be read against each other.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Both files are written temp-then-rename. The dashboard polls them, and a
 * reader that catches a half-written file must get invalid JSON, not a partial
 * number.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, openSync, fsyncSync, closeSync, unlinkSync, chmodSync } from "node:fs";
import { join } from "node:path";

export const STATUS_DIRNAME = "status";
export const STATS_FILENAME = "social_stats.json";
export const LOG_FILENAME = "social_log.json";

/** The dashboard contract. Three platforms, no others. */
export const PLATFORMS = ["instagram", "tiktok", "youtube_shorts"];

/** The dashboard contract for an event. Three types, no others. */
export const EVENT_TYPES = ["published", "scheduled", "failed"];

export const MAX_LOG_ENTRIES = 100;

const DETAIL_MAX_CHARS = 120;
const SLUG_MAX_CHARS = 80;

/**
 * Map a network name as this repo spells it onto the dashboard's vocabulary.
 *
 * "youtube" → youtube_shorts is correct rather than lossy: metricool.js posts
 * every video with `youtubeData: { type: "short" }`, so the only YouTube this
 * poster produces IS a Short. (Long-form lives in youtube-longform.yml and
 * writes youtube-log.json, which this writer deliberately does not read.)
 *
 * Facebook and LinkedIn return null — they are real destinations, but they are
 * outside the three-platform contract and must not be silently folded into a
 * neighbouring bucket.
 */
export function platformOf(network) {
  switch (String(network || "").trim().toLowerCase()) {
    case "instagram":
    case "satellite_ig":
    case "instagram_main_native":
      return "instagram";
    case "tiktok":
      return "tiktok";
    case "youtube":
    case "youtube_shorts":
    case "shorts":
      return "youtube_shorts";
    default:
      return null;
  }
}

/**
 * Chicago-local YYYY-MM-DD.
 *
 * A local copy of carousel-content.js's helper rather than an import, on
 * purpose: this module is loaded by merge-log-push.mjs in a step that runs
 * `if: always()`, including after the run has already failed. carousel-content
 * pulls in the Anthropic SDK at import time, and an SDK that fails to load
 * must not be able to take the telemetry down with it. Six lines is a cheaper
 * dependency than that risk.
 */
export function todayInChicago(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** UTC ISO 8601 with a Z suffix and no microseconds — the shape the dashboard parses. */
export function isoZ(value = new Date()) {
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function clip(text, max) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max - 1).trimEnd() + "…";
}

/** Is this entry's timestamp on `dateStr` (Chicago-local)? Unparseable → no. */
function onDay(timestamp, dateStr) {
  const ts = new Date(timestamp);
  if (Number.isNaN(ts.getTime())) return false;
  return todayInChicago(ts) === dateStr;
}

/** Something a human can recognise the post by. Never a fabricated title. */
function slugFor(entry) {
  const candidate =
    entry.fileName ||
    entry.topic ||
    entry.title ||
    (entry.captionSnippet ? String(entry.captionSnippet).split("\n")[0] : "") ||
    entry.driveFileId ||
    entry.city ||
    "";
  return clip(candidate, SLUG_MAX_CHARS) || "unidentified post";
}

function event({ ts, platform, type, slug, detail }) {
  const e = { ts: isoZ(ts), type, title_or_slug: slug, detail: clip(detail, DETAIL_MAX_CHARS) };
  // platform is omitted, never guessed, when the fact is not platform-specific
  // (a whole-run failure) — omitted means unknown, exactly like the stats.
  if (platform) e.platform = platform;
  return e;
}

// ── posted-log.json → events ────────────────────────────────────────────────

/**
 * Events from one posted-log entry. Returns [] for anything outside the
 * contract rather than guessing at it.
 *
 * The `brands` field carries the load here. main.js sets it to the joined
 * labels of the brands whose scheduler call returned 200, and state.recordPost
 * only persists it `if (entry.brands)` — so an EMPTY join (no brand succeeded)
 * leaves the key ABSENT. That gives three distinguishable states, and they are
 * treated as three:
 *
 *   non-empty string      → the scheduler accepted at least one brand: scheduled
 *   "unknown"             → createPost returned nothing readable: no event
 *   absent, with platforms→ every brand failed: failed
 */
export function eventsFromPostedEntry(entry) {
  if (!entry || typeof entry !== "object") return [];
  const ts = entry.timestamp;
  if (!ts) return [];
  const slug = slugFor(entry);

  // A manual-confirm receipt: the owner posted to main Instagram natively and
  // confirmed it. This is the ONLY published-on-Instagram evidence this repo
  // has, because main IG is never auto-published (mainBrandSkipIG).
  if (entry.platform === "instagram_main_native") {
    return [event({
      ts, platform: "instagram", type: "published", slug,
      detail: "main Instagram — confirmed posted natively by owner",
    })];
  }

  // LinkedIn-only entries are a different pipeline and a platform this
  // contract does not carry.
  if (entry.type === "linkedin") return [];

  const out = [];

  // An entry that recorded its own failure. Not platform-specific — a reel that
  // never got built failed everywhere and nowhere — so `platform` is omitted.
  if (entry.success === false) {
    out.push(event({
      ts, type: "failed", slug,
      detail: entry.note || entry.error || entry.reason || "run recorded success: false",
    }));
    return out;
  }

  // A VERIFIED reel. main.js runs reel-verify.js after the scheduler accepts the
  // post and stamps the entry with per-network verdict rows — the same shape and
  // the same meaning as a carousel row — so the outcome is readable here rather
  // than guessable. When those rows exist they REPLACE the `platforms` literal
  // entirely: `platforms` records intent, the rows record what happened, and
  // counting both would report one publication as scheduled AND published.
  const verdictRows = Array.isArray(entry.distribution) ? entry.distribution : [];
  if (verdictRows.length > 0) {
    out.push(...eventsFromVerdictRows({ ts, slug, rows: verdictRows, kind: "reel" }));
    out.push(...mainIgDeliveryEvents({ ts, slug, entry }));
    return out;
  }

  const intended = Array.isArray(entry.platforms) ? entry.platforms : [];
  const platforms = [...new Set(intended.map(platformOf).filter(Boolean))];

  if (platforms.length === 0) return out;

  const brands = typeof entry.brands === "string" ? entry.brands.trim() : "";

  if (brands === "unknown") {
    // createPost gave main.js nothing readable. We do not know whether this
    // reached the scheduler, so we say nothing about it.
    return out;
  }

  if (!brands) {
    // The key is absent because the join was empty: no brand's scheduler call
    // succeeded. A real, counted failure.
    out.push(event({
      ts, type: "failed", slug,
      detail: "no brand accepted the post — the scheduler rejected every account",
    }));
    return out;
  }

  for (const platform of platforms) {
    out.push(event({
      ts, platform, type: "scheduled", slug,
      detail: `submitted to the scheduler for ${brands}`,
    }));
  }

  out.push(...mainIgDeliveryEvents({ ts, slug, entry }));

  return out;
}

/**
 * Delivery of the main-IG cut is a separate, real outcome: when it fails the
 * owner never gets the video and main Instagram silently goes dark that slot.
 * Independent of verification — the satellites can publish perfectly while the
 * owner's copy never arrives.
 */
function mainIgDeliveryEvents({ ts, slug, entry }) {
  if (!entry.mainIgDelivery || entry.mainIgDelivery === "delivered") return [];
  return [event({
    ts, platform: "instagram", type: "failed", slug,
    detail: "main Instagram video was not delivered to the owner — nothing to post natively",
  })];
}

// ── verdict rows → events ───────────────────────────────────────────────────

/**
 * The one reader for a verified per-network row, used by BOTH pipelines.
 *
 * carousel-verify.js and reel-verify.js write the same row — { network, label,
 * postId, ok, verdict, failureReason } — because they answer the same question
 * against the same API. `kind` only names the pipeline in the human-readable
 * detail; the counting is identical, which is the point: a published reel and a
 * published carousel are both one publication.
 */
function eventsFromVerdictRows({ ts, slug, rows, kind }) {
  const out = [];
  for (const row of rows) {
    if (!row || row.skipped) continue;           // never sent to that network
    const platform = platformOf(row.network);
    if (!platform) continue;                     // facebook / linkedin

    // The account name is not decoration — it is what makes two rows distinct.
    // One post fans out to several brands, so a single run really does publish
    // to Instagram two or three times, on different accounts, in the same
    // second. Without the label those rows render identically and the log
    // dedupes real publications away: on 2026-08-11 the carousel published to
    // Instagram as propertypete01 AND lifestyledesignrealtyaustintx, and the
    // log showed one of them while the stats counted both.
    const who = row.label ? ` (${row.label})` : "";

    if (row.verdict === "published") {
      out.push(event({ ts, platform, type: "published", slug, detail: `${kind} confirmed published${who}` }));
    } else if (row.verdict === "failed") {
      out.push(event({
        ts, platform, type: "failed", slug,
        detail: `${row.failureReason || `${kind} provider reported failure`}${who}`,
      }));
    } else if (row.ok && row.postId) {
      // pending / unknown — it reached the scheduler, and that is all we know.
      out.push(event({ ts, platform, type: "scheduled", slug, detail: `${kind} accepted by scheduler, publication unconfirmed${who}` }));
    }
  }
  return out;
}

// ── carousel-log.json → events ──────────────────────────────────────────────

/**
 * Events from one carousel entry.
 *
 * carousel-verify.js polls Metricool after settling and stamps each
 * distribution row with a verdict, so "published" here is a confirmed
 * publication rather than an accepted upload. The reels path now writes the same
 * rows, and both go through the same reader.
 */
export function eventsFromCarouselEntry(entry) {
  if (!entry || typeof entry !== "object") return [];
  const ts = entry.timestamp || entry.date;
  if (!ts) return [];
  return eventsFromVerdictRows({
    ts,
    slug: slugFor(entry),
    rows: Array.isArray(entry.distribution) ? entry.distribution : [],
    kind: "carousel",
  });
}

// ── Stats ───────────────────────────────────────────────────────────────────

/**
 * Collapse today's events into the five scalars.
 *
 * posts_published_today carries a key for a platform ONLY when today produced
 * at least one settled observation about it — a published or a failed verdict.
 * A platform that was merely scheduled all day is omitted, because "scheduled"
 * is not evidence of publication and a 0 there would read as "we checked and
 * nothing published", which is a different and false claim.
 */
export function buildStats(events, { date, lastRunIso }) {
  const published = {};
  const settled = new Set();
  let scheduled = 0;
  let failures = 0;

  for (const e of events) {
    if (e.type === "scheduled") {
      scheduled += 1;
      continue;
    }
    if (e.type === "failed") {
      failures += 1;
      // A failed verdict is a settled observation: it proves we can see this
      // platform's outcome, so a 0 alongside it is a counted zero.
      if (e.platform) settled.add(e.platform);
      continue;
    }
    if (e.type === "published" && e.platform) {
      settled.add(e.platform);
      published[e.platform] = (published[e.platform] || 0) + 1;
    }
  }

  const posts_published_today = {};
  for (const platform of PLATFORMS) {
    if (settled.has(platform)) posts_published_today[platform] = published[platform] || 0;
  }

  return {
    date,
    posts_scheduled: scheduled,
    posts_published_today,
    failures,
    last_run_iso: lastRunIso,
  };
}

// ── Rolling log ─────────────────────────────────────────────────────────────

function validEvent(e) {
  if (!e || typeof e !== "object") return false;
  if (!EVENT_TYPES.includes(e.type)) return false;
  if (e.platform !== undefined && !PLATFORMS.includes(e.platform)) return false;
  return !Number.isNaN(new Date(e.ts).getTime());
}

/** Identity for dedupe — every contract field, so a rerun is a no-op. */
function keyOf(e) {
  return [e.ts, e.platform || "", e.type, e.title_or_slug || "", e.detail || ""].join(" ");
}

function publicEvent(e) {
  const out = { ts: String(e.ts), type: String(e.type), title_or_slug: String(e.title_or_slug ?? ""), detail: String(e.detail ?? "") };
  if (e.platform) out.platform = String(e.platform);
  return out;
}

/**
 * Union of what is on disk and what this run can see — NOT an append.
 *
 * Every posting job runs this, and a job that loses the push race re-runs the
 * whole thing on top of the winner's commit. An append would duplicate the
 * winner's events every time; a merge makes the retry a no-op. It also means
 * history older than the source logs' retention survives on disk.
 *
 * `fresh` wins a key collision — it carries the current rendering.
 */
export function mergeSocialLog(existing, fresh, limit = MAX_LOG_ENTRIES) {
  const merged = new Map();
  for (const e of Array.isArray(existing) ? existing : []) {
    if (validEvent(e)) merged.set(keyOf(e), e);
  }
  for (const e of Array.isArray(fresh) ? fresh : []) {
    if (validEvent(e)) merged.set(keyOf(e), e);
  }
  return [...merged.values()]
    .sort((a, b) => (a.ts === b.ts ? keyOf(a).localeCompare(keyOf(b)) : (a.ts < b.ts ? 1 : -1)))
    .slice(0, limit)
    .map(publicEvent);
}

// ── Reading and writing ─────────────────────────────────────────────────────

/** Whatever is on disk. Unreadable or wrong-shaped is treated as absent — a
 *  corrupt file must not stop this run from publishing. */
export function readJsonOr(path, fallback) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Temp file in the destination directory, then rename.
 *
 * Same directory so the rename is same-filesystem and therefore atomic; fsync
 * before it so a killed runner cannot leave a renamed-but-empty file.
 */
export function atomicWriteJson(path, payload) {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", { encoding: "utf-8", mode: 0o644 });
    const fd = openSync(tmp, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o644);
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* the temp file may never have existed */ }
    throw err;
  }
}

/**
 * Build today's events from both source logs.
 *
 * Reads from disk rather than taking the in-memory log so that it sees the
 * MERGED state — merge-log-push.mjs calls this after resetting to origin/main
 * and re-merging, so the files on disk are the union of this run and every
 * sibling runner, including the manual-confirm Instagram receipts the
 * dashboard pushes from outside this repo.
 */
export function collectEvents({ autoPosterDir, date }) {
  const posted = readJsonOr(join(autoPosterDir, "posted-log.json"), { posts: [] });
  const carousel = readJsonOr(join(autoPosterDir, "carousel-log.json"), { posts: [] });

  const events = [];
  for (const entry of Array.isArray(posted?.posts) ? posted.posts : []) {
    if (!onDay(entry?.timestamp, date)) continue;
    events.push(...eventsFromPostedEntry(entry));
  }
  for (const entry of Array.isArray(carousel?.posts) ? carousel.posts : []) {
    if (!onDay(entry?.timestamp || entry?.date, date)) continue;
    events.push(...eventsFromCarouselEntry(entry));
  }
  return events.filter(validEvent);
}

/**
 * Write both status files. Returns what was written, for logging and tests.
 *
 * NEVER THROWS. This is called from the commit step of a live posting job that
 * runs `if: always()`; failing here would turn a successful post red — or
 * worse, abort the step that pushes the posted-log, which is the file that
 * stops the next run double-posting. A dashboard number is never worth that.
 */
export function writeSocialTelemetry({ repoRoot, autoPosterDir, now = new Date() } = {}) {
  try {
    const date = todayInChicago(now);
    const statusDir = join(repoRoot, STATUS_DIRNAME);
    const statsPath = join(statusDir, STATS_FILENAME);
    const logPath = join(statusDir, LOG_FILENAME);

    const fresh = collectEvents({ autoPosterDir, date });
    const merged = mergeSocialLog(readJsonOr(logPath, []), fresh);
    const stats = buildStats(fresh, { date, lastRunIso: isoZ(now) });

    atomicWriteJson(statsPath, stats);
    atomicWriteJson(logPath, merged);

    return { ok: true, stats, log: merged, paths: [statsPath, logPath] };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}
