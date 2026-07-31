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

/** Dispatch table used by merge-log-push.mjs. */
export const MERGE_STRATEGIES = {
  "posted-log.json": (l, r, log) => mergePostedLog(l, r || { posts: [] }, log),
  "video-matches.json": mergeVideoMatches,
  "performance-weights.json": mergePerformanceWeights,
  "qc-blocklist.json": mergeBlocklist,
  "linkedin-history.json": (l, r, log) => mergeLinkedinHistory(l, r || { posts: [] }, log),
  "trial-variants.json": (l, r, log) => mergeTrialVariants(l, r || { variants: [] }, log),
};

export const MERGE_FILES = Object.keys(MERGE_STRATEGIES);
