/**
 * merge-strategies.mjs — pure JSON merge functions used by merge-log-push.mjs.
 *
 * Extracted from merge-log-push.mjs so they can be unit-tested without touching git.
 * These functions must stay PURE (no fs, no git, no process.exit) — that is what
 * makes the concurrent-runner merge behaviour testable.
 */

/**
 * posted-log.json: append local entries whose timestamp doesn't already exist remotely.
 *
 * Dedup key is `timestamp`. Entries are matched on timestamp alone because a single
 * logical post is written exactly once by recordPost() with a ms-precision ISO stamp.
 */
export function mergePostedLog(local, remote, log = console.log) {
  const remotePosts = [...(remote?.posts || [])];
  const localPosts = local?.posts || [];

  const existingTimestamps = new Set(
    remotePosts.map((p) => p.timestamp).filter(Boolean)
  );

  let added = 0;
  for (const entry of localPosts) {
    if (entry.timestamp && !existingTimestamps.has(entry.timestamp)) {
      remotePosts.push(entry);
      existingTimestamps.add(entry.timestamp);
      added++;
    }
  }

  const merged = { ...remote, ...local, posts: remotePosts };
  log(`[Merge] posted-log: ${added} new entries appended (total: ${remotePosts.length})`);
  return merged;
}

/** video-matches.json: object keyed by drive file id → local wins on conflict. */
export function mergeVideoMatches(local, remote, log = console.log) {
  const merged = { ...remote, ...local };
  log(`[Merge] video-matches: local=${Object.keys(local || {}).length}, remote=${Object.keys(remote || {}).length}, merged=${Object.keys(merged).length}`);
  return merged;
}

/** performance-weights.json: per key, take whichever side has the newer lastUpdated. */
export function mergePerformanceWeights(local, remote, log = console.log) {
  const merged = { ...(remote || {}) };
  for (const [key, localVal] of Object.entries(local || {})) {
    if (!merged[key]) {
      merged[key] = localVal;
    } else if (localVal && typeof localVal === "object" && localVal.lastUpdated) {
      const remoteUpdated = merged[key]?.lastUpdated || "";
      if (localVal.lastUpdated > remoteUpdated) merged[key] = localVal;
    } else {
      merged[key] = localVal;
    }
  }
  log(`[Merge] performance-weights: ${Object.keys(merged).length} keys`);
  return merged;
}

/** qc-blocklist.json: union — once blocked, always blocked. */
export function mergeBlocklist(local, remote, log = console.log) {
  const merged = {
    blockedDriveIds: { ...(remote?.blockedDriveIds || {}), ...(local?.blockedDriveIds || {}) },
  };
  log(`[Merge] qc-blocklist: ${Object.keys(merged.blockedDriveIds).length} blocked videos`);
  return merged;
}

/** linkedin-history.json: union by date, keep last 7. */
export function mergeLinkedinHistory(local, remote, log = console.log) {
  const allPosts = [...(remote?.posts || []), ...(local?.posts || [])];
  const byDate = new Map();
  for (const p of allPosts) byDate.set(p.date || p.body?.slice(0, 30), p);
  const merged = { posts: [...byDate.values()].slice(-7) };
  log(`[Merge] linkedin-history: ${merged.posts.length} entries`);
  return merged;
}

/** trial-variants.json: union by generatedAt, newest first, keep 100. */
export function mergeTrialVariants(local, remote, log = console.log) {
  const all = [...(remote?.variants || []), ...(local?.variants || [])];
  const seen = new Set();
  const deduped = [];
  for (const v of all) {
    const key = v.generatedAt || `${v.date}-${v.window}-${v.sourceVideoId}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(v);
    }
  }
  deduped.sort((a, b) => (b.generatedAt || "").localeCompare(a.generatedAt || ""));
  const merged = { variants: deduped.slice(0, 100) };
  log(`[Merge] trial-variants: ${merged.variants.length} entries`);
  return merged;
}

/**
 * carousel-log.json: union by timestamp, oldest first, keep the last 120.
 *
 * Append-only like posted-log, but with a second dedup key. The carousel job
 * has its own concurrency group, so two runners writing the same day's entry
 * should not happen — if it does, `date` catches the duplicate that `timestamp`
 * would miss, since two runs of the same day produce different ms stamps but
 * the same date. Losing that check would put two entries for one day into the
 * writer's anti-example window and waste it.
 */
export function mergeCarouselLog(local, remote, log = console.log) {
  const all = [...(remote?.posts || []), ...(local?.posts || [])];
  const seenTimestamps = new Set();
  const seenDates = new Set();
  const merged = [];
  for (const p of all) {
    if (!p || typeof p !== "object") continue;
    const ts = p.timestamp;
    if (ts && seenTimestamps.has(ts)) continue;
    if (p.date && seenDates.has(p.date)) continue;
    if (ts) seenTimestamps.add(ts);
    if (p.date) seenDates.add(p.date);
    merged.push(p);
  }
  merged.sort((a, b) => String(a.timestamp || "").localeCompare(String(b.timestamp || "")));
  const kept = merged.slice(-120);
  log(`[Merge] carousel-log: ${kept.length} entries`);
  return { ...remote, ...local, posts: kept };
}

/**
 * skip-list.json: union by driveFileId — a skip is never un-done by a
 * concurrent runner that happened to check out an older copy.
 */
export function mergeSkipList(local, remote, log = console.log) {
  const all = [...(Array.isArray(remote) ? remote : []), ...(Array.isArray(local) ? local : [])];
  const byId = new Map();
  for (const e of all) {
    if (e && typeof e === "object" && typeof e.driveFileId === "string" && e.driveFileId) {
      // Keep the earliest skip for an id — first skip wins, later ones add nothing.
      if (!byId.has(e.driveFileId)) byId.set(e.driveFileId, e);
    }
  }
  const merged = [...byId.values()];
  log(`[Merge] skip-list: ${merged.length} skipped videos`);
  return merged;
}

/**
 * yt-approvals.json: union by requestId, merged field-group by field-group.
 *
 * This is the only managed file with TWO independent writers. The poster
 * appends the request and, later, the acted marker; the dashboard appends
 * Peter's decision and commits it separately. Neither sees the other's commit
 * before making its own, so both sides routinely push a version of the same
 * record that is missing the other side's fields.
 *
 * A plain "local wins" or "first wins" union loses one of them every time, so
 * each record is merged in three independent groups:
 *
 *   identity  kind, requestedAt, payload, videoId
 *   decision  decision, notes, decidedAt        <- only the dashboard writes these
 *   acted     actedAt, actedAction, actedResult <- only the poster writes these
 *
 * Within a group, a side that HAS the group beats a side that does not, and if
 * both have it the earlier timestamp wins. That makes the merge deterministic
 * regardless of which runner gets there first, and gives the approval channel
 * the two properties it depends on:
 *
 *   - a recorded decision can never be erased or flipped by a poster push,
 *   - an acted marker can never be erased by a dashboard push, which is what
 *     stops a re-merge from resurrecting an already-published request and
 *     publishing it a second time.
 */
export function mergeYtApprovals(local, remote, log = console.log) {
  const all = [...(remote?.requests || []), ...(local?.requests || [])];
  const byId = new Map();

  for (const entry of all) {
    if (!entry || typeof entry !== "object") continue;
    const id = entry.requestId;
    if (typeof id !== "string" || !id) continue;
    const existing = byId.get(id);
    byId.set(id, existing ? mergeApprovalRecord(existing, entry) : { ...entry });
  }

  const merged = [...byId.values()].sort((a, b) =>
    String(a.requestedAt || "").localeCompare(String(b.requestedAt || ""))
  );
  const kept = merged.slice(-MAX_APPROVALS);
  const decided = kept.filter((r) => typeof r.decision === "string" && r.decision).length;
  const acted = kept.filter((r) => r.actedAt).length;
  log(`[Merge] yt-approvals: ${kept.length} requests (${decided} decided, ${acted} acted)`);
  return { ...remote, ...local, requests: kept };
}

/** Keep in step with MAX_ENTRIES in src/yt-approvals.js. */
const MAX_APPROVALS = 400;

/**
 * Which side owns a field group: a present value beats an absent one, and when
 * both are present the earlier timestamp wins so the result does not depend on
 * which runner happened to push first.
 */
function groupWinner(aVal, bVal, aStamp, bStamp) {
  const aHas = aVal !== undefined && aVal !== null;
  const bHas = bVal !== undefined && bVal !== null;
  if (aHas && !bHas) return "a";
  if (bHas && !aHas) return "b";
  if (!aHas && !bHas) return "neither";
  const a = String(aStamp || "");
  const b = String(bStamp || "");
  if (a && b) return a <= b ? "a" : "b";
  return a ? "a" : "b";
}

function mergeApprovalRecord(x, y) {
  const out = { requestId: x.requestId };

  // identity — whichever side carries it; earlier requestedAt breaks the tie.
  const idFrom = groupWinner(x.kind, y.kind, x.requestedAt, y.requestedAt) === "b" ? y : x;
  out.kind = idFrom.kind ?? x.kind ?? y.kind;
  out.requestedAt = idFrom.requestedAt ?? x.requestedAt ?? y.requestedAt;
  out.payload = idFrom.payload !== undefined ? idFrom.payload : (x.payload ?? y.payload ?? null);
  const videoId = idFrom.videoId ?? x.videoId ?? y.videoId;
  if (videoId !== undefined) out.videoId = videoId;

  // decision — the dashboard's half. Never dropped, never flipped.
  const dec = groupWinner(x.decision, y.decision, x.decidedAt, y.decidedAt);
  if (dec !== "neither") {
    const d = dec === "a" ? x : y;
    out.decision = d.decision;
    out.notes = d.notes ?? null;
    out.decidedAt = d.decidedAt ?? null;
  }

  // acted — the poster's latch. Never dropped, or an approved video publishes twice.
  const act = groupWinner(x.actedAt, y.actedAt, x.actedAt, y.actedAt);
  if (act !== "neither") {
    const a = act === "a" ? x : y;
    out.actedAt = a.actedAt;
    out.actedAction = a.actedAction ?? null;
    out.actedResult = a.actedResult ?? null;
  }

  return out;
}

/** Dispatch table used by merge-log-push.mjs. */
export const MERGE_STRATEGIES = {
  "posted-log.json": (l, r, log) => mergePostedLog(l, r || { posts: [] }, log),
  "video-matches.json": mergeVideoMatches,
  "performance-weights.json": mergePerformanceWeights,
  "qc-blocklist.json": mergeBlocklist,
  "linkedin-history.json": (l, r, log) => mergeLinkedinHistory(l, r || { posts: [] }, log),
  "trial-variants.json": (l, r, log) => mergeTrialVariants(l, r || { variants: [] }, log),
  "skip-list.json": (l, r, log) => mergeSkipList(l, r || [], log),
  "carousel-log.json": (l, r, log) => mergeCarouselLog(l, r || { posts: [] }, log),
  "yt-approvals.json": (l, r, log) => mergeYtApprovals(l, r || { requests: [] }, log),
};

export const MERGE_FILES = Object.keys(MERGE_STRATEGIES);
