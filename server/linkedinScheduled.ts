import type { Request, Response } from "express";
import { sdk } from "./_core/sdk";
import { ENV } from "./_core/env";
import * as db from "./db";
import { getCdtPickDate, cdtTimeToUtcMs } from "./selection";
import { generateLinkedinPost } from "./linkedinAuthor";
import { publishLinkedinText } from "./metricool";
import { chicagoLocalDateTime } from "./scheduledPublish";
import { LINKEDIN_BRAND_BLOG_ID } from "../shared/const";

/** Daily LinkedIn recruiting posts publish at 2 PM CT. */
const LINKEDIN_POST_HOUR = 14;

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

/**
 * Ensure today's LinkedIn post exists (idempotent). Generates the AI draft in
 * Peter's voice for the rotation topic, stores it as status="scheduled" with a
 * 2 PM CT scheduled time. If a row already exists for the date it is returned
 * as-is (so editing/regeneration is intentional, not automatic).
 */
export async function ensureTodayLinkedinPost(postDate: string) {
  const existing = await db.getLinkedinPostByDate(postDate);
  if (existing) return existing;

  const { topic, body } = await generateLinkedinPost(postDate);
  const scheduledFor = cdtTimeToUtcMs(postDate, LINKEDIN_POST_HOUR);
  await db.insertLinkedinPost({
    postDate,
    topic,
    body,
    status: "scheduled",
    scheduledFor,
  });
  return db.getLinkedinPostByDate(postDate);
}

/**
 * Morning generation endpoint: proactively create today's LinkedIn post so it
 * always exists before the 2 PM window. Intended for a morning Heartbeat cron.
 */
export async function generateLinkedinHandler(req: Request, res: Response) {
  try {
    if (!(await authorize(req))) return res.status(403).json({ error: "forbidden" });
    const postDate = getCdtPickDate();
    const post = await ensureTodayLinkedinPost(postDate);
    return res.json({
      ok: true,
      postDate,
      topic: post?.topic,
      status: post?.status,
      words: (post?.body ?? "").split(/\s+/).filter(Boolean).length,
      body: post?.body,
    });
  } catch (err) {
    const e = err as Error;
    return res.status(500).json({ error: e.message, stack: e.stack });
  }
}

/**
 * 2 PM publish endpoint: self-heals (generates today's post if missing), then
 * publishes the due LinkedIn post as TEXT ONLY via Metricool and marks it
 * posted/failed. Idempotent: an already-posted post short-circuits.
 */
export async function publishLinkedinHandler(req: Request, res: Response) {
  try {
    if (!(await authorize(req))) return res.status(403).json({ error: "forbidden" });
    const postDate = getCdtPickDate();
    const nowMs = Date.now();

    // SELF-HEAL: guarantee today's post exists (and is scheduled) even if the
    // morning cron never ran. Non-fatal if generation fails; fall through.
    try {
      await ensureTodayLinkedinPost(postDate);
    } catch (genErr) {
      console.error("[publishLinkedin] ensureTodayLinkedinPost failed (continuing):", genErr);
    }

    const due = await db.getDueLinkedinPost(postDate, nowMs);
    if (!due) {
      const cur = await db.getLinkedinPostByDate(postDate);
      return res.json({ due: false, status: cur?.status ?? "none" });
    }

    const publishAt = chicagoLocalDateTime(Date.now() + 90_000);
    const result = await publishLinkedinText({
      blogId: LINKEDIN_BRAND_BLOG_ID,
      text: due.body,
      publishAt,
      timezone: "America/Chicago",
      autoPublish: true,
    });

    if (result.ok) {
      await db.updateLinkedinPost(due.id, {
        status: "posted",
        metricoolPostId: result.postId ? String(result.postId) : null,
        postedAt: Date.now(),
      });
      return res.json({ ok: true, status: "posted", metricoolPostId: result.postId, topic: due.topic });
    } else {
      await db.updateLinkedinPost(due.id, {
        status: "failed",
        errorReason: (result.error ?? "publish failed").slice(0, 2000),
      });
      return res.status(500).json({ ok: false, error: result.error, raw: result.raw });
    }
  } catch (err) {
    const e = err as Error;
    return res.status(500).json({ error: e.message, stack: e.stack });
  }
}
