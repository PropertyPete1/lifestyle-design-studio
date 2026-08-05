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
  saveApprovals,
  appendRequest,
  markActed,
  recordDecision,
  decisionState,
  isApproved,
  hasDecision,
  hasActed,
  latestRequestOfKind,
  regenerationNotes,
  newRequestId,
  KIND_TOPIC_PICK,
  KIND_VIDEO_REVIEW,
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
