/**
 * State Management — posted-log.json tracking
 *
 * Stores which videos have been posted and when, committed back to the repo.
 *
 * ─── skip-list.json — INTERFACE FOR THE DASHBOARD SKIP BUTTON ────────────────
 *
 * The auto-poster makes only OUTBOUND calls to the dashboard (9 POSTs, 0 reads),
 * so it currently cannot observe a Skip at all. A skipped video therefore stays
 * fully eligible and can be selected again — see issue #7 for the audit.
 *
 * `skip-list.json` is the landing place for that signal. This side is complete:
 * selection already excludes anything listed here, and merge-log-push manages
 * the file so concurrent runners can't lose writes. Nothing is guessed about the
 * dashboard's own behaviour — until the dashboard writes to it the file stays
 * empty and behaviour is unchanged.
 *
 * SCHEMA — a JSON array (not an object), newest-last:
 *
 *   [
 *     {
 *       "driveFileId": "1o3-yTnUY5-21wNwv-EH99sZQz-w20Ecf",  // REQUIRED, the match key
 *       "fileName":    "38AC81FB-0672-47C6-830C-B6EF01D3D044.mp4", // optional, for humans
 *       "skippedAt":   "2026-08-01T20:13:24.511Z",           // optional, ISO 8601
 *       "source":      "dashboard"                            // optional, who skipped it
 *     }
 *   ]
 *
 * Only `driveFileId` is load-bearing. Entries missing it are ignored rather than
 * throwing, so a partially-written file can never take down a posting run.
 *
 * To integrate: append an entry when Skip is pressed and commit the file. The
 * union merge in merge-log-push.mjs means a concurrent auto-poster run will not
 * clobber it.
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
 * Every readable entry in a log, defensively.
 *
 * posted-log.json is merged by an external script and can in principle be hand
 * edited, so a `null` or non-object element is possible. Dereferencing one threw
 * out of hasRecentPost — the FIRST guard every run touches — which turned a data
 * blemish into a dead slot. Every reader funnels through here instead.
 */
export function validPosts(log) {
  const posts = log?.posts;
  if (!Array.isArray(posts)) return [];
  return posts.filter(p => p && typeof p === "object");
}

/**
 * Check if a video (by Drive file ID) was posted in the last N days.
 */
export function wasPostedRecently(log, driveFileId, days = 30) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return validPosts(log).some(
    p => p.driveFileId === driveFileId && new Date(p.timestamp).getTime() > cutoff
  );
}

/**
 * Check if there was already a post within the last 20 hours (slot-aware idempotency guard).
 *
 * Two rules:
 * 1. Block if same city + same slot posted within 20h.
 * 2. Hard cooldown: block if same city posted within 2h regardless of slot
 *    (protects against delayed/overlapping runs).
 *
 * Old log entries without a slot field are treated as "pm".
 * Returns { blocked: boolean, reason?: string }.
 */
export function hasRecentPost(log, city, slot, hoursAgo = 20) {
  const slotCutoff = Date.now() - hoursAgo * 60 * 60 * 1000;
  const hardCooldown = Date.now() - 2 * 60 * 60 * 1000;

  for (const p of validPosts(log)) {
    if (p.city !== city) continue;
    if (p.type === "linkedin") continue; // LinkedIn entries don't count as video posts
    if (p.platform === "instagram_main_native") continue; // Manual-confirm receipts are not slot posts
    if (p.type === "trial_variant" || p.type === "trial_variant_confirm") continue; // Trial variants are separate from slot posts
    const ts = new Date(p.timestamp).getTime();

    // Hard cooldown: same city within 2h regardless of slot
    if (ts > hardCooldown) {
      return { blocked: true, reason: `hard-cooldown (${city} posted within 2h)` };
    }
    // Slot guard: same city + same slot within 20h
    const entrySlot = p.slot || "pm"; // Legacy entries default to "pm"
    if (entrySlot === slot && ts > slotCutoff) {
      return { blocked: true, reason: `already posted for ${city} slot ${slot} in the last ${hoursAgo} hours` };
    }
  }
  return { blocked: false };
}

/**
 * Has a LinkedIn recruiting post gone out within the last N hours?
 *
 * Pure and exported so both callers can share it AND so the rule can be tested
 * without a network: main.js asks this of its own in-memory log as a free early
 * skip, and claimLinkedinSlot (src/linkedin-claim.js) asks it of the LIVE log
 * it is about to compare-and-swap against. The claim is the call that matters —
 * a checkout is pinned to the SHA the run was created at, so the in-memory
 * answer is not trustworthy when the primary and backup crons overlap.
 *
 * A claim entry ({type:"linkedin", status:"claimed"}) counts as a post here,
 * ON PURPOSE: the slot is taken from the moment the claim lands, not from the
 * moment Metricool answers.
 *
 * Duplicates on 2026-08-05 through 08-09 are what this is guarding: same topic,
 * twice a day for five days, on three real LinkedIn accounts.
 */
export function hasRecentLinkedinPost(log, hoursAgo = 20) {
  const cutoff = Date.now() - hoursAgo * 60 * 60 * 1000;
  return validPosts(log).some(
    p => p.type === "linkedin" && new Date(p.timestamp).getTime() > cutoff
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
  log.posts = validPosts(log).filter(p => new Date(p.timestamp).getTime() > yearAgo);

  saveLog(log);
}

/**
 * Get all Drive file IDs posted in the last N days for a specific city.
 */
export function getRecentlyPostedIds(log, city, days = 30) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return new Set(
    validPosts(log)
      .filter(p => p.city === city && new Date(p.timestamp).getTime() > cutoff)
      .map(p => p.driveFileId)
  );
}

/**
 * Get all fileNames posted in the last N days for a specific city.
 * This catches re-uploaded files that have a new driveFileId but same content.
 */
export function getRecentlyPostedFileNames(log, city, days = 30) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return new Set(
    validPosts(log)
      .filter(p => p.city === city && p.fileName && new Date(p.timestamp).getTime() > cutoff)
      .map(p => p.fileName)
  );
}

/**
 * Get all Drive file IDs posted in the last N days across EVERY city.
 *
 * The per-city variants above are not sufficient on their own: all three city
 * runs fan out to the SAME Metricool brands / IG accounts, so the same video
 * living in two city folders can be published twice inside the 30-day window
 * with each city's guard individually satisfied. From Instagram's perspective
 * that is a repost of identical content to the same account.
 */
export function getRecentlyPostedIdsAllCities(log, days = 30) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return new Set(
    validPosts(log)
      .filter(p => p.driveFileId && new Date(p.timestamp).getTime() > cutoff)
      .map(p => p.driveFileId)
  );
}

/**
 * Get all fileNames posted in the last N days across EVERY city.
 * Catches the same video re-uploaded under a new driveFileId in a different
 * city folder. See getRecentlyPostedIdsAllCities for why city scope is unsafe.
 */
export function getRecentlyPostedFileNamesAllCities(log, days = 30) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return new Set(
    validPosts(log)
      .filter(p => p.fileName && new Date(p.timestamp).getTime() > cutoff)
      .map(p => p.fileName)
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

// ─── Skip list ───────────────────────────────────────────────────────────────
// Schema documented in the module header above.

const SKIP_LIST_PATH = join(__dirname, "..", "skip-list.json");

/**
 * Load the skip list. Always returns an array — a missing, empty, malformed or
 * wrong-shaped file degrades to "nothing skipped" rather than throwing, because
 * this file is written by an external system.
 */
export function loadSkipList() {
  if (!existsSync(SKIP_LIST_PATH)) return [];
  try {
    const parsed = JSON.parse(readFileSync(SKIP_LIST_PATH, "utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Set of skipped Drive file IDs. Entries without a driveFileId are ignored. */
export function getSkippedDriveIds(skipList) {
  const ids = new Set();
  for (const entry of skipList || []) {
    if (entry && typeof entry.driveFileId === "string" && entry.driveFileId) {
      ids.add(entry.driveFileId);
    }
  }
  return ids;
}

/** Is this video on the skip list? */
export function isSkipped(skipList, driveFileId) {
  if (!driveFileId) return false;
  return getSkippedDriveIds(skipList).has(driveFileId);
}

export { LOG_PATH, BLOCKLIST_PATH, SKIP_LIST_PATH };
