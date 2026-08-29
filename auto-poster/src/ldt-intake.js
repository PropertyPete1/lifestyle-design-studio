/**
 * ldt-intake.js — candidate selection for the LDT intake folder.
 *
 * The intake folder holds operator-supplied clips (screen recordings of
 * PRIMARY working — compose-card sends, voice turns, THE FLOOR). Unlike the
 * realty city folders there is no 30-day rotation: every clip posts exactly
 * once, oldest first, and a posted clip never reselects (within the log's
 * 365-day retention).
 *
 * Pure functions only — the runner (ldt-main.js) does the I/O. Keeping the
 * selection logic side-effect-free is what lets the tests feed it fixture
 * file lists and logs without touching Drive.
 */

import { getBrandPostedIds, getBrandPostedFileNames, isBlocklisted, validPosts } from "./state.js";
import { chicagoDayOf } from "./brands.js";

const VIDEO_EXT = /\.(mp4|mov|m4v|webm|avi|mkv)$/i;

/**
 * Is this Drive file a video we should consider? mimeType is the primary
 * signal, but phone/desktop sync clients upload .mov as
 * application/octet-stream (the reason listFolderFiles does not filter
 * server-side), so the extension is the second axis.
 */
export function isVideoLike(file) {
  if (!file) return false;
  if (String(file.mimeType || "").startsWith("video/")) return true;
  return VIDEO_EXT.test(String(file.name || ""));
}

/**
 * Order and filter the intake folder into an eligible candidate list.
 *
 * Returns { eligible, skipped } where skipped carries a reason per file so an
 * empty slot can report WHY it was empty (the realty pipeline's "0 eligible"
 * lesson: the tally is what tells Peter which action to take).
 */
export function pickIntakeCandidates(files, log, blocklist, { brandKey = "ldt" } = {}) {
  const postedIds = getBrandPostedIds(log, brandKey);
  const postedNames = getBrandPostedFileNames(log, brandKey);

  const skipped = [];
  const videos = [];
  for (const f of files || []) {
    if (!isVideoLike(f)) {
      skipped.push({ file: f, reason: "not a video" });
      continue;
    }
    if (blocklist && isBlocklisted(blocklist, f.id)) {
      skipped.push({ file: f, reason: "qc-blocklist" });
      continue;
    }
    if (postedIds.has(f.id)) {
      skipped.push({ file: f, reason: "already posted (driveFileId)" });
      continue;
    }
    if (f.name && postedNames.has(f.name)) {
      skipped.push({ file: f, reason: "already posted (fileName — re-upload of posted content)" });
      continue;
    }
    videos.push(f);
  }

  // Oldest first: operator drops clips in over time, and the queue drains in
  // the order they arrived. Files without createdTime sort last.
  const eligible = videos.sort((a, b) => {
    const at = a.createdTime ? new Date(a.createdTime).getTime() : Infinity;
    const bt = b.createdTime ? new Date(b.createdTime).getTime() : Infinity;
    return at - bt;
  });

  return { eligible, skipped };
}

/**
 * Has this brand already posted an entry of this TYPE today (Chicago day)?
 *
 * Per-format-per-day dedup for the self-made lane: the angle is deterministic
 * per DATE, so two same-day posts of the same format would tell the same
 * story in the same clothes — the cadence budget (2/day) and the 3h min-gap
 * both pass at the second slot, and the rotation's no-repeat rule only
 * demotes a kind, it never bans it (a walk whose other generators all fail
 * lands right back on the morning's format). Each format gets at most one
 * post per day; the second slot is for a clip or a DIFFERENT format.
 */
export function hasBrandTypeToday(log, brandKey, type, now = new Date()) {
  const today = chicagoDayOf(now);
  return validPosts(log).some(p =>
    p.brand === brandKey &&
    p.type === type &&
    p.success !== false &&
    chicagoDayOf(p.timestamp) === today);
}
