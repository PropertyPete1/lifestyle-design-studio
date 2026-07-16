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
 * Persists all audit fields passed by main.js (voiceover_reason,
 * voiceover_transcript, freshness, mainIgDelivery, deliveryDriveLink, etc.)
 */
export function recordPost(log, entry) {
  // Core fields (always present)
  const record = {
    driveFileId: entry.driveFileId,
    fileName: entry.fileName,
    city: entry.city,
    caption: entry.caption.slice(0, 200),
    voiceover: entry.voiceover || false,
    platforms: entry.platforms || ["instagram", "tiktok", "youtube"],
    timestamp: new Date().toISOString(),
    success: entry.success ?? true,
  };
  // Persist which brands/IG accounts the post reached (audit trail)
  if (entry.brands) record.brands = entry.brands;
  // Persist LinkedIn-specific fields if present
  if (entry.type) record.type = entry.type;
  if (entry.topic) record.topic = entry.topic;

  // Persist all remaining audit fields (voiceover_reason, voiceover_transcript,
  // freshness, mainIgDelivery, deliveryDriveLink, and any future additions)
  const coreKeys = new Set([
    "driveFileId", "fileName", "city", "caption", "voiceover",
    "platforms", "success", "brands", "type", "topic",
  ]);
  for (const [key, value] of Object.entries(entry)) {
    if (!coreKeys.has(key) && value !== undefined && value !== null) {
      record[key] = value;
    }
  }

  log.posts.push(record);

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

// ─── QC Blocklist ────────────────────────────────────────────────────────────

const BLOCKLIST_PATH = join(__dirname, "..", "qc-blocklist.json");

/**
 * Load the QC blocklist.
 */
export function loadBlocklist() {
  if (!existsSync(BLOCKLIST_PATH)) {
    return { blockedDriveIds: {} };
  }
  try {
    const raw = readFileSync(BLOCKLIST_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { blockedDriveIds: {} };
  }
}

/**
 * Save the QC blocklist.
 */
export function saveBlocklist(blocklist) {
  writeFileSync(BLOCKLIST_PATH, JSON.stringify(blocklist, null, 2) + "\n");
}

/**
 * Add a video to the QC blocklist for an inherent failure reason.
 */
export function blocklistVideo(blocklist, driveFileId, filename, reason) {
  blocklist.blockedDriveIds[driveFileId] = {
    filename,
    reason,
    blockedAt: new Date().toISOString(),
  };
  saveBlocklist(blocklist);
}

/**
 * Check if a video is on the QC blocklist.
 */
export function isBlocklisted(blocklist, driveFileId) {
  return !!blocklist.blockedDriveIds[driveFileId];
}

export { LOG_PATH, BLOCKLIST_PATH };
