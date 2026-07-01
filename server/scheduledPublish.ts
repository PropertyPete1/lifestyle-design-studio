import type { Request, Response } from "express";
import { sdk } from "./_core/sdk";
import { ENV } from "./_core/env";
import * as db from "./db";
import { syncIgPostHistory } from "./igHistorySync";
import { getCdtPickDate } from "./selection";
import { createScheduledPost } from "./metricool";
import { checkSourceCooldown } from "./sourceCooldown";
import { makeDifferentiatedVariant } from "./videoVariant";

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

const CITY_VALUES = new Set(["austin", "san_antonio"]);

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
    const pick = await db.getDueConfirmedPickForCity(
      city as "austin" | "san_antonio",
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
 * publishNow endpoint: called by the agent after it has fetched the fresh video URL.
 * Body: { pickId, repostId, videoUrl, caption?, thumbnailUrl? }
 * - Calls Metricool to schedule the post for immediate publication (autoPublish: true).
 * - Marks the pick as posted or failed in the database.
 */
export async function publishNowHandler(req: Request, res: Response) {
  try {
    if (!(await authorize(req))) {
      return res.status(403).json({ error: "forbidden" });
    }

    const pickId = Number(req.body?.pickId);
    const repostId = Number(req.body?.repostId);
    const videoUrl = String(req.body?.videoUrl ?? "");
    const captionOverride = req.body?.caption ? String(req.body.caption) : undefined;
    const thumbnailUrl = req.body?.thumbnailUrl ? String(req.body.thumbnailUrl) : null;

    if (!pickId) return res.status(400).json({ error: "missing pickId" });
    if (!videoUrl || !videoUrl.startsWith("http")) {
      return res.status(400).json({ error: "missing or invalid videoUrl" });
    }

    // Fetch the pick to get the caption if not provided
    const pickDate = getCdtPickDate();
    const picks = await db.getDailyPicks(pickDate);
    const pick = picks.find(p => p.id === pickId);
    if (!pick) {
      return res.status(404).json({ error: "pick not found for today" });
    }
    if (pick.status === "posted") {
      return res.json({ ok: true, alreadyPosted: true });
    }

    const video = await db.getVideoById(pick.videoId);
    const caption = captionOverride ?? pick.refreshedCaption ?? video?.caption ?? "";

    // -------------------------------------------------------------------------
    // GUARD 1 — Hard same-source cooldown (last line of defense).
    // Blocks publishing the same source video (by IG postId OR caption
    // fingerprint) if it was posted within the cooldown window on ANY path
    // (dashboard reposts OR live Instagram history). This prevents the
    // duplicate-content throttle that floors reach on rapid re-posts.
    // Can be bypassed with { force: true } for manual overrides.
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
    // GUARD 2 — Light video differentiation.
    // Re-encode the source with a tiny (imperceptible) transform + metadata
    // strip so the uploaded file is NOT byte-identical to the reel already on
    // the account. Byte-identical re-uploads are detected as duplicates and
    // throttled. Differentiation is best-effort: if it fails we fall back to
    // the original URL rather than block the post.
    // -------------------------------------------------------------------------
    let mediaUrl = videoUrl;
    let differentiated = false;
    try {
      const variant = await makeDifferentiatedVariant({
        sourceUrl: videoUrl,
        postId: pick.postId,
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

    // Publish immediately via Metricool (schedule 1 minute from now to satisfy API)
    const publishAt = new Date(Date.now() + 60_000).toISOString().slice(0, 19); // "YYYY-MM-DDTHH:MM:SS"

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
        platforms: "Instagram, TikTok, YouTube",
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
