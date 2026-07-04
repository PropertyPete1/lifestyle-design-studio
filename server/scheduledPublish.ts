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
    const video = await db.getVideoById(pick.videoId);
    return res.json({
      due: true,
      pick: {
        pickId: pick.id,
        repostId: pick.repostId,
        city: pick.city,
        postId: pick.postId,
        shortcode: video?.shortcode ?? null,
        permalink: video?.permalink ?? null,
        caption: pick.refreshedCaption ?? video?.caption ?? "",
        thumbnailUrl: video?.thumbnailUrl ?? null,
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
      videoUrl = bodyVideoUrl || null;
    }
    if (!videoUrl || !videoUrl.startsWith("http")) {
      // No Drive original and no agent-provided URL — skip this pick
      const skipMsg = "No Drive original available and no videoUrl provided";
      console.warn(`[publishNow] ${skipMsg} for pick ${pickId}`);
      if (repostId) await db.markRepostFailed(repostId, skipMsg);
      await db.updateDailyPick(pickId, { status: "failed" });
      return res.status(422).json({ ok: false, error: skipMsg, source: "no_video" });
    }

    const video = await db.getVideoById(pick.videoId);
    const caption = captionOverride ?? pick.refreshedCaption ?? video?.caption ?? "";

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
    // GUARD 2 - Serverless byte differentiation (best-effort, NO ffmpeg).
    // If using a Drive original (driveVideoUrl), the variant was already applied
    // during the morning preprocessing job — skip re-differentiation.
    // For legacy IG-copy URLs, apply the variant at publish time as before.
    // -------------------------------------------------------------------------
    let mediaUrl = videoUrl;
    let differentiated = false;
    const usingDriveOriginal = Boolean(pick.driveVideoUrl);

    if (usingDriveOriginal) {
      // Drive originals are already differentiated in the morning job
      differentiated = true;
      console.log(`[publishNow] Using pre-uploaded Drive original for pick ${pickId}`);
    } else {
      // Legacy path: apply variant at publish time
      try {
        const variant = await makeDifferentiatedVariant({
          sourceUrl: videoUrl,
          postId: pick.postId,
          salt: `${Date.now()}`,
        });
        if (variant.ok && variant.url) {
          mediaUrl = variant.url;
          differentiated = true;
        } else {
          console.warn(`[publishNow] variant failed, using original URL: ${variant.error}`);
        }
      } catch (e) {
        console.warn(`[publishNow] variant threw, using original URL:`, e);
      }
    }

    // Publish immediately via Metricool. Metricool interprets publicationDate
    // in the given timezone, so we MUST build a wall-clock string in
    // America/Chicago (NOT a UTC ISO string), or the post is scheduled ~5h late.
    const publishAt = chicagoLocalDateTime(Date.now() + 90_000); // "YYYY-MM-DDTHH:MM:SS"

    const result = await createScheduledPost({
      videoUrl: mediaUrl,
      caption,
      publishAt,
      timezone: "America/Chicago",
      thumbnailUrl: thumbnailUrl ?? video?.thumbnailUrl ?? null,
    });

    if (result.ok) {
      const metricoolPostId = result.postId ? String(result.postId) : undefined;
      if (repostId) await db.markRepostPosted(repostId, metricoolPostId);
      await db.updateDailyPick(pickId, { status: "posted" });
      return res.json({
        ok: true,
        status: "posted",
        metricoolPostId,
        differentiated,
        driveSource: usingDriveOriginal,
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
 */
export async function generatePicksHandler(req: Request, res: Response) {
  try {
    if (!(await authorize(req))) {
      return res.status(403).json({ error: "forbidden" });
    }
    const pickDate = getCdtPickDate();
    const picks = await ensureTodayPicks(pickDate);

    // -----------------------------------------------------------------------
    // DRIVE PRE-PROCESSING: After picks are generated + auto-confirmed,
    // match each pick to its Drive original, download, apply fingerprint
    // change, and upload to S3. This makes the 2/3/4 PM publish instant.
    // Non-blocking: if Drive matching fails, the pick stays confirmed but
    // without a driveVideoUrl (publishNow will fail gracefully).
    // -----------------------------------------------------------------------
    let driveResults: unknown = null;
    try {
      const { preprocessDriveOriginals } = await import("./drivePreprocess");
      driveResults = await preprocessDriveOriginals();
    } catch (driveErr) {
      console.error("[generatePicks] Drive preprocessing failed (non-fatal):", driveErr);
      driveResults = { error: String(driveErr) };
    }

    return res.json({
      ok: true,
      pickDate,
      count: picks.length,
      picks: picks.map(p => ({ city: p.city, status: p.status, scheduledFor: p.scheduledFor })),
      drivePreprocess: driveResults,
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
