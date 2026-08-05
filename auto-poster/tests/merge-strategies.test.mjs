/**
 * Concurrent-runner log merge.
 *
 * Two GitHub Actions runners can finish within seconds of each other. Whichever
 * loses the push race re-merges its own state onto the winner's commit. If that
 * merge drops an entry, the next run for that city sees no record of the post and
 * publishes the same video again.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  mergePostedLog,
  mergeBlocklist,
  mergeTrialVariants,
  mergePerformanceWeights,
  mergeYtApprovals,
} from "../merge-strategies.mjs";

const quiet = () => {};

describe("mergePostedLog — no entry may be lost", () => {
  test("appends a local entry that the remote does not have", () => {
    const local = { posts: [{ timestamp: "2026-07-30T16:00:00.000Z", city: "san_antonio" }] };
    const remote = { posts: [] };
    const merged = mergePostedLog(local, remote, quiet);
    assert.equal(merged.posts.length, 1);
  });

  test("does NOT duplicate an entry already present remotely", () => {
    const entry = { timestamp: "2026-07-30T16:00:00.000Z", city: "san_antonio" };
    const merged = mergePostedLog({ posts: [entry] }, { posts: [entry] }, quiet);
    assert.equal(merged.posts.length, 1);
  });

  test("KEEPS the winner's entry when the loser re-merges (the race that matters)", () => {
    // Runner A (Austin) pushed first. Runner B (San Antonio) lost the race,
    // reset to origin/main, and now re-merges its own /tmp copy on top.
    const winnerOnRemote = {
      posts: [{ timestamp: "2026-07-30T17:00:00.000Z", city: "austin", fileName: "atx.mp4" }],
    };
    const loserLocal = {
      posts: [{ timestamp: "2026-07-30T16:59:58.000Z", city: "san_antonio", fileName: "sa.mp4" }],
    };
    const merged = mergePostedLog(loserLocal, winnerOnRemote, quiet);
    const names = merged.posts.map((p) => p.fileName).sort();
    assert.deepEqual(names, ["atx.mp4", "sa.mp4"], "both runners' posts must survive");
  });

  test("survives three-way pileup without dropping anyone", () => {
    const runs = [
      { timestamp: "2026-07-30T16:00:00.000Z", city: "san_antonio" },
      { timestamp: "2026-07-30T17:00:00.000Z", city: "austin" },
      { timestamp: "2026-07-30T21:00:00.000Z", city: "dallas" },
    ];
    let remote = { posts: [] };
    for (const entry of runs) {
      remote = mergePostedLog({ posts: [entry] }, remote, quiet);
    }
    assert.equal(remote.posts.length, 3);
    assert.deepEqual(remote.posts.map((p) => p.city).sort(), ["austin", "dallas", "san_antonio"]);
  });

  test("does not mutate the caller's remote array", () => {
    const remote = { posts: [{ timestamp: "a" }] };
    mergePostedLog({ posts: [{ timestamp: "b" }] }, remote, quiet);
    assert.equal(remote.posts.length, 1, "merge must be side-effect free");
  });

  test("tolerates a null/empty remote (first ever run)", () => {
    const merged = mergePostedLog({ posts: [{ timestamp: "x" }] }, { posts: [] }, quiet);
    assert.equal(merged.posts.length, 1);
  });

  test("skips entries with no timestamp rather than throwing", () => {
    const merged = mergePostedLog({ posts: [{ city: "nope" }] }, { posts: [] }, quiet);
    assert.equal(merged.posts.length, 0);
  });
});

describe("mergeBlocklist — once blocked, always blocked", () => {
  test("unions both sides", () => {
    const merged = mergeBlocklist(
      { blockedDriveIds: { A: { reason: "too short" } } },
      { blockedDriveIds: { B: { reason: "corrupt" } } },
      quiet
    );
    assert.deepEqual(Object.keys(merged.blockedDriveIds).sort(), ["A", "B"]);
  });

  test("a remote block is never dropped by a local merge", () => {
    const merged = mergeBlocklist({ blockedDriveIds: {} }, { blockedDriveIds: { KEEP: {} } }, quiet);
    assert.ok(merged.blockedDriveIds.KEEP);
  });
});

describe("mergeTrialVariants", () => {
  test("dedupes by generatedAt and keeps both distinct variants", () => {
    const shared = { generatedAt: "2026-07-30T13:15:00.000Z", window: "am" };
    const merged = mergeTrialVariants(
      { variants: [shared, { generatedAt: "2026-07-30T23:45:00.000Z", window: "pm" }] },
      { variants: [shared] },
      quiet
    );
    assert.equal(merged.variants.length, 2);
  });

  test("caps history at 100 entries", () => {
    const many = Array.from({ length: 130 }, (_, i) => ({ generatedAt: `2026-01-${String(i).padStart(3, "0")}` }));
    const merged = mergeTrialVariants({ variants: many }, { variants: [] }, quiet);
    assert.equal(merged.variants.length, 100);
  });
});

describe("mergePerformanceWeights", () => {
  test("newer lastUpdated wins", () => {
    const merged = mergePerformanceWeights(
      { hook: { score: 2, lastUpdated: "2026-07-30" } },
      { hook: { score: 1, lastUpdated: "2026-07-01" } },
      quiet
    );
    assert.equal(merged.hook.score, 2);
  });

  test("older local does NOT clobber newer remote", () => {
    const merged = mergePerformanceWeights(
      { hook: { score: 1, lastUpdated: "2026-07-01" } },
      { hook: { score: 9, lastUpdated: "2026-07-30" } },
      quiet
    );
    assert.equal(merged.hook.score, 9);
  });
});

describe("mergeYtApprovals — two writers, neither sees the other", () => {
  const REQ = {
    requestId: "video_review-2026-08-14-aaaa1111",
    kind: "video_review",
    requestedAt: "2026-08-14T18:00:00.000Z",
    payload: { title: "Moving to San Antonio" },
    videoId: "vid-1",
  };

  test("the poster's request and the dashboard's decision both survive", () => {
    // The poster pushed the request. The dashboard, working from an older
    // checkout, pushes only the decision fields for the same id.
    const local = { requests: [{ ...REQ }] };
    const remote = {
      requests: [{
        requestId: REQ.requestId,
        decision: "approve",
        notes: null,
        decidedAt: "2026-08-14T19:30:00.000Z",
      }],
    };
    const merged = mergeYtApprovals(local, remote, quiet);
    assert.equal(merged.requests.length, 1);
    const r = merged.requests[0];
    assert.equal(r.kind, "video_review", "identity fields lost");
    assert.equal(r.payload.title, "Moving to San Antonio", "payload lost");
    assert.equal(r.decision, "approve", "decision lost");
    assert.equal(r.decidedAt, "2026-08-14T19:30:00.000Z");
  });

  test("THE RACE THAT MATTERS: an acted marker is never erased by a dashboard push", () => {
    // The poster published and stamped the record. The dashboard then pushes
    // its own copy, which has the decision but has never heard of actedAt.
    // If the merge drops actedAt, the next scheduled run sees an unacted
    // approval and publishes the same video a second time.
    const posterLocal = {
      requests: [{
        ...REQ,
        decision: "approve",
        decidedAt: "2026-08-14T19:30:00.000Z",
        actedAt: "2026-08-15T14:00:00.000Z",
        actedAction: "published",
        actedResult: { youtubeId: "abc123" },
      }],
    };
    const dashboardRemote = {
      requests: [{
        requestId: REQ.requestId,
        decision: "approve",
        notes: null,
        decidedAt: "2026-08-14T19:30:00.000Z",
      }],
    };
    const merged = mergeYtApprovals(posterLocal, dashboardRemote, quiet);
    assert.equal(merged.requests[0].actedAt, "2026-08-15T14:00:00.000Z");
    assert.equal(merged.requests[0].actedResult.youtubeId, "abc123");
  });

  test("and it survives with the arguments the other way round", () => {
    const acted = {
      requests: [{ ...REQ, decision: "approve", decidedAt: "2026-08-14T19:30:00.000Z", actedAt: "2026-08-15T14:00:00.000Z" }],
    };
    const plain = { requests: [{ requestId: REQ.requestId, decision: "approve", decidedAt: "2026-08-14T19:30:00.000Z" }] };
    assert.equal(mergeYtApprovals(plain, acted, quiet).requests[0].actedAt, "2026-08-15T14:00:00.000Z");
    assert.equal(mergeYtApprovals(acted, plain, quiet).requests[0].actedAt, "2026-08-15T14:00:00.000Z");
  });

  test("a decision is never flipped by a poster push that predates it", () => {
    const posterLocal = { requests: [{ ...REQ }] }; // no decision at all
    const dashboardRemote = {
      requests: [{ requestId: REQ.requestId, decision: "revise", notes: "hook is soft", decidedAt: "2026-08-14T19:30:00.000Z" }],
    };
    const merged = mergeYtApprovals(posterLocal, dashboardRemote, quiet);
    assert.equal(merged.requests[0].decision, "revise");
    assert.equal(merged.requests[0].notes, "hook is soft");
  });

  test("when both sides carry a decision, the earlier one wins — deterministically", () => {
    const early = { requestId: "r", decision: "revise", decidedAt: "2026-08-14T19:00:00.000Z" };
    const late = { requestId: "r", decision: "approve", decidedAt: "2026-08-14T20:00:00.000Z" };
    assert.equal(mergeYtApprovals({ requests: [early] }, { requests: [late] }, quiet).requests[0].decision, "revise");
    assert.equal(mergeYtApprovals({ requests: [late] }, { requests: [early] }, quiet).requests[0].decision, "revise");
  });

  test("distinct requests are all kept", () => {
    const local = { requests: [{ ...REQ, requestId: "a" }] };
    const remote = { requests: [{ ...REQ, requestId: "b" }, { ...REQ, requestId: "c" }] };
    assert.equal(mergeYtApprovals(local, remote, quiet).requests.length, 3);
  });

  test("tolerates a null/empty remote (first ever run)", () => {
    const merged = mergeYtApprovals({ requests: [{ ...REQ }] }, { requests: [] }, quiet);
    assert.equal(merged.requests.length, 1);
  });

  test("drops garbage entries instead of throwing", () => {
    const local = { requests: [null, "nope", {}, { requestId: "" }, { ...REQ }] };
    const merged = mergeYtApprovals(local, { requests: [] }, quiet);
    assert.equal(merged.requests.length, 1);
  });

  test("does not mutate either side", () => {
    const local = { requests: [{ ...REQ }] };
    const remote = { requests: [{ requestId: REQ.requestId, decision: "approve", decidedAt: "2026-08-14T19:30:00.000Z" }] };
    mergeYtApprovals(local, remote, quiet);
    assert.equal(local.requests[0].decision, undefined);
    assert.equal(remote.requests[0].kind, undefined);
  });

  test("survives a three-way pileup without losing anyone's half", () => {
    const a = { requests: [{ ...REQ }] };
    const b = { requests: [{ requestId: REQ.requestId, decision: "approve", decidedAt: "2026-08-14T19:30:00.000Z" }] };
    const c = { requests: [{ requestId: REQ.requestId, actedAt: "2026-08-15T14:00:00.000Z", actedAction: "published" }] };
    const merged = mergeYtApprovals(c, mergeYtApprovals(b, a, quiet), quiet);
    const r = merged.requests[0];
    assert.equal(r.kind, "video_review");
    assert.equal(r.decision, "approve");
    assert.equal(r.actedAt, "2026-08-15T14:00:00.000Z");
  });

  test("caps history without dropping the newest", () => {
    const many = Array.from({ length: 450 }, (_, i) => ({
      requestId: `r-${String(i).padStart(4, "0")}`,
      kind: "topic_pick",
      requestedAt: `2026-01-01T00:${String(i % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.${String(i).padStart(3, "0")}Z`,
    }));
    const merged = mergeYtApprovals({ requests: many }, { requests: [] }, quiet);
    assert.equal(merged.requests.length, 400);
  });
});
