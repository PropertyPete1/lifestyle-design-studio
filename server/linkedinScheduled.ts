import type { Request, Response } from "express";
import { sdk } from "./_core/sdk";
import { ENV } from "./_core/env";
import * as db from "./db";
import { getCdtPickDate, cdtTimeToUtcMs } from "./selection";
import { generateLinkedinPost } from "./linkedinAuthor";
import { publishLinkedinText, getLinkedinBrands } from "./metricool";
import { chicagoLocalDateTime } from "./scheduledPublish";
import {
  LINKEDIN_BRAND_BLOG_ID,
  LINKEDIN_POST_START_HOUR,
  LINKEDIN_BRAND_STAGGER_MINUTES,
} from "../shared/const";

/** Daily LinkedIn recruiting posts publish at 2 PM CT (first brand). */
const LINKEDIN_POST_HOUR = LINKEDIN_POST_START_HOUR;

type BrandResult = {
  blogId: number;
  label: string;
  ok: boolean;
  postId?: string | null;
  publishAt: string;
  error?: string;
};

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

    // Discover every LinkedIn-connected brand and post the SAME text to each,
    // staggered 30 min apart (2:00, 2:30, 3:00 PM CT ...) so simultaneous
    // identical posts across related company pages don't look automated.
    let brands = await getLinkedinBrands();
    if (brands.length === 0) {
      // Fallback to the known brand if discovery returns nothing.
      brands = [{ blogId: LINKEDIN_BRAND_BLOG_ID, label: "LinkedIn", networks: ["LINKEDIN"] }];
    }

    // Base time: schedule ~90s out so Metricool accepts it, then add the stagger.
    const baseMs = Date.now() + 90_000;
    const staggerMs = LINKEDIN_BRAND_STAGGER_MINUTES * 60_000;

    const results: BrandResult[] = [];
    for (let i = 0; i < brands.length; i++) {
      const brand = brands[i];
      const publishAt = chicagoLocalDateTime(baseMs + i * staggerMs);
      const r = await publishLinkedinText({
        blogId: brand.blogId,
        text: due.body,
        publishAt,
        timezone: "America/Chicago",
        autoPublish: true,
      });
      results.push({
        blogId: brand.blogId,
        label: brand.label,
        ok: r.ok,
        postId: r.postId ? String(r.postId) : null,
        publishAt,
        error: r.ok ? undefined : (r.error ?? "publish failed").slice(0, 500),
      });
    }

    const anyOk = results.some(r => r.ok);
    const allOk = results.every(r => r.ok);
    const firstOk = results.find(r => r.ok);
    const failedLabels = results.filter(r => !r.ok).map(r => r.label);

    await db.updateLinkedinPost(due.id, {
      status: anyOk ? "posted" : "failed",
      metricoolPostId: firstOk?.postId ?? null,
      brandResults: JSON.stringify(results),
      postedAt: anyOk ? Date.now() : null,
      errorReason: allOk
        ? null
        : failedLabels.length
          ? `Failed on: ${failedLabels.join(", ")}`.slice(0, 2000)
          : null,
    });

    if (anyOk) {
      return res.json({
        ok: true,
        status: "posted",
        topic: due.topic,
        brands: results.map(r => ({ label: r.label, ok: r.ok, publishAt: r.publishAt, postId: r.postId })),
        allOk,
      });
    }
    return res.status(500).json({ ok: false, error: "all LinkedIn brands failed", brands: results });
  } catch (err) {
    const e = err as Error;
    return res.status(500).json({ error: e.message, stack: e.stack });
  }
}
