import { bigint, int, mysqlEnum, mysqlTable, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 */
export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/**
 * The Instagram video library, ranked by Instagram-only views and classified by
 * city via AI vision reading on-screen location text.
 */
export const videos = mysqlTable("videos", {
  id: int("id").autoincrement().primaryKey(),
  /** Instagram media id (stable unique identifier). */
  postId: varchar("postId", { length: 32 }).notNull().unique(),
  shortcode: varchar("shortcode", { length: 32 }),
  permalink: varchar("permalink", { length: 255 }),
  /** "austin" | "san_antonio" */
  city: mysqlEnum("city", ["austin", "san_antonio"]).notNull(),
  caption: text("caption"),
  /** Instagram-only views (basis for ranking). */
  views: int("views").default(0).notNull(),
  likeCount: int("likeCount").default(0).notNull(),
  commentsCount: int("commentsCount").default(0).notNull(),
  /** Stable hosted cover thumbnail URL. */
  thumbnailUrl: varchar("thumbnailUrl", { length: 512 }),
  /** On-screen location text read by AI vision. */
  onscreenText: varchar("onscreenText", { length: 255 }),
  /** Original IG post time (ISO string from API). */
  originalTimestamp: varchar("originalTimestamp", { length: 40 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type Video = typeof videos.$inferSelect;
export type InsertVideo = typeof videos.$inferInsert;

/**
 * Repost history — one row per actually-confirmed/posted repost. Powers the
 * 30-day no-repeat rotation logic and the history log.
 */
export const reposts = mysqlTable("reposts", {
  id: int("id").autoincrement().primaryKey(),
  videoId: int("videoId").notNull(),
  postId: varchar("postId", { length: 32 }).notNull(),
  city: mysqlEnum("city", ["austin", "san_antonio"]).notNull(),
  /** The caption used for this repost (post-edit). */
  captionUsed: text("captionUsed"),
  viewsAtRepost: int("viewsAtRepost").default(0).notNull(),
  thumbnailUrl: varchar("thumbnailUrl", { length: 512 }),
  /** UTC ms when scheduled to publish. */
  scheduledFor: bigint("scheduledFor", { mode: "number" }),
  /** "confirmed" | "posted" | "failed" */
  status: mysqlEnum("status", ["confirmed", "posted", "failed"]).default("confirmed").notNull(),
  confirmedAt: timestamp("confirmedAt").defaultNow().notNull(),
  postedAt: timestamp("postedAt"),
  /** The Instagram media id of the newly published reel (set on success). */
  igMediaId: varchar("igMediaId", { length: 32 }),
  /** Error detail if a publish attempt failed. */
  publishError: text("publishError"),
});

export type Repost = typeof reposts.$inferSelect;
export type InsertRepost = typeof reposts.$inferInsert;

/**
 * Per-day selection state. One row per (pickDate, city). Holds the chosen video,
 * the editable AI-refreshed caption, and the post status for that day.
 */
export const dailyPicks = mysqlTable("daily_picks", {
  id: int("id").autoincrement().primaryKey(),
  /** Local pick date, format YYYY-MM-DD (America/Chicago). */
  pickDate: varchar("pickDate", { length: 10 }).notNull(),
  city: mysqlEnum("city", ["austin", "san_antonio"]).notNull(),
  videoId: int("videoId").notNull(),
  postId: varchar("postId", { length: 32 }).notNull(),
  /** AI-refreshed caption (editable by owner). */
  refreshedCaption: text("refreshedCaption"),
  /** Whether selection used fresh pick or fallback (all in cooldown). */
  selectionMode: varchar("selectionMode", { length: 16 }).default("fresh").notNull(),
  /** UTC ms when scheduled to publish (2PM/3PM CDT defaults). */
  scheduledFor: bigint("scheduledFor", { mode: "number" }),
  /** "pending" | "confirmed" | "posted" | "failed" */
  status: mysqlEnum("status", ["pending", "confirmed", "posted", "failed"]).default("pending").notNull(),
  repostId: int("repostId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, t => ({
  uniqPickDateCity: uniqueIndex("uq_pick_date_city").on(t.pickDate, t.city),
}));

export type DailyPick = typeof dailyPicks.$inferSelect;
export type InsertDailyPick = typeof dailyPicks.$inferInsert;

/**
 * Small key/value store for app settings — used to persist the AGENT cron
 * task_uids so a future session can manage them.
 */
export const appSettings = mysqlTable("app_settings", {
  id: int("id").autoincrement().primaryKey(),
  settingKey: varchar("settingKey", { length: 64 }).notNull().unique(),
  settingValue: text("settingValue"),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type AppSetting = typeof appSettings.$inferSelect;
export type InsertAppSetting = typeof appSettings.$inferInsert;
