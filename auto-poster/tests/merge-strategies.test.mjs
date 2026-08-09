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

describe("mergePostedLog — the retention window is enforced HERE or nowhere", () => {
  const daysAgo = (n) => new Date(Date.now() - n * 86400_000).toISOString();

  test("drops a remote entry older than the retention window", () => {
    // The exact shape that used to survive forever. recordPost() had already
    // pruned this entry out of the local copy; the merge re-seeded it from
    // origin/main and appended on top, so it was never removed again.
    const remote = { posts: [{ timestamp: daysAgo(400), city: "san_antonio", fileName: "ancient.mp4" }] };
    const local = { posts: [{ timestamp: daysAgo(0), city: "san_antonio", fileName: "today.mp4" }] };

    const merged = mergePostedLog(local, remote, quiet);

    assert.deepEqual(
      merged.posts.map((p) => p.fileName),
      ["today.mp4"],
      "a 400-day-old entry must not survive the merge"
    );
  });

  test("keeps an entry just inside the window", () => {
    const remote = { posts: [{ timestamp: daysAgo(364), fileName: "just-inside.mp4" }] };
    const merged = mergePostedLog({ posts: [] }, remote, quiet);
    assert.equal(merged.posts.length, 1, "364 days old is still within 365");
  });

  test("trimming does not depend on the local side having anything to add", () => {
    // A no-post run still merges. If the trim only ran on the append path, a
    // quiet day would leave expired entries in place.
    const remote = { posts: [{ timestamp: daysAgo(500), fileName: "ancient.mp4" }] };
    const merged = mergePostedLog({ posts: [] }, remote, quiet);
    assert.equal(merged.posts.length, 0);
  });

  test("KEEPS entries whose timestamp cannot be parsed — never silent data loss", () => {
    // Dropping what we cannot date would trade unbounded growth for lost history.
    const remote = { posts: [{ timestamp: "not-a-date", fileName: "undateable.mp4" }] };
    const merged = mergePostedLog({ posts: [] }, remote, quiet);
    assert.deepEqual(merged.posts.map((p) => p.fileName), ["undateable.mp4"]);
  });

  test("a year of daily posts stays bounded across repeated merges", () => {
    // Simulates the real loop: every run re-seeds from the previous merged
    // result, which is exactly how the old version accumulated.
    let remote = { posts: [] };
    for (let d = 500; d >= 0; d--) {
      remote = mergePostedLog({ posts: [{ timestamp: daysAgo(d), fileName: `d${d}.mp4` }] }, remote, quiet);
    }
    assert.ok(remote.posts.length <= 366, `expected <=366 entries, got ${remote.posts.length}`);
    assert.ok(
      remote.posts.every((p) => Date.parse(p.timestamp) > Date.now() - 366 * 86400_000),
      "nothing older than the window may remain"
    );
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

describe("mergeYtApprovals — the shapes the LIVE dashboard actually writes", () => {
  const REQUEST = {
    requestId: "topic_pick-2026-08-06-db587860",
    kind: "topic_pick",
    requestedAt: "2026-08-06T03:28:03.955Z",
    payload: { candidates: [{ title: "one" }, { title: "two" }, { title: "three" }] },
  };
  // Exactly what the dashboard committed: a bare array, whole file replaced.
  const DASHBOARD = [
    { requestId: REQUEST.requestId, decision: "approve", decidedAt: "2026-08-06T03:40:18.246Z", selection: 2 },
  ];

  test("a bare-array remote does NOT wipe the poster's request records", () => {
    // Before the fix, remote.requests was undefined, the merge kept only the
    // poster's half, and Peter's decision was silently discarded.
    const merged = mergeYtApprovals({ requests: [REQUEST] }, DASHBOARD, quiet);
    assert.equal(merged.requests.length, 1);
    assert.equal(merged.requests[0].kind, "topic_pick");
    assert.equal(merged.requests[0].decision, "approve");
  });

  test("it works with the arguments the other way round too", () => {
    const merged = mergeYtApprovals(DASHBOARD, { requests: [REQUEST] }, quiet);
    assert.equal(merged.requests[0].decision, "approve");
    assert.equal(merged.requests[0].payload.candidates.length, 3);
  });

  test("SELECTION SURVIVES — it is the field that says which video to make", () => {
    // An earlier version copied decision/notes/decidedAt and dropped selection,
    // so a recovered record resolved to "approved, but nothing says which one"
    // and the pipeline stalled on a decision that was actually complete.
    const merged = mergeYtApprovals({ requests: [REQUEST] }, DASHBOARD, quiet);
    assert.equal(merged.requests[0].selection, 2);
  });

  test("the result is always the poster's object shape, never numeric keys", () => {
    const merged = mergeYtApprovals(DASHBOARD, DASHBOARD, quiet);
    assert.ok(Array.isArray(merged.requests));
    assert.equal(merged["0"], undefined, "spreading a bare array would produce numeric keys");
  });

  test("the request payload survives a dashboard write", () => {
    const merged = mergeYtApprovals({ requests: [REQUEST] }, DASHBOARD, quiet);
    assert.equal(merged.requests[0].payload.candidates.length, 3);
    assert.equal(merged.requests[0].requestedAt, REQUEST.requestedAt);
  });
});

describe("mergeYtApprovals — a deliberate outline rewrite survives", () => {
  // A reoutline rewrites the payload of a record that already exists remotely.
  // Both sides share a requestId AND a requestedAt, so the identity group's
  // "earlier stamp wins" tie-break resolves to the remote — and the rewrite
  // would push, merge, and silently come back unchanged. Caught before shipping
  // scripts/reoutline-request.mjs; this is the test that would have caught it.
  const base = {
    requestId: "r1", kind: "topic_pick", requestedAt: "2026-08-07T17:32:30.393Z",
    decision: "approve", selection: 1, notes: "Let's target veterans",
  };
  const oldPayload = { candidates: [{ index: 1, outline: "the established pockets inside 1604" }] };
  const newPayload = {
    candidates: [{ index: 1, outline: "Stone Oak, Hollywood Park, Shavano Park" }],
    reoutlinedAt: "2026-08-07T20:00:00.000Z",
  };

  test("the rewritten payload wins over the copy it rewrote", () => {
    const merged = mergeYtApprovals(
      { requests: [{ ...base, payload: newPayload }] },
      { requests: [{ ...base, payload: oldPayload }] },
      quiet
    );
    assert.match(merged.requests[0].payload.candidates[0].outline, /Stone Oak/);
  });

  test("wins regardless of which side the merge sees first", () => {
    const merged = mergeYtApprovals(
      { requests: [{ ...base, payload: oldPayload }] },
      { requests: [{ ...base, payload: newPayload }] },
      quiet
    );
    assert.match(merged.requests[0].payload.candidates[0].outline, /Stone Oak/);
  });

  test("the later of two rewrites wins", () => {
    const older = { candidates: [{ index: 1, outline: "first try" }], reoutlinedAt: "2026-08-07T19:00:00.000Z" };
    const merged = mergeYtApprovals(
      { requests: [{ ...base, payload: older }] },
      { requests: [{ ...base, payload: newPayload }] },
      quiet
    );
    assert.match(merged.requests[0].payload.candidates[0].outline, /Stone Oak/);
  });

  test("a rewrite never disturbs the decision, selection, notes or acted marker", () => {
    const merged = mergeYtApprovals(
      { requests: [{ ...base, payload: newPayload }] },
      { requests: [{ ...base, payload: oldPayload, actedAt: "2026-08-07T18:00:00.000Z", actedAction: "kit_delivered" }] },
      quiet
    );
    const r = merged.requests[0];
    assert.equal(r.decision, "approve");
    assert.equal(r.selection, 1);
    assert.equal(r.notes, "Let's target veterans");
    assert.equal(r.actedAt, "2026-08-07T18:00:00.000Z", "the acted latch is untouched");
  });

  test("records with no rewrite marker behave exactly as before", () => {
    const merged = mergeYtApprovals(
      { requests: [{ ...base, payload: { candidates: [{ index: 1, outline: "local" }] } }] },
      { requests: [{ ...base, payload: { candidates: [{ index: 1, outline: "remote" }] } }] },
      quiet
    );
    assert.equal(merged.requests[0].payload.candidates[0].outline, "remote", "unchanged tie-break");
  });
});

describe("mergeYouTubeLog preserves fields it has never heard of", async () => {
  const { mergeYouTubeLog } = await import("../merge-strategies.mjs");
  const base = { videoId: "v1", requestId: "r1", createdAt: "2026-08-09T00:00:00Z", title: "t", market: "san_antonio" };

  test("the iteration loop's revision history survives a two-sided merge", () => {
    // Video 1 lost revision 2 and its rework history exactly here: the runner's
    // post-build push merged with a moved main, and this function rebuilt the
    // record from an allowlist that predated those fields.
    const local = { videos: [{ ...base, uploadedAt: "2026-08-09T20:59:00Z", revision: 2, reworks: [{ revision: 1, rejectedAt: "2026-08-09T20:02:00Z", metricoolPostId: 111 }] }] };
    const remote = { videos: [{ ...base, thumbnailText: "WRONG STREET WRONG SCHOOL" }] };
    const m = mergeYouTubeLog(local, remote, () => {}).videos[0];
    assert.equal(m.revision, 2);
    assert.equal(m.reworks.length, 1);
    assert.equal(m.reworks[0].metricoolPostId, 111);
    assert.equal(m.thumbnailText, "WRONG STREET WRONG SCHOOL");
    assert.equal(m.uploadedAt, "2026-08-09T20:59:00Z", "the upload group still applies its policy");
  });

  test("reworks union without duplicating either side's history", () => {
    const r1 = { revision: 1, rejectedAt: "a" };
    const r2 = { revision: 2, rejectedAt: "b" };
    const m = mergeYouTubeLog(
      { videos: [{ ...base, reworks: [r1, r2] }] },
      { videos: [{ ...base, reworks: [r1] }] },
      () => {}
    ).videos[0];
    assert.equal(m.reworks.length, 2);
  });

  test("a completed distribution step is never erased by a stale copy", () => {
    const m = mergeYouTubeLog(
      { videos: [{ ...base, distribution: { thumbnail: { done: true, at: "x" } } }] },
      { videos: [{ ...base, distribution: { thumbnail: { done: false }, playlist: { done: true } } }] },
      () => {}
    ).videos[0];
    assert.equal(m.distribution.thumbnail.done, true, "done wins");
    assert.equal(m.distribution.playlist.done, true, "the other side's completed step survives too");
  });

  test("a field invented NEXT month survives without editing the merge", () => {
    const m = mergeYouTubeLog(
      { videos: [{ ...base, someFutureField: { a: 1 } }] },
      { videos: [{ ...base, anotherNewThing: "kept" }] },
      () => {}
    ).videos[0];
    assert.deepEqual(m.someFutureField, { a: 1 });
    assert.equal(m.anotherNewThing, "kept");
  });
});
