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
  /** "austin" | "san_antonio" | "dallas" */
  city: mysqlEnum("city", ["austin", "san_antonio", "dallas"]).notNull(),
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
  city: mysqlEnum("city", ["austin", "san_antonio", "dallas"]).notNull(),
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
  city: mysqlEnum("city", ["austin", "san_antonio", "dallas"]).notNull(),
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
 * Recent Instagram post history — synced from the IG API.
 * Used by AI visual deduplication to prevent reposting visually similar content
 * within the 30-day rotation window, even when post IDs differ (re-edits, reposts).
 */
export const igPostHistory = mysqlTable("ig_post_history", {
  id: int("id").autoincrement().primaryKey(),
  /** Instagram media id. */
  igPostId: varchar("igPostId", { length: 32 }).notNull().unique(),
  /** Thumbnail URL for AI vision comparison. */
  thumbnailUrl: varchar("thumbnailUrl", { length: 512 }),
  /** Caption snippet for additional context. */
  captionSnippet: varchar("captionSnippet", { length: 500 }),
  /** AI-generated visual description of the property/location (cached). */
  visualDescription: text("visualDescription"),
  /** When this post was published on Instagram (UTC ms). */
  postedAt: bigint("postedAt", { mode: "number" }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type IgPostHistory = typeof igPostHistory.$inferSelect;
export type InsertIgPostHistory = typeof igPostHistory.$inferInsert;

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

/**
 * Per-post, per-platform performance metrics ingested from Metricool analytics.
 * Powers the AI cross-platform performance analyst: tracks views, reach,
 * engagement AND the reach-determining signals (skip rate, avg watch time) so
 * the analyst can diagnose WHY a reel under/over-performed, not just that it did.
 *
 * One row per (network, networkPostId, capturedOn) so we keep a daily snapshot
 * trail and can watch a reel mature over its first days.
 */
export const postMetrics = mysqlTable("post_metrics", {
  id: int("id").autoincrement().primaryKey(),
  /** "instagram" | "tiktok" | "linkedin" | "youtube" | "facebook" */
  network: varchar("network", { length: 24 }).notNull(),
  /** Metricool brand/blog id the post belongs to. */
  blogId: bigint("blogId", { mode: "number" }).notNull(),
  /** Human label for the brand (e.g. lifestyledesignrealtytexas). */
  brandLabel: varchar("brandLabel", { length: 128 }),
  /** The network's own post/reel id (e.g. IG reelId). */
  networkPostId: varchar("networkPostId", { length: 64 }).notNull(),
  /** First ~120 chars of the caption, for matching back to our reposts. */
  captionSnippet: varchar("captionSnippet", { length: 500 }),
  /** When the post was published (UTC ms). */
  publishedAt: bigint("publishedAt", { mode: "number" }),
  views: int("views").default(0).notNull(),
  reach: int("reach").default(0).notNull(),
  likes: int("likes").default(0).notNull(),
  comments: int("comments").default(0).notNull(),
  shares: int("shares").default(0).notNull(),
  saved: int("saved").default(0).notNull(),
  /** Instagram reel skip rate (0-100); the dominant reach lever. */
  skipRate: int("skipRate"),
  /** Average watch time in seconds (rounded). */
  avgWatchTimeSec: int("avgWatchTimeSec"),
  /** Whether this post was produced by our auto-poster (best-effort match). */
  isAutoPost: int("isAutoPost").default(0).notNull(),
  /** Local capture date YYYY-MM-DD (America/Chicago) for the daily snapshot. */
  capturedOn: varchar("capturedOn", { length: 10 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, t => ({
  uniqNetworkPostDay: uniqueIndex("uq_metrics_net_post_day").on(
    t.network, t.networkPostId, t.capturedOn
  ),
}));

export type PostMetric = typeof postMetrics.$inferSelect;
export type InsertPostMetric = typeof postMetrics.$inferInsert;

/**
 * AI analyst output: one row per analysis run. Stores the summary, the
 * machine-readable strategy recommendations, and the numbers behind them so the
 * dashboard Performance tab and the owner notification can render the findings.
 */
export const analystInsights = mysqlTable("analyst_insights", {
  id: int("id").autoincrement().primaryKey(),
  /** Local run date YYYY-MM-DD (America/Chicago). */
  runDate: varchar("runDate", { length: 10 }).notNull(),
  /** Markdown human-readable summary shown to the owner. */
  summary: text("summary").notNull(),
  /** JSON: { recommendations: [...], flagged: [...], medians: {...} }. */
  data: text("data"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, t => ({
  uniqRunDate: uniqueIndex("uq_analyst_run_date").on(t.runDate),
}));

export type AnalystInsight = typeof analystInsights.$inferSelect;
export type InsertAnalystInsight = typeof analystInsights.$inferInsert;

/**
 * Daily LinkedIn recruiting posts. Text-only, first-person as Peter Allen,
 * aimed at recruiting realtors to Lifestyle Design Realty. One row per local
 * pick date (America/Chicago). The generator rotates through a fixed set of
 * topics and self-improves by reading recent posts + their engagement.
 */
export const linkedinPosts = mysqlTable("linkedin_posts", {
  id: int("id").autoincrement().primaryKey(),
  /** Local pick date YYYY-MM-DD (America/Chicago); one post per day. */
  postDate: varchar("postDate", { length: 10 }).notNull(),
  /** Rotation topic key (see LINKEDIN_TOPICS in shared/const.ts). */
  topic: varchar("topic", { length: 64 }).notNull(),
  /** The full post body (text only, < 150 words, no em-dashes). */
  body: text("body").notNull(),
  /** "draft" (generated, editable) | "scheduled" | "posted" | "failed". */
  status: mysqlEnum("status", ["draft", "scheduled", "posted", "failed"]).default("draft").notNull(),
  /** Metricool post id once scheduled/published (first brand, kept for back-compat). */
  metricoolPostId: varchar("metricoolPostId", { length: 64 }),
  /** Per-brand publish outcomes JSON: [{blogId,label,ok,postId,publishAt,error}]. */
  brandResults: text("brandResults"),
  /** Failure reason if status = failed. */
  errorReason: text("errorReason"),
  /** Epoch ms the post is scheduled to publish (2 PM CT that day). */
  scheduledFor: bigint("scheduledFor", { mode: "number" }),
  /** Epoch ms the post was actually published. */
  postedAt: bigint("postedAt", { mode: "number" }),
  /** Engagement pulled back from Metricool for self-improvement. */
  impressions: int("impressions").default(0).notNull(),
  reactions: int("reactions").default(0).notNull(),
  comments: int("comments").default(0).notNull(),
  shares: int("shares").default(0).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, t => ({
  uniqPostDate: uniqueIndex("uq_linkedin_post_date").on(t.postDate),
}));
export type LinkedinPost = typeof linkedinPosts.$inferSelect;
export type InsertLinkedinPost = typeof linkedinPosts.$inferInsert;
