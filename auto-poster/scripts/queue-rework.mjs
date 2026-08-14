#!/usr/bin/env node
/**
 * queue-rework.mjs — supersede the pending review and re-open the build.
 *
 * The reject-with-notes path queues a rework automatically. This script is for
 * the other case: the video needs a rebuild BEFORE Peter has reviewed it — a
 * retrofit landed, a treatment changed — and the review card sitting on his
 * dashboard describes a render that is about to be superseded. Leaving that
 * card live invites approving a version that no longer exists.
 *
 * What it does, in order:
 *   1. marks the waiting video_review acted ("superseded_by_rebuild") so the
 *      stage machine stops waiting on a stale card
 *   2. records a rework on the log entry — the old upload moves into history,
 *      the upload markers clear, and the next run rebuilds with the same takes
 *
 *   node scripts/queue-rework.mjs "graphics retrofit + vertical treatment"
 */

import { loadApprovals, saveApprovals, markActed, decisionState, KIND_VIDEO_REVIEW } from "../src/yt-approvals.js";
import { loadLog, saveLog, recordRework, findByRequest, isUploaded } from "../src/yt-log.js";
import { routeWarnChannel } from "../src/yt-evidence.js";
// The Actions log drops the warn channel entirely (proven on two preserved
// runs) — route it to stdout at every entrypoint. See yt-evidence.js.
routeWarnChannel();

const notes = process.argv.slice(2).join(" ").trim();
if (!notes) {
  console.error('usage: node scripts/queue-rework.mjs "<why the rebuild>"');
  process.exit(1);
}

const approvals = loadApprovals();
const review = decisionState(approvals, KIND_VIDEO_REVIEW);

if (review.state === "none") {
  console.error("no video_review exists — there is nothing to supersede");
  process.exit(1);
}
if (review.state === "approved") {
  console.error(`${review.record.requestId} was APPROVED — refusing to rework an approved video from a script. Reject it through the dashboard if it truly needs rework.`);
  process.exit(1);
}

const videoId = review.record.videoId || review.record.payload?.videoId;
const log = loadLog();
const entry = log.videos.find((v) => v.videoId === videoId);
if (!entry) {
  console.error(`log entry for ${videoId} not found`);
  process.exit(1);
}

if (review.state === "waiting") {
  saveApprovals(markActed(approvals, review.record.requestId, {
    action: "superseded_by_rebuild",
    result: { videoId, notes },
  }));
  console.log(`superseded waiting review ${review.record.requestId}`);
}

if (isUploaded(entry)) {
  saveLog(recordRework(log, videoId, { notes }));
  console.log(`rework queued for ${videoId} (revision ${(entry.revision || 1) + 1}): ${notes}`);
} else {
  console.log(`${videoId} has no live upload — the build gate is already open`);
}

console.log("the next pipeline run rebuilds with the same takes and sends a fresh review card");
