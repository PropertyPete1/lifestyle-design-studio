import { COOKIE_NAME } from "@shared/const";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { ownerProcedure, publicProcedure, router } from "./_core/trpc";
import { refreshCaption } from "./captionRefresh";
import * as db from "./db";
import { getRecentIgHistory, isCaptionRecentlyPosted, isVisuallyDuplicate, syncIgPostHistory } from "./igHistorySync";
import {
  defaultScheduleMs,
  getCdtPickDate,
  isDallasDay,
  selectForCity,
} from "./selection";

const citySchema = z.enum(["austin", "san_antonio", "dallas"]);

/**
 * Ensure today's picks (SA + Austin, plus Dallas on Dallas days) exist,
 * generating them if missing.
 * Idempotent: if rows already exist for the pick date, they are returned as-is.
 * Dedup is caption-fingerprint first (catches reposts under new IG IDs), then
 * AI visual check, skipping any candidate shown in the last 30 days.
 */
async function ensureTodayPicks(pickDate: string) {
  const existing = await db.getDailyPicks(pickDate);
  const haveCities = new Set(existing.map(p => p.city));
  const lastRepost = await db.getLastRepostByPostId();
  const chosenToday = new Set(existing.map(p => p.postId));
  // Load recent IG post history for AI visual dedup
  const recentIgHistory = await getRecentIgHistory();

  // SA + Austin every day; Dallas only on Dallas days (roughly every 2 days).
  // Dallas silently skips when there are no Dallas-classified videos yet.
  const marketsToday = ["san_antonio", "austin", ...(isDallasDay(pickDate) ? ["dallas" as const] : [])] as const;

  for (const city of marketsToday) {
    if (haveCities.has(city)) continue;
    const lib = await db.getVideosByCity(city);
    if (!lib.length) continue;

    // Try candidates in ranked order; skip any that are visually similar to a recent post
    let picked: Awaited<ReturnType<typeof selectForCity>> | null = null;
    const triedIds = new Set<string>();
    let attempts = 0;
    const MAX_ATTEMPTS = Math.min(lib.length, 10); // check up to 10 candidates

    while (attempts < MAX_ATTEMPTS) {
      const result = selectForCity(lib, lastRepost, new Set([...Array.from(chosenToday), ...Array.from(triedIds)]));
      if (!result) break;
      triedIds.add(result.video.postId);
      attempts++;

      // Caption-fingerprint dedup (PRIMARY): catches the same reel reposted
      // under a different IG post ID. Captions are stable; IG CDN thumbnails expire.
      if (isCaptionRecentlyPosted(result.video.caption, recentIgHistory)) {
        console.log(`[Dedup] Skipping ${result.video.postId} (${city}) — caption matches a post from the last 30 days`);
        continue;
      }

      // AI visual dedup (SECONDARY): skip if same property was posted in last 30 days
      const thumbUrl = result.video.thumbnailUrl;
      if (thumbUrl && recentIgHistory.length > 0) {
        const isDup = await isVisuallyDuplicate(
          thumbUrl,
          recentIgHistory,
          result.video.caption
        );
        if (isDup) {
          console.log(`[AI Dedup] Skipping ${result.video.postId} (${city}) — visually similar to recent post`);
          continue;
        }
      }

      picked = result;
      break;
    }

    if (!picked) {
      // Fallback: every candidate we tried was flagged. Instead of blindly using
      // the top-ranked video (which would re-post a duplicate), pick the best
      // candidate whose caption was NOT posted in the last 30 days.
      console.warn(`[Dedup] All ${attempts} candidates for ${city} flagged — searching for best caption-clean fallback`);
      const fallbackExcluded = new Set(chosenToday);
      let fb: Awaited<ReturnType<typeof selectForCity>> | null = null;
      for (let i = 0; i < lib.length; i++) {
        const cand = selectForCity(lib, lastRepost, fallbackExcluded);
        if (!cand) break;
        if (!isCaptionRecentlyPosted(cand.video.caption, recentIgHistory)) {
          fb = cand;
          break;
        }
        fallbackExcluded.add(cand.video.postId);
      }
      // If literally every video matches a recent caption, only then accept the
      // top-ranked one (better to post something than nothing).
      picked = fb ?? selectForCity(lib, lastRepost, chosenToday);
    }
    if (!picked) continue;

    chosenToday.add(picked.video.postId);
    const refreshed = await refreshCaption(picked.video.caption ?? "");
    await db.insertDailyPick({
      pickDate,
      city,
      videoId: picked.video.id,
      postId: picked.video.postId,
      refreshedCaption: refreshed,
      selectionMode: picked.mode,
      scheduledFor: defaultScheduleMs(pickDate, city),
      status: "pending",
    });
  }
  return db.getDailyPicks(pickDate);
}

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),

  /* ----------------------- Daily Picks ----------------------- */
  picks: router({
    /** Today's two picks with their video details. Generates if absent. */
    today: ownerProcedure.query(async () => {
      const pickDate = getCdtPickDate();
      const picks = await ensureTodayPicks(pickDate);
      const detailed = await Promise.all(
        picks.map(async p => ({
          ...p,
          video: await db.getVideoById(p.videoId),
        }))
      );
      // Sort San Antonio first (2PM) then Austin (3PM)
      detailed.sort((a, b) => (a.scheduledFor ?? 0) - (b.scheduledFor ?? 0));
      return { pickDate, picks: detailed };
    }),

    /** Edit the (AI-refreshed) caption before confirming. */
    updateCaption: ownerProcedure
      .input(z.object({ pickId: z.number(), caption: z.string() }))
      .mutation(async ({ input }) => {
        await db.updateDailyPick(input.pickId, { refreshedCaption: input.caption });
        return { success: true };
      }),

    /** Regenerate the AI caption for a pick. */
    regenerateCaption: ownerProcedure
      .input(z.object({ pickId: z.number() }))
      .mutation(async ({ input }) => {
        const pickDate = getCdtPickDate();
        const picks = await db.getDailyPicks(pickDate);
        const pick = picks.find(p => p.id === input.pickId);
        if (!pick) throw new TRPCError({ code: "NOT_FOUND" });
        const video = await db.getVideoById(pick.videoId);
        const refreshed = await refreshCaption(video?.caption ?? "");
        await db.updateDailyPick(input.pickId, { refreshedCaption: refreshed });
        return { caption: refreshed };
      }),

    /** One-tap confirm: lock the post in, record repost history & schedule. */
    confirm: ownerProcedure
      .input(z.object({ pickId: z.number() }))
      .mutation(async ({ input }) => {
        const pickDate = getCdtPickDate();
        const picks = await db.getDailyPicks(pickDate);
        const pick = picks.find(p => p.id === input.pickId);
        if (!pick) throw new TRPCError({ code: "NOT_FOUND" });
        if (pick.status !== "pending") {
          return { success: true, alreadyDone: true, status: pick.status };
        }
        const video = await db.getVideoById(pick.videoId);
        const repostId = await db.insertRepost({
          videoId: pick.videoId,
          postId: pick.postId,
          city: pick.city,
          captionUsed: pick.refreshedCaption ?? video?.caption ?? "",
          viewsAtRepost: video?.views ?? 0,
          thumbnailUrl: video?.thumbnailUrl ?? null,
          scheduledFor: pick.scheduledFor,
          status: "confirmed",
        });
        await db.updateDailyPick(pick.id, { status: "confirmed", repostId });
        return { success: true, repostId };
      }),
  }),

  /* ----------------------- Library ----------------------- */
  library: router({
    list: ownerProcedure
      .input(z.object({ city: citySchema.optional() }).optional())
      .query(async ({ input }) => {
        if (input?.city) return db.getVideosByCity(input.city);
        return db.getAllVideos();
      }),
    stats: ownerProcedure.query(async () => {
      const all = await db.getAllVideos();
      const austin = all.filter(v => v.city === "austin");
      const sa = all.filter(v => v.city === "san_antonio");
      const dallas = all.filter(v => v.city === "dallas");
      return {
        total: all.length,
        austin: austin.length,
        sanAntonio: sa.length,
        dallas: dallas.length,
        topAustinViews: austin[0]?.views ?? 0,
        topSaViews: sa[0]?.views ?? 0,
        topDallasViews: dallas[0]?.views ?? 0,
      };
    }),
  }),

  /* ----------------------- History ----------------------- */
  history: router({
    list: ownerProcedure.query(async () => db.getAllReposts()),
  }),

  /* ----------------------- Performance analyst ----------------------- */
  analyst: router({
    /** Latest analyst insight (summary markdown + parsed data). */
    latest: ownerProcedure.query(async () => {
      const row = await db.getLatestAnalystInsight();
      if (!row) return null;
      let data: unknown = null;
      try {
        data = row.data ? JSON.parse(row.data) : null;
      } catch {
        data = null;
      }
      return { runDate: row.runDate, summary: row.summary, data, createdAt: row.createdAt };
    }),
    /** Recent analyst runs (for a history list). */
    list: ownerProcedure.query(async () => {
      const rows = await db.getAnalystInsights(30);
      return rows.map(r => ({ runDate: r.runDate, summary: r.summary, createdAt: r.createdAt }));
    }),
    /** Latest per-post metric snapshot across brands (for the table). */
    metrics: ownerProcedure.query(async () => {
      const rows = await db.getLatestMetricsPerPost();
      return rows
        .filter(r => r.views > 0 || r.reach > 0)
        .map(r => ({
        network: r.network,
        brandLabel: r.brandLabel,
        networkPostId: r.networkPostId,
        captionSnippet: r.captionSnippet,
        publishedAt: r.publishedAt,
        views: r.views,
        reach: r.reach,
        likes: r.likes,
        comments: r.comments,
        shares: r.shares,
        saved: r.saved,
        skipRate: r.skipRate,
        avgWatchTimeSec: r.avgWatchTimeSec,
        capturedOn: r.capturedOn,
      }));
    }),
    /** Owner-triggered manual analyst run (same logic as the scheduled cron). */
    run: ownerProcedure
      .input(z.object({ days: z.number().int().min(1).max(30).optional() }).optional())
      .mutation(async ({ input }) => {
        const { runPerformanceAnalyst } = await import("./performanceAnalyst");
        return runPerformanceAnalyst(input?.days ?? 5);
      }),
  }),

});

export type AppRouter = typeof appRouter;
