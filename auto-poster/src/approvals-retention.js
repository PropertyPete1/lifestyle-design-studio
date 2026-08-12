/**
 * approvals-retention.js — how much of yt-approvals.json is kept, and whose.
 *
 * ITS OWN MODULE, AND IT IMPORTS NOTHING. Both writers of that file need this
 * rule and they have incompatible constraints:
 *
 *   src/yt-approvals.js   reads and writes the file, so it imports `fs`.
 *   merge-strategies.mjs  states at the top that it must stay pure — no fs, no
 *                         git, no process.exit — because that purity is what
 *                         makes the concurrent-runner merge testable without a
 *                         repository.
 *
 * So the rule cannot live in yt-approvals.js and be imported by the merge:
 * that would drag `fs` into the pure module through the back door. It used to
 * live in BOTH, as a `MAX_ENTRIES = 400` here and a `MAX_APPROVALS = 400`
 * there, with a comment on each asking the reader to keep them in step. That
 * was survivable while the number was one number. It stopped being survivable
 * when the reels edit queue became a second writer with its own budget, because
 * "keep two copies of a four-line bucketing function in step" is not a thing a
 * comment can enforce.
 *
 * A third module with no dependencies is what lets both import it.
 */

/** Long-form: weekly cadence, two requests a week — years of history. */
export const MAX_ENTRIES = 400;

/** Reels: the queue moves faster and its records are small. Its own budget. */
export const MAX_REEL_ENTRIES = 200;

/**
 * Which pipeline a kind belongs to.
 *
 * Data rather than a predicate, so a third pipeline is a line here rather than
 * an edit to the pruning logic. The kind STRINGS are repeated rather than
 * imported from yt-approvals.js — importing them would re-create exactly the
 * `fs` dependency this module exists to avoid — and edit-queue-safety.test.mjs
 * asserts the two agree.
 */
export const KIND_FAMILY = {
  topic_pick: "longform",
  video_review: "longform",
  reel_edit: "reels",
  reel_review: "reels",
};

export const FAMILY_LIMITS = { longform: MAX_ENTRIES, reels: MAX_REEL_ENTRIES, other: MAX_ENTRIES };

/**
 * Trim the request list, PER PIPELINE.
 *
 * This used to be a bare `.slice(-MAX_ENTRIES)` over the whole file, which was
 * exactly right while one pipeline wrote to it and became a live hazard the
 * moment a second one did. The reels edit queue raises at least two cards per
 * video and Peter drops videos whenever he likes; long-form raises two a week.
 * A global cap means a busy fortnight of reels silently deletes months of
 * long-form approval history from the shared file — the long-form pipeline's
 * own audit trail, evicted by a feature that has nothing to do with it.
 *
 * Capping per family removes the coupling: reels records can only ever push out
 * older reels records. The long-form budget is unchanged at 400, so nothing
 * about its behaviour moves.
 *
 * A record of an UNKNOWN kind is kept, under its own "other" budget. A cap that
 * cannot classify a record must not delete it — that trades bounded growth for
 * silent data loss, which is the trade mergePostedLog explicitly refuses when
 * it keeps entries it cannot date.
 *
 * Ordering is preserved (oldest first by requestedAt) because callers assume
 * the array is chronological — `latestRequestOfKind` takes the last match.
 */
export function capRequests(requests, limits = FAMILY_LIMITS) {
  const sorted = [...(requests || [])].sort((a, b) =>
    String(a?.requestedAt || "").localeCompare(String(b?.requestedAt || ""))
  );
  const buckets = new Map();
  for (const r of sorted) {
    const family = KIND_FAMILY[r?.kind] || "other";
    if (!buckets.has(family)) buckets.set(family, []);
    buckets.get(family).push(r);
  }
  const keep = new Set();
  for (const [family, rows] of buckets) {
    for (const r of rows.slice(-(limits[family] ?? MAX_ENTRIES))) keep.add(r);
  }
  return sorted.filter((r) => keep.has(r));
}
