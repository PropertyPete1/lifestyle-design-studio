/**
 * edit-queue-safety.test.mjs — the two promises this feature is not allowed to break.
 *
 *   1. A SCHEDULED CHECK CANNOT START AN EDIT.
 *   2. NOTHING HERE CHANGES WHAT THE LONG-FORM PIPELINE DOES.
 *
 * Both are asserted structurally rather than behaviourally where that is
 * possible, because a behavioural test proves what happened on one input and a
 * structural one proves what CAN happen on any input. The scan job's import
 * graph is walked to show no renderer is reachable from it at all; the long-form
 * state machine is driven with reels records mixed into its file to show they
 * are invisible to it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  KIND_REEL_EDIT,
  KIND_REEL_REVIEW,
  KIND_TOPIC_PICK,
  KIND_VIDEO_REVIEW,
  KINDS,
  KIND_FAMILY,
  MAX_ENTRIES,
  MAX_REEL_ENTRIES,
  appendRequest,
  capRequests,
  decisionState,
  hasActed,
  latestRequestOfKind,
  markActed,
  recordDecision,
} from "../src/yt-approvals.js";
import { approvedAndUnacted, decidedAndUnacted } from "../src/edit-queue-gates.js";
import { mergeEditQueue, mergeYtApprovals } from "../merge-strategies.mjs";
import { STATUS } from "../src/edit-queue.js";

const SRC = resolve(import.meta.dirname, "..", "src");

// ─── 1. the scheduled check cannot edit ─────────────────────────────────────

/** Every local module reachable from an entry point, followed transitively. */
function importGraph(entry, seen = new Set()) {
  const abs = resolve(entry);
  if (seen.has(abs)) return seen;
  seen.add(abs);
  let source;
  try {
    source = readFileSync(abs, "utf-8");
  } catch {
    return seen;
  }
  // Static `import ... from "./x.js"` and bare `import "./x.js"`. Dynamic
  // import() is checked separately below — a renderer pulled in dynamically
  // would evade this walk, so its absence is asserted rather than assumed.
  for (const m of source.matchAll(/^\s*import\s+(?:[^'"]*?\s+from\s+)?["'](\.[^"']+)["']/gm)) {
    importGraph(join(dirname(abs), m[1]), seen);
  }
  return seen;
}

test("the scan job has no path to a renderer", () => {
  const graph = [...importGraph(join(SRC, "edit-queue-scan.js"))].map((p) => p.replace(`${SRC}/`, ""));

  // The modules that can actually cut or encode a video. If any of these is
  // reachable from the scan, the "a scheduled check never edits" claim is a
  // comment rather than a property.
  const renderers = ["reel-edit.js", "reel-variant.js", "reel-hooks.js", "yt-oncamera-edit.js", "yt-assemble.js"];
  for (const renderer of renderers) {
    assert.equal(
      graph.includes(renderer),
      false,
      `edit-queue-scan.js can reach ${renderer} — the scan must not be able to render anything.\nGraph: ${graph.join(", ")}`
    );
  }
});

test("the scan job contains no dynamic import and no direct ffmpeg call", () => {
  // The import walk above is static, so a dynamic import would be a hole in it.
  const source = readFileSync(join(SRC, "edit-queue-scan.js"), "utf-8");
  assert.equal(/\bimport\s*\(/.test(source), false, "a dynamic import would evade the import-graph check");
  assert.equal(/execFileSync|spawnSync|\bexecSync\b/.test(source), false, "the scan must not be able to shell out to ffmpeg");
});

test("the advance job CAN reach a renderer — the safety test is not vacuous", () => {
  // If this ever fails, the test above has stopped meaning anything: it would
  // be passing because nothing anywhere imports a renderer.
  const graph = [...importGraph(join(SRC, "edit-queue-advance.js"))].map((p) => p.replace(`${SRC}/`, ""));
  assert.ok(graph.includes("reel-edit.js"), "the advance job should be the half that renders");
  assert.ok(graph.includes("yt-oncamera-edit.js"), "the retention edit should be reached, not re-implemented");
});

test("an approval is the only thing that opens the gate", () => {
  const requestId = "reel_edit-2026-08-11-abcd1234";
  let log = appendRequest({ requests: [] }, { requestId, kind: KIND_REEL_EDIT, payload: {} });

  // No decision — a scheduled run finds nothing to do, forever.
  assert.equal(approvedAndUnacted(log, requestId), false, "an undecided card must never start an edit");

  // Things that are NOT an approval.
  for (const decision of ["", "  ", "yes", "approved-ish", "APPROVE_WITH_NOTES", "reject", "skip"]) {
    const l = recordDecision({ requests: [{ requestId, kind: KIND_REEL_EDIT }] }, requestId, { decision });
    assert.equal(approvedAndUnacted(l, requestId), false, `"${decision}" must not read as an approval`);
  }

  // The real thing, in the casings a human-facing dashboard might send.
  for (const decision of ["approve", "Approve", " APPROVE "]) {
    const l = recordDecision({ requests: [{ requestId, kind: KIND_REEL_EDIT }] }, requestId, { decision });
    assert.equal(approvedAndUnacted(l, requestId), true, `"${decision}" should be an approval`);
  }
});

test("a decision is consumed exactly once, however many times the poll runs", () => {
  const requestId = "reel_edit-2026-08-11-abcd1234";
  let log = appendRequest({ requests: [] }, { requestId, kind: KIND_REEL_EDIT, payload: {} });
  log = recordDecision(log, requestId, { decision: "approve" });

  assert.equal(approvedAndUnacted(log, requestId), true);
  log = markActed(log, requestId, { action: "start_edit" });
  assert.equal(approvedAndUnacted(log, requestId), false, "an acted decision must not fire again on the next poll");

  // And a second markActed cannot move the marker — the first action is the one
  // that happened.
  const stamp = log.requests[0].actedAt;
  log = markActed(log, requestId, { action: "start_edit" });
  assert.equal(log.requests[0].actedAt, stamp);
});

test("a decision for an unknown request opens nothing", () => {
  const log = { requests: [{ requestId: "other", kind: KIND_REEL_EDIT, decision: "approve" }] };
  assert.equal(approvedAndUnacted(log, "the-one-we-care-about"), false);
  assert.equal(decidedAndUnacted(log, "the-one-we-care-about"), false);
});

test("a rejection is actionable, an unanswered review card is not", () => {
  const requestId = "reel_review-2026-08-11-abcd1234";
  let log = appendRequest({ requests: [] }, { requestId, kind: KIND_REEL_REVIEW, payload: {} });
  assert.equal(decidedAndUnacted(log, requestId), false, "an unanswered review must not be re-processed every poll");

  log = recordDecision(log, requestId, { decision: "reject", notes: "open wider" });
  assert.equal(decidedAndUnacted(log, requestId), true);
  assert.equal(approvedAndUnacted(log, requestId), false, "a rejection is not an approval");

  log = markActed(log, requestId, { action: "review_decision" });
  assert.equal(decidedAndUnacted(log, requestId), false);
});

test("reject then approve on the SAME card cannot deliver", () => {
  // Peter changes his mind on a card that has already been acted on. The
  // rejection created a new card; this one is spent.
  const requestId = "reel_review-2026-08-11-abcd1234";
  let log = appendRequest({ requests: [] }, { requestId, kind: KIND_REEL_REVIEW, payload: {} });
  log = recordDecision(log, requestId, { decision: "reject", notes: "open wider" });
  log = markActed(log, requestId, { action: "review_decision" });

  // recordDecision refuses to overwrite, so the card stays rejected...
  log = recordDecision(log, requestId, { decision: "approve" });
  assert.equal(log.requests[0].decision, "reject", "a recorded decision must never be flipped");
  // ...and even if it had flipped, the acted latch closes it.
  assert.equal(decidedAndUnacted(log, requestId), false);
  assert.equal(approvedAndUnacted(log, requestId), false);
});

// ─── 2. the long-form pipeline is untouched ─────────────────────────────────

test("reels records are invisible to every long-form lookup", () => {
  const log = {
    requests: [
      { requestId: "topic-1", kind: KIND_TOPIC_PICK, requestedAt: "2026-08-01T00:00:00Z", payload: { candidates: [] } },
      { requestId: "video-1", kind: KIND_VIDEO_REVIEW, requestedAt: "2026-08-02T00:00:00Z", payload: {} },
      // Raised LATER than both, which is what would hijack a "newest wins" read.
      { requestId: "reel-1", kind: KIND_REEL_EDIT, requestedAt: "2026-08-09T00:00:00Z", decision: "approve", payload: {} },
      { requestId: "reel-2", kind: KIND_REEL_REVIEW, requestedAt: "2026-08-10T00:00:00Z", decision: "approve", payload: {} },
    ],
  };

  assert.equal(latestRequestOfKind(log, KIND_TOPIC_PICK).requestId, "topic-1");
  assert.equal(latestRequestOfKind(log, KIND_VIDEO_REVIEW).requestId, "video-1");

  // The whole hazard in one assertion: an approved reel card must not present
  // itself to the long-form pipeline as an approved video review, which would
  // publish a YouTube video off a reels button press.
  assert.equal(decisionState(log, KIND_VIDEO_REVIEW).state, "waiting");
  assert.equal(decisionState(log, KIND_TOPIC_PICK).state, "waiting");
});

test("long-form and reels kinds are distinct, and all four are accepted", () => {
  assert.notEqual(KIND_REEL_EDIT, KIND_VIDEO_REVIEW);
  assert.notEqual(KIND_REEL_REVIEW, KIND_VIDEO_REVIEW);
  assert.notEqual(KIND_REEL_EDIT, KIND_TOPIC_PICK);
  for (const kind of [KIND_TOPIC_PICK, KIND_VIDEO_REVIEW, KIND_REEL_EDIT, KIND_REEL_REVIEW]) {
    assert.ok(KINDS.includes(kind));
    assert.doesNotThrow(() => appendRequest({ requests: [] }, { requestId: `x-${kind}`, kind, payload: {} }));
  }
  assert.throws(() => appendRequest({ requests: [] }, { requestId: "x", kind: "something_else", payload: {} }), /Unknown approval kind/);
});

test("a busy reels queue cannot evict long-form approval history", () => {
  // The concrete hazard: the cap used to be a global slice(-400) over one file
  // that two pipelines now write to. Peter drops videos whenever he likes and
  // each one raises at least two cards; long-form raises two a week.
  const longform = Array.from({ length: 50 }, (_, i) => ({
    requestId: `lf-${i}`,
    kind: i % 2 ? KIND_TOPIC_PICK : KIND_VIDEO_REVIEW,
    requestedAt: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
  }));
  const reels = Array.from({ length: 2000 }, (_, i) => ({
    requestId: `reel-${i}`,
    kind: i % 2 ? KIND_REEL_EDIT : KIND_REEL_REVIEW,
    requestedAt: `2026-08-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
  }));

  const kept = capRequests([...longform, ...reels]);
  const keptLongform = kept.filter((r) => r.kind === KIND_TOPIC_PICK || r.kind === KIND_VIDEO_REVIEW);
  assert.equal(keptLongform.length, 50, "2000 reels cards evicted long-form history");

  const keptReels = kept.filter((r) => r.kind === KIND_REEL_EDIT || r.kind === KIND_REEL_REVIEW);
  assert.equal(keptReels.length, MAX_REEL_ENTRIES, "the reels budget is not being applied");
});

test("the long-form budget itself is unchanged at 400", () => {
  // Strictly increasing stamps. Built from an epoch offset rather than by
  // formatting `i` into a seconds field, which wraps at 60 and would make the
  // fixture's own ordering disagree with its ids.
  const many = Array.from({ length: 500 }, (_, i) => ({
    requestId: `lf-${i}`,
    kind: KIND_TOPIC_PICK,
    requestedAt: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
  }));
  assert.equal(capRequests(many).length, MAX_ENTRIES);
  // And the newest survive, which is what latestRequestOfKind depends on.
  assert.equal(capRequests(many).at(-1).requestId, "lf-499");
});

test("capRequests keeps the array chronological — latestRequestOfKind depends on it", () => {
  const out = capRequests([
    { requestId: "c", kind: KIND_REEL_EDIT, requestedAt: "2026-08-03T00:00:00Z" },
    { requestId: "a", kind: KIND_TOPIC_PICK, requestedAt: "2026-08-01T00:00:00Z" },
    { requestId: "b", kind: KIND_REEL_REVIEW, requestedAt: "2026-08-02T00:00:00Z" },
  ]);
  assert.deepEqual(out.map((r) => r.requestId), ["a", "b", "c"]);
});

test("the retention module's kind strings match the real kind constants", () => {
  // approvals-retention.js repeats the four kind literals rather than importing
  // them, because importing yt-approvals.js would drag `fs` into the pure merge
  // module. That is the right trade and it creates exactly one drift risk,
  // which this closes: a kind renamed in one place and not the other would
  // silently fall into the "other" bucket and share a budget with junk.
  const classified = Object.keys(KIND_FAMILY).sort();
  assert.deepEqual(classified, [...KINDS].sort(), "a kind exists that the retention rule cannot classify");
  assert.equal(KIND_FAMILY[KIND_TOPIC_PICK], "longform");
  assert.equal(KIND_FAMILY[KIND_VIDEO_REVIEW], "longform");
  assert.equal(KIND_FAMILY[KIND_REEL_EDIT], "reels");
  assert.equal(KIND_FAMILY[KIND_REEL_REVIEW], "reels");
});

test("a record of an unknown kind is still retained, not silently deleted", () => {
  // A cap that cannot classify a record must not throw it away — that trades
  // bounded growth for data loss, which is the same trade mergePostedLog
  // explicitly refuses.
  const out = capRequests([{ requestId: "mystery", kind: "from_the_future", requestedAt: "2026-08-01T00:00:00Z" }]);
  assert.equal(out.length, 1);
});

test("the two-writer approvals merge still works with reels records in the file", () => {
  // The dashboard commits a bare array; the poster has the request half.
  const poster = { requests: [{ requestId: "reel-1", kind: KIND_REEL_EDIT, requestedAt: "2026-08-11T00:00:00Z", payload: { fileName: "c.mp4" } }] };
  const dashboard = [{ requestId: "reel-1", decision: "approve", decidedAt: "2026-08-11T01:00:00Z" }];

  const merged = mergeYtApprovals(dashboard, poster, () => {});
  const record = merged.requests.find((r) => r.requestId === "reel-1");
  assert.equal(record.decision, "approve", "the decision was lost");
  assert.equal(record.payload.fileName, "c.mp4", "the request payload was lost");
  assert.equal(record.kind, KIND_REEL_EDIT);
});

test("an acted marker on a reels card survives a dashboard push", () => {
  const poster = { requests: [{ requestId: "reel-1", kind: KIND_REEL_EDIT, requestedAt: "2026-08-11T00:00:00Z", actedAt: "2026-08-11T02:00:00Z", actedAction: "start_edit" }] };
  const dashboard = [{ requestId: "reel-1", decision: "approve", decidedAt: "2026-08-11T01:00:00Z" }];
  const merged = mergeYtApprovals(dashboard, poster, () => {});
  const record = merged.requests.find((r) => r.requestId === "reel-1");
  assert.equal(hasActed(record), true, "losing the acted marker would re-edit on the next poll");
  assert.equal(record.decision, "approve");
});

// ─── the queue merge ────────────────────────────────────────────────────────

test("a concurrent scan does not erase an in-flight edit", () => {
  const scan = { videos: [{ driveFileId: "f1", fileName: "c.mp4", discoveredAt: "2026-08-11T00:00:00Z", status: STATUS.QUEUED, statusAt: "2026-08-11T00:00:00Z", queueRequestId: "q1" }] };
  const advance = { videos: [{ driveFileId: "f1", fileName: "c.mp4", discoveredAt: "2026-08-11T00:00:00Z", status: STATUS.EDITING, statusAt: "2026-08-11T03:00:00Z", queueRequestId: "q1", revision: 1, attempts: [{ revision: 1, startedAt: "2026-08-11T03:00:00Z", finishedAt: null }] }] };

  const merged = mergeEditQueue(advance, scan, () => {});
  assert.equal(merged.videos[0].status, STATUS.EDITING, "the later transition should win");
  assert.equal(merged.videos[0].revision, 1);
  assert.equal(merged.videos[0].attempts.length, 1);
});

test("a rejection can move a record BACKWARDS from in_review to queued", () => {
  // The reason a rank-ordered "furthest along wins" merge would be wrong.
  const stale = { videos: [{ driveFileId: "f1", discoveredAt: "2026-08-11T00:00:00Z", status: STATUS.IN_REVIEW, statusAt: "2026-08-11T03:00:00Z", revision: 1 }] };
  const rework = { videos: [{ driveFileId: "f1", discoveredAt: "2026-08-11T00:00:00Z", status: STATUS.QUEUED, statusAt: "2026-08-11T05:00:00Z", revision: 1, queueRequestId: "q2" }] };
  const merged = mergeEditQueue(rework, stale, () => {});
  assert.equal(merged.videos[0].status, STATUS.QUEUED, "a rework must not be beaten by the copy it superseded");
  assert.equal(merged.videos[0].queueRequestId, "q2");
});

test("a delivery is never downgraded by a concurrent runner", () => {
  const delivered = { videos: [{ driveFileId: "f1", discoveredAt: "2026-08-11T00:00:00Z", status: STATUS.DELIVERED, statusAt: "2026-08-11T03:00:00Z", deliveredAt: "2026-08-11T03:00:00Z" }] };
  const behind = { videos: [{ driveFileId: "f1", discoveredAt: "2026-08-11T00:00:00Z", status: STATUS.IN_REVIEW, statusAt: "2026-08-11T09:00:00Z" }] };
  // Even with a LATER statusAt on the stale side, delivered stands.
  const merged = mergeEditQueue(behind, delivered, () => {});
  assert.equal(merged.videos[0].status, STATUS.DELIVERED, "re-delivering would put a second copy of every variant on the Trial tab");
  assert.equal(merged.videos[0].deliveredAt, "2026-08-11T03:00:00Z");
});

test("the queue merge keeps fields nobody wrote a rule for", () => {
  // mergeVideoRecord became an accidental allowlist and silently dropped every
  // field added after it was written. This one starts with the lesson applied.
  const a = { videos: [{ driveFileId: "f1", discoveredAt: "2026-08-11T00:00:00Z", status: STATUS.QUEUED, statusAt: "2026-08-11T00:00:00Z", somethingNew: "keep me" }] };
  const b = { videos: [{ driveFileId: "f1", discoveredAt: "2026-08-11T00:00:00Z", status: STATUS.QUEUED, statusAt: "2026-08-11T01:00:00Z" }] };
  assert.equal(mergeEditQueue(a, b, () => {}).videos[0].somethingNew, "keep me");
});

test("both cards' ids survive a merge — an orphaned card matches no video", () => {
  const a = { videos: [{ driveFileId: "f1", discoveredAt: "2026-08-11T00:00:00Z", status: STATUS.IN_REVIEW, statusAt: "2026-08-11T02:00:00Z", queueRequestId: "q1", reviewRequestId: "r1" }] };
  const b = { videos: [{ driveFileId: "f1", discoveredAt: "2026-08-11T00:00:00Z", status: STATUS.QUEUED, statusAt: "2026-08-11T00:00:00Z", queueRequestId: "q1" }] };
  const merged = mergeEditQueue(b, a, () => {});
  assert.equal(merged.videos[0].queueRequestId, "q1");
  assert.equal(merged.videos[0].reviewRequestId, "r1");
});

test("attempt history unions rather than choosing a side", () => {
  const a = { videos: [{ driveFileId: "f1", discoveredAt: "2026-08-11T00:00:00Z", status: STATUS.FAILED, statusAt: "2026-08-11T02:00:00Z", attempts: [{ revision: 1, startedAt: "2026-08-11T01:00:00Z", finishedAt: "2026-08-11T02:00:00Z", ok: false }] }] };
  const b = { videos: [{ driveFileId: "f1", discoveredAt: "2026-08-11T00:00:00Z", status: STATUS.IN_REVIEW, statusAt: "2026-08-11T05:00:00Z", attempts: [{ revision: 2, startedAt: "2026-08-11T04:00:00Z", finishedAt: "2026-08-11T05:00:00Z", ok: true }] }] };
  const merged = mergeEditQueue(b, a, () => {});
  assert.equal(merged.videos[0].attempts.length, 2);
  assert.deepEqual(merged.videos[0].attempts.map((x) => x.revision), [1, 2]);
});

test("a finished attempt beats the open copy of itself", () => {
  const open = { videos: [{ driveFileId: "f1", discoveredAt: "2026-08-11T00:00:00Z", status: STATUS.EDITING, statusAt: "2026-08-11T01:00:00Z", attempts: [{ revision: 1, startedAt: "2026-08-11T01:00:00Z", finishedAt: null }] }] };
  const done = { videos: [{ driveFileId: "f1", discoveredAt: "2026-08-11T00:00:00Z", status: STATUS.IN_REVIEW, statusAt: "2026-08-11T02:00:00Z", attempts: [{ revision: 1, startedAt: "2026-08-11T01:00:00Z", finishedAt: "2026-08-11T02:00:00Z", ok: true }] }] };
  const merged = mergeEditQueue(open, done, () => {});
  assert.equal(merged.videos[0].attempts.length, 1);
  assert.equal(merged.videos[0].attempts[0].ok, true);
});
