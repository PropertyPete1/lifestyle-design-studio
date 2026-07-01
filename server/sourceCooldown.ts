/**
 * Hard same-source-video cooldown guard.
 *
 * This is the LAST line of defense against reposting the same reel too often.
 * The dashboard's pick-generation path already applies caption/visual dedup, but
 * the publish path (`publishNow`) previously re-published whatever it was handed.
 * That let the same video go out multiple times in ~48h, which triggers
 * Instagram's duplicate-content throttle and floors reach.
 *
 * This module checks BOTH sources of "recently posted" truth:
 *   1. reposts table  — anything published/confirmed through the dashboard
 *   2. ig_post_history — anything actually live on the Instagram account
 * and blocks a publish when the same source video (by Instagram postId OR by
 * caption fingerprint) was posted within COOLDOWN_DAYS.
 */

import * as db from "./db";
import { captionFingerprint, getRecentIgHistory } from "./igHistorySync";

/** Same video may not repeat within this many days on ANY path. */
export const COOLDOWN_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface CooldownCheckInput {
  /** Instagram media id of the source video we intend to repost. */
  postId: string;
  /** Caption of the source video (used for fingerprint matching). */
  caption?: string | null;
  /** The pick/repost we're about to publish, so we can exclude it from the scan. */
  excludeRepostId?: number;
  now?: number;
}

export interface CooldownResult {
  blocked: boolean;
  /** Days since the most recent conflicting post (for logging/reporting). */
  daysSinceLast?: number;
  /** Human-readable reason when blocked. */
  reason?: string;
  /** Which signal matched: "postId" | "caption". */
  matchedBy?: "postId" | "caption";
}

/**
 * Returns { blocked: true, ... } when the same source video was posted within
 * COOLDOWN_DAYS through either the dashboard or directly on Instagram.
 */
export async function checkSourceCooldown(
  input: CooldownCheckInput
): Promise<CooldownResult> {
  const now = input.now ?? Date.now();
  const cutoff = now - COOLDOWN_DAYS * DAY_MS;
  const candidateFp = captionFingerprint(input.caption);

  let mostRecentConflictMs = 0;
  let matchedBy: "postId" | "caption" | undefined;

  // 1. Dashboard reposts (posted or confirmed). We only count rows that are not
  // the pick we're publishing right now.
  const reposts = await db.getAllReposts();
  for (const r of reposts) {
    if (input.excludeRepostId && r.id === input.excludeRepostId) continue;
    // Only count reposts that were actually sent out or locked in.
    if (r.status === "failed") continue;
    const t = (r.postedAt
      ? new Date(r.postedAt).getTime()
      : r.confirmedAt
        ? new Date(r.confirmedAt).getTime()
        : (r.scheduledFor ?? 0)) as number;
    if (t < cutoff) continue;

    const samePost = r.postId === input.postId;
    const sameCaption =
      candidateFp.length >= 12 &&
      captionFingerprint(r.captionUsed) === candidateFp;
    if (samePost || sameCaption) {
      if (t > mostRecentConflictMs) {
        mostRecentConflictMs = t;
        matchedBy = samePost ? "postId" : "caption";
      }
    }
  }

  // 2. Live Instagram history (posts made directly on IG, outside the dashboard).
  const igHistory = await getRecentIgHistory(now);
  for (const h of igHistory) {
    const t = h.postedAt as number;
    if (t < cutoff) continue;
    const samePost = h.igPostId === input.postId;
    const sameCaption =
      candidateFp.length >= 12 &&
      captionFingerprint(h.captionSnippet) === candidateFp;
    if (samePost || sameCaption) {
      if (t > mostRecentConflictMs) {
        mostRecentConflictMs = t;
        matchedBy = samePost ? "postId" : "caption";
      }
    }
  }

  if (mostRecentConflictMs > 0) {
    const daysSinceLast = Math.floor((now - mostRecentConflictMs) / DAY_MS);
    return {
      blocked: true,
      daysSinceLast,
      matchedBy,
      reason: `Same source video was posted ${daysSinceLast} day(s) ago (matched by ${matchedBy}); cooldown is ${COOLDOWN_DAYS} days. Skipping to avoid Instagram's duplicate-content throttle.`,
    };
  }

  return { blocked: false };
}
