/**
 * yt-log.js — youtube-log.json, the record of every long-form video.
 *
 * Three jobs, and the third is the one that matters most:
 *
 *   1. audit — what was made, when, from which footage, scoring what
 *   2. anti-repetition — which B-roll has been spent, so the next video does
 *      not reuse it, and which topics have been covered
 *   3. THE PUBLISH LATCH — whether a video has been uploaded, and whether
 *      Peter approved it. A scheduled job that re-reads this file must be able
 *      to tell "not uploaded yet" from "uploaded, awaiting review" from
 *      "approved" without inferring anything.
 *
 * Reads are defensive and degrade to empty. Empty means "nothing has been
 * uploaded and nothing is approved" — the direction that stalls rather than
 * releases, same as the approvals file.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const YT_LOG_PATH = join(ROOT, "youtube-log.json");

/** Weekly cadence — years of history, and it bounds the file. */
export const MAX_ENTRIES = 200;

/**
 * The only privacy value this system ever writes.
 *
 * Publishing is Peter's action, taken in YouTube Studio, where he also sets the
 * custom thumbnail and the altered-content disclosure that Metricool's API
 * cannot reach. Nothing here flips a video public — see yt-publish.js.
 */
export const PRIVACY = "private";

export function loadLog(path = YT_LOG_PATH) {
  if (!existsSync(path)) return { videos: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (!parsed || !Array.isArray(parsed.videos)) {
      console.warn("[YTLog] youtube-log.json has no videos array — treating as empty");
      return { videos: [] };
    }
    return { ...parsed, videos: parsed.videos.filter(isEntry) };
  } catch (err) {
    console.warn(`[YTLog] youtube-log.json unreadable (${err.message}) — treating as empty`);
    return { videos: [] };
  }
}

export function saveLog(log, path = YT_LOG_PATH) {
  const videos = [...(log?.videos || [])]
    .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")))
    .slice(-MAX_ENTRIES);
  writeFileSync(path, JSON.stringify({ ...log, videos }, null, 2) + "\n");
}

function isEntry(v) {
  return Boolean(v) && typeof v === "object" && typeof v.videoId === "string" && v.videoId.length > 0;
}

/**
 * A videoId is derived from the requestId rather than random.
 *
 * The pipeline is a retrying scheduled job: it can reach the upload step twice
 * for the same request. A derived id means the second run finds the first run's
 * entry instead of creating a duplicate and uploading 320MB again.
 */
export function videoIdFor(requestId) {
  return `vid-${String(requestId || "").replace(/^[a-z_]+-/, "")}`;
}

export function findVideo(log, videoId) {
  return (log?.videos || []).find((v) => v.videoId === videoId) || null;
}

export function findByRequest(log, requestId) {
  return (log?.videos || []).find((v) => v.requestId === requestId) || null;
}

/** Has this video already been uploaded? The guard against a double upload. */
export function isUploaded(entry) {
  return Boolean(entry) && typeof entry.uploadedAt === "string" && entry.uploadedAt.length > 0;
}

/** Did Peter approve it? Nothing downstream may run without this being true. */
export function isApproved(entry) {
  return Boolean(entry) && entry.approved === true;
}

/**
 * Content hashes of every B-roll clip spent on recent videos.
 *
 * Fed to the timeline planner so a new video reaches for fresh footage first.
 * Bounded by `count` because a library of 138 clips cannot avoid everything
 * forever — past a few videos, insisting on novelty would just fail.
 */
export function recentBrollHashes(log, count = 4) {
  const recent = [...(log?.videos || [])]
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, count);
  const hashes = new Set();
  for (const v of recent) {
    for (const h of v.brollHashes || []) hashes.add(h);
  }
  return hashes;
}

/** Titles already made, so the brief does not propose them again. */
export function pastTitles(log) {
  return [...(log?.videos || [])]
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .map((v) => v.title)
    .filter(Boolean);
}

/** Record a video at render time, before anything is uploaded. */
export function recordRender(log, entry) {
  const videoId = entry.videoId;
  if (!videoId) throw new Error("recordRender requires a videoId");
  if (findVideo(log, videoId)) {
    console.warn(`[YTLog] ${videoId} already recorded — not duplicating`);
    return log;
  }
  return {
    ...log,
    videos: [
      ...(log?.videos || []),
      {
        videoId,
        requestId: entry.requestId || null,
        title: entry.title || null,
        // Who fronts this video. Identity stamp only ({id, name, role});
        // null on entries that predate the presenter system, which all read
        // as the owner's.
        presenter: entry.presenter || null,
        market: entry.market || null,
        intent: entry.intent || null,
        createdAt: new Date().toISOString(),
        runtimeSeconds: entry.runtimeSeconds ?? null,
        bytes: entry.bytes ?? null,
        resolution: entry.resolution || null,
        brollHashes: entry.brollHashes || [],
        scriptScores: entry.scriptScores || null,
        packagingScores: entry.packagingScores || null,
        // The thumbnail line shipped with this video, kept so hook style can
        // be correlated with CTR once analytics exist. Null when generation
        // failed and Peter made one by hand in Studio.
        thumbnailText: entry.thumbnailText || null,
        thumbnailScores: entry.thumbnailScores || null,
        // The face composite the contest chose, persisted to Drive so the
        // sweep's thumbnails.set uses the CHOSEN image rather than quietly
        // re-rendering a text-only card after the workDir is gone.
        thumbnailDriveId: entry.thumbnailDriveId || null,
        // The teaser cut from this render, waiting in Drive for the publish
        // flip; the sweep delivers it to the Trial tab.
        teaser: entry.teaser || null,
        // OBSERVED at render time by syntheticNarrationUsed(plan) — the
        // publish step's disclosure decision reads this, and it was silently
        // dropped here (this list is an allowlist) while the call site set
        // it: video 1's entry shipped without it and the disclosure decision
        // fell back to configuration. Evidence beats configuration only if
        // the evidence is actually recorded.
        syntheticNarration: typeof entry.syntheticNarration === "boolean" ? entry.syntheticNarration : null,
        // Never true at render time. Only an explicit approval sets it.
        approved: false,
      },
    ],
  };
}

/**
 * Stamp a video as uploaded. Refuses to re-stamp — the first upload is the one
 * that happened, and overwriting would hide a double upload rather than
 * prevent one.
 */
export function recordUpload(log, videoId, { youtubeUrl, metricoolPostId, blogId, privacy = PRIVACY }) {
  if (privacy !== PRIVACY) {
    throw new Error(`refusing to log an upload with privacy "${privacy}" — this system only uploads ${PRIVACY}`);
  }
  return {
    ...log,
    videos: (log?.videos || []).map((v) => {
      if (v.videoId !== videoId) return v;
      if (isUploaded(v)) {
        console.warn(`[YTLog] ${videoId} was already uploaded at ${v.uploadedAt} — leaving it alone`);
        return v;
      }
      return {
        ...v,
        uploadedAt: new Date().toISOString(),
        privacy: PRIVACY,
        youtubeUrl: youtubeUrl || null,
        metricoolPostId: metricoolPostId || null,
        blogId: blogId || null,
      };
    }),
  };
}


/**
 * Queue a rejected video for a rebuild with the same takes.
 *
 * THE ITERATION LOOP THIS ENABLES: Peter rejects the review card with notes,
 * the edit is adjusted, and the next run rebuilds — same recordings, new
 * render, new review card. Before this existed a rejection was a dead end:
 * the notes were recorded and every later run said "review already recorded —
 * nothing further", which is an archive, not an edit bay.
 *
 * The previous upload is not erased — it moves into `reworks[]` with the
 * rejection notes, so the whole revision history of the video is readable in
 * one entry. `uploadedAt` clearing is what re-opens buildFromRecordings, and
 * `reviewedAt` clearing is what lets the NEXT review card be recorded on the
 * same entry (recordReview refuses to overwrite an existing verdict, which is
 * correct for a final decision and wrong for a superseded one).
 */
export function recordRework(log, videoId, { notes = null } = {}) {
  return {
    ...log,
    videos: (log?.videos || []).map((v) => {
      if (v.videoId !== videoId) return v;
      return {
        ...v,
        reworks: [
          ...(v.reworks || []),
          {
            revision: v.revision || 1,
            uploadedAt: v.uploadedAt || null,
            metricoolPostId: v.metricoolPostId || null,
            youtubeUrl: v.youtubeUrl || null,
            rejectedAt: v.reviewedAt || new Date().toISOString(),
            notes,
          },
        ],
        revision: (v.revision || 1) + 1,
        uploadedAt: null,
        metricoolPostId: null,
        youtubeUrl: null,
        reviewedAt: null,
        reviewNotes: null,
        approved: false,
        // Distribution state belongs to the superseded upload.
        distribution: null,
        youtubeVideoId: null,
      };
    }),
  };
}

/**
 * Record Peter's decision on the finished video.
 *
 * `approved` is only ever set from an explicit approval upstream, and it is
 * never un-set: a video he approved stays approved even if a later run re-reads
 * a stale file.
 */
export function recordReview(log, videoId, { approved, notes = null }) {
  return {
    ...log,
    videos: (log?.videos || []).map((v) => {
      if (v.videoId !== videoId) return v;
      if (v.reviewedAt) {
        console.warn(`[YTLog] ${videoId} was already reviewed at ${v.reviewedAt} — leaving it alone`);
        return v;
      }
      return { ...v, reviewedAt: new Date().toISOString(), approved: approved === true, reviewNotes: notes };
    }),
  };
}

/** Record that the Shorts cutdowns have been made, so they are made once. */
export function recordShorts(log, videoId, shorts) {
  return {
    ...log,
    videos: (log?.videos || []).map((v) =>
      v.videoId === videoId && !v.shortsCutAt
        ? { ...v, shortsCutAt: new Date().toISOString(), shorts: shorts || [] }
        : v
    ),
  };
}
