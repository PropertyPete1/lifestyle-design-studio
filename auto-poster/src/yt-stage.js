/**
 * yt-stage.js — which video a scheduled run should be BUILDING.
 *
 * THE INCIDENT THIS EXISTS FOR (2026-08-31). Video 2's recording kit had been
 * out since Aug 25 (topic_pick-2026-08-17-f60982b7, actedAction
 * "kit_delivered"). Peter recorded all 35 takes on Monday Aug 31 and the
 * dashboard finished uploading them to Drive at 20:40 UTC. Twenty-three
 * minutes EARLIER the Monday brief for video 3 had gone out
 * (topic_pick-2026-08-31-f4a39608): the Aug 17 brief had a decision on it, so
 * the "one unanswered brief at a time" guard did not apply, and a fresh card
 * was raised on top of a video still being recorded.
 *
 * main() keyed its whole stage machine off decisionState(KIND_TOPIC_PICK),
 * which reads the NEWEST topic_pick. The newest was the video 3 brief, it was
 * unanswered, so every one of the next six scheduled runs logged
 * "waiting on Peter — exiting cleanly" and returned before anything looked at
 * the delivered kit. Thirty-five takes sat in Drive for a day, no assembly
 * ran, and every run page was green. The same shape as run 32201677539
 * (see pendingAnsweredReview in yt-approvals.js), one stage earlier.
 *
 * THE PRINCIPLE, STATED ONCE: a kit in flight outranks a question not yet
 * answered. The build stage is keyed off DELIVERED KITS — records the pipeline
 * has already advanced past the topic gate on — and never off whichever brief
 * happens to be newest. A newer gate card cannot block a stage that already
 * passed its own gate.
 *
 * And the braces to that belt: the Monday brief does not open a second topic
 * gate while a video is still being recorded (briefBlockedBy). Two open topic
 * cards is exactly the state the dashboard could not show and the pipeline
 * could not reason about.
 *
 * Pure and dependency-light: yt-approvals.js and yt-log.js only, so `npm test`
 * covers every branch without a runner or a Drive token.
 */

import {
  isTestRequest,
  decisionState,
  hasDecision,
  latestRequestOfKind,
  KIND_TOPIC_PICK,
  KIND_VIDEO_REVIEW,
} from "./yt-approvals.js";
import { findByRequest, isUploaded, videoIdFor } from "./yt-log.js";

/** The acted marker deliverKitForApprovedTopic stamps once a kit is out. */
export const KIT_DELIVERED = "kit_delivered";

/**
 * Every delivered kit, oldest first.
 *
 * "Delivered" is the acted marker AND a script on the record: the build
 * matches recordings against actedResult.script, so a kit_delivered stamp with
 * nothing to match against is not something a run can advance. A re-briefed
 * or superseded topic (acted, but not a kit) is never in this list.
 */
export function deliveredKits(approvals) {
  return (approvals?.requests || [])
    .filter((r) => r && typeof r === "object" && !isTestRequest(r))
    .filter((r) => r.kind === KIND_TOPIC_PICK)
    .filter((r) => r.actedAction === KIT_DELIVERED && Boolean(r.actedResult?.script))
    .sort((a, b) => String(a.requestedAt || "").localeCompare(String(b.requestedAt || "")));
}

/**
 * Is this kit's video still being made?
 *
 * In flight until an upload is logged for the request. A rejected review
 * clears uploadedAt (recordRework in yt-log.js), which puts the video BACK in
 * flight — the same predicate the already-acted branch used before, now
 * stated once.
 */
export function isInflight(record, videoLog) {
  const entry = findByRequest(videoLog, record?.requestId);
  return !entry || !isUploaded(entry);
}

/** Delivered kits whose videos are not uploaded, oldest first. */
export function inflightKits(approvals, videoLog) {
  return deliveredKits(approvals).filter((r) => isInflight(r, videoLog));
}

/**
 * The kit a run should be building from, or null.
 *
 * Oldest first: finish the video that was started first. Two kits in flight
 * at once takes a FORCE=true brief (briefBlockedBy refuses the normal path),
 * so this is almost always a list of one.
 */
export function pendingInflightKit(approvals, videoLog) {
  const kits = inflightKits(approvals, videoLog);
  return kits.length ? kits[0] : null;
}

/**
 * The review gate for ONE video.
 *
 * Scoped by videoId rather than "whichever review is newest": review records
 * carry the videoId they were raised for (appendRequest in the build path),
 * and a review of some other video must not gate this one. A review record
 * that predates the videoId field simply is not found, which reads as "no
 * review" — and buildFromRecordings' own already-uploaded guard makes that the
 * safe direction.
 */
export function reviewGateFor(approvals, record) {
  return decisionState(approvals, KIND_VIDEO_REVIEW, { videoId: videoIdFor(record?.requestId) });
}

/**
 * Why the Monday brief must NOT go out right now, or { blocked: false }.
 *
 *   unanswered  the newest brief has no decision — sending another would
 *               supersede it (latestRequestOfKind takes the newest) and
 *               quietly discard a pick Peter had not got to yet.
 *   inflight    a delivered kit has no upload — a video is being recorded, and
 *               a second topic card on top of it is what shadowed the
 *               2026-08-31 build.
 *
 * FORCE is the caller's business: this only says what is true.
 */
export function briefBlockedBy(approvals, videoLog) {
  const open = decisionState(approvals, KIND_TOPIC_PICK);
  if (open.state === "waiting") return { blocked: true, reason: "unanswered", record: open.record };
  const kit = pendingInflightKit(approvals, videoLog);
  if (kit) return { blocked: true, reason: "inflight", record: kit };
  return { blocked: false };
}

// Re-exported so a caller that only wants "is the newest brief answered" does
// not have to reach past this module for it.
export { hasDecision, latestRequestOfKind };
