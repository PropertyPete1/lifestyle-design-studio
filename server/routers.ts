import { COOKIE_NAME } from "@shared/const";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { ownerProcedure, publicProcedure, router } from "./_core/trpc";
import { refreshCaption } from "./captionRefresh";
import * as db from "./db";
import { getRecentIgHistory, isVisuallyDuplicate, syncIgPostHistory } from "./igHistorySync";
import {
  defaultScheduleMs,
  getCdtPickDate,
  selectForCity,
} from "./selection";

const citySchema = z.enum(["austin", "san_antonio"]);

/**
 * Ensure today's two picks (Austin + SA) exist, generating them if missing.
 * Idempotent: if rows already exist for the pick date, they are returned as-is.
 * Uses AI visual deduplication to skip candidates that show the same property
 * as any post made in the last 30 days — even if the post ID is different.
 */
async function ensureTodayPicks(pickDate: string) {
  const existing = await db.getDailyPicks(pickDate);
  const haveCities = new Set(existing.map(p => p.city));
  const lastRepost = await db.getLastRepostByPostId();
  const chosenToday = new Set(existing.map(p => p.postId));
  // Load recent IG post history for AI visual dedup
  const recentIgHistory = await getRecentIgHistory();

  for (const city of ["san_antonio", "austin"] as const) {
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

      // AI visual dedup: skip if same property was posted in last 30 days
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
      // Fallback: if all candidates were flagged as duplicates, use the top-ranked one anyway
      console.warn(`[AI Dedup] All ${attempts} candidates for ${city} flagged as duplicates — using top-ranked fallback`);
      picked = selectForCity(lib, lastRepost, chosenToday);
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
      return {
        total: all.length,
        austin: austin.length,
        sanAntonio: sa.length,
        topAustinViews: austin[0]?.views ?? 0,
        topSaViews: sa[0]?.views ?? 0,
      };
    }),
  }),

  /* ----------------------- History ----------------------- */
  history: router({
    list: ownerProcedure.query(async () => db.getAllReposts()),
  }),

});

export type AppRouter = typeof appRouter;
