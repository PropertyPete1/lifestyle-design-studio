import { COOKIE_NAME } from "@shared/const";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { ownerProcedure, publicProcedure, router } from "./_core/trpc";
import { refreshCaption } from "./captionRefresh";
import { optimizeHook } from "./hookOptimizer";
import * as db from "./db";
import { isCaptionRecentlyPosted, isVisuallyDuplicate } from "./igHistorySync";
import {
  defaultScheduleMs,
  getCdtPickDate,
  isDallasDay,
  selectReelForCity,
} from "./selection";
import { storageGetSignedUrl } from "./storage";

const citySchema = z.enum(["austin", "san_antonio", "dallas"]);

/**
 * Ensure today's picks (SA + Austin, plus Dallas on Dallas days) exist,
 * generating them if missing.
 * Idempotent: if rows already exist for the pick date, they are returned as-is.
 *
 * NEW PIPELINE: reads from ig_reels table (scraped IG engagement data).
 * Dedup is caption-fingerprint first, then AI visual check against post_history
 * (what WE posted in the last 30 days).
 */
export async function ensureTodayPicks(pickDate: string) {
  const existing = await db.getDailyPicks(pickDate);
  const haveCities = new Set(existing.map(p => p.city));
  const lastPostMap = await db.getLastPostByIgMediaId();
  const chosenToday = new Set(existing.map(p => p.postId));

  // Load recent post history (what WE posted) for dedup
  const recentHistory = await db.getRecentPostHistory(30);
  // Convert to the shape isVisuallyDuplicate expects
  const recentForDedup = recentHistory.map(h => ({
    igPostId: String(h.id),
    thumbnailUrl: h.thumbnailStorageKey ? `/manus-storage/${h.thumbnailStorageKey}` : null,
    captionSnippet: h.caption ? h.caption.slice(0, 500) : null,
    postedAt: h.postedAt ?? 0,
  }));

  // SA + Austin every day; Dallas only on Dallas days (roughly every 2 days).
  const marketsToday = ["san_antonio", "austin", ...(isDallasDay(pickDate) ? ["dallas" as const] : [])] as const;

  for (const city of marketsToday) {
    if (haveCities.has(city)) continue;
    const lib = await db.getReelsByCity(city);
    if (!lib.length) continue;

    // Try candidates in ranked order; skip any that are visually similar to a recent post
    let picked: Awaited<ReturnType<typeof selectReelForCity>> | null = null;
    const triedIds = new Set<string>();
    let attempts = 0;
    const MAX_ATTEMPTS = Math.min(lib.length, 10);

    while (attempts < MAX_ATTEMPTS) {
      const result = selectReelForCity(lib, lastPostMap, new Set([...Array.from(chosenToday), ...Array.from(triedIds)]));
      if (!result) break;
      triedIds.add(result.reel.igMediaId);
      attempts++;

      // Caption-fingerprint dedup (PRIMARY): catches the same reel reposted
      if (isCaptionRecentlyPosted(result.reel.caption, recentForDedup)) {
        console.log(`[Dedup] Skipping ${result.reel.igMediaId} (${city}) — caption matches a post from the last 30 days`);
        continue;
      }

      // AI visual dedup (SECONDARY): skip if same property was posted in last 30 days
      let thumbUrl = "";
      if (result.reel.thumbnailStorageKey) {
        try {
          thumbUrl = await storageGetSignedUrl(result.reel.thumbnailStorageKey);
        } catch {
          thumbUrl = `/manus-storage/${result.reel.thumbnailStorageKey}`;
        }
      }
      if (thumbUrl && recentForDedup.length > 0) {
        const isDup = await isVisuallyDuplicate(
          thumbUrl,
          recentForDedup,
          result.reel.caption
        );
        if (isDup) {
          console.log(`[AI Dedup] Skipping ${result.reel.igMediaId} (${city}) — visually similar to recent post`);
          continue;
        }
      }

      picked = result;
      break;
    }

    if (!picked) {
      // Fallback: every candidate was flagged. Pick best caption-clean fallback.
      console.warn(`[Dedup] All ${attempts} candidates for ${city} flagged — searching for best caption-clean fallback`);
      const fallbackExcluded = new Set(chosenToday);
      let fb: Awaited<ReturnType<typeof selectReelForCity>> | null = null;
      for (let i = 0; i < lib.length; i++) {
        const cand = selectReelForCity(lib, lastPostMap, fallbackExcluded);
        if (!cand) break;
        if (!isCaptionRecentlyPosted(cand.reel.caption, recentForDedup)) {
          fb = cand;
          break;
        }
        fallbackExcluded.add(cand.reel.igMediaId);
      }
      picked = fb ?? selectReelForCity(lib, lastPostMap, chosenToday);
    }
    if (!picked) continue;

    chosenToday.add(picked.reel.igMediaId);
    // 1) Vary the wording so the repost isn't a near-duplicate (hashtags/CTA kept).
    const refreshed = await refreshCaption(picked.reel.caption ?? "");
    // 2) ACTIVELY strengthen the opening hook using this account's winning hooks
    const optimized = await optimizeHook(refreshed);
    await db.insertDailyPick({
      pickDate,
      city,
      videoId: picked.reel.id,
      postId: picked.reel.igMediaId,
      refreshedCaption: optimized.caption,
      selectionMode: picked.mode,
      scheduledFor: defaultScheduleMs(pickDate, city),
      status: "pending",
    });
  }

  // ---------------------------------------------------------------------------
  // AUTO-CONFIRM: confirm every pending pick so the 2/3/4 PM CT agent finds it due.
  // ---------------------------------------------------------------------------
  const generated = await db.getDailyPicks(pickDate);
  for (const p of generated) {
    if (p.status === "pending") {
      try {
        await db.autoConfirmPick({
          id: p.id,
          status: p.status,
          videoId: p.videoId,
          postId: p.postId,
          city: p.city,
          refreshedCaption: p.refreshedCaption ?? null,
          scheduledFor: p.scheduledFor ?? null,
        });
      } catch (err) {
        console.error(`[AutoConfirm] Failed to auto-confirm ${p.city} pick ${p.id}:`, err);
      }
    }
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
    /** Today's two picks with their reel details. Generates if absent. */
    today: ownerProcedure.query(async () => {
      const pickDate = getCdtPickDate();
      const picks = await ensureTodayPicks(pickDate);
      const detailed = await Promise.all(
        picks.map(async p => {
          // Look up from ig_reels (postId = igMediaId)
          const reel = await db.getReelByIgMediaId(p.postId);
          return {
            ...p,
            video: reel ? {
              id: reel.id,
              postId: reel.igMediaId,
              caption: reel.caption,
              views: reel.views,
              likes: reel.likes,
              comments: reel.comments,
              city: reel.city,
              thumbnailUrl: reel.thumbnailStorageKey ? `/manus-storage/${reel.thumbnailStorageKey}` : null,
              permalink: reel.reelLink,
              shortcode: null,
              engagementScore: reel.engagementScore,
            } : null,
          };
        })
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
        // Look up from ig_reels
        const reel = await db.getReelByIgMediaId(pick.postId);
        const refreshed = await refreshCaption(reel?.caption ?? "");
        const optimized = await optimizeHook(refreshed);
        await db.updateDailyPick(input.pickId, { refreshedCaption: optimized.caption });
        return { caption: optimized.caption };
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
        const result = await db.autoConfirmPick({
          id: pick.id,
          status: pick.status,
          videoId: pick.videoId,
          postId: pick.postId,
          city: pick.city,
          refreshedCaption: pick.refreshedCaption ?? null,
          scheduledFor: pick.scheduledFor ?? null,
        });
        return { success: true, repostId: result.repostId };
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
    /** The winning hooks the AI Hook Optimizer is currently learning from. */
    topHooks: ownerProcedure.query(async () => {
      const { getWinningHooks } = await import("./hookOptimizer");
      return getWinningHooks(undefined, 5);
    }),
    /** Owner-triggered manual analyst run (same logic as the scheduled cron). */
    run: ownerProcedure
      .input(z.object({ days: z.number().int().min(1).max(30).optional() }).optional())
      .mutation(async ({ input }) => {
        const { runPerformanceAnalyst } = await import("./performanceAnalyst");
        return runPerformanceAnalyst(input?.days ?? 5);
      }),
  }),

  /* ----------------------- LinkedIn recruiting posts ----------------------- */
  linkedin: router({
    /** Today's LinkedIn post; generated + auto-scheduled if it does not exist. */
    today: ownerProcedure.query(async () => {
      const { getCdtPickDate } = await import("./selection");
      const { ensureTodayLinkedinPost } = await import("./linkedinScheduled");
      const postDate = getCdtPickDate();
      const post = await ensureTodayLinkedinPost(postDate);
      return post ?? null;
    }),
    /** Recent LinkedIn posts (history list). */
    history: ownerProcedure.query(async () => db.getRecentLinkedinPosts(30)),
    /** Owner edits today's post body before it publishes. */
    updateBody: ownerProcedure
      .input(z.object({ id: z.number().int(), body: z.string().min(1).max(4000) }))
      .mutation(async ({ input }) => {
        const { sanitizePost } = await import("./linkedinAuthor");
        await db.updateLinkedinPost(input.id, { body: sanitizePost(input.body) });
        return { ok: true };
      }),
    /** Regenerate today's post with the AI writer (overwrites the draft body). */
    regenerate: ownerProcedure
      .input(z.object({ id: z.number().int(), postDate: z.string() }))
      .mutation(async ({ input }) => {
        const { generateLinkedinPost } = await import("./linkedinAuthor");
        const { topic, body } = await generateLinkedinPost(input.postDate);
        await db.updateLinkedinPost(input.id, { topic, body });
        return { ok: true, body };
      }),
  }),

  /* ----------------------- Settings (Auto-Pilot) ----------------------- */
  settings: router({
    /** Get auto-pilot status. */
    getAutoPilot: ownerProcedure.query(async () => {
      const val = await db.getSetting("autoPilot");
      return { enabled: val === "true" };
    }),
    /** Toggle auto-pilot on/off. */
    setAutoPilot: ownerProcedure
      .input(z.object({ enabled: z.boolean() }))
      .mutation(async ({ input }) => {
        await db.setSetting("autoPilot", input.enabled ? "true" : "false");
        return { ok: true, enabled: input.enabled };
      }),
    /** Get auto-voiceover status (default ON). */
    getAutoVoiceover: ownerProcedure.query(async () => {
      const val = await db.getSetting("autoVoiceover");
      // Default to ON if not set
      return { enabled: val === null || val === "true" };
    }),
    /** Toggle auto-voiceover on/off. */
    setAutoVoiceover: ownerProcedure
      .input(z.object({ enabled: z.boolean() }))
      .mutation(async ({ input }) => {
        await db.setSetting("autoVoiceover", input.enabled ? "true" : "false");
        return { ok: true, enabled: input.enabled };
      }),
  }),

  /* ----------------------- Voiceover ----------------------- */
  voiceover: router({
    /** Get voiceover job for a pick (or null if none). */
    getJob: ownerProcedure
      .input(z.object({ pickId: z.number() }))
      .query(async ({ input }) => {
        return db.getVoiceoverJobByPickId(input.pickId);
      }),

    /** Start a voiceover job for a pick (detection → scripting → pending_approval). */
    startJob: ownerProcedure
      .input(z.object({
        pickId: z.number(),
        originalAudioMode: z.enum(["duck", "mute"]).default("duck"),
      }))
      .mutation(async ({ input }) => {
        // Check if job already exists
        const existing = await db.getVoiceoverJobByPickId(input.pickId);
        if (existing) return existing;

        // Get the pick details
        const pickDate = getCdtPickDate();
        const picks = await db.getDailyPicks(pickDate);
        const pick = picks.find(p => p.id === input.pickId);
        if (!pick) throw new TRPCError({ code: "NOT_FOUND", message: "Pick not found" });

        const reel = await db.getReelByIgMediaId(pick.postId);
        if (!reel) throw new TRPCError({ code: "NOT_FOUND", message: "Reel not found" });

        // Create the job
        const result = await db.insertVoiceoverJob({
          pickId: input.pickId,
          reelId: reel.id,
          city: pick.city,
          status: "detecting",
          originalAudioMode: input.originalAudioMode,
          voiceId: "ymv1q5WLElzdmrHdtgsw",
        });

        // Kick off async detection + scripting (non-blocking)
        processVoiceoverJob(result.id).catch(err =>
          console.error(`[Voiceover] Background job ${result.id} failed:`, err)
        );

        return db.getVoiceoverJob(result.id);
      }),

    /** Update the script before approval. */
    updateScript: ownerProcedure
      .input(z.object({ jobId: z.number(), script: z.string().min(1) }))
      .mutation(async ({ input }) => {
        const job = await db.getVoiceoverJob(input.jobId);
        if (!job) throw new TRPCError({ code: "NOT_FOUND" });
        if (job.status !== "pending_approval" && job.status !== "duration_mismatch")
          throw new TRPCError({ code: "BAD_REQUEST", message: "Script can only be edited in pending_approval or duration_mismatch status" });
        await db.updateVoiceoverJob(input.jobId, { script: input.script });
        return { ok: true };
      }),

    /** Regenerate the script with LLM. */
    regenerateScript: ownerProcedure
      .input(z.object({ jobId: z.number() }))
      .mutation(async ({ input }) => {
        const job = await db.getVoiceoverJob(input.jobId);
        if (!job) throw new TRPCError({ code: "NOT_FOUND" });
        await db.updateVoiceoverJob(input.jobId, { status: "scripting" });
        processScriptGeneration(input.jobId).catch(err =>
          console.error(`[Voiceover] Script regen ${input.jobId} failed:`, err)
        );
        return { ok: true };
      }),

    /** Approve script and trigger TTS + render. */
    approveScript: ownerProcedure
      .input(z.object({ jobId: z.number() }))
      .mutation(async ({ input }) => {
        const job = await db.getVoiceoverJob(input.jobId);
        if (!job) throw new TRPCError({ code: "NOT_FOUND" });
        if (!job.script) throw new TRPCError({ code: "BAD_REQUEST", message: "No script to approve" });

        // Check budget
        const month = new Date().toISOString().slice(0, 7);
        const budget = await db.getOrCreateBudget(month);
        const estimatedChars = job.script.length;
        if (budget.charactersUsed + estimatedChars > budget.budgetLimit) {
          throw new TRPCError({ code: "FORBIDDEN", message: `Monthly character budget exceeded (${budget.charactersUsed}/${budget.budgetLimit})` });
        }

        await db.updateVoiceoverJob(input.jobId, { status: "generating_audio" });
        processRender(input.jobId).catch(err =>
          console.error(`[Voiceover] Render ${input.jobId} failed:`, err)
        );
        return { ok: true };
      }),

    /** Approve the rendered video for posting. */
    approveVideo: ownerProcedure
      .input(z.object({ jobId: z.number() }))
      .mutation(async ({ input }) => {
        const job = await db.getVoiceoverJob(input.jobId);
        if (!job) throw new TRPCError({ code: "NOT_FOUND" });
        if (job.status !== "preview_ready")
          throw new TRPCError({ code: "BAD_REQUEST", message: "Video not ready for approval" });
        await db.updateVoiceoverJob(input.jobId, { status: "approved" });
        return { ok: true };
      }),

    /** Get current month's budget. */
    budget: ownerProcedure.query(async () => {
      const month = new Date().toISOString().slice(0, 7);
      return db.getOrCreateBudget(month);
    }),

    /** Update monthly budget limit. */
    setBudgetLimit: ownerProcedure
      .input(z.object({ limit: z.number().int().min(1000) }))
      .mutation(async ({ input }) => {
        const month = new Date().toISOString().slice(0, 7);
        await db.updateBudgetLimit(month, input.limit);
        return { ok: true };
      }),
  }),

});

export type AppRouter = typeof appRouter;

/* ===================== Voiceover Background Processors ===================== */

async function processVoiceoverJob(jobId: number) {
  try {
    const job = await db.getVoiceoverJob(jobId);
    if (!job) return;

    // Step 1: Audio detection
    const reel = await db.getReelByIgMediaId(
      (await db.getDailyPicks(getCdtPickDate())).find(p => p.id === job.pickId)?.postId ?? ""
    );
    if (!reel) {
      await db.updateVoiceoverJob(jobId, { status: "failed", errorMessage: "Reel not found" });
      return;
    }

    const { analyzeSourceAudio, getVideoDuration } = await import("./voiceoverAudioIntel");
    // Audio detection requires a local file — we'll do it during render phase
    // For now, estimate from the pick's Drive video if available
    let audioType: "speech" | "music_only" | "silent" | "unknown" = "music_only";
    let videoDurationSec = 30;

    // If the pick already has a Drive video, download a small probe
    const pickDate = getCdtPickDate();
    const picks = await db.getDailyPicks(pickDate);
    const pick = picks.find(p => p.id === job.pickId);
    if (pick?.driveVideoUrl) {
      try {
        const { storageGetSignedUrl } = await import("./storage");
        const { execSync } = await import("child_process");
        const storageKey = pick.driveVideoUrl.replace(/^\/manus-storage\//, "");
        const signedUrl = await storageGetSignedUrl(storageKey);
        const probePath = `/tmp/voiceover-render/probe_${jobId}.mp4`;
        execSync(`mkdir -p /tmp/voiceover-render && curl -sL -r 0-5000000 -o "${probePath}" "${signedUrl}"`, { timeout: 30000 });
        const analysis = await analyzeSourceAudio(probePath);
        audioType = analysis.audioType;
        videoDurationSec = analysis.durationSec > 0 ? analysis.durationSec : 30;
        execSync(`rm -f "${probePath}"`);
      } catch {
        // Detection failed, use defaults
        videoDurationSec = 30;
      }
    }

    await db.updateVoiceoverJob(jobId, {
      status: "scripting",
      audioType,
      videoDurationSec,
      // Default: mute if music_only, duck if speech/mixed
      originalAudioMode: audioType === "music_only" ? "mute" : "duck",
    });

    // Step 2: Generate script
    await processScriptGeneration(jobId);
  } catch (err: any) {
    await db.updateVoiceoverJob(jobId, { status: "failed", errorMessage: err.message ?? "Unknown error" });
  }
}

async function processScriptGeneration(jobId: number) {
  try {
    const job = await db.getVoiceoverJob(jobId);
    if (!job) return;

    const reel = await db.getReelByIgMediaId(
      (await db.getDailyPicks(getCdtPickDate())).find(p => p.id === job.pickId)?.postId ?? ""
    );

    const { generateVoiceoverScript } = await import("./voiceoverScript");
    const result = await generateVoiceoverScript({
      caption: reel?.caption ?? "",
      city: job.city,
      videoDurationSec: job.videoDurationSec ?? 30,
      audioType: (job.audioType as "speech" | "music_only" | "silent" | "mixed") ?? "music_only",
    });

    await db.updateVoiceoverJob(jobId, {
      status: "pending_approval",
      script: result.script,
    });
  } catch (err: any) {
    await db.updateVoiceoverJob(jobId, { status: "failed", errorMessage: err.message ?? "Script generation failed" });
  }
}

async function processRender(jobId: number) {
  try {
    const job = await db.getVoiceoverJob(jobId);
    if (!job || !job.script) return;

    // Get the pick's Drive video URL
    const pickDate = getCdtPickDate();
    const picks = await db.getDailyPicks(pickDate);
    const pick = picks.find(p => p.id === job.pickId);
    if (!pick) {
      await db.updateVoiceoverJob(jobId, { status: "failed", errorMessage: "Pick not found" });
      return;
    }

    // Download the source video from S3 (Drive original stored on the pick)
    const driveVideoUrl = pick.driveVideoUrl;
    if (!driveVideoUrl) {
      await db.updateVoiceoverJob(jobId, { status: "failed", errorMessage: "No Drive original video available" });
      return;
    }

    // driveVideoUrl is a /manus-storage/ path — get a signed URL
    const { storageGetSignedUrl } = await import("./storage");
    const storageKey = driveVideoUrl.replace(/^\/manus-storage\//, "");
    const videoSignedUrl = await storageGetSignedUrl(storageKey);
    // Download to temp
    const { execSync } = await import("child_process");
    const { existsSync, mkdirSync } = await import("fs");
    const workDir = "/tmp/voiceover-render";
    if (!existsSync(workDir)) mkdirSync(workDir, { recursive: true });
    const sourcePath = `${workDir}/job_${jobId}_source.mp4`;
    execSync(`curl -sL -o "${sourcePath}" "${videoSignedUrl}"`, { timeout: 120000 });

    await db.updateVoiceoverJob(jobId, { status: "rendering" });

    // Render
    const { renderVoiceover } = await import("./voiceoverRender");
    const renderResult = await renderVoiceover({
      sourceVideoPath: sourcePath,
      script: job.script,
      originalAudioMode: (job.originalAudioMode as "duck" | "mute") ?? "duck",
      jobId,
    });

    // Upload rendered video to S3
    const { readFileSync } = await import("fs");
    const { storagePut } = await import("./storage");
    const renderedKeyInput = `voiceover-rendered/job_${jobId}.mp4`;
    const { key: renderedKey } = await storagePut(renderedKeyInput, readFileSync(renderResult.outputPath), "video/mp4");

    // Track character usage
    const month = new Date().toISOString().slice(0, 7);
    await db.addCharacterUsage(month, renderResult.charactersUsed);

    await db.updateVoiceoverJob(jobId, {
      status: "preview_ready",
      charactersUsed: renderResult.charactersUsed,
      audioDurationSec: renderResult.audioDurationSec,
      durationMismatchPct: renderResult.durationMismatchPct,
      audioStorageKey: renderResult.audioStorageKey,
      renderedVideoStorageKey: renderedKey,
    });

    // Clean up source file
    try { execSync(`rm -f "${sourcePath}"`); } catch { /* ignore */ }
  } catch (err: any) {
    await db.updateVoiceoverJob(jobId, { status: "failed", errorMessage: err.message ?? "Render failed" });
  }
}
