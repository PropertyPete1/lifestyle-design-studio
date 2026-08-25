/**
 * The stall alarm and the dropped-write recovery.
 *
 * The incident under test: on 2026-08-19 Peter answered a topic card, the
 * dashboard never committed the decision, and every run for a week logged
 * "waiting on Peter" and exited green. These tests defend the three pieces
 * that make that impossible to repeat silently: the 72-hour nudge (with its
 * merge-surviving stamp), the validated manual decision the nudge points at,
 * and the waiting-record list the dashboard reconcile sweep keys off.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  nudgeDue,
  stallNudgeText,
  maybeNudgeStalledRequest,
  waitingRecords,
  STALL_NUDGE_HOURS,
} from "../src/yt-stall-nudge.js";
import {
  applyManualDecision,
  markStallNudged,
  recordDecision,
  KIND_TOPIC_PICK,
  KIND_VIDEO_REVIEW,
} from "../src/yt-approvals.js";
import { mergeYtApprovals } from "../merge-strategies.mjs";

const HOUR = 3600 * 1000;
const NOW = new Date("2026-08-25T12:00:00.000Z");
const hoursAgo = (h) => new Date(NOW - h * HOUR).toISOString();

const topicRecord = (over = {}) => ({
  requestId: "topic_pick-2026-08-17-aaaa1111",
  kind: KIND_TOPIC_PICK,
  requestedAt: hoursAgo(100),
  payload: {
    candidates: [
      { index: 1, title: "Option one" },
      { index: 2, title: "Option two" },
      { index: 3, title: "Option three" },
    ],
  },
  ...over,
});

describe("nudgeDue — the 72-hour clock", () => {
  test("a fresh request is not due", () => {
    assert.equal(nudgeDue(topicRecord({ requestedAt: hoursAgo(1) }), NOW), false);
  });

  test("a request just under the threshold is not due", () => {
    assert.equal(nudgeDue(topicRecord({ requestedAt: hoursAgo(STALL_NUDGE_HOURS - 1) }), NOW), false);
  });

  test("a request past the threshold is due", () => {
    assert.equal(nudgeDue(topicRecord({ requestedAt: hoursAgo(STALL_NUDGE_HOURS + 1) }), NOW), true);
  });

  test("a recent nudge silences it", () => {
    assert.equal(nudgeDue(topicRecord({ stallNudgedAt: hoursAgo(2) }), NOW), false);
  });

  test("a stale nudge re-arms it", () => {
    assert.equal(nudgeDue(topicRecord({ stallNudgedAt: hoursAgo(STALL_NUDGE_HOURS + 2) }), NOW), true);
  });

  test("an unreadable clock degrades to silence, not to a mail per run", () => {
    assert.equal(nudgeDue(topicRecord({ requestedAt: "not-a-date" }), NOW), false);
    assert.equal(nudgeDue(topicRecord({ stallNudgedAt: "not-a-date" }), NOW), false);
    assert.equal(nudgeDue({}, NOW), false);
    assert.equal(nudgeDue(null, NOW), false);
  });
});

describe("stallNudgeText — the mail IS the recovery path", () => {
  test("names the request, the wait, and the record-decision job", () => {
    const { subject, body } = stallNudgeText(topicRecord(), NOW);
    assert.match(subject, /topic_pick-2026-08-17-aaaa1111/);
    assert.match(subject, /4 days/);
    assert.match(body, /record-decision/);
    assert.match(body, /youtube-longform\.yml/);
  });

  test("a topic card asks for the selection; a review card says to skip it", () => {
    const topic = stallNudgeText(topicRecord(), NOW).body;
    assert.match(topic, /selection: the option number/);
    const review = stallNudgeText(
      { requestId: "video_review-x", kind: KIND_VIDEO_REVIEW, requestedAt: hoursAgo(100) },
      NOW
    ).body;
    assert.match(review, /leave selection blank/);
  });
});

describe("maybeNudgeStalledRequest — rides a healthy run, never breaks one", () => {
  test("dry run reports and stamps nothing", async () => {
    const approvals = { requests: [topicRecord()] };
    const out = await maybeNudgeStalledRequest(approvals, approvals.requests[0], { dryRun: true, now: NOW });
    assert.equal(out, approvals);
    assert.equal(out.requests[0].stallNudgedAt, undefined);
  });

  test("a record that is not due is untouched", async () => {
    const approvals = { requests: [topicRecord({ requestedAt: hoursAgo(1) })] };
    const out = await maybeNudgeStalledRequest(approvals, approvals.requests[0], { now: NOW });
    assert.equal(out, approvals);
  });

  test("a send failure never throws and never stamps — the next run is the retry", async () => {
    // The credentials are removed FOR the test, not assumed absent: a
    // developer with GOOGLE_* exported must not mail Peter by running the
    // suite. With no token the send path fails, and the contract is that the
    // caller (a healthy scheduled run) never sees it.
    const saved = {};
    for (const k of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    try {
      const approvals = { requests: [topicRecord()] };
      const out = await maybeNudgeStalledRequest(approvals, approvals.requests[0], { now: NOW });
      assert.equal(out, approvals);
      assert.equal(out.requests[0].stallNudgedAt, undefined);
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
    }
  });
});

describe("the nudge stamp survives the two-writer merge", () => {
  test("a stamp meets a dashboard-side record that lacks it, and lives", () => {
    const poster = { requests: [markStallNudged({ requests: [topicRecord()] }, "topic_pick-2026-08-17-aaaa1111", hoursAgo(1)).requests[0]] };
    const dashboard = [{ requestId: "topic_pick-2026-08-17-aaaa1111", decision: "approve", decidedAt: NOW.toISOString(), selection: 2 }];
    const merged = mergeYtApprovals(poster, dashboard, () => {});
    const rec = merged.requests.find((r) => r.requestId === "topic_pick-2026-08-17-aaaa1111");
    assert.equal(rec.stallNudgedAt, hoursAgo(1), "the poster's stamp was merged away");
    assert.equal(rec.decision, "approve", "the dashboard's decision was merged away");
    assert.equal(rec.selection, 2);
  });

  test("two stamps: the later one wins, because it is when Peter was last reminded", () => {
    const a = { requests: [topicRecord({ stallNudgedAt: hoursAgo(80) })] };
    const b = { requests: [topicRecord({ stallNudgedAt: hoursAgo(2) })] };
    const merged = mergeYtApprovals(a, b, () => {});
    assert.equal(merged.requests[0].stallNudgedAt, hoursAgo(2));
  });
});

describe("applyManualDecision — every typo refused with a reason", () => {
  const log = () => ({ requests: [topicRecord()] });

  test("unknown requestId is refused, not silently no-opped", () => {
    const r = applyManualDecision(log(), { requestId: "topic_pick-typo", decision: "approve", selection: 1 });
    assert.equal(r.ok, false);
    assert.match(r.reason, /no request/);
  });

  test("TEST- fixtures are refused — deciding one built a real kit once", () => {
    const l = { requests: [topicRecord({ requestId: "TEST-topic_pick-x" })] };
    const r = applyManualDecision(l, { requestId: "TEST-topic_pick-x", decision: "approve", selection: 1 });
    assert.equal(r.ok, false);
    assert.match(r.reason, /smoke-test/);
  });

  test("an existing decision is never overwritten", () => {
    const l = { requests: [topicRecord({ decision: "approve", decidedAt: hoursAgo(1), selection: 1 })] };
    const r = applyManualDecision(l, { requestId: "topic_pick-2026-08-17-aaaa1111", decision: "reject" });
    assert.equal(r.ok, false);
    assert.match(r.reason, /already has decision/);
  });

  test("an acted record is refused — nothing is waiting on it", () => {
    const l = { requests: [topicRecord({ actedAt: hoursAgo(1), actedAction: "kit_delivered" })] };
    const r = applyManualDecision(l, { requestId: "topic_pick-2026-08-17-aaaa1111", decision: "approve", selection: 1 });
    assert.equal(r.ok, false);
    assert.match(r.reason, /already acted/);
  });

  test("only approve and reject are decisions", () => {
    for (const word of ["approved", "yes", "", null, "APPROVE_WITH_NOTES"]) {
      const r = applyManualDecision(log(), { requestId: "topic_pick-2026-08-17-aaaa1111", decision: word, selection: 1 });
      assert.equal(r.ok, false, `"${word}" was accepted as a decision`);
    }
  });

  test("a topic approval without a valid selection is the stall this fixes, not one it may write", () => {
    for (const sel of [null, "", "0", "4", "two", 1.5]) {
      const r = applyManualDecision(log(), { requestId: "topic_pick-2026-08-17-aaaa1111", decision: "approve", selection: sel });
      assert.equal(r.ok, false, `selection "${sel}" was accepted`);
      assert.match(r.reason, /selection/);
    }
  });

  test("the happy path writes exactly what the dashboard would have", () => {
    const r = applyManualDecision(log(), { requestId: "topic_pick-2026-08-17-aaaa1111", decision: "Approve", selection: "2" });
    assert.equal(r.ok, true);
    const rec = r.log.requests[0];
    assert.equal(rec.decision, "approve");
    assert.equal(rec.selection, 2);
    assert.equal(rec.notes, null);
    assert.ok(rec.decidedAt);
  });

  test("a rejection carries its notes and needs no selection, even on a topic card", () => {
    const r = applyManualDecision(log(), { requestId: "topic_pick-2026-08-17-aaaa1111", decision: "reject", notes: "  redo with veterans angle  " });
    assert.equal(r.ok, true);
    assert.equal(r.log.requests[0].decision, "reject");
    assert.equal(r.log.requests[0].notes, "redo with veterans angle");
    assert.equal(r.log.requests[0].selection, undefined);
  });

  test("a review decision needs no selection", () => {
    const l = { requests: [{ requestId: "video_review-x", kind: KIND_VIDEO_REVIEW, requestedAt: hoursAgo(90) }] };
    const r = applyManualDecision(l, { requestId: "video_review-x", decision: "approve" });
    assert.equal(r.ok, true);
    assert.equal(r.log.requests[0].selection, undefined);
  });
});

describe("recordDecision carries the selection the merge already protects", () => {
  test("selection is written when given and absent when not", () => {
    const withSel = recordDecision({ requests: [topicRecord()] }, "topic_pick-2026-08-17-aaaa1111", { decision: "approve", selection: 3 });
    assert.equal(withSel.requests[0].selection, 3);
    const without = recordDecision({ requests: [topicRecord()] }, "topic_pick-2026-08-17-aaaa1111", { decision: "reject" });
    assert.ok(!("selection" in without.requests[0]));
  });
});

describe("waitingRecords — what the reconcile sweep must find on the dashboard", () => {
  test("a waiting card past the grace is listed; a decided one is not", () => {
    const approvals = {
      requests: [
        topicRecord(),
        { requestId: "video_review-y", kind: KIND_VIDEO_REVIEW, requestedAt: hoursAgo(50), decision: "approve", decidedAt: hoursAgo(40), actedAt: hoursAgo(39) },
      ],
    };
    const out = waitingRecords(approvals, { now: NOW });
    assert.deepEqual(out.map((r) => r.requestId), ["topic_pick-2026-08-17-aaaa1111"]);
  });

  test("a card inside the grace window is not checked yet — the dashboard needs time to render it", () => {
    const approvals = { requests: [topicRecord({ requestedAt: hoursAgo(1) })] };
    assert.deepEqual(waitingRecords(approvals, { now: NOW }), []);
  });

  test("smoke fixtures are invisible here, like everywhere scheduled", () => {
    const approvals = { requests: [topicRecord({ requestId: "TEST-topic_pick-z" })] };
    assert.deepEqual(waitingRecords(approvals, { now: NOW }), []);
  });
});
