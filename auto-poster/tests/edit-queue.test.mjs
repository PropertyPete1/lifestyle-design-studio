/**
 * edit-queue.test.mjs — the state machine and its refusals.
 *
 * The claims worth arguing with here are all refusals: what the queue will NOT
 * do. A test that only proves the happy path passes on a system that also edits
 * videos nobody asked it to.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ALL_STATUSES,
  EDIT_LEASE_MINUTES,
  MIN_EDITABLE_SECONDS,
  STATUS,
  TEST_PREFIX,
  awaitingReview,
  awaitingStart,
  discover,
  durationOf,
  findVideo,
  finishAttempt,
  isLongEnough,
  isTestFile,
  leaseExpired,
  loadQueue,
  pendingDeliveries,
  looksLikeVideo,
  markDelivered,
  needsQueueCard,
  realVideos,
  reclaimStale,
  saveQueue,
  setStatus,
  startEdit,
  summarise,
  tooShortReason,
} from "../src/edit-queue.js";
import { TEST_REQUEST_PREFIX } from "../src/yt-approvals.js";
import { TEST_PREFIX as DELIVERY_TEST_PREFIX } from "../src/delivery.js";

const NOW = "2026-08-11T12:00:00.000Z";

function driveFile(over = {}) {
  return { id: "f1", name: "clip.mp4", mimeType: "video/mp4", size: "1200000", videoMediaMetadata: { durationMillis: "41200" }, ...over };
}

function queueWith(...videos) {
  return { videos };
}

// ─── discovery ──────────────────────────────────────────────────────────────

test("an empty folder produces an empty queue and no cards", () => {
  const { queue, added, ignored } = discover({ videos: [] }, [], { now: NOW });
  assert.equal(queue.videos.length, 0);
  assert.equal(added.length, 0);
  assert.equal(ignored.length, 0);
  assert.equal(needsQueueCard(queue).length, 0);
});

test("a new video is discovered as queued, never as anything further", () => {
  const { queue, added } = discover({ videos: [] }, [driveFile()], { now: NOW });
  assert.equal(added.length, 1);
  assert.equal(queue.videos[0].status, STATUS.QUEUED);
  assert.equal(queue.videos[0].durationSeconds, 41.2);
  assert.equal(queue.videos[0].revision, 0);
  assert.deepEqual(queue.videos[0].attempts, []);
});

test("a non-video is reported rather than silently dropped", () => {
  const { queue, added, ignored } = discover({ videos: [] }, [driveFile({ name: "notes.pdf", mimeType: "application/pdf" })], { now: NOW });
  assert.equal(added.length, 0);
  assert.equal(queue.videos.length, 0);
  assert.equal(ignored.length, 1);
  assert.match(ignored[0].why, /not a video/);
});

test("a .mov Drive mislabelled as octet-stream is still a video", () => {
  // Phones and desktop sync clients do this constantly. Rejecting it would make
  // the folder look empty to the scan while holding three videos.
  assert.equal(looksLikeVideo({ name: "IMG_0042.mov", mimeType: "application/octet-stream" }), true);
  assert.equal(looksLikeVideo({ name: "IMG_0042.MP4", mimeType: "" }), true);
  assert.equal(looksLikeVideo({ name: "deck.pdf", mimeType: "application/pdf" }), false);
  assert.equal(looksLikeVideo({ name: "Sub folder", mimeType: "application/vnd.google-apps.folder" }), false);
});

test("re-discovering a video already in the queue changes nothing about it", () => {
  for (const status of ALL_STATUSES) {
    const existing = { driveFileId: "f1", fileName: "clip.mp4", status, statusAt: NOW, discoveredAt: NOW, revision: 3 };
    const { queue, added } = discover(queueWith(existing), [driveFile()], { now: "2026-09-01T00:00:00.000Z" });
    assert.equal(added.length, 0, `${status} was re-added`);
    assert.equal(queue.videos.length, 1);
    assert.deepEqual(queue.videos[0], existing, `${status} was mutated by a re-scan`);
  }
});

test("a delivered video is never put back on the dashboard by a later scan", () => {
  const delivered = { driveFileId: "f1", fileName: "clip.mp4", status: STATUS.DELIVERED, statusAt: NOW, discoveredAt: NOW, queueRequestId: "r1" };
  const { queue } = discover(queueWith(delivered), [driveFile()], { now: NOW });
  assert.equal(needsQueueCard(queue).length, 0);
  assert.equal(awaitingStart(queue).length, 0);
});

test("duration missing from Drive is not read as 'too short'", () => {
  // Drive populates videoMediaMetadata ASYNCHRONOUSLY after an upload, so a
  // scan running shortly after Peter drops a file legitimately sees nothing
  // here. Reading that as "too short" would refuse good videos for a reason
  // that has nothing to do with them; reading it as "long enough" lets a
  // 1.5-second clip through to the advance job, which measures the real
  // duration with ffprobe and fails it there. The first live sweep found this
  // exact case — the clip was carded, and the floor that caught it was the
  // second one.
  assert.equal(durationOf({ videoMediaMetadata: {} }), null);
  assert.equal(durationOf({}), null);
  assert.equal(durationOf({ videoMediaMetadata: { durationMillis: "0" } }), null);
  assert.equal(isLongEnough({ durationSeconds: null }), true);
  assert.equal(isLongEnough({ durationSeconds: MIN_EDITABLE_SECONDS - 0.1 }), false);
  assert.equal(isLongEnough({ durationSeconds: MIN_EDITABLE_SECONDS }), true);
});

test("both guards on the too-short floor give Peter the same sentence", () => {
  // The scan reads Drive's metadata and the advance job reads ffprobe. They
  // fire in different jobs and Peter has no idea there are two, so they must
  // not explain themselves differently.
  const short = tooShortReason(1.5, { fileName: "clip.mp4" });
  assert.match(short, /clip\.mp4 is 1\.5s, under the 10s floor/);
  assert.match(short, /re-encode that changes nothing/);
  assert.equal(tooShortReason(MIN_EDITABLE_SECONDS, { fileName: "clip.mp4" }), null);
  assert.equal(tooShortReason(41.2, { fileName: "clip.mp4" }), null);
});

test("an unknown duration is not 'too short' — it is unknown", () => {
  // This is the case the first live sweep hit: Drive had not written the
  // metadata yet. Returning a reason here would refuse good videos; returning
  // null lets the advance job measure the real bytes and decide.
  for (const value of [null, undefined, 0, -1, "", "not a number", NaN]) {
    assert.equal(tooShortReason(value, { fileName: "clip.mp4" }), null, `${String(value)} was read as too short`);
  }
});

// ─── the gate on editing ────────────────────────────────────────────────────

test("startEdit refuses without a decision id", () => {
  const q = queueWith({ driveFileId: "f1", fileName: "c.mp4", status: STATUS.QUEUED, queueRequestId: "card-1", statusAt: NOW });
  const res = startEdit(q, "f1", { now: NOW });
  assert.equal(res.ok, false);
  assert.match(res.reason, /requires the requestId of an approved card/);
  assert.equal(findVideo(res.queue, "f1").status, STATUS.QUEUED);
});

test("startEdit refuses a decision that belongs to a different card", () => {
  // The exact shape of "Peter approved something else and this video moved".
  const q = queueWith({ driveFileId: "f1", fileName: "c.mp4", status: STATUS.QUEUED, queueRequestId: "card-1", statusAt: NOW });
  const res = startEdit(q, "f1", { decidedRequestId: "card-SOMETHING-ELSE", now: NOW });
  assert.equal(res.ok, false);
  assert.match(res.reason, /does not match this video's open card/);
  assert.equal(findVideo(res.queue, "f1").status, STATUS.QUEUED);
});

test("startEdit opens for a matching decision, and bumps the revision", () => {
  const q = queueWith({ driveFileId: "f1", fileName: "c.mp4", status: STATUS.QUEUED, queueRequestId: "card-1", statusAt: NOW, revision: 0, attempts: [] });
  const res = startEdit(q, "f1", { decidedRequestId: "card-1", now: NOW });
  assert.equal(res.ok, true);
  const v = findVideo(res.queue, "f1");
  assert.equal(v.status, STATUS.EDITING);
  assert.equal(v.revision, 1);
  assert.equal(v.attempts.length, 1);
  assert.equal(v.attempts[0].finishedAt, null);
});

test("Start pressed twice cannot start two edits", () => {
  const q = queueWith({ driveFileId: "f1", fileName: "c.mp4", status: STATUS.QUEUED, queueRequestId: "card-1", statusAt: NOW, revision: 0, attempts: [] });
  const first = startEdit(q, "f1", { decidedRequestId: "card-1", now: NOW });
  const second = startEdit(first.queue, "f1", { decidedRequestId: "card-1", now: NOW });
  assert.equal(second.ok, false);
  assert.match(second.reason, /already editing/);
  assert.equal(findVideo(second.queue, "f1").revision, 1, "the second press bumped the revision");
});

test("Start on a delivered video is a refusal, not a second delivery", () => {
  const q = queueWith({ driveFileId: "f1", fileName: "c.mp4", status: STATUS.DELIVERED, queueRequestId: "card-1", statusAt: NOW });
  const res = startEdit(q, "f1", { decidedRequestId: "card-1", now: NOW });
  assert.equal(res.ok, false);
  assert.match(res.reason, /already delivered/);
});

test("an unknown video cannot be edited", () => {
  const res = startEdit(queueWith(), "nope", { decidedRequestId: "card-1", now: NOW });
  assert.equal(res.ok, false);
  assert.match(res.reason, /not in the queue/);
});

// ─── the lease ──────────────────────────────────────────────────────────────

test("a render killed mid-flight is reclaimed as a failure, not retried", () => {
  const started = "2026-08-11T00:00:00.000Z";
  const now = "2026-08-11T12:00:00.000Z"; // 12 hours later
  const q = queueWith({
    driveFileId: "f1", fileName: "c.mp4", status: STATUS.EDITING, statusAt: started,
    queueRequestId: "card-1", revision: 1, attempts: [{ revision: 1, startedAt: started, finishedAt: null, ok: null }],
  });
  assert.equal(leaseExpired(q.videos[0], { now }), true);

  const { queue, reclaimed } = reclaimStale(q, { now });
  assert.deepEqual(reclaimed, ["f1"]);
  const v = findVideo(queue, "f1");
  assert.equal(v.status, STATUS.FAILED, "a dead render must not stay 'editing' forever");
  assert.match(v.failure.reason, /never finished it and its lease has expired/);
  assert.equal(v.attempts[0].finishedAt, now, "the open attempt was closed");
  assert.equal(v.attempts[0].ok, false);
});

test("a live render is not reclaimed out from under itself", () => {
  const started = "2026-08-11T11:59:00.000Z";
  const q = queueWith({ driveFileId: "f1", status: STATUS.EDITING, statusAt: started, attempts: [] });
  const { reclaimed } = reclaimStale(q, { now: NOW });
  assert.deepEqual(reclaimed, []);
  assert.equal(leaseExpired(q.videos[0], { now: NOW, minutes: EDIT_LEASE_MINUTES }), false);
});

test("a record with an unreadable statusAt is treated as expired, not as live forever", () => {
  assert.equal(leaseExpired({ statusAt: "not a date" }, { now: NOW }), true);
  assert.equal(leaseExpired({}, { now: NOW }), true);
});

// ─── outcomes ───────────────────────────────────────────────────────────────

test("a finished edit lands in review with its outputs", () => {
  const q = queueWith({ driveFileId: "f1", status: STATUS.EDITING, statusAt: NOW, revision: 1, attempts: [{ revision: 1, startedAt: NOW, finishedAt: null }] });
  const next = finishAttempt(q, "f1", { ok: true, patch: { master: { link: "https://x" }, variants: [{ label: "A" }] }, now: NOW });
  const v = findVideo(next, "f1");
  assert.equal(v.status, STATUS.IN_REVIEW);
  assert.equal(v.failure, null);
  assert.equal(v.attempts[0].ok, true);
  assert.equal(v.master.link, "https://x");
});

test("a failed edit carries the reason, and the reason survives", () => {
  const q = queueWith({ driveFileId: "f1", status: STATUS.EDITING, statusAt: NOW, revision: 1, attempts: [{ revision: 1, startedAt: NOW, finishedAt: null }] });
  const next = finishAttempt(q, "f1", { ok: false, stage: "render", reason: "ffmpeg died", now: NOW });
  const v = findVideo(next, "f1");
  assert.equal(v.status, STATUS.FAILED);
  assert.equal(v.failure.reason, "ffmpeg died");
  assert.equal(v.failure.stage, "render");
  assert.equal(v.attempts[0].ok, false);
  assert.equal(v.attempts[0].reason, "ffmpeg died");
});

test("setStatus rejects a status that is not one of the five", () => {
  assert.throws(() => setStatus(queueWith({ driveFileId: "f1" }), "f1", "publishing"), /Unknown edit-queue status/);
});

// ─── test artifacts ─────────────────────────────────────────────────────────

test("the TEST- prefix means the same thing in all three modules", () => {
  // Three copies of one literal, each with a comment explaining why it is not
  // imported. The comments are worth nothing if they drift.
  assert.equal(TEST_PREFIX, "TEST-");
  assert.equal(TEST_REQUEST_PREFIX, "TEST-");
  assert.equal(DELIVERY_TEST_PREFIX, "TEST-");
});

test("TEST- videos are tracked but invisible to every real surface", () => {
  const { queue } = discover({ videos: [] }, [driveFile({ name: "TEST-sweep.mp4" }), driveFile({ id: "f2", name: "real.mp4" })], { now: NOW });
  assert.equal(queue.videos.length, 2, "a test file must still be tracked, or every scan re-cards it");
  assert.equal(queue.videos[0].test, true);
  assert.equal(queue.videos[1].test, false);
  assert.deepEqual(realVideos(queue).map((v) => v.fileName), ["real.mp4"]);
  assert.match(summarise(queue), /queued=1/, "the summary counts real videos only");
  assert.equal(isTestFile("TEST-x.mp4"), true);
  assert.equal(isTestFile("x.mp4"), false);
});

// ─── persistence ────────────────────────────────────────────────────────────

test("an unreadable queue file degrades to empty rather than throwing", () => {
  const dir = mkdtempSync(join(tmpdir(), "eq-"));
  try {
    const path = join(dir, "edit-queue.json");
    writeFileSync(path, "{not json");
    assert.deepEqual(loadQueue(path), { videos: [] });

    writeFileSync(path, JSON.stringify({ somethingElse: true }));
    assert.deepEqual(loadQueue(path), { videos: [] });

    assert.deepEqual(loadQueue(join(dir, "missing.json")), { videos: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("records without a driveFileId are dropped on load — they can match nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "eq-"));
  try {
    const path = join(dir, "edit-queue.json");
    writeFileSync(path, JSON.stringify({ videos: [null, { fileName: "orphan.mp4" }, { driveFileId: "f1" }] }));
    const q = loadQueue(path);
    assert.equal(q.videos.length, 1);
    assert.equal(q.videos[0].driveFileId, "f1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a round trip through save/load preserves every field", () => {
  const dir = mkdtempSync(join(tmpdir(), "eq-"));
  try {
    const path = join(dir, "edit-queue.json");
    const record = {
      driveFileId: "f1", fileName: "c.mp4", status: STATUS.IN_REVIEW, statusAt: NOW, discoveredAt: NOW,
      revision: 2, attempts: [{ revision: 2, startedAt: NOW, finishedAt: NOW, ok: true }],
      master: { driveFileId: "m1", link: "https://x" },
      variants: [{ label: "A", hookLine: "a line", link: "https://a" }],
      queueRequestId: "q1", reviewRequestId: "r1", test: false,
    };
    saveQueue({ videos: [record] }, path);
    assert.deepEqual(loadQueue(path).videos[0], record);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── selection ──────────────────────────────────────────────────────────────

test("the selectors pick exactly the records their job should look at", () => {
  const q = queueWith(
    { driveFileId: "a", status: STATUS.QUEUED },
    { driveFileId: "b", status: STATUS.QUEUED, queueRequestId: "q-b" },
    { driveFileId: "c", status: STATUS.EDITING, queueRequestId: "q-c" },
    { driveFileId: "d", status: STATUS.IN_REVIEW, reviewRequestId: "r-d" },
    { driveFileId: "e", status: STATUS.IN_REVIEW },
    { driveFileId: "f", status: STATUS.DELIVERED, reviewRequestId: "r-f" },
    { driveFileId: "g", status: STATUS.FAILED, queueRequestId: "q-g" }
  );
  assert.deepEqual(needsQueueCard(q).map((v) => v.driveFileId), ["a"]);
  assert.deepEqual(awaitingStart(q).map((v) => v.driveFileId), ["b"]);
  assert.deepEqual(awaitingReview(q).map((v) => v.driveFileId), ["d"]);
});

test("a partial delivery is not re-sent when the decision is retried", () => {
  const items = [
    { label: "MASTER", driveFileId: "m" },
    { label: "A", driveFileId: "a" },
    { label: "B", driveFileId: "b" },
    { label: "C", driveFileId: "c" },
  ];

  // Nothing sent yet: everything goes.
  assert.deepEqual(pendingDeliveries({}, items).map((i) => i.label), ["MASTER", "A", "B", "C"]);

  // Crashed after the second: only the rest goes, and the order is preserved.
  assert.deepEqual(
    pendingDeliveries({ deliveredLabels: ["MASTER", "A"] }, items).map((i) => i.label),
    ["B", "C"]
  );

  // Everything already landed: a retry sends nothing at all.
  assert.deepEqual(pendingDeliveries({ deliveredLabels: ["MASTER", "A", "B", "C"] }, items), []);
});

test("an output with no Drive id is never delivered — a link that 404s is worse than a gap", () => {
  const items = [{ label: "MASTER", driveFileId: "m" }, { label: "A" }, null];
  assert.deepEqual(pendingDeliveries({}, items).map((i) => i.label), ["MASTER"]);
});

test("markDelivered is terminal and stamps when", () => {
  const q = queueWith({ driveFileId: "f1", status: STATUS.IN_REVIEW, statusAt: NOW });
  const v = findVideo(markDelivered(q, "f1", { now: NOW }), "f1");
  assert.equal(v.status, STATUS.DELIVERED);
  assert.equal(v.deliveredAt, NOW);
});
