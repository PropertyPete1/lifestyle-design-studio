import type { Video } from "../drizzle/schema";

export const NO_REPEAT_DAYS = 30;
export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * America/Chicago is UTC-5 (CDT) during daylight saving. We use a fixed -5
 * offset for the business-day boundary and the 2PM/3PM default post times,
 * which matches the user's stated "CDT" intent.
 */
const CDT_OFFSET_HOURS = -5;

/** Current local (CDT) pick date as YYYY-MM-DD. */
export function getCdtPickDate(now: Date = new Date()): string {
  const shifted = new Date(now.getTime() + CDT_OFFSET_HOURS * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

/**
 * UTC ms for a given local CDT hour on the given pick date (YYYY-MM-DD).
 * e.g. 2 PM CDT -> 19:00 UTC.
 */
export function cdtTimeToUtcMs(pickDate: string, localHour: number): number {
  const [y, m, d] = pickDate.split("-").map(Number);
  const utcHour = localHour - CDT_OFFSET_HOURS; // localHour + 5
  return Date.UTC(y, m - 1, d, utcHour, 0, 0, 0);
}

/** Default scheduled times: San Antonio 2PM, Austin 3PM (one hour apart). */
export function defaultScheduleMs(pickDate: string, city: "austin" | "san_antonio"): number {
  return cdtTimeToUtcMs(pickDate, city === "san_antonio" ? 14 : 15);
}

export type SelectionResult = { video: Video; mode: "fresh" | "fallback" } | null;

/**
 * Pick the best video for a city.
 * - videos: that city's library, will be sorted by views desc internally.
 * - lastRepostByPostId: map postId -> last repost time (ms).
 * - excludePostIds: ids already chosen today (avoid double-picking).
 * Rule: highest views with no repost within NO_REPEAT_DAYS. If none qualify,
 * fall back to the least-recently reposted (then highest views).
 */
export function selectForCity(
  videos: Video[],
  lastRepostByPostId: Record<string, number>,
  excludePostIds: Set<string> = new Set(),
  now: number = Date.now()
): SelectionResult {
  const sorted = [...videos].sort((a, b) => b.views - a.views);
  const cutoff = now - NO_REPEAT_DAYS * DAY_MS;

  const eligible = sorted.filter(v => {
    if (excludePostIds.has(v.postId)) return false;
    const last = lastRepostByPostId[v.postId];
    return !last || last <= cutoff;
  });
  if (eligible.length) return { video: eligible[0], mode: "fresh" };

  const candidates = sorted.filter(v => !excludePostIds.has(v.postId));
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const la = lastRepostByPostId[a.postId] ?? 0;
    const lb = lastRepostByPostId[b.postId] ?? 0;
    if (la !== lb) return la - lb; // least recently reposted first
    return b.views - a.views;
  });
  return { video: candidates[0], mode: "fallback" };
}
