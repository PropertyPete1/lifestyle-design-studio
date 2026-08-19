/**
 * The approval gate.
 *
 * Everything here defends one sentence from the spec: publish ONLY on an
 * explicit approve decision. The interesting tests are not the happy path —
 * they are all the ways something that is not an approval could be mistaken
 * for one, and the ways an already-published request could be published twice.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadApprovals,
  normaliseApprovals,
  saveApprovals,
  appendRequest,
  markActed,
  recordDecision,
  decisionState,
  pendingAnsweredReview,
  isApproved,
  hasDecision,
  hasActed,
  latestRequestOfKind,
  regenerationNotes,
  newRequestId,
  KIND_TOPIC_PICK,
  KIND_VIDEO_REVIEW,
  isTestRequest,
} from "../src/yt-approvals.js";

const quiet = { warn: console.warn };

function req(overrides = {}) {
  return {
    requestId: "topic_pick-2026-08-10-abcd1234",
    kind: KIND_TOPIC_PICK,
    requestedAt: "2026-08-10T14:00:00.000Z",
    payload: { candidates: [] },
    ...overrides,
  };
}

describe("isApproved — only an explicit approval publishes", () => {
  test("exactly 'approve' approves", () => {
    assert.equal(isApproved({ decision: "approve" }), true);
  });

  test("tolerates the casing and padding a human-facing dashboard might send", () => {
    for (const d of ["Approve", "APPROVE", " approve ", "\tApprove\n"]) {
      assert.equal(isApproved({ decision: d }), true, `${JSON.stringify(d)} should approve`);
    }
  });

  test("does NOT approve on anything else, however approving it looks", () => {
    const notApprovals = [
      "approved", "approves", "yes", "ok", "APPROVE_WITH_NOTES", "approve-with-changes",
      "reject", "revise", "", "   ", "pending", "true",
    ];
    for (const d of notApprovals) {
      assert.equal(isApproved({ decision: d }), false, `${JSON.stringify(d)} must NOT approve`);
    }
  });

  test("does NOT approve on non-string truthy values", () => {
    for (const d of [true, 1, {}, [], { decision: "approve" }]) {
      assert.equal(isApproved({ decision: d }), false, `${JSON.stringify(d)} must NOT approve`);
    }
  });

  test("a missing record is not an approval", () => {
    assert.equal(isApproved(null), false);
    assert.equal(isApproved(undefined), false);
    assert.equal(isApproved({}), false);
  });
});

describe("hasDecision — a half-written row is not an answer", () => {
  test("decidedAt without a decision does not count", () => {
    assert.equal(hasDecision({ decidedAt: "2026-08-12T00:00:00.000Z" }), false);
  });

  test("a whitespace-only decision does not count", () => {
    assert.equal(hasDecision({ decision: "   " }), false);
  });

  test("a real decision counts even when it is a rejection", () => {
    assert.equal(hasDecision({ decision: "revise" }), true);
  });
});

describe("decisionState — what a scheduled job should do", () => {
  test("nothing requested yet", () => {
    assert.equal(decisionState({ requests: [] }, KIND_TOPIC_PICK).state, "none");
  });

  test("requested but undecided means WAIT, not proceed", () => {
    const log = { requests: [req()] };
    assert.equal(decisionState(log, KIND_TOPIC_PICK).state, "waiting");
  });

  test("an approval that has not been acted on is actionable", () => {
    const log = { requests: [req({ decision: "approve", decidedAt: "2026-08-11T00:00:00.000Z" })] };
    assert.equal(decisionState(log, KIND_TOPIC_PICK).state, "approved");
  });

  test("an approval already acted on is NOT actionable again", () => {
    const log = {
      requests: [req({
        decision: "approve",
        decidedAt: "2026-08-11T00:00:00.000Z",
        actedAt: "2026-08-11T01:00:00.000Z",
      })],
    };
    assert.equal(decisionState(log, KIND_TOPIC_PICK).state, "already-acted");
  });

  test("a rejection carries its notes through as regeneration guidance", () => {
    const log = {
      requests: [req({ decision: "revise", notes: "hook is too soft, lead with the payment gap" })],
    };
    const s = decisionState(log, KIND_TOPIC_PICK);
    assert.equal(s.state, "rejected");
    assert.equal(s.notes, "hook is too soft, lead with the payment gap");
  });

  test("a rejection with no notes still rejects", () => {
    const log = { requests: [req({ decision: "reject" })] };
    const s = decisionState(log, KIND_TOPIC_PICK);
    assert.equal(s.state, "rejected");
    assert.equal(s.notes, null);
  });

  test("one kind's decision never answers another kind's question", () => {
    const log = { requests: [req({ decision: "approve", decidedAt: "2026-08-11T00:00:00.000Z" })] };
    assert.equal(decisionState(log, KIND_VIDEO_REVIEW).state, "none");
  });

  test("a video_review is scoped to its own video", () => {
    const log = {
      requests: [
        req({ requestId: "vr-1", kind: KIND_VIDEO_REVIEW, videoId: "vid-a", decision: "approve", decidedAt: "2026-08-11T00:00:00.000Z" }),
      ],
    };
    assert.equal(decisionState(log, KIND_VIDEO_REVIEW, { videoId: "vid-a" }).state, "approved");
    // Last week's approval must not release this week's video.
    assert.equal(decisionState(log, KIND_VIDEO_REVIEW, { videoId: "vid-b" }).state, "none");
  });
});

describe("latestRequestOfKind — a stale unanswered brief must not wedge the next one", () => {
  test("the newest request wins even when an older one is still unanswered", () => {
    const log = {
      requests: [
        req({ requestId: "old", requestedAt: "2026-08-03T14:00:00.000Z" }),
        req({ requestId: "new", requestedAt: "2026-08-10T14:00:00.000Z" }),
      ],
    };
    assert.equal(latestRequestOfKind(log, KIND_TOPIC_PICK).requestId, "new");
  });

  test("ordering does not depend on array order", () => {
    const log = {
      requests: [
        req({ requestId: "new", requestedAt: "2026-08-10T14:00:00.000Z" }),
        req({ requestId: "old", requestedAt: "2026-08-03T14:00:00.000Z" }),
      ],
    };
    assert.equal(latestRequestOfKind(log, KIND_TOPIC_PICK).requestId, "new");
  });
});

describe("markActed — the idempotency latch", () => {
  test("stamps an unstamped record", () => {
    const log = { requests: [req({ decision: "approve" })] };
    const after = markActed(log, log.requests[0].requestId, { action: "published" });
    assert.ok(hasActed(after.requests[0]));
    assert.equal(after.requests[0].actedAction, "published");
  });

  test("REFUSES to re-stamp — the first action is the one that happened", () => {
    const first = "2026-08-11T01:00:00.000Z";
    const log = { requests: [req({ decision: "approve", actedAt: first, actedAction: "published" })] };
    const after = markActed(log, log.requests[0].requestId, { action: "published-again" });
    assert.equal(after.requests[0].actedAt, first);
    assert.equal(after.requests[0].actedAction, "published");
  });

  test("acting twice in a row cannot publish twice", () => {
    let log = { requests: [req({ decision: "approve", decidedAt: "2026-08-11T00:00:00.000Z" })] };
    const id = log.requests[0].requestId;

    // Run 1 sees an actionable approval and acts.
    assert.equal(decisionState(log, KIND_TOPIC_PICK).state, "approved");
    log = markActed(log, id, { action: "published" });

    // Run 2, on the next schedule, sees the same approved decision.
    assert.equal(decisionState(log, KIND_TOPIC_PICK).state, "already-acted");
  });

  test("leaves other records alone", () => {
    const log = { requests: [req({ requestId: "a" }), req({ requestId: "b" })] };
    const after = markActed(log, "a", { action: "x" });
    assert.equal(hasActed(after.requests[1]), false);
  });
});

describe("recordDecision — never overwrite Peter's answer", () => {
  test("records a first decision", () => {
    const log = { requests: [req()] };
    const after = recordDecision(log, log.requests[0].requestId, { decision: "approve" });
    assert.equal(after.requests[0].decision, "approve");
  });

  test("refuses to overwrite an existing decision", () => {
    const log = { requests: [req({ decision: "reject", notes: "no" })] };
    const after = recordDecision(log, log.requests[0].requestId, { decision: "approve" });
    assert.equal(after.requests[0].decision, "reject");
  });
});

describe("appendRequest", () => {
  test("rejects an unknown kind rather than writing a record nothing will read", () => {
    assert.throws(() => appendRequest({ requests: [] }, { requestId: "x", kind: "nonsense" }));
  });

  test("does not duplicate a requestId", () => {
    let log = appendRequest({ requests: [] }, { requestId: "x", kind: KIND_TOPIC_PICK, payload: {} });
    log = appendRequest(log, { requestId: "x", kind: KIND_TOPIC_PICK, payload: {} });
    assert.equal(log.requests.length, 1);
  });

  test("generated ids are unique and carry their kind", () => {
    const a = newRequestId(KIND_VIDEO_REVIEW);
    const b = newRequestId(KIND_VIDEO_REVIEW);
    assert.notEqual(a, b);
    assert.ok(a.startsWith(KIND_VIDEO_REVIEW));
  });
});

describe("regenerationNotes", () => {
  test("blank notes are no notes", () => {
    assert.equal(regenerationNotes({ notes: "   " }), null);
    assert.equal(regenerationNotes({}), null);
    assert.equal(regenerationNotes({ notes: 42 }), null);
  });
});

describe("loadApprovals — an unreadable file must stall, never release", () => {
  function tmpFile(contents) {
    const dir = mkdtempSync(join(tmpdir(), "yt-approvals-"));
    const path = join(dir, "yt-approvals.json");
    writeFileSync(path, contents);
    return path;
  }

  test("a missing file reads as empty", () => {
    assert.deepEqual(loadApprovals(join(tmpdir(), "definitely-not-here-9f3a.json")), { requests: [] });
  });

  test("corrupt JSON reads as empty, and empty approves nothing", () => {
    const log = loadApprovals(tmpFile("{ not json"));
    assert.deepEqual(log, { requests: [] });
    assert.equal(decisionState(log, KIND_TOPIC_PICK).state, "none");
  });

  test("a file with no requests array reads as empty", () => {
    assert.deepEqual(loadApprovals(tmpFile('{"somethingElse": 1}')), { requests: [] });
  });

  test("entries without a requestId are dropped rather than throwing", () => {
    const log = loadApprovals(tmpFile(JSON.stringify({ requests: [{ decision: "approve" }, req()] })));
    assert.equal(log.requests.length, 1);
  });

  test("round-trips through save and load", () => {
    const path = tmpFile("{}");
    const log = appendRequest({ requests: [] }, { requestId: "r1", kind: KIND_TOPIC_PICK, payload: { a: 1 } });
    saveApprovals(log, path);
    assert.equal(loadApprovals(path).requests[0].payload.a, 1);
  });
});

describe("the dashboard writes a BARE ARRAY — found on the first live round-trip", () => {
  // The deployed dashboard commits [{ requestId, decision, decidedAt, selection }],
  // replacing the whole file. The request half — kind, requestedAt, and the
  // payload holding the candidates — vanishes from HEAD.
  const DASHBOARD_WRITE = [
    {
      requestId: "topic_pick-2026-08-06-db587860",
      decision: "approve",
      decidedAt: "2026-08-06T03:40:18.246Z",
      selection: 2,
    },
  ];

  test("normaliseApprovals accepts the bare array", () => {
    const n = normaliseApprovals(DASHBOARD_WRITE);
    assert.equal(n.requests.length, 1);
    assert.equal(n.requests[0].selection, 2);
  });

  test("normaliseApprovals still accepts the poster's own shape", () => {
    const n = normaliseApprovals({ requests: [req()] });
    assert.equal(n.requests.length, 1);
  });

  test("anything else is rejected, so a corrupt file still stalls", () => {
    assert.equal(normaliseApprovals({ nope: 1 }), null);
    assert.equal(normaliseApprovals("string"), null);
    assert.equal(normaliseApprovals(null), null);
  });

  test("a decision-only record cannot answer for a kind it does not name", () => {
    // It has no `kind`, so on its own it is not a topic_pick decision. This is
    // why the request half has to be merged back in rather than relied on alone.
    const log = normaliseApprovals(DASHBOARD_WRITE);
    assert.equal(decisionState(log, KIND_TOPIC_PICK).state, "none");
  });
});

describe("TEST- requests are invisible to every scheduled job", () => {
  // The smoke suite posts cards through the real webhook and taps their
  // buttons, so the dashboard commits decisions for them exactly as it would
  // for a real request. On 2026-08-06 a [TEST] card was approved and DID
  // produce a real script and a real recording kit — the candidates were
  // marked, the requestId was not, and the requestId is what the pipeline reads.
  const req = (id, extra = {}) => ({
    requestId: id,
    kind: KIND_TOPIC_PICK,
    requestedAt: "2026-08-08T10:00:00.000Z",
    payload: {},
    ...extra,
  });

  test("isTestRequest recognises the prefix on a record or a bare id", () => {
    assert.equal(isTestRequest("TEST-topic_pick-2026-08-08-abcd"), true);
    assert.equal(isTestRequest({ requestId: "TEST-anything" }), true);
    assert.equal(isTestRequest("topic_pick-2026-08-08-abcd"), false);
    assert.equal(isTestRequest({ requestId: "not-a-test" }), false);
    assert.equal(isTestRequest(null), false);
    assert.equal(isTestRequest({}), false);
  });

  test("a TEST- request is never returned as the latest of its kind", () => {
    const log = {
      requests: [
        req("topic_pick-2026-08-08-real", { requestedAt: "2026-08-08T09:00:00.000Z" }),
        req("TEST-topic_pick-2026-08-08-smoke", { requestedAt: "2026-08-08T23:00:00.000Z" }),
      ],
    };
    assert.equal(latestRequestOfKind(log, KIND_TOPIC_PICK).requestId, "topic_pick-2026-08-08-real");
  });

  test("AN APPROVED TEST- REQUEST DOES NOT MAKE THE PIPELINE ACT", () => {
    // The exact shape the dashboard commits after the smoke suite taps approve.
    const log = {
      requests: [
        req("TEST-topic_pick-2026-08-08-smoke", { decision: "approve", selection: 1, decidedAt: "t" }),
      ],
    };
    assert.deepEqual(decisionState(log, KIND_TOPIC_PICK), { state: "none" });
  });

  test("a log of nothing but TEST- requests reads as empty", () => {
    const log = { requests: [req("TEST-a"), req("TEST-b", { decision: "approve" })] };
    assert.equal(latestRequestOfKind(log, KIND_TOPIC_PICK), null);
  });

  test("real requests are completely unaffected", () => {
    const log = { requests: [req("topic_pick-2026-08-08-real", { decision: "approve", decidedAt: "t" })] };
    assert.equal(decisionState(log, KIND_TOPIC_PICK).state, "approved");
  });
});

describe("a superseded (acted, undecided) request is closed, not waiting", () => {
  test("decisionState returns already-acted for acted-without-decision", async () => {
    const { decisionState, KIND_VIDEO_REVIEW } = await import("../src/yt-approvals.js");
    // The queue-rework case: the system supersedes a WAITING review card. No
    // decision exists — Peter never answered — but the request is closed. The
    // old order made this "waiting" forever, and the rebuild dispatched after
    // the supersede exited as a no-op.
    const log = { requests: [{
      requestId: "video_review-2026-08-09-test",
      kind: KIND_VIDEO_REVIEW,
      requestedAt: "2026-08-09T17:13:18.000Z",
      actedAt: "2026-08-09T20:02:53.000Z",
      actedAction: "superseded_by_rebuild",
    }] };
    const st = decisionState(log, KIND_VIDEO_REVIEW);
    assert.equal(st.state, "already-acted", `superseded card must be closed, got "${st.state}"`);
  });

  test("an untouched waiting request still reads as waiting", async () => {
    const { decisionState, KIND_VIDEO_REVIEW } = await import("../src/yt-approvals.js");
    const log = { requests: [{ requestId: "r", kind: KIND_VIDEO_REVIEW, requestedAt: "2026-08-09T17:13:18.000Z" }] };
    assert.equal(decisionState(log, KIND_VIDEO_REVIEW).state, "waiting");
  });
});

describe("pendingAnsweredReview — a decision Peter made outranks a question he has not answered", () => {
  const world = () => {
    // The exact shape of run 32201677539's no-op: video 1's topic acted, its
    // review APPROVED but unacted — and video 2's brief already out, waiting.
    let log = { requests: [] };
    log = appendRequest(log, { requestId: "topic_pick-old", kind: "topic_pick" });
    log = recordDecision(log, "topic_pick-old", { decision: "approve" });
    log = markActed(log, "topic_pick-old", { action: "kit_sent" });
    log = appendRequest(log, { requestId: "video_review-old", kind: "video_review", videoId: "v1" });
    log = recordDecision(log, "video_review-old", { decision: "approve" });
    log = appendRequest(log, { requestId: "topic_pick-new", kind: "topic_pick" });
    return log;
  };

  test("the approved review surfaces even though the NEWEST topic is waiting", () => {
    const log = world();
    // Pin the collision's precondition: the topic-keyed switch would exit here.
    assert.equal(decisionState(log, "topic_pick").state, "waiting", "fixture must reproduce the waiting-brief state");
    const answered = pendingAnsweredReview(log);
    assert.ok(answered, "the approved review must outrank the waiting brief");
    assert.equal(answered.state, "approved");
    assert.equal(answered.record.requestId, "video_review-old");
  });

  test("once acted, it stops surfacing — the sweep owns it from there", () => {
    let log = world();
    log = markActed(log, "video_review-old", { action: "review_recorded" });
    assert.equal(pendingAnsweredReview(log), null);
  });

  test("a rejection surfaces the same way — rework outranks the new brief too", () => {
    let log = world();
    log = { requests: log.requests.map((r) => r.requestId === "video_review-old" ? { ...r, decision: "reject", notes: "tighten the hook" } : r) };
    const answered = pendingAnsweredReview(log);
    assert.equal(answered?.state, "rejected");
  });

  test("no review, or a merely-waiting review, yields null", () => {
    let log = { requests: [] };
    assert.equal(pendingAnsweredReview(log), null);
    log = appendRequest(log, { requestId: "video_review-x", kind: "video_review" });
    assert.equal(pendingAnsweredReview(log), null, "an unanswered review is not actionable");
  });
});
