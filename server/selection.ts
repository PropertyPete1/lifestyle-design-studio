import type { IgReel, Video } from "../drizzle/schema";

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

/** The three markets the app posts to. */
export type Market = "austin" | "san_antonio" | "dallas";

/** Default scheduled hour (CDT) per market: SA 2PM, Austin 3PM, Dallas 4PM. */
export function scheduleHourFor(market: Market): number {
  if (market === "san_antonio") return 14;
  if (market === "austin") return 15;
  return 16; // dallas
}

/** Default scheduled times: San Antonio 2PM, Austin 3PM, Dallas 4PM. */
export function defaultScheduleMs(pickDate: string, city: Market): number {
  return cdtTimeToUtcMs(pickDate, scheduleHourFor(city));
}

/**
 * Dallas posts roughly every 2 days. We derive a deterministic on/off pattern
 * from the pick date so it's stable per day (no randomness, no drift): Dallas is
 * "on" when the day-count since the Unix epoch is even. This yields an
 * every-other-day cadence that requires no stored state.
 */
export function isDallasDay(pickDate: string): boolean {
  const [y, m, d] = pickDate.split("-").map(Number);
  const dayNumber = Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
  return dayNumber % 2 === 0;
}

/** Legacy selection result (old videos table). */
export type SelectionResult = { video: Video; mode: "fresh" | "fallback" } | null;

/** New selection result for ig_reels pipeline. */
export type ReelSelectionResult = { reel: IgReel; mode: "fresh" | "fallback" } | null;

/**
 * Pick the best video for a city (LEGACY — old videos table).
 * Kept for back-compat with any remaining callers.
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
    if (la !== lb) return la - lb;
    return b.views - a.views;
  });
  return { video: candidates[0], mode: "fallback" };
}

/**
 * Pick the best IG reel for a city (NEW — ig_reels table).
 * - reels: that city's scraped reels, already sorted by engagementScore desc.
 * - lastPostByIgMediaId: map igMediaId -> last post time (ms).
 * - excludeIgMediaIds: ids already chosen today (avoid double-picking).
 * Rule: highest engagement with no post within NO_REPEAT_DAYS AND original IG
 * post date older than 30 days (audience already saw recent posts). If none
 * qualify, fall back to the least-recently posted (then highest engagement).
 */
export function selectReelForCity(
  reels: IgReel[],
  lastPostByIgMediaId: Record<string, number>,
  excludeIgMediaIds: Set<string> = new Set(),
  now: number = Date.now()
): ReelSelectionResult {
  // Already sorted by engagement score desc from DB query
  const sorted = [...reels].sort((a, b) => b.engagementScore - a.engagementScore);
  const cutoff = now - NO_REPEAT_DAYS * DAY_MS;

  const eligible = sorted.filter(r => {
    if (excludeIgMediaIds.has(r.igMediaId)) return false;
    // Exclude reels originally posted on IG within 30 days (audience already saw them)
    if (r.postedAt && r.postedAt > cutoff) return false;
    const last = lastPostByIgMediaId[r.igMediaId];
    return !last || last <= cutoff;
  });
  if (eligible.length) return { reel: eligible[0], mode: "fresh" };

  // Fallback: still exclude reels posted on IG within 30 days
  const candidates = sorted.filter(r => {
    if (excludeIgMediaIds.has(r.igMediaId)) return false;
    if (r.postedAt && r.postedAt > cutoff) return false;
    return true;
  });
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const la = lastPostByIgMediaId[a.igMediaId] ?? 0;
    const lb = lastPostByIgMediaId[b.igMediaId] ?? 0;
    if (la !== lb) return la - lb; // least recently posted first
    return b.engagementScore - a.engagementScore;
  });
  return { reel: candidates[0], mode: "fallback" };
}
