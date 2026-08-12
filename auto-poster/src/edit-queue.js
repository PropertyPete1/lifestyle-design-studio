/**
 * edit-queue.js — what is in "Videos To Edit", and how far each one has got.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE: knowing about a video and editing a
 * video are different things, and only Peter moves a video from the first to the
 * second. A scheduled check may discover, describe, card and record a video. It
 * may not start an edit, and it is not merely discouraged from doing so — there
 * is no transition out of `queued` in this module that does not take a
 * requestId whose decision came from the dashboard. See `startEdit`.
 *
 * That is worth being blunt about because the failure would be expensive and
 * quiet: the folder is where Peter drops raw footage he has not decided about
 * yet, so a scan that edits on sight would burn runner minutes and Drive space
 * on takes he was still thinking about, and the first symptom would be a review
 * card for a video he never asked anyone to touch.
 *
 * ─── THE STATE FILE ─────────────────────────────────────────────────────────
 *
 * edit-queue.json, one record per Drive file id:
 *
 *   {
 *     "videos": [{
 *       "driveFileId":  "1Rh...",        // REQUIRED — the match key
 *       "fileName":     "IMG_0042.mov",
 *       "durationSeconds": 41.2,          // from Drive metadata, no download
 *       "discoveredAt": "2026-08-11T...",
 *       "status":       "queued",         // see STATUS below
 *       "statusAt":     "2026-08-11T...", // when status last changed
 *       "test":         false,            // TEST- file: filtered off real surfaces
 *       "queueRequestId":  "reel_edit-...",   // the Start Edit card
 *       "reviewRequestId": "reel_review-...", // the current review card
 *       "revision":     1,
 *       "attempts":     [{ revision, startedAt, finishedAt, ok, reason, notes }],
 *       "master":       { driveFileId, link, fileName },
 *       "variants":     [{ label, hookLine, treatment, driveFileId, link, fileName, caption }],
 *       "failure":      { stage, reason, at },
 *       "deliveredAt":  "2026-08-11T..."
 *     }]
 *   }
 *
 * ─── STATUS ─────────────────────────────────────────────────────────────────
 *
 *   queued     seen in the folder, carded, waiting on Peter. The resting state.
 *   editing    a Start decision was consumed and a render is in flight.
 *   in_review  master + variants are in Drive and the review card has gone out.
 *   delivered  approved; master and variants are on the Trial tab.
 *   failed     something broke. Carries the reason, and always produces a card.
 *
 * The transitions are NOT monotonic, and that is deliberate: a rejection sends
 * `in_review` back to `editing` with Peter's note, which is the same revision
 * loop the long-form pipeline runs. Anything that assumes forward-only progress
 * here (a rank-ordered merge, for one) is wrong — see mergeEditQueue.
 *
 * ─── WHY A SEPARATE FILE FROM yt-approvals.json ─────────────────────────────
 *
 * The card CONVERSATION lives in yt-approvals.json, because that is the file
 * the dashboard writes decisions into and the dashboard is not ours to change.
 * Everything else — the folder's contents, the render history, the Drive ids of
 * eleven output files — lives here, because it is poster-owned data that the
 * dashboard never writes and that would otherwise bloat a file two processes
 * fight over. The two are joined by requestId.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const EDIT_QUEUE_PATH = join(ROOT, "edit-queue.json");

/**
 * The Drive folder Peter drops raw verticals into.
 *
 * A folder id, not a secret — the same class of value as the city folder ids in
 * drive.js and YT_LONGFORM_BROLL_FOLDER in the long-form workflow. Overridable
 * so the sweep can point at a scratch folder without editing code, and so a
 * second tenant can have its own without a fork.
 */
export const VIDEOS_TO_EDIT_FOLDER =
  process.env.EDIT_QUEUE_FOLDER_ID || "1RhTWL35j76bYOVHo_AIO79FvM7oHXyUQ";

export const STATUS = {
  QUEUED: "queued",
  EDITING: "editing",
  IN_REVIEW: "in_review",
  DELIVERED: "delivered",
  FAILED: "failed",
};

export const ALL_STATUSES = Object.values(STATUS);

/**
 * Videos shorter than this are not edited, and the card says why.
 *
 * Not a taste threshold. The edit removes silence and changes framing every
 * ~2.5 seconds; under ten seconds there is neither enough dead air to be worth
 * removing nor room for two framings, so the "edit" would be a re-encode that
 * changes nothing while costing a render, an upload and a review card. Below
 * this the honest answer is "there is nothing here to cut", said out loud.
 */
export const MIN_EDITABLE_SECONDS = 10;

/**
 * How long a render may hold `editing` before another run may take it back.
 *
 * A runner that is cancelled, OOMs, or hits the job timeout mid-ffmpeg leaves
 * the record saying `editing` with nobody editing. Without a lease that record
 * is wedged forever: every later run sees "already in flight" and declines, and
 * the queue silently stops moving with no failure anywhere to notice.
 *
 * Three hours is comfortably longer than the longest plausible render of a
 * phone-length vertical plus its variants (minutes), and comfortably shorter
 * than a working day, so a genuinely dead run is reclaimed before Peter next
 * looks. Reclaiming writes a `failed` record with the reason — it never
 * silently retries, because a run that died mid-render may have died for a
 * reason that will repeat.
 */
export const EDIT_LEASE_MINUTES = 180;

/** Keep the file bounded. One record per video Peter has ever dropped. */
export const MAX_ENTRIES = 500;

/**
 * The marker that keeps sweep artifacts off Peter's real surfaces.
 *
 * Same literal as delivery.js's TEST_PREFIX and yt-approvals.js's
 * TEST_REQUEST_PREFIX, and duplicated here for the same reason delivery.js
 * duplicates it: this module belongs to the reels side and should not import
 * the long-form approvals module to learn one string. The tests assert all
 * three agree, which is the check that actually prevents drift.
 */
export const TEST_PREFIX = "TEST-";

export function isTestFile(name) {
  return String(name ?? "").startsWith(TEST_PREFIX);
}

// ─── load / save ────────────────────────────────────────────────────────────

/**
 * Read the queue. Anything unreadable degrades to empty.
 *
 * Empty means "nothing is in flight and nothing has been approved", which is
 * the safe direction for every caller: the scan re-discovers the folder from
 * Drive (the real source of truth), and the advance job finds nothing to act
 * on. It must never degrade to a state that looks like an approval.
 */
export function loadQueue(path = EDIT_QUEUE_PATH) {
  if (!existsSync(path)) return { videos: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (!parsed || !Array.isArray(parsed.videos)) {
      console.warn("[EditQueue] edit-queue.json is not {videos:[]} — treating as empty");
      return { videos: [] };
    }
    return { ...parsed, videos: parsed.videos.filter(isRecord) };
  } catch (err) {
    console.warn(`[EditQueue] edit-queue.json unreadable (${err.message}) — treating as empty`);
    return { videos: [] };
  }
}

export function saveQueue(queue, path = EDIT_QUEUE_PATH) {
  const videos = [...(queue?.videos || [])]
    .sort((a, b) => String(a.discoveredAt || "").localeCompare(String(b.discoveredAt || "")))
    .slice(-MAX_ENTRIES);
  writeFileSync(path, JSON.stringify({ ...queue, videos }, null, 2) + "\n");
}

function isRecord(v) {
  return Boolean(v) && typeof v === "object" && typeof v.driveFileId === "string" && v.driveFileId.length > 0;
}

export function findVideo(queue, driveFileId) {
  return (queue?.videos || []).find((v) => v.driveFileId === driveFileId) || null;
}

/**
 * Every record a real surface should show.
 *
 * TEST- files are tracked — they have to be, or every scan would re-card the
 * same sweep artifact — but they are invisible here, so a sweep leaves the
 * dashboard, the counts and the reports exactly as it found them.
 */
export function realVideos(queue) {
  return (queue?.videos || []).filter((v) => !v.test);
}

// ─── discovery ──────────────────────────────────────────────────────────────

/**
 * Fold a Drive listing into the queue. Returns the records that are NEW.
 *
 * PURE, and it takes the listing rather than fetching it, because "what does
 * the scan do with what Drive returned" is the part worth arguing with in a
 * test — an empty folder, a folder of PDFs, a video that vanished and came
 * back under a new id.
 *
 * A file already in the queue is left completely alone whatever its status.
 * Re-discovering a delivered video must not re-queue it, or approving one video
 * would put it back on the dashboard forever; and re-discovering one that is
 * `editing` must not reset it mid-render.
 */
export function discover(queue, driveFiles = [], { now = new Date().toISOString() } = {}) {
  const videos = [...(queue?.videos || [])];
  const known = new Set(videos.map((v) => v.driveFileId));
  const added = [];
  const ignored = [];

  for (const file of driveFiles || []) {
    const id = file?.id;
    if (typeof id !== "string" || !id) continue;
    if (known.has(id)) continue;

    // A non-video that reached the listing. The Drive query filters on
    // mimeType, so this is the mislabelled case — a .mov uploaded as
    // application/octet-stream is real and common off an iPhone — and the
    // extension is the second opinion. Anything that is neither is REPORTED
    // rather than dropped: a silently ignored file looks identical to a folder
    // the scan cannot read.
    if (!looksLikeVideo(file)) {
      ignored.push({ id, name: file.name || "(unnamed)", why: `not a video (mimeType ${file.mimeType || "unknown"})` });
      continue;
    }

    const record = {
      driveFileId: id,
      fileName: file.name || id,
      durationSeconds: durationOf(file),
      sizeBytes: Number(file.size) || null,
      discoveredAt: now,
      status: STATUS.QUEUED,
      statusAt: now,
      test: isTestFile(file.name),
      revision: 0,
      attempts: [],
    };
    videos.push(record);
    known.add(id);
    added.push(record);
  }

  return { queue: { ...queue, videos }, added, ignored };
}

/**
 * Is this Drive file a video?
 *
 * Two independent signals, because each one alone has a false negative that
 * costs a real video. The mimeType is authoritative when Drive got it right;
 * phones and desktop sync clients routinely upload .mov and .mp4 as
 * application/octet-stream, and rejecting those would silently ignore exactly
 * the files this folder exists for.
 */
export function looksLikeVideo(file) {
  const mime = String(file?.mimeType || "");
  if (mime.startsWith("video/")) return true;
  if (mime === "application/vnd.google-apps.folder") return false;
  return /\.(mp4|mov|m4v|avi|mkv|webm)$/i.test(String(file?.name || ""));
}

/** Duration in seconds from Drive's own metadata — no download, no ffprobe. */
export function durationOf(file) {
  const ms = Number(file?.videoMediaMetadata?.durationMillis);
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms) / 1000 : null;
}

/**
 * Is this video long enough to be worth editing?
 *
 * `null` duration means Drive did not report one — which happens on a file
 * still processing, or one whose container Drive cannot parse. That is NOT
 * treated as too short: the render measures the real duration with ffprobe
 * anyway, and refusing on missing metadata would drop good videos for a reason
 * that has nothing to do with them.
 */
export function isLongEnough(record, min = MIN_EDITABLE_SECONDS) {
  const seconds = record?.durationSeconds;
  if (seconds === null || seconds === undefined) return true;
  return Number(seconds) >= min;
}

// ─── transitions ────────────────────────────────────────────────────────────

/**
 * Move a record to a new status, recording when.
 *
 * Every transition goes through here so `statusAt` cannot be forgotten — it is
 * what the lease and the merge both read, and a status change that did not
 * update it would be invisible to a concurrent runner.
 */
export function setStatus(queue, driveFileId, status, patch = {}, { now = new Date().toISOString() } = {}) {
  if (!ALL_STATUSES.includes(status)) throw new Error(`Unknown edit-queue status: ${status}`);
  const videos = (queue?.videos || []).map((v) =>
    v.driveFileId === driveFileId ? { ...v, ...patch, status, statusAt: now } : v
  );
  return { ...queue, videos };
}

/**
 * THE ONLY DOOR INTO `editing`, and it will not open without a decision.
 *
 * `decidedRequestId` is not decoration and is not trusted from the caller's
 * intent — the advance job passes the requestId of a card the DASHBOARD
 * recorded an approval against, and this function refuses to move a record that
 * is not carrying that exact id as its open queue card. So the scan job cannot
 * reach `editing` even by calling this function, because it has no decision to
 * pass and no requestId that matches one.
 *
 * Returns { ok, queue, reason }. A refusal is never an exception: the advance
 * job processes several videos in one run and one wedged record must not take
 * the others down with it.
 */
export function startEdit(queue, driveFileId, { decidedRequestId, notes = null, now = new Date().toISOString() } = {}) {
  const record = findVideo(queue, driveFileId);
  if (!record) return { ok: false, queue, reason: `${driveFileId} is not in the queue` };
  if (!decidedRequestId) return { ok: false, queue, reason: "startEdit requires the requestId of an approved card" };
  if (record.queueRequestId !== decidedRequestId) {
    return {
      ok: false,
      queue,
      reason:
        `decision ${decidedRequestId} does not match this video's open card ` +
        `(${record.queueRequestId || "none"}) — refusing to edit on a decision that was not about it`,
    };
  }
  if (record.status === STATUS.EDITING && !leaseExpired(record, { now })) {
    return { ok: false, queue, reason: `already editing since ${record.statusAt}` };
  }
  if (record.status === STATUS.DELIVERED) {
    return { ok: false, queue, reason: "already delivered — a second Start on a delivered video is a no-op" };
  }

  const revision = (Number(record.revision) || 0) + 1;
  const attempts = [...(record.attempts || []), { revision, startedAt: now, finishedAt: null, ok: null, reason: null, notes }];
  return {
    ok: true,
    reason: null,
    queue: setStatus(queue, driveFileId, STATUS.EDITING, { revision, attempts, failure: null }, { now }),
  };
}

/** Has an `editing` record held its lease longer than a render could possibly take? */
export function leaseExpired(record, { now = new Date().toISOString(), minutes = EDIT_LEASE_MINUTES } = {}) {
  const started = Date.parse(record?.statusAt);
  if (Number.isNaN(started)) return true;
  return Date.parse(now) - started > minutes * 60 * 1000;
}

/**
 * Every record whose render died without saying so.
 *
 * Reported as failures rather than retried. A run that was killed mid-ffmpeg
 * may have been killed by the thing it was rendering, and a queue that quietly
 * retries forever is how one bad video eats every runner minute in the account.
 */
export function reclaimStale(queue, { now = new Date().toISOString(), minutes = EDIT_LEASE_MINUTES } = {}) {
  const stale = (queue?.videos || []).filter((v) => v.status === STATUS.EDITING && leaseExpired(v, { now, minutes }));
  let next = queue;
  for (const v of stale) {
    next = finishAttempt(next, v.driveFileId, {
      ok: false,
      stage: "render",
      reason:
        `the run that started this edit at ${v.statusAt} never finished it and its lease has expired ` +
        `(over ${minutes} minutes). The runner was cancelled, timed out, or died mid-render.`,
      now,
    });
  }
  return { queue: next, reclaimed: stale.map((v) => v.driveFileId) };
}

/** Close the open attempt and land on `in_review` or `failed`. */
export function finishAttempt(queue, driveFileId, { ok, reason = null, stage = null, patch = {}, now = new Date().toISOString() } = {}) {
  const record = findVideo(queue, driveFileId);
  if (!record) return queue;
  const attempts = [...(record.attempts || [])];
  for (let i = attempts.length - 1; i >= 0; i--) {
    if (attempts[i] && attempts[i].finishedAt === null) {
      attempts[i] = { ...attempts[i], finishedAt: now, ok: Boolean(ok), reason };
      break;
    }
  }
  return setStatus(
    queue,
    driveFileId,
    ok ? STATUS.IN_REVIEW : STATUS.FAILED,
    { ...patch, attempts, failure: ok ? null : { stage, reason, at: now } },
    { now }
  );
}

/** Approved: the master and its variants are on the Trial tab. */
export function markDelivered(queue, driveFileId, { now = new Date().toISOString() } = {}) {
  return setStatus(queue, driveFileId, STATUS.DELIVERED, { deliveredAt: now }, { now });
}

// ─── selection ──────────────────────────────────────────────────────────────

/** Records the scan should raise a Start card for: queued, no card out yet. */
export function needsQueueCard(queue) {
  return (queue?.videos || []).filter((v) => v.status === STATUS.QUEUED && !v.queueRequestId);
}

/** Records with a live Start card whose decision the advance job should look up. */
export function awaitingStart(queue) {
  return (queue?.videos || []).filter((v) => v.status === STATUS.QUEUED && v.queueRequestId);
}

/** Records with a live review card whose decision the advance job should look up. */
export function awaitingReview(queue) {
  return (queue?.videos || []).filter((v) => v.status === STATUS.IN_REVIEW && v.reviewRequestId);
}

/** A one-line summary for the run page, so a quiet run still says what it saw. */
export function summarise(queue) {
  const counts = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0]));
  for (const v of realVideos(queue)) counts[v.status] = (counts[v.status] || 0) + 1;
  return ALL_STATUSES.map((s) => `${s}=${counts[s]}`).join(" ");
}
