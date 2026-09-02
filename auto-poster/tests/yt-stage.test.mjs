/**
 * The build stage is keyed off DELIVERED KITS, never off the newest brief.
 *
 * The incident under test: on 2026-08-31 video 2's kit (topic_pick-2026-08-17-
 * f60982b7, delivered Aug 25) had all 35 takes uploaded at 20:40 UTC, and the
 * Monday brief for video 3 (topic_pick-2026-08-31-f4a39608) had gone out at
 * 20:17. main() read the newest topic_pick, found it waiting, and exited —
 * six green runs, no assembly. These tests pin the two halves of the fix: a
 * kit in flight outranks a question not yet answered (pendingInflightKit),
 * and the Monday brief will not open a second topic gate over a video still
 * being recorded (briefBlockedBy).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  KIT_DELIVERED,
  deliveredKits,
  isInflight,
  inflightKits,
  pendingInflightKit,
  reviewGateFor,
  briefBlockedBy,
} from "../src/yt-stage.js";
import {
  appendRequest,
  recordDecision,
  markActed,
  decisionState,
  KIND_TOPIC_PICK,
  KIND_VIDEO_REVIEW,
} from "../src/yt-approvals.js";
import { recordRework, videoIdFor } from "../src/yt-log.js";

const KIT_REQUEST = "topic_pick-2026-08-17-f60982b7";
const BRIEF_REQUEST = "topic_pick-2026-08-31-f4a39608";
const KIT_VIDEO = videoIdFor(KIT_REQUEST); // vid-2026-08-17-f60982b7

/** A minimal script — the build matches recordings against actedResult.script. */
const script = () => ({
  title: "Cost of Living in San Antonio: What a $100K Salary Really Covers",
  sections: [{ title: "s1", takes: [{ id: "s1t1", mode: "ON_CAMERA", text: "Before any of it." }] }],
});

/** Stamp a request the way yt-pipeline-main.js does when it delivers a kit. */
function withKit(log, requestId, { requestedAt, actedAt = "2026-08-25T23:31:30.579Z" }) {
  let next = appendRequest(log, { requestId, kind: KIND_TOPIC_PICK, payload: { candidates: [{ index: 1, title: "Cost of living" }] } });
  next = recordDecision(next, requestId, { decision: "approve", selection: 1, decidedAt: "2026-08-25T22:45:00.000Z" });
  next = markActed(next, requestId, {
    action: KIT_DELIVERED,
    result: { selectedIndex: 1, selectedTitle: "Cost of living", folderPath: `YT Recordings/${requestId}`, takeCount: 35, script: script() },
  });
  // appendRequest/markActed stamp "now"; pin the timestamps the incident had.
  return {
    ...next,
    requests: next.requests.map((r) => (r.requestId === requestId ? { ...r, requestedAt, actedAt } : r)),
  };
}

/** The exact shape of yt-approvals.json + youtube-log.json at 2026-09-01 19:38 UTC. */
function incident() {
  let approvals = { requests: [] };
  // Video 1, fully shipped: topic acted, review approved and acted.
  approvals = withKit(approvals, "topic_pick-2026-08-07-d5cddf9d", { requestedAt: "2026-08-07T14:00:00.000Z", actedAt: "2026-08-09T17:12:00.000Z" });
  approvals = appendRequest(approvals, { requestId: "video_review-2026-08-16-87b36f20", kind: KIND_VIDEO_REVIEW, videoId: "vid-2026-08-07-d5cddf9d", payload: {} });
  approvals = recordDecision(approvals, "video_review-2026-08-16-87b36f20", { decision: "approve", decidedAt: "2026-08-19T00:17:14.528Z" });
  approvals = markActed(approvals, "video_review-2026-08-16-87b36f20", { action: "review_recorded", result: { approved: true } });
  // Video 2: the delivered kit, takes in Drive, nothing built.
  approvals = withKit(approvals, KIT_REQUEST, { requestedAt: "2026-08-17T14:23:38.595Z" });
  // Video 3: the Monday brief, sent 23 minutes before the upload finished, unanswered.
  approvals = appendRequest(approvals, { requestId: BRIEF_REQUEST, kind: KIND_TOPIC_PICK, payload: { candidates: [] } });
  approvals = { ...approvals, requests: approvals.requests.map((r) => (r.requestId === BRIEF_REQUEST ? { ...r, requestedAt: "2026-08-31T20:17:56.192Z" } : r)) };

  const videoLog = {
    videos: [
      { videoId: "vid-2026-08-07-d5cddf9d", requestId: "topic_pick-2026-08-07-d5cddf9d", createdAt: "2026-08-09T17:12:48.371Z", uploadedAt: "2026-08-16T01:26:09.099Z", approved: true, revision: 10 },
    ],
  };
  return { approvals, videoLog };
}

describe("the 2026-08-31 shape — a kit in flight outranks a question not yet answered", () => {
  test("the precondition: the newest topic_pick is the unanswered video 3 brief", () => {
    const { approvals } = incident();
    const topic = decisionState(approvals, KIND_TOPIC_PICK);
    assert.equal(topic.state, "waiting", "fixture must reproduce the state every run exited on");
    assert.equal(topic.record.requestId, BRIEF_REQUEST);
  });

  test("the delivered kit is what the run should build, whatever the newest brief is doing", () => {
    const { approvals, videoLog } = incident();
    const kit = pendingInflightKit(approvals, videoLog);
    assert.ok(kit, "the Aug 17 kit must surface");
    assert.equal(kit.requestId, KIT_REQUEST);
    assert.equal(kit.actedAction, KIT_DELIVERED);
    assert.ok(kit.actedResult.script, "the build needs the script on the record");
  });

  test("video 1 is not in flight — it is uploaded and approved", () => {
    const { approvals, videoLog } = incident();
    const ids = inflightKits(approvals, videoLog).map((k) => k.requestId);
    assert.deepEqual(ids, [KIT_REQUEST]);
  });

  test("once video 2 uploads it leaves the in-flight list, and the run has nothing to build", () => {
    const { approvals, videoLog } = incident();
    videoLog.videos.push({ videoId: KIT_VIDEO, requestId: KIT_REQUEST, createdAt: "2026-09-02T00:00:00.000Z", uploadedAt: "2026-09-02T01:00:00.000Z" });
    assert.equal(pendingInflightKit(approvals, videoLog), null);
  });

  test("a rejected review clears the upload and puts the kit BACK in flight — rebuild with the same takes", () => {
    const { approvals, videoLog } = incident();
    videoLog.videos.push({ videoId: KIT_VIDEO, requestId: KIT_REQUEST, createdAt: "2026-09-02T00:00:00.000Z", uploadedAt: "2026-09-02T01:00:00.000Z", reviewedAt: "2026-09-02T02:00:00.000Z" });
    const reworked = recordRework(videoLog, KIT_VIDEO, { notes: "tighten the hook" });
    assert.equal(pendingInflightKit(approvals, reworked)?.requestId, KIT_REQUEST);
  });
});

describe("deliveredKits — what counts as a kit", () => {
  test("acted without a script is not buildable, so it is not a kit", () => {
    let log = { requests: [] };
    log = appendRequest(log, { requestId: "topic_pick-x", kind: KIND_TOPIC_PICK });
    log = markActed(log, "topic_pick-x", { action: KIT_DELIVERED, result: { selectedTitle: "no script here" } });
    assert.deepEqual(deliveredKits(log), []);
  });

  test("a re-briefed or superseded topic (acted, not a kit) is never a kit", () => {
    let log = { requests: [] };
    log = appendRequest(log, { requestId: "topic_pick-old", kind: KIND_TOPIC_PICK });
    log = recordDecision(log, "topic_pick-old", { decision: "reject", notes: "no" });
    log = markActed(log, "topic_pick-old", { action: "rebriefed", result: { replacedBy: "topic_pick-new", script: script() } });
    assert.deepEqual(deliveredKits(log), []);
  });

  test("TEST- kits are invisible, like everywhere scheduled", () => {
    let log = { requests: [] };
    log = withKit(log, "TEST-topic_pick-smoke", { requestedAt: "2026-08-20T00:00:00.000Z" });
    assert.deepEqual(deliveredKits(log), []);
    assert.equal(pendingInflightKit(log, { videos: [] }), null);
  });

  test("review cards and reels cards are not kits", () => {
    let log = { requests: [] };
    log = appendRequest(log, { requestId: "video_review-x", kind: KIND_VIDEO_REVIEW, videoId: "v" });
    log = markActed(log, "video_review-x", { action: KIT_DELIVERED, result: { script: script() } });
    assert.deepEqual(deliveredKits(log), []);
  });

  test("two kits in flight come back oldest first — finish what was started first", () => {
    let log = { requests: [] };
    log = withKit(log, "topic_pick-b", { requestedAt: "2026-08-24T00:00:00.000Z" });
    log = withKit(log, "topic_pick-a", { requestedAt: "2026-08-17T00:00:00.000Z" });
    assert.deepEqual(inflightKits(log, { videos: [] }).map((k) => k.requestId), ["topic_pick-a", "topic_pick-b"]);
    assert.equal(pendingInflightKit(log, { videos: [] }).requestId, "topic_pick-a");
  });

  test("isInflight: no entry, or an entry with no upload", () => {
    const rec = { requestId: "topic_pick-a" };
    assert.equal(isInflight(rec, { videos: [] }), true);
    assert.equal(isInflight(rec, { videos: [{ videoId: "vid-a", requestId: "topic_pick-a" }] }), true);
    assert.equal(isInflight(rec, { videos: [{ videoId: "vid-a", requestId: "topic_pick-a", uploadedAt: "2026-09-01T00:00:00.000Z" }] }), false);
  });
});

describe("reviewGateFor — scoped to the video, not to whichever review is newest", () => {
  test("a waiting review of ANOTHER video does not gate this kit", () => {
    let log = { requests: [] };
    log = withKit(log, "topic_pick-a", { requestedAt: "2026-08-17T00:00:00.000Z" });
    log = appendRequest(log, { requestId: "video_review-other", kind: KIND_VIDEO_REVIEW, videoId: "vid-other" });
    const kit = pendingInflightKit(log, { videos: [] });
    assert.equal(decisionState(log, KIND_VIDEO_REVIEW).state, "waiting", "the unscoped read would have gated it");
    assert.equal(reviewGateFor(log, kit).state, "none");
  });

  test("this video's own recorded rejection is found", () => {
    let log = { requests: [] };
    log = withKit(log, "topic_pick-a", { requestedAt: "2026-08-17T00:00:00.000Z" });
    log = appendRequest(log, { requestId: "video_review-a", kind: KIND_VIDEO_REVIEW, videoId: videoIdFor("topic_pick-a") });
    log = recordDecision(log, "video_review-a", { decision: "reject", notes: "again" });
    log = markActed(log, "video_review-a", { action: "review_recorded", result: { approved: false, reworkQueued: true } });
    const kit = pendingInflightKit(log, { videos: [] });
    assert.equal(reviewGateFor(log, kit).state, "already-acted");
  });
});

describe("briefBlockedBy — one topic gate open at a time", () => {
  test("an unanswered brief blocks, as it always did", () => {
    let log = { requests: [] };
    log = appendRequest(log, { requestId: "topic_pick-open", kind: KIND_TOPIC_PICK });
    const b = briefBlockedBy(log, { videos: [] });
    assert.equal(b.blocked, true);
    assert.equal(b.reason, "unanswered");
    assert.equal(b.record.requestId, "topic_pick-open");
  });

  test("THE 2026-08-31 CASE: the previous brief is answered but its kit has no upload — blocked", () => {
    const { approvals, videoLog } = incident();
    // Rewind to 20:14 UTC on Aug 31: video 3's brief has not been sent yet.
    const before = { requests: approvals.requests.filter((r) => r.requestId !== BRIEF_REQUEST) };
    assert.equal(decisionState(before, KIND_TOPIC_PICK).state, "already-acted", "the old guard saw an answered brief and let the new one out");
    const b = briefBlockedBy(before, videoLog);
    assert.equal(b.blocked, true);
    assert.equal(b.reason, "inflight");
    assert.equal(b.record.requestId, KIT_REQUEST);
  });

  test("once the video is uploaded the next Monday brief may go out", () => {
    const { approvals, videoLog } = incident();
    const before = { requests: approvals.requests.filter((r) => r.requestId !== BRIEF_REQUEST) };
    videoLog.videos.push({ videoId: KIT_VIDEO, requestId: KIT_REQUEST, createdAt: "2026-09-02T00:00:00.000Z", uploadedAt: "2026-09-02T01:00:00.000Z" });
    assert.deepEqual(briefBlockedBy(before, videoLog), { blocked: false });
  });

  test("a superseded (acted, undecided) newest brief is closed, not 'unanswered'", () => {
    let log = { requests: [] };
    log = appendRequest(log, { requestId: "topic_pick-superseded", kind: KIND_TOPIC_PICK });
    log = markActed(log, "topic_pick-superseded", { action: "superseded", result: null });
    assert.deepEqual(briefBlockedBy(log, { videos: [] }), { blocked: false });
  });

  test("nothing sent yet — not blocked", () => {
    assert.deepEqual(briefBlockedBy({ requests: [] }, { videos: [] }), { blocked: false });
  });
});
