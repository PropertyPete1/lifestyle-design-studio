/**
 * carousel-state.js — read/write carousel-log.json.
 *
 * The log is both the audit trail and the anti-repetition memory: the last 14
 * topics and hooks are fed back to the writer as "do not resemble" examples.
 *
 * Reads are defensive. A corrupt or missing log must degrade to "no history"
 * rather than killing the run — losing anti-repetition for one day is a much
 * smaller failure than not posting.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CAROUSEL_LOG_PATH = join(ROOT, "carousel-log.json");

/** How many entries to keep. Well past the 14 the writer sees. */
export const MAX_ENTRIES = 120;

export function loadCarouselLog(path = CAROUSEL_LOG_PATH) {
  if (!existsSync(path)) return { posts: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (!parsed || !Array.isArray(parsed.posts)) return { posts: [] };
    return parsed;
  } catch (err) {
    console.warn(`[CarouselState] carousel-log.json unreadable (${err.message}) — treating as empty`);
    return { posts: [] };
  }
}

/** Most recent entries first — the order the writer's anti-examples expect. */
export function recentEntries(log, count = 14) {
  return [...(log.posts || [])]
    .sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")))
    .slice(0, count);
}

/** True when a carousel has already been logged for this Chicago-local date. */
export function alreadyPostedToday(log, dateStr) {
  return (log.posts || []).some((p) => p.date === dateStr);
}

export function appendEntry(log, entry) {
  const posts = [...(log.posts || []), entry];
  // Trim oldest first so the file cannot grow without bound.
  posts.sort((a, b) => String(a.timestamp || "").localeCompare(String(b.timestamp || "")));
  return { ...log, posts: posts.slice(-MAX_ENTRIES) };
}

export function saveCarouselLog(log, path = CAROUSEL_LOG_PATH) {
  writeFileSync(path, JSON.stringify(log, null, 2) + "\n");
}

/** Build the log entry for a completed run. */
export function buildEntry(result, { accent, slideCount, distribution, delivered }) {
  return {
    date: result.date,
    timestamp: new Date().toISOString(),
    pillar: result.pillar,
    topic: result.topic,
    hook: result.hook,
    closeType: result.closeType,
    keyword: result.keyword,
    accent,
    slideCount,
    // The rendered copy, kept so a deck can be re-scored later against a
    // changed critic. Without it the log holds only the hook, which is why the
    // clarity axis could not be back-tested against past runs.
    deck: result.deck,
    scores: result.scores,
    attemptsUsed: result.attemptsUsed,
    regenerated: result.regenerated,
    belowBar: Boolean(result.belowBar),
    criticUnavailable: Boolean(result.criticUnavailable),
    leaksStripped: result.leaksStripped?.length || 0,
    // postId and blogId are recorded so the run can be verified afterwards.
    // Their absence is why 2026-08-03's TikTok failure went unnoticed: the log
    // said ok:true and held nothing to check that claim against.
    distribution: (distribution || []).map((d) => ({
      label: d.label,
      blogId: d.blogId,
      network: d.network,
      ok: Boolean(d.ok),
      postId: d.postId,
      skipped: d.skipped || undefined,
      error: d.error || undefined,
    })),
    deliveredToOwner: Boolean(delivered),
  };
}
