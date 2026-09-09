/**
 * promote-ahead.js — give never-aired footage a real place in the rotation.
 *
 * THE PROBLEM. Step 4 of main.js sorts eligible candidates by the publishedAt
 * of their first cached IG match, oldest first. A video with no cached match
 * scores the sentinel 0, and the comparator returns 1 for it unconditionally —
 * so footage that has never aired sorts behind every repost, always. Within
 * that tail the comparator returns 0, V8's sort is stable, and the input
 * arrives in Drive's `orderBy: "name"` order, so the tail's internal order
 * never changes either: the same members win every time and the ones behind
 * them wait indefinitely.
 *
 * MEASURED, 2026-09-09. 21 San Antonio videos have been visible to the pipeline
 * since the 2026-07-11 backfill and have never once been selected. Austin has
 * none and Dallas has none — their folders (44 and 10 videos, against 2 and 1
 * slots per day) are so over-subscribed that the 30-day rule empties them
 * regardless of ordering, and Austin's queue on the day of measurement was one
 * candidate deep. That asymmetry is why this is a PARTITION and not a reserved
 * slot: a slot reserved for exploration would have starved Austin's only
 * candidate, and would have capped San Antonio at a rate slower than the ~6-10
 * first-ever airings per week the pipeline already manages unaided.
 *
 * WHAT THIS IS NOT. It is not exploration in the bandit sense, and calling it
 * that would overstate it. Nothing in this pipeline prefers a video because it
 * performed well — selection reads no performance data, and analytics.js and
 * learn.js contain no reference to driveFileId or fileName. So a debut airing
 * teaches the system nothing on its own. It becomes a measurement only once the
 * publish manifest is recording which reel came from which Drive file. The
 * honest name for what this does today is COVERAGE: footage that was paid for
 * and has never been seen.
 *
 * SAFETY IS STRUCTURAL, NOT BEHAVIOURAL. This reorders `eligible`, which
 * main.js has already built by filtering out everything the qc-blocklist, the
 * skip-list, the 5s duration floor, the four 30-day membership tests and the
 * cached-match-age test exclude. Reordering a list cannot add a member to it.
 * No ordering this module produces can post something the 30-day rule excluded.
 * `partitionsPreserveSet` in the tests asserts exactly that as set equality.
 */

/**
 * How many unhashable IG posts we tolerate before standing down.
 *
 * A debut has never aired from OUR library, but the same footage may already be
 * on the account from a manual post. liveIgMatchCheck is what catches that, and
 * it can only catch it for IG posts whose thumbnail hashed. Every post that did
 * not hash is a blind spot, so past a small number we do not promote.
 */
export const DEBUT_UNMATCHABLE_CEILING = 3;

/** Slots the debut lane may use. The others always ship proven content. */
export const DEFAULT_DEBUT_SLOTS = ["am"];

/**
 * Is this video one that has never aired?
 *
 * Three conditions, and the third is the subtle one: a cached match in
 * video-matches.json is affirmative evidence of a PRIOR IG publication, and
 * that cache reaches back to 2026-06-11 — before posted-log existed. Treating a
 * matched-but-unlogged video as a debut would promote footage that has already
 * aired, on the strength of the log simply not going back far enough.
 *
 * Measured on the committed state this yields exactly the 21 never-matched
 * starved San Antonio videos, and correctly excludes the 6 starved videos whose
 * cached match is 6-16 days old — those are stopped by main.js's cached-match
 * gate before `eligible` is even built, and they re-enter the rotation on their
 * own as the match ages past 30 days.
 */
export function isDebut(video, { everPostedIds, everPostedNames, matchCache = {} } = {}) {
  if (!video || !video.id) return false;
  if (everPostedIds?.has(video.id)) return false;
  if (video.name && everPostedNames?.has(video.name)) return false;
  const cached = matchCache[video.id];
  if (Array.isArray(cached) && cached.length > 0) return false;
  return true;
}

/**
 * Decide whether the debut lane may run, and say why when it may not.
 *
 * THE OUTAGE RULE IS THE IMPORTANT ONE. main.js catches a getRecentIgPosts
 * failure, warns, and leaves `igPosts = []` (main.js Step 1). The hashing loop
 * then never executes, so `unmatchable` is also empty — and a gate written as
 * `unmatchableCount <= CEILING` would read a total Metricool outage as PERFECT
 * safety, on precisely the run where liveIgMatchCheck is blind and a debut is
 * least safe to promote. The ceiling therefore requires POSITIVE evidence that
 * the IG read succeeded, not merely the absence of evidence that it failed.
 */
export function debutGate({
  enabled = true,
  slot = null,
  allowedSlots = DEFAULT_DEBUT_SLOTS,
  igPostsCount = 0,
  unmatchableCount = 0,
  debutCount = 0,
  ceiling = DEBUT_UNMATCHABLE_CEILING,
} = {}) {
  if (!enabled) return { allowed: false, reason: "disabled by PROMOTE_AHEAD" };
  if (slot && allowedSlots.length && !allowedSlots.includes(slot)) {
    return { allowed: false, reason: `slot ${slot} not in [${allowedSlots.join(", ")}]` };
  }
  // Positive evidence first — see the note above.
  if (!(igPostsCount > 0)) {
    return { allowed: false, reason: "no IG posts were read this run (live duplicate check is blind)" };
  }
  if (unmatchableCount > ceiling) {
    return { allowed: false, reason: `${unmatchableCount} unhashable IG posts exceeds ceiling ${ceiling}` };
  }
  if (debutCount === 0) return { allowed: false, reason: "no debut candidates" };
  return { allowed: true, reason: `${debutCount} debut candidate(s)` };
}

/**
 * Stably partition `sorted` into debuts-first, everything-else-after.
 *
 * PURE, and it never mutates the input. `const sorted = eligible.sort(...)`
 * (main.js) sorts in place, so `sorted === eligible` — mutating here would
 * corrupt a list other code still reads.
 *
 * Relative order WITHIN each partition is preserved, so the existing rotation
 * comparator still orders the repost lane exactly as it does today.
 */
export function applyPromoteAhead(sorted, opts = {}) {
  const list = Array.isArray(sorted) ? sorted : [];
  const {
    enabled = true,
    slot = null,
    allowedSlots = DEFAULT_DEBUT_SLOTS,
    everPostedIds = new Set(),
    everPostedNames = new Set(),
    matchCache = {},
    igPostsCount = 0,
    unmatchableCount = 0,
    ceiling = DEBUT_UNMATCHABLE_CEILING,
  } = opts;

  const ctx = { everPostedIds, everPostedNames, matchCache };
  const debut = list.filter((v) => isDebut(v, ctx));

  const gate = debutGate({
    enabled, slot, allowedSlots, igPostsCount, unmatchableCount,
    debutCount: debut.length, ceiling,
  });

  if (!gate.allowed) {
    return { candidates: list, stats: { debut: 0, repost: list.length, active: false, reason: gate.reason } };
  }

  const repost = list.filter((v) => !isDebut(v, ctx));
  return {
    candidates: [...debut, ...repost],
    stats: { debut: debut.length, repost: repost.length, active: true, reason: gate.reason },
  };
}
