import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import {
  appSettings,
  dailyPicks,
  igPostHistory,
  InsertDailyPick,
  InsertRepost,
  InsertUser,
  InsertVideo,
  reposts,
  users,
  videos,
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

export async function getVideosByCity(city: "austin" | "san_antonio") {
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

export async function getDailyPick(pickDate: string, city: "austin" | "san_antonio") {
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
  city: "austin" | "san_antonio",
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
