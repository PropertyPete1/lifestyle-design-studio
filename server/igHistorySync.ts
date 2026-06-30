/**
 * Instagram Post History Sync + AI Visual Deduplication
 *
 * Syncs the last 30 days of Instagram posts into ig_post_history,
 * then uses AI vision to check if a candidate video thumbnail shows
 * the same property/development as any recent post.
 *
 * This prevents reposting visually similar content even when post IDs
 * differ (re-edits, reposts of the same property with a new ID).
 */

import { eq } from "drizzle-orm";
import { igPostHistory } from "../drizzle/schema";
import { invokeLLM } from "./_core/llm";
import { getDb } from "./db";

const NO_REPEAT_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface IgPost {
  id: string;
  thumbnail_url?: string;
  media_url?: string;
  caption?: string;
  timestamp: string; // ISO string
}

/**
 * Upsert recent IG posts into ig_post_history.
 * Called by the daily agent before pick generation.
 */
export async function syncIgPostHistory(recentPosts: IgPost[]): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const cutoff = Date.now() - NO_REPEAT_DAYS * DAY_MS;

  for (const post of recentPosts) {
    const postedAt = new Date(post.timestamp).getTime();
    if (postedAt < cutoff) continue; // older than 30 days, skip

    const thumbnailUrl = post.thumbnail_url ?? post.media_url ?? null;
    const captionSnippet = post.caption ? post.caption.slice(0, 500) : null;

    await db
      .insert(igPostHistory)
      .values({
        igPostId: post.id,
        thumbnailUrl,
        captionSnippet,
        postedAt,
      })
      .onDuplicateKeyUpdate({
        set: {
          thumbnailUrl,
          captionSnippet,
          postedAt,
        },
      });
  }
}

/**
 * Get all ig_post_history entries within the last 30 days.
 */
export async function getRecentIgHistory(nowMs: number = Date.now()) {
  const db = await getDb();
  if (!db) return [];
  const cutoff = nowMs - NO_REPEAT_DAYS * DAY_MS;
  const all = await db.select().from(igPostHistory);
  return all.filter(p => p.postedAt >= cutoff);
}

/**
 * AI visual deduplication check.
 *
 * Given a candidate video thumbnail and a list of recent IG post thumbnails,
 * asks the AI vision model whether the candidate shows the same property,
 * development, or location as any of the recent posts.
 *
 * Returns true if the candidate is visually similar to a recent post (should skip),
 * false if it's fresh and safe to pick.
 */
export async function isVisuallyDuplicate(
  candidateThumbnailUrl: string,
  recentPosts: Array<{ igPostId: string; thumbnailUrl: string | null; captionSnippet: string | null; postedAt: number }>,
  candidateCaption?: string | null
): Promise<boolean> {
  if (!recentPosts.length) return false;

  // Build the list of recent post thumbnails for comparison
  const recentWithThumbs = recentPosts.filter(p => p.thumbnailUrl);
  if (!recentWithThumbs.length) return false;

  // Build image content array: candidate first, then recent posts
  const imageContent: Array<{ type: "image_url"; image_url: { url: string; detail: "low" } }> = [
    { type: "image_url", image_url: { url: candidateThumbnailUrl, detail: "low" } },
    ...recentWithThumbs.slice(0, 10).map(p => ({
      type: "image_url" as const,
      image_url: { url: p.thumbnailUrl!, detail: "low" as const },
    })),
  ];

  const captionHint = candidateCaption
    ? `\nCandidate caption hint: "${candidateCaption.slice(0, 200)}"`
    : "";

  const prompt = `You are a real estate content moderation AI. Your job is to detect if a candidate Instagram reel thumbnail shows the same property, housing development, or specific location as any of the recently posted thumbnails.

The FIRST image is the CANDIDATE video thumbnail (the one we want to post).
The REMAINING images (${recentWithThumbs.length}) are thumbnails from posts made in the last 30 days.${captionHint}

Rules:
- "Same" means: same house, same development/community, same specific street corner, same model home, or same recognizable property.
- "Different" means: clearly a different property, different neighborhood, or different development — even if both are in the same city.
- If the candidate is a different angle or edit of the SAME property as a recent post, that counts as "same."
- If you are uncertain, lean toward "different" (do not over-block).

Respond with ONLY a JSON object: {"isDuplicate": true} or {"isDuplicate": false}`;

  try {
    const response = await invokeLLM({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            ...imageContent,
          ],
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "dedup_result",
          strict: true,
          schema: {
            type: "object",
            properties: {
              isDuplicate: { type: "boolean", description: "true if candidate shows same property as a recent post" },
            },
            required: ["isDuplicate"],
            additionalProperties: false,
          },
        },
      },
    });

    const content = response?.choices?.[0]?.message?.content;
    if (!content) return false;
    const parsed = typeof content === "string" ? JSON.parse(content) : content;
    return parsed.isDuplicate === true;
  } catch (err) {
    console.error("[AI Dedup] Vision check failed, defaulting to not-duplicate:", err);
    return false; // fail open: don't block a pick if AI is unavailable
  }
}

/**
 * Update the visual description cache for a post in ig_post_history.
 */
export async function updateVisualDescription(igPostId: string, description: string) {
  const db = await getDb();
  if (!db) return;
  await db
    .update(igPostHistory)
    .set({ visualDescription: description })
    .where(eq(igPostHistory.igPostId, igPostId));
}
