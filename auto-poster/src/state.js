/**
 * State Management — posted-log.json tracking
 * 
 * Stores which videos have been posted and when, committed back to the repo.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_PATH = join(__dirname, "..", "posted-log.json");

/**
 * Load the posted log.
 */
export function loadLog() {
  if (!existsSync(LOG_PATH)) {
    return { posts: [], lastTemplateIndex: -1 };
  }
  try {
    const raw = readFileSync(LOG_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { posts: [], lastTemplateIndex: -1 };
  }
}

/**
 * Save the posted log.
 */
export function saveLog(log) {
  writeFileSync(LOG_PATH, JSON.stringify(log, null, 2) + "\n");
}

/**
 * Check if a video (by Drive file ID) was posted in the last N days.
 */
export function wasPostedRecently(log, driveFileId, days = 30) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return log.posts.some(
    p => p.driveFileId === driveFileId && new Date(p.timestamp).getTime() > cutoff
  );
}

/**
 * Check if there was already a post within the last 20 hours (idempotency guard).
 */
export function hasRecentPost(log, city, hoursAgo = 20) {
  const cutoff = Date.now() - hoursAgo * 60 * 60 * 1000;
  return log.posts.some(
    p => p.city === city && new Date(p.timestamp).getTime() > cutoff
  );
}

/**
 * Record a successful post.
 */
export function recordPost(log, entry) {
  log.posts.push({
    driveFileId: entry.driveFileId,
    fileName: entry.fileName,
    city: entry.city,
    caption: entry.caption.slice(0, 200),
    voiceover: entry.voiceover || false,
    platforms: entry.platforms || ["instagram", "tiktok", "youtube"],
    timestamp: new Date().toISOString(),
    success: entry.success ?? true,
  });

  // Keep only last 365 days of history
  const yearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
  log.posts = log.posts.filter(p => new Date(p.timestamp).getTime() > yearAgo);

  saveLog(log);
}

/**
 * Get all Drive file IDs posted in the last N days for a specific city.
 */
export function getRecentlyPostedIds(log, city, days = 30) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return new Set(
    log.posts
      .filter(p => p.city === city && new Date(p.timestamp).getTime() > cutoff)
      .map(p => p.driveFileId)
  );
}

export { LOG_PATH };
