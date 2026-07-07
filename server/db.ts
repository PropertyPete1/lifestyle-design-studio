import { and, desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import {
  analystInsights,
  appSettings,
  dailyPicks,
  igPostHistory,
  igReels,
  InsertAnalystInsight,
  InsertDailyPick,
  InsertLinkedinPost,
  InsertPostHistory,
  InsertPostMetric,
  InsertRepost,
  InsertUser,
  InsertVideo,
  InsertVoiceoverJob,
  linkedinPosts,
  postHistory,
  postMetrics,
  reposts,
  users,
  videos,
  voiceoverBudget,
  voiceoverJobs,
} from "../drizzle/schema";
import { ENV } from "./_core/env";

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

/* ----------------------------- Users ----------------------------- */

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();
  if (!db) return;
  const values: InsertUser = { openId: user.openId };
  const updateSet: Record<string, unknown> = {};
  for (const field of ["name", "email", "loginMethod"] as const) {
    const value = user[field];
    if (value === undefined) continue;
    const normalized = value ?? null;
    values[field] = normalized;
    updateSet[field] = normalized;
  }
  if (user.lastSignedIn !== undefined) {
    values.lastSignedIn = user.lastSignedIn;
    updateSet.lastSignedIn = user.lastSignedIn;
  }
  if (user.role !== undefined) {
    values.role = user.role;
    updateSet.role = user.role;
  } else if (user.openId === ENV.ownerOpenId) {
    values.role = "admin";
    updateSet.role = "admin";
  }
  if (!values.lastSignedIn) values.lastSignedIn = new Date();
  if (Object.keys(updateSet).length === 0) updateSet.lastSignedIn = new Date();
  await db.insert(users).values(values).onDuplicateKeyUpdate({ set: updateSet });
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

/* ----------------------------- Videos ----------------------------- */

export async function getVideosByCity(city: "austin" | "san_antonio" | "dallas") {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(videos).where(eq(videos.city, city)).orderBy(desc(videos.views));
}

export async function getAllVideos() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(videos).orderBy(desc(videos.views));
}

export async function getVideoById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db.select().from(videos).where(eq(videos.id, id)).limit(1);
  return r[0];
}

export async function countVideos(): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const r = await db.select().from(videos);
  return r.length;
}

export async function bulkInsertVideos(rows: InsertVideo[]): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  let n = 0;
  for (const row of rows) {
    await db
      .insert(videos)
      .values(row)
      .onDuplicateKeyUpdate({
        set: {
          views: row.views ?? 0,
          city: row.city,
          caption: row.caption ?? null,
          thumbnailUrl: row.thumbnailUrl ?? null,
          onscreenText: row.onscreenText ?? null,
        },
      });
    n++;
  }
  return n;
}

/* ----------------------------- Reposts ----------------------------- */

export async function getAllReposts() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(reposts).orderBy(desc(reposts.confirmedAt));
}

/** Map of postId -> most recent repost time (ms) for cooldown logic. */
export async function getLastRepostByPostId(): Promise<Record<string, number>> {
  const db = await getDb();
  if (!db) return {};
  const map: Record<string, number> = {};

  // 1. Dashboard reposts (confirmed or posted through the app)
  const allReposts = await db.select().from(reposts);
  for (const r of allReposts) {
    // Use confirmedAt as the primary timestamp (when user locked the pick in),
    // fall back to scheduledFor, then 0. This ensures a video confirmed today
    // is excluded for the next 30 days even before it actually posts.
    const t = (r.confirmedAt ? new Date(r.confirmedAt).getTime() : (r.scheduledFor ?? 0)) as number;
    if (!map[r.postId] || t > map[r.postId]) map[r.postId] = t;
  }

  // 2. Real Instagram posts (posted directly on IG, outside the dashboard)
  // ig_post_history.igPostId matches videos.postId (both are Instagram media IDs)
  const igHistory = await db.select().from(igPostHistory);
  for (const h of igHistory) {
    const t = h.postedAt as number;
    if (!map[h.igPostId] || t > map[h.igPostId]) map[h.igPostId] = t;
  }

  return map;
}

export async function insertRepost(row: InsertRepost): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const res = await db.insert(reposts).values(row);
  // mysql2 returns insertId on the first element
  // @ts-expect-error drizzle mysql returns header with insertId
  return Number(res[0]?.insertId ?? res.insertId ?? 0);
}

export async function markRepostPosted(repostId: number, igMediaId?: string) {
  const db = await getDb();
  if (!db) return;
  await db
    .update(reposts)
    .set({ status: "posted", postedAt: new Date(), igMediaId: igMediaId ?? null })
    .where(eq(reposts.id, repostId));
}

export async function updateRepostCompression(repostId: number, fileSizeMb: number, crfValue: number) {
  const db = await getDb();
  if (!db) return;
  await db
    .update(reposts)
    .set({ compressedFileSizeMb: String(fileSizeMb), crfValue })
    .where(eq(reposts.id, repostId));
}

export async function markRepostFailed(repostId: number, error: string) {
  const db = await getDb();
  if (!db) return;
  await db
    .update(reposts)
    .set({ status: "failed", publishError: error.slice(0, 2000) })
    .where(eq(reposts.id, repostId));
}

export async function getRepostById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db.select().from(reposts).where(eq(reposts.id, id)).limit(1);
  return r[0];
}

/* --------------------------- Daily Picks --------------------------- */

export async function getDailyPicks(pickDate: string) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(dailyPicks).where(eq(dailyPicks.pickDate, pickDate));
}

export async function getDailyPick(pickDate: string, city: "austin" | "san_antonio" | "dallas") {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db
    .select()
    .from(dailyPicks)
    .where(and(eq(dailyPicks.pickDate, pickDate), eq(dailyPicks.city, city)))
    .limit(1);
  return r[0];
}

export async function insertDailyPick(row: InsertDailyPick): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  // onDuplicateKeyUpdate with a no-op set makes this idempotent:
  // if (pickDate, city) already exists the insert is silently skipped.
  const res = await db
    .insert(dailyPicks)
    .values(row)
    .onDuplicateKeyUpdate({ set: { updatedAt: new Date() } });
  // @ts-expect-error insertId access
  return Number(res[0]?.insertId ?? res.insertId ?? 0);
}

export async function updateDailyPick(id: number, set: Partial<InsertDailyPick>) {
  const db = await getDb();
  if (!db) return;
  await db.update(dailyPicks).set(set).where(eq(dailyPicks.id, id));
}

/**
 * Atomic lock: attempts to set pick status to "publishing". Returns true only
 * if the row was in "confirmed" status. Prevents duplicate posts when the
 * agent calls publishNow concurrently for the same pick.
 */
export async function claimPickForPublishing(pickId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  // Use a sentinel driveMatchConfidence value 'claiming' as an atomic lock flag
  // since 'publishing' is not in the status enum. We check that driveMatchConfidence
  // is NOT 'claiming' to prevent concurrent publishes.
  const result = await db.execute(
    sql`UPDATE daily_picks SET driveMatchConfidence = 'claiming' WHERE id = ${pickId} AND status = 'confirmed' AND (driveMatchConfidence IS NULL OR driveMatchConfidence != 'claiming')`
  );
  // mysql2 returns [ResultSetHeader, ...] where affectedRows tells us if the row was updated
  const header = Array.isArray(result) ? result[0] : result;
  return (header as any)?.affectedRows === 1;
}

/**
 * Auto-confirm a pending pick WITHOUT any manual tap. Mirrors the picks.confirm
 * tRPC flow: creates the repost history row (status=confirmed) and moves the
 * daily pick to status=confirmed with its repostId set, so the 2/3/4 PM posting
 * agent finds it due and publishes it. Idempotent: a pick that is not "pending"
 * is returned as-is (no duplicate repost row).
 */
export async function autoConfirmPick(pick: {
  id: number;
  status: string;
  videoId: number;
  postId: string;
  city: "austin" | "san_antonio" | "dallas";
  refreshedCaption: string | null;
  scheduledFor: number | null;
}): Promise<{ confirmed: boolean; repostId?: number; alreadyDone?: boolean }> {
  if (pick.status !== "pending") {
    return { confirmed: false, alreadyDone: true };
  }
  const video = await getVideoById(pick.videoId);
  const repostId = await insertRepost({
    videoId: pick.videoId,
    postId: pick.postId,
    city: pick.city,
    captionUsed: pick.refreshedCaption ?? video?.caption ?? "",
    viewsAtRepost: video?.views ?? 0,
    thumbnailUrl: video?.thumbnailUrl ?? null,
    scheduledFor: pick.scheduledFor,
    status: "confirmed",
  });
  await updateDailyPick(pick.id, { status: "confirmed", repostId });
  return { confirmed: true, repostId };
}

/**
 * When drivePreprocess swaps a pick to a different reel, update the associated
 * repost row so its postId matches the new reel. This prevents stale repost data.
 */
export async function syncRepostForPick(pickId: number, newPostId: string) {
  const db = await getDb();
  if (!db) return;
  // Find the pick to get its repostId
  const [pick] = await db.select().from(dailyPicks).where(eq(dailyPicks.id, pickId)).limit(1);
  if (!pick?.repostId) return;
  // Update the repost row's postId to match
  await db.update(reposts).set({ postId: newPostId }).where(eq(reposts.id, pick.repostId));
}

export async function getConfirmedDuePicks(nowMs: number) {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select().from(dailyPicks).where(eq(dailyPicks.status, "confirmed"));
  return rows.filter(r => (r.scheduledFor ?? 0) <= nowMs);
}

/**
 * The single confirmed pick that is due to publish for a given city today.
 * Used by the publishing agent. Returns undefined if nothing is due.
 */
export async function getDueConfirmedPickForCity(
  city: "austin" | "san_antonio" | "dallas",
  pickDate: string,
  nowMs: number
) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db
    .select()
    .from(dailyPicks)
    .where(
      and(
        eq(dailyPicks.pickDate, pickDate),
        eq(dailyPicks.city, city),
        eq(dailyPicks.status, "confirmed")
      )
    )
    .limit(1);
  const pick = rows[0];
  if (!pick) return undefined;
  if ((pick.scheduledFor ?? 0) > nowMs) return undefined; // not yet due
  return pick;
}

/* ----------------------------- Settings ----------------------------- */

export async function getSetting(key: string): Promise<string | null> {
  const db = await getDb();
  if (!db) return null;
  const r = await db.select().from(appSettings).where(eq(appSettings.settingKey, key)).limit(1);
  return r[0]?.settingValue ?? null;
}

export async function setSetting(key: string, value: string) {
  const db = await getDb();
  if (!db) return;
  await db
    .insert(appSettings)
    .values({ settingKey: key, settingValue: value })
    .onDuplicateKeyUpdate({ set: { settingValue: value } });
}

/* ----------------------------- Post metrics (analyst) ----------------------------- */

/**
 * Upsert one daily snapshot of a post's metrics. Idempotent per
 * (network, networkPostId, capturedOn) so re-running the ingest the same day
 * refreshes the numbers instead of duplicating rows.
 */
export async function upsertPostMetric(m: InsertPostMetric): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db
    .insert(postMetrics)
    .values(m)
    .onDuplicateKeyUpdate({
      set: {
        views: m.views,
        reach: m.reach,
        likes: m.likes,
        comments: m.comments,
        shares: m.shares,
        saved: m.saved,
        skipRate: m.skipRate,
        avgWatchTimeSec: m.avgWatchTimeSec,
        isAutoPost: m.isAutoPost,
        brandLabel: m.brandLabel,
        captionSnippet: m.captionSnippet,
        publishedAt: m.publishedAt,
      },
    });
}

/** Metrics captured on or after a given local date (YYYY-MM-DD), newest first. */
export async function getRecentPostMetrics(sinceCapturedOn: string) {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select().from(postMetrics).orderBy(desc(postMetrics.publishedAt));
  return rows.filter(r => r.capturedOn >= sinceCapturedOn);
}

/** Latest snapshot per (network, networkPostId), used by the Performance tab. */
export async function getLatestMetricsPerPost() {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select().from(postMetrics).orderBy(desc(postMetrics.capturedOn));
  const seen = new Set<string>();
  const out: typeof rows = [];
  for (const r of rows) {
    const k = `${r.network}:${r.networkPostId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

/* ----------------------------- Analyst insights ----------------------------- */

export async function saveAnalystInsight(row: InsertAnalystInsight): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db
    .insert(analystInsights)
    .values(row)
    .onDuplicateKeyUpdate({ set: { summary: row.summary, data: row.data } });
}

export async function getLatestAnalystInsight() {
  const db = await getDb();
  if (!db) return null;
  const r = await db.select().from(analystInsights).orderBy(desc(analystInsights.runDate)).limit(1);
  return r[0] ?? null;
}

export async function getAnalystInsights(limit = 30) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(analystInsights).orderBy(desc(analystInsights.runDate)).limit(limit);
}

/* ----------------------------- LinkedIn posts ----------------------------- */

/** The LinkedIn post for a given local date, if one exists. */
export async function getLinkedinPostByDate(postDate: string) {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db
    .select()
    .from(linkedinPosts)
    .where(eq(linkedinPosts.postDate, postDate))
    .limit(1);
  return r[0];
}

/** Insert a LinkedIn post row (idempotent per postDate via unique key). */
export async function insertLinkedinPost(row: InsertLinkedinPost): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const res = await db
    .insert(linkedinPosts)
    .values(row)
    .onDuplicateKeyUpdate({ set: { updatedAt: new Date() } });
  // @ts-expect-error insertId access
  return Number(res[0]?.insertId ?? res.insertId ?? 0);
}

export async function updateLinkedinPost(id: number, set: Partial<InsertLinkedinPost>) {
  const db = await getDb();
  if (!db) return;
  await db.update(linkedinPosts).set(set).where(eq(linkedinPosts.id, id));
}

/** Recent LinkedIn posts, newest first (for history + self-improvement). */
export async function getRecentLinkedinPosts(limit = 30) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(linkedinPosts)
    .orderBy(desc(linkedinPosts.postDate))
    .limit(limit);
}

/** The scheduled LinkedIn post that is due to publish now (if any). */
export async function getDueLinkedinPost(postDate: string, nowMs: number) {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db
    .select()
    .from(linkedinPosts)
    .where(eq(linkedinPosts.postDate, postDate))
    .limit(1);
  const post = r[0];
  if (!post) return undefined;
  if (post.status === "posted") return undefined;
  if ((post.scheduledFor ?? 0) > nowMs) return undefined;
  return post;
}

/* ----------------------------- IG Reels (new pipeline) ----------------------------- */

/** Get all reels for a city, sorted by engagement score descending. */
export async function getReelsByCity(city: "austin" | "san_antonio" | "dallas") {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(igReels)
    .where(eq(igReels.city, city))
    .orderBy(desc(igReels.engagementScore));
}

/** Get all reels sorted by engagement score descending. */
export async function getAllReels() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(igReels).orderBy(desc(igReels.engagementScore));
}

/** Get a single reel by its auto-increment id. */
export async function getReelById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db.select().from(igReels).where(eq(igReels.id, id)).limit(1);
  return r[0];
}

/** Get a single reel by its IG media ID (used for matching picks to reels). */
export async function getReelByIgMediaId(igMediaId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const r = await db.select().from(igReels).where(eq(igReels.igMediaId, igMediaId)).limit(1);
  return r[0];
}

/* ----------------------------- Post History (30-day dedup) ----------------------------- */

/** Insert a post history record (tracks what WE posted). */
export async function insertPostHistory(row: InsertPostHistory): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const res = await db.insert(postHistory).values(row);
  // @ts-expect-error insertId access
  return Number(res[0]?.insertId ?? res.insertId ?? 0);
}

/** Get post history from the last N days (for 30-day visual dedup). */
export async function getRecentPostHistory(days: number = 30): Promise<Array<typeof postHistory.$inferSelect>> {
  const db = await getDb();
  if (!db) return [];
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const all = await db.select().from(postHistory).orderBy(desc(postHistory.postedAt));
  return all.filter(p => (p.postedAt ?? 0) >= cutoff);
}

/** Map of igMediaId -> most recent post time (ms) for cooldown logic against ig_reels. */
export async function getLastPostByIgMediaId(): Promise<Record<string, number>> {
  const db = await getDb();
  if (!db) return {};
  const map: Record<string, number> = {};

  // From post_history (what we posted through this system)
  const history = await db.select().from(postHistory);
  // post_history doesn't have igMediaId directly, but we track via daily_picks
  // So we also check daily_picks for the last 30 days
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const recentPicks = await db.select().from(dailyPicks);
  for (const p of recentPicks) {
    if (p.status === "confirmed" || p.status === "posted") {
      const t = p.createdAt ? new Date(p.createdAt).getTime() : 0;
      if (t >= cutoff) {
        if (!map[p.postId] || t > map[p.postId]) map[p.postId] = t;
      }
    }
  }

  // Also include reposts table for back-compat
  const allReposts = await db.select().from(reposts);
  for (const r of allReposts) {
    const t = (r.confirmedAt ? new Date(r.confirmedAt).getTime() : (r.scheduledFor ?? 0)) as number;
    if (t >= cutoff) {
      if (!map[r.postId] || t > map[r.postId]) map[r.postId] = t;
    }
  }

  return map;
}

/* ===================== Voiceover Jobs ===================== */

export async function insertVoiceoverJob(data: InsertVoiceoverJob) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [result] = await db.insert(voiceoverJobs).values(data).$returningId();
  return result;
}

export async function getVoiceoverJobByPickId(pickId: number) {
  const db = await getDb();
  if (!db) return null;
  // Prefer the latest approved job; fall back to latest job of any status
  const approved = await db.select().from(voiceoverJobs)
    .where(and(eq(voiceoverJobs.pickId, pickId), eq(voiceoverJobs.status, "approved")))
    .orderBy(desc(voiceoverJobs.id)).limit(1);
  if (approved[0]) return approved[0];
  const rows = await db.select().from(voiceoverJobs)
    .where(eq(voiceoverJobs.pickId, pickId))
    .orderBy(desc(voiceoverJobs.id)).limit(1);
  return rows[0] ?? null;
}

export async function getVoiceoverJob(id: number) {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(voiceoverJobs).where(eq(voiceoverJobs.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function updateVoiceoverJob(id: number, data: Partial<InsertVoiceoverJob>) {
  const db = await getDb();
  if (!db) return;
  await db.update(voiceoverJobs).set(data).where(eq(voiceoverJobs.id, id));
}

export async function getRecentVoiceoverJobs(limit: number = 30) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(voiceoverJobs).orderBy(desc(voiceoverJobs.createdAt)).limit(limit);
}

/* ===================== Voiceover Budget ===================== */

export async function getOrCreateBudget(month: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db.select().from(voiceoverBudget).where(eq(voiceoverBudget.month, month)).limit(1);
  if (rows[0]) return rows[0];
  // Create new month entry
  await db.insert(voiceoverBudget).values({ month, charactersUsed: 0, budgetLimit: 100000 });
  const created = await db.select().from(voiceoverBudget).where(eq(voiceoverBudget.month, month)).limit(1);
  return created[0]!;
}

export async function addCharacterUsage(month: string, chars: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const budget = await getOrCreateBudget(month);
  const newTotal = budget.charactersUsed + chars;
  await db.update(voiceoverBudget).set({ charactersUsed: newTotal }).where(eq(voiceoverBudget.id, budget.id));
  return { ...budget, charactersUsed: newTotal };
}

export async function updateBudgetLimit(month: string, limit: number) {
  const db = await getDb();
  if (!db) return;
  const budget = await getOrCreateBudget(month);
  await db.update(voiceoverBudget).set({ budgetLimit: limit }).where(eq(voiceoverBudget.id, budget.id));
}
