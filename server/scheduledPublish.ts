import type { Request, Response } from "express";
import { sdk } from "./_core/sdk";
import { ENV } from "./_core/env";
import * as db from "./db";
import { syncIgPostHistory } from "./igHistorySync";
import { getCdtPickDate } from "./selection";
import { createScheduledPost } from "./metricool";
import { checkSourceCooldown } from "./sourceCooldown";
import { makeDifferentiatedVariant } from "./videoVariant";
import { runPerformanceAnalyst } from "./performanceAnalyst";
import { ensureTodayPicks } from "./routers";
import { storageGetSignedUrl } from "./storage";

/**
 * Endpoints used by the publishing AGENT cron (a scheduled Manus session that
 * has the Instagram connector). The agent authenticates with the owner's
 * `$SCHEDULED_TASK_COOKIE`, so we accept either a cron identity or the owner.
 */

async function authorize(req: Request): Promise<boolean> {
  try {
    const user = await sdk.authenticateRequest(req);
    if (user?.isCron) return true;
    if (ENV.ownerOpenId && user?.openId === ENV.ownerOpenId) return true;
    return false;
  } catch {
    return false;
  }
}

const CITY_VALUES = new Set(["austin", "san_antonio", "dallas"]);

/**
 * Build a "YYYY-MM-DDTHH:MM:SS" wall-clock string in America/Chicago for the
 * given epoch-ms. Metricool reads publicationDate.dateTime in the supplied
 * timezone, so passing a UTC ISO string with timezone:"America/Chicago"
 * schedules the post ~5–6 hours late. This produces the correct local time.
 */
export function chicagoLocalDateTime(epochMs: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(epochMs));
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? "00";
  // en-CA gives ISO-like date parts; hour may come back as "24" at midnight.
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}:${get("second")}`;
}

/**
 * GET-style (POST) endpoint: returns the confirmed pick that is due to publish
 * for the requested city today, including the video's caption + postId so the
 * agent can fetch a fresh media URL and publish it. Returns { due: false } when
 * nothing is ready (so the agent exits cleanly).
 */
export async function dueForPublishHandler(req: Request, res: Response) {
  try {
    if (!(await authorize(req))) {
      return res.status(403).json({ error: "forbidden" });
    }

    // Auto-Pilot check: if disabled, skip posting entirely
    const autoPilot = await db.getSetting("autoPilot");
    if (autoPilot !== "true") {
      return res.json({ due: false, reason: "autoPilot is OFF" });
    }

    const city = String(req.body?.city ?? "");
    if (!CITY_VALUES.has(city)) {
      return res.status(400).json({ error: "invalid city" });
    }
    const pickDate = getCdtPickDate();
    const nowMs = Date.now();
    // SELF-HEAL: guarantee today's picks exist AND are auto-confirmed before we
    // check what's due. ensureTodayPicks is idempotent and auto-confirms every
    // pending pick, so even if the morning generation cron never ran (or the
    // owner never opened the app), the posting agent still finds a confirmed,
    // due pick here. Failures are non-fatal — fall through to the normal lookup.
    try {
      await ensureTodayPicks(pickDate);
    } catch (genErr) {
      console.error("[dueForPublish] ensureTodayPicks failed (continuing):", genErr);
    }
    const pick = await db.getDueConfirmedPickForCity(
      city as "austin" | "san_antonio" | "dallas",
      pickDate,
      nowMs
    );
    if (!pick) {
      return res.json({ due: false });
    }
    // Look up from ig_reels (new pipeline) — postId is the igMediaId
    const reel = await db.getReelByIgMediaId(pick.postId);
    return res.json({
      due: true,
      pick: {
        pickId: pick.id,
        repostId: pick.repostId,
        city: pick.city,
        postId: pick.postId,
        shortcode: null, // no shortcode in ig_reels
        permalink: reel?.reelLink ?? null,
        caption: pick.refreshedCaption ?? reel?.caption ?? "",
        thumbnailUrl: reel?.thumbnailStorageKey ? `/manus-storage/${reel.thumbnailStorageKey}` : null,
        scheduledFor: pick.scheduledFor,
      },
    });
  } catch (err) {
    const e = err as Error;
    return res.status(500).json({
      error: e.message,
      stack: e.stack,
      context: { url: req.originalUrl },
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * publishNow endpoint: called by the agent OR the Heartbeat cron.
 * Body: { pickId, repostId, videoUrl?, caption?, thumbnailUrl? }
 *
 * NEW FLOW (Drive-original): If the pick has a pre-uploaded driveVideoUrl
 * (set by the morning preprocessing job), that URL is used directly —
 * no videoUrl from the agent is needed. The agent just calls dueForPublish
 * → gets the pick → calls publishNow with pickId+repostId.
 *
 * LEGACY FLOW: If driveVideoUrl is not set AND a videoUrl is provided in
 * the body, that URL is used (backward-compatible).
 *
 * If neither source is available, the pick is skipped (no fallback to IG copy).
 */
export async function publishNowHandler(req: Request, res: Response) {
  try {
    if (!(await authorize(req))) {
      return res.status(403).json({ error: "forbidden" });
    }

    const pickId = Number(req.body?.pickId);
    const repostId = Number(req.body?.repostId);
    const bodyVideoUrl = req.body?.videoUrl ? String(req.body.videoUrl) : "";
    const captionOverride = req.body?.caption ? String(req.body.caption) : undefined;
    const thumbnailUrl = req.body?.thumbnailUrl ? String(req.body.thumbnailUrl) : null;

    if (!pickId) return res.status(400).json({ error: "missing pickId" });

    // Fetch the pick to get the caption and driveVideoUrl
    const pickDate = getCdtPickDate();
    const picks = await db.getDailyPicks(pickDate);
    const pick = picks.find(p => p.id === pickId);
    if (!pick) {
      return res.status(404).json({ error: "pick not found for today" });
    }
    if (pick.status === "posted") {
      return res.json({ ok: true, alreadyPosted: true });
    }

    // Determine video source: Drive original (preferred) or body videoUrl (legacy)
    // driveVideoUrl is now stored as an S3 storage KEY (not a signed URL).
    // Generate a fresh signed URL at publish time so it never expires.
    let videoUrl: string | null = null;
    if (pick.driveVideoUrl) {
      // If it looks like a full URL (legacy rows from before the fix), use as-is
      if (pick.driveVideoUrl.startsWith("http")) {
        videoUrl = pick.driveVideoUrl;
      } else {
        // It's a storage key — generate a fresh signed URL (valid ~1h)
        videoUrl = await storageGetSignedUrl(pick.driveVideoUrl);
        console.log(`[publishNow] Generated fresh signed URL from storage key for pick ${pickId}`);
      }
    } else {
      // 4K-ONLY POLICY: Drive original is required. Attempt Drive preprocessing
      // one more time as a self-heal (covers the case where morning job failed
      // due to temporary Drive disconnect but it's back now).
      console.log(`[publishNow] No driveVideoUrl for pick ${pickId} — attempting Drive retry...`);
      try {
        const { driveHealthCheck } = await import("./driveIndex");
        const health = await driveHealthCheck();
        if (health.healthy) {
          const { preprocessDriveOriginals } = await import("./drivePreprocess");
          await preprocessDriveOriginals();
          // Re-fetch the pick to see if it now has a driveVideoUrl
          const updatedPicks = await db.getDailyPicks(pickDate);
          const updatedPick = updatedPicks.find(p => p.id === pickId);
          if (updatedPick?.driveVideoUrl) {
            if (updatedPick.driveVideoUrl.startsWith("http")) {
              videoUrl = updatedPick.driveVideoUrl;
            } else {
              videoUrl = await storageGetSignedUrl(updatedPick.driveVideoUrl);
            }
            console.log(`[publishNow] Drive retry succeeded for pick ${pickId}`);
          }
        } else {
          console.warn(`[publishNow] Drive still disconnected: ${health.error}`);
        }
      } catch (retryErr) {
        console.error(`[publishNow] Drive retry failed:`, retryErr);
      }

      // If still no video URL after retry, fail the pick
      if (!videoUrl) {
        const skipMsg = "No Drive original available — 4K-only policy (Drive retry also failed)";
        console.warn(`[publishNow] ${skipMsg} for pick ${pickId}`);
        if (repostId) await db.markRepostFailed(repostId, skipMsg);
        await db.updateDailyPick(pickId, { status: "failed" });
        // Notify owner about the failure
        try {
          const { notifyOwner } = await import("./_core/notification");
          await notifyOwner({
            title: "\u274c Post Failed — No Drive Original",
            content: `The ${pick.city} post for today could not be published because no 4K Drive original was available (both morning preprocessing and publish-time retry failed).\n\nPlease check that the Google Drive connector is enabled in your Manus project settings.`,
          });
        } catch (_) { /* notification is best-effort */ }
        return res.status(422).json({ ok: false, error: skipMsg, source: "no_drive_original" });
      }
    }
    if (!videoUrl || !videoUrl.startsWith("http")) {
      const skipMsg = "Drive original URL could not be resolved";
      console.warn(`[publishNow] ${skipMsg} for pick ${pickId}`);
      if (repostId) await db.markRepostFailed(repostId, skipMsg);
      await db.updateDailyPick(pickId, { status: "failed" });
      return res.status(422).json({ ok: false, error: skipMsg, source: "no_video" });
    }

    // Look up from ig_reels (new pipeline)
    const reel = await db.getReelByIgMediaId(pick.postId);
    const caption = captionOverride ?? pick.refreshedCaption ?? reel?.caption ?? "";

    // -------------------------------------------------------------------------
    // GUARD 1 - Hard same-source cooldown (last line of defense).
    // Blocks publishing the same source video (by IG postId OR caption
    // fingerprint) if it was posted within the cooldown window on ANY path
    // (dashboard reposts OR live Instagram history). This prevents the
    // duplicate-content throttle that floors reach on rapid re-posts.
    // Bypassable with { force: true } for manual overrides.
    // -------------------------------------------------------------------------
    const force = Boolean(req.body?.force);
    if (!force) {
      const cooldown = await checkSourceCooldown({
        postId: pick.postId,
        caption,
        excludeRepostId: repostId || undefined,
      });
      if (cooldown.blocked) {
        if (repostId) await db.markRepostFailed(repostId, cooldown.reason ?? "cooldown");
        await db.updateDailyPick(pickId, { status: "failed" });
        return res.status(409).json({
          ok: false,
          blocked: true,
          reason: cooldown.reason,
          daysSinceLast: cooldown.daysSinceLast,
          matchedBy: cooldown.matchedBy,
        });
      }
    }

    // -------------------------------------------------------------------------
    // VOICEOVER CHECK: If an approved voiceover exists, use the rendered video.
    // -------------------------------------------------------------------------
    let mediaUrl = videoUrl;
    const voiceoverJob = await db.getVoiceoverJobByPickId(pickId);
    if (voiceoverJob?.status === "approved" && voiceoverJob.renderedVideoStorageKey) {
      try {
        mediaUrl = await storageGetSignedUrl(voiceoverJob.renderedVideoStorageKey);
        console.log(`[publishNow] Using voiceover-rendered video for pick ${pickId} (job ${voiceoverJob.id})`);
      } catch (voErr) {
        console.warn(`[publishNow] Failed to get voiceover video URL, falling back to Drive original:`, voErr);
        // Fall back to the Drive original
      }
    } else {
      console.log(`[publishNow] Using pre-uploaded Drive original for pick ${pickId}`);
    }
    const differentiated = true;

    // Publish immediately via Metricool. Metricool interprets publicationDate
    // in the given timezone, so we MUST build a wall-clock string in
    // America/Chicago (NOT a UTC ISO string), or the post is scheduled ~5h late.
    const publishAt = chicagoLocalDateTime(Date.now() + 90_000); // "YYYY-MM-DDTHH:MM:SS"

    // Resolve thumbnail to a full public URL (Metricool can't fetch relative paths).
    // If we can't get a signed URL, just omit it — Metricool will auto-generate one.
    let resolvedThumbnailUrl: string | null = null;
    try {
      const thumbKey = thumbnailUrl || (reel?.thumbnailStorageKey ?? null);
      if (thumbKey && !thumbKey.startsWith("http")) {
        // It's a storage key — get a signed public URL
        resolvedThumbnailUrl = await storageGetSignedUrl(thumbKey);
      } else if (thumbKey?.startsWith("http")) {
        resolvedThumbnailUrl = thumbKey;
      }
    } catch (thumbErr) {
      console.warn(`[publishNow] Could not resolve thumbnail URL, omitting:`, thumbErr);
    }

    const result = await createScheduledPost({
      videoUrl: mediaUrl,
      caption,
      publishAt,
      timezone: "America/Chicago",
      thumbnailUrl: resolvedThumbnailUrl,
    });

    if (result.ok) {
      const metricoolPostId = result.postId ? String(result.postId) : undefined;
      if (repostId) {
        await db.markRepostPosted(repostId, metricoolPostId);
        // Save compression metadata if video was compressed
        if (result.compression) {
          await db.updateRepostCompression(repostId, result.compression.fileSizeMb, result.compression.crfValue);
        }
      }
      await db.updateDailyPick(pickId, { status: "posted" });
      return res.json({
        ok: true,
        status: "posted",
        metricoolPostId,
        differentiated,
        driveSource: true,
        driveMatchConfidence: pick.driveMatchConfidence ?? null,
        platforms: result.platforms ?? "connected Metricool networks",
      });
    } else {
      const errMsg = result.error ?? "Metricool publish failed";
      if (repostId) await db.markRepostFailed(repostId, errMsg);
      await db.updateDailyPick(pickId, { status: "failed" });
      return res.status(500).json({ ok: false, error: errMsg, raw: result.raw });
    }
  } catch (err) {
    const e = err as Error;
    return res.status(500).json({
      error: e.message,
      stack: e.stack,
      context: { url: req.originalUrl },
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * generatePicks endpoint: proactively generates (and auto-confirms) today's
 * picks so they always exist BEFORE the 2/3/4 PM CT posting window, even if no
 * one opens the app that morning. Intended to be called by a morning Heartbeat
 * cron (~8 AM CT). ensureTodayPicks is idempotent and now auto-confirms every
 * pending pick, so the posting agent finds them due.
 *
 * NEW PIPELINE: ig_reels must be populated BEFORE this runs. The agent scrape
 * task calls /api/scheduled/scrapeReels first, then this endpoint.
 */
export async function generatePicksHandler(req: Request, res: Response) {
  try {
    if (!(await authorize(req))) {
      return res.status(403).json({ error: "forbidden" });
    }

    // Auto-Pilot check: if disabled, still generate picks (for dashboard display)
    // but mark them so the publish step knows not to fire
    const autoPilot = await db.getSetting("autoPilot");
    const isAutoPilotOn = autoPilot === "true";

    const pickDate = getCdtPickDate();
    const picks = await ensureTodayPicks(pickDate);

    // -----------------------------------------------------------------------
    // DRIVE HEALTH CHECK: Before preprocessing, verify Drive token is valid.
    // If disconnected, notify owner immediately so they can re-enable it.
    // -----------------------------------------------------------------------
    let driveResults: unknown = null;
    let driveHealthy = false;
    if (isAutoPilotOn) {
      try {
        const { driveHealthCheck } = await import("./driveIndex");
        const health = await driveHealthCheck();
        driveHealthy = health.healthy;
        if (!health.healthy) {
          console.error(`[generatePicks] Drive health check FAILED: ${health.error}`);
          // Notify owner immediately
          try {
            const { notifyOwner } = await import("./_core/notification");
            await notifyOwner({
              title: "\u26a0\ufe0f Google Drive Disconnected",
              content: `The Google Drive connector is not responding (${health.error ?? "token expired or revoked"}). Today's videos cannot be posted in 4K until Drive is reconnected.\n\nPlease re-enable the Google Drive connector in your Manus project settings (Settings \u2192 Integrations).\n\nThe system will retry at publish time (2/3/4 PM CT), so if you reconnect before then, posts will still go out on schedule.`,
            });
          } catch (notifErr) {
            console.error("[generatePicks] Failed to send Drive disconnect notification:", notifErr);
          }
          driveResults = { error: "Drive disconnected", detail: health.error };
        }
      } catch (healthErr) {
        console.error("[generatePicks] Drive health check threw:", healthErr);
        driveResults = { error: "Drive health check failed", detail: String(healthErr) };
      }

      // Only run Drive preprocessing if health check passed
      if (driveHealthy) {
        try {
          const { preprocessDriveOriginals } = await import("./drivePreprocess");
          driveResults = await preprocessDriveOriginals();
        } catch (driveErr) {
          console.error("[generatePicks] Drive preprocessing failed (non-fatal):", driveErr);
          driveResults = { error: String(driveErr) };
        }
      }
    } else {
      driveResults = { skipped: "autoPilot is OFF" };
    }

    // --- Auto-Voiceover: start voiceover jobs for all picks if enabled ---
    let voiceoverResults: any = { skipped: "autoVoiceover is OFF" };
    const autoVoiceoverVal = await db.getSetting("autoVoiceover");
    const isAutoVoiceoverOn = autoVoiceoverVal === null || autoVoiceoverVal === "true"; // default ON
    if (isAutoVoiceoverOn && isAutoPilotOn) {
      try {
        const { processFullVoiceover } = await import("./voiceoverPipeline");
        const voiceoverJobs = [];
        for (const pick of picks) {
          // Only start if no existing job and pick has a Drive original
          const existingJob = await db.getVoiceoverJob(pick.id);
          if (!existingJob && pick.driveVideoUrl) {
            try {
              const result = await processFullVoiceover(pick.id);
              voiceoverJobs.push({ pickId: pick.id, city: pick.city, status: result.status });
            } catch (voErr) {
              console.error(`[generatePicks] Auto-voiceover failed for pick ${pick.id}:`, voErr);
              voiceoverJobs.push({ pickId: pick.id, city: pick.city, error: String(voErr) });
            }
          } else if (existingJob) {
            voiceoverJobs.push({ pickId: pick.id, city: pick.city, status: "already_exists" });
          } else {
            voiceoverJobs.push({ pickId: pick.id, city: pick.city, status: "no_drive_video" });
          }
        }
        voiceoverResults = { started: voiceoverJobs.length, jobs: voiceoverJobs };
      } catch (voErr) {
        console.error("[generatePicks] Auto-voiceover module error:", voErr);
        voiceoverResults = { error: String(voErr) };
      }
    }

    return res.json({
      ok: true,
      autoPilot: isAutoPilotOn,
      autoVoiceover: isAutoVoiceoverOn,
      pickDate,
      count: picks.length,
      picks: picks.map(p => ({ city: p.city, status: p.status, scheduledFor: p.scheduledFor })),
      drivePreprocess: driveResults,
      voiceover: voiceoverResults,
    });
  } catch (err) {
    const e = err as Error;
    return res.status(500).json({
      error: e.message,
      stack: e.stack,
      context: { url: req.originalUrl },
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * scrapeReels endpoint: called by the morning agent (which has the Instagram
 * MCP connector) to push freshly scraped IG reel data into ig_reels.
 *
 * Body: { reels: Array<{ igMediaId, caption, views, likes, comments, shares,
 *         saved, reelLink, postedAt, thumbnailUrl? }> }
 *
 * This MUST be called BEFORE generatePicks so the ig_reels table has fresh
 * engagement data for the selection algorithm.
 */
export async function scrapeReelsHandler(req: Request, res: Response) {
  try {
    if (!(await authorize(req))) {
      return res.status(403).json({ error: "forbidden" });
    }
    const reels = req.body?.reels;
    if (!Array.isArray(reels) || reels.length === 0) {
      return res.status(400).json({ error: "reels must be a non-empty array" });
    }
    const { upsertScrapedReels } = await import("./igScraper");
    const result = await upsertScrapedReels(reels);
    return res.json({ ok: true, ...result });
  } catch (err) {
    const e = err as Error;
    return res.status(500).json({
      error: e.message,
      stack: e.stack,
      context: { url: req.originalUrl },
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * syncIgHistory endpoint: called by the daily agent before pick generation.
 * Body: { posts: Array<{ id, thumbnail_url?, media_url?, caption?, timestamp }> }
 * Upserts the recent IG posts into ig_post_history for AI visual dedup.
 */
export async function syncIgHistoryHandler(req: Request, res: Response) {
  try {
    if (!(await authorize(req))) {
      return res.status(403).json({ error: "forbidden" });
    }
    const posts = req.body?.posts;
    if (!Array.isArray(posts)) {
      return res.status(400).json({ error: "posts must be an array" });
    }
    await syncIgPostHistory(posts);
    return res.json({ ok: true, synced: posts.length });
  } catch (err) {
    const e = err as Error;
    return res.status(500).json({ error: e.message });
  }
}

/**
 * Report the result of a publish attempt (legacy / fallback).
 * Body: { pickId, repostId, success, igMediaId?, error? }
 * Marks the daily pick + repost row as posted or failed. Idempotent.
 */
export async function reportPublishHandler(req: Request, res: Response) {
  try {
    if (!(await authorize(req))) {
      return res.status(403).json({ error: "forbidden" });
    }
    const pickId = Number(req.body?.pickId);
    const repostId = Number(req.body?.repostId);
    const success = Boolean(req.body?.success);
    const igMediaId = req.body?.igMediaId ? String(req.body.igMediaId) : undefined;
    const error = req.body?.error ? String(req.body.error) : "unknown error";

    if (!pickId) return res.status(400).json({ error: "missing pickId" });

    const pickDate = getCdtPickDate();
    const picks = await db.getDailyPicks(pickDate);
    const pick = picks.find(p => p.id === pickId);
    if (!pick) {
      return res.json({ ok: true, skipped: "pick-not-found" });
    }
    if (pick.status === "posted") {
      return res.json({ ok: true, alreadyPosted: true });
    }

    if (success) {
      if (repostId) await db.markRepostPosted(repostId, igMediaId);
      await db.updateDailyPick(pickId, { status: "posted" });
      return res.json({ ok: true, status: "posted" });
    } else {
      if (repostId) await db.markRepostFailed(repostId, error);
      await db.updateDailyPick(pickId, { status: "failed" });
      return res.json({ ok: true, status: "failed" });
    }
  } catch (err) {
    const e = err as Error;
    return res.status(500).json({
      error: e.message,
      stack: e.stack,
      context: { url: req.originalUrl },
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * Scheduled AI performance-analyst run. Ingests recent per-brand metrics from
 * Metricool, diagnoses under/over-performers vs each brand's own median, asks
 * the LLM for a concrete strategy update, stores the insight, and notifies the
 * owner. Runs inline (no agent) so it fits a Heartbeat HTTP cron.
 *
 * Idempotent: post_metrics upserts by (network, post, day) and the insight
 * upserts by run date, so retries just refresh the same day's data.
 */
export async function runAnalystHandler(req: Request, res: Response) {
  try {
    if (!(await authorize(req))) {
      return res.status(403).json({ error: "forbidden" });
    }
    const days = Number(req.body?.days) > 0 ? Number(req.body.days) : 5;
    const result = await runPerformanceAnalyst(days);
    if (!result.ok) {
      return res.status(500).json({
        error: result.error ?? "analyst run failed",
        context: { url: req.originalUrl, runDate: result.runDate },
        timestamp: new Date().toISOString(),
      });
    }
    return res.json({
      ok: true,
      runDate: result.runDate,
      ingested: result.ingested,
      flagged: result.flaggedCount,
      notified: result.notified,
    });
  } catch (err) {
    const e = err as Error;
    return res.status(500).json({
      error: e.message,
      stack: e.stack,
      context: { url: req.originalUrl },
      timestamp: new Date().toISOString(),
    });
  }
}
