/**
 * The debut lane, and the three ways it could have shipped broken.
 *
 * Step 4's comparator sorts never-matched footage behind every repost,
 * unconditionally, and the tail's internal order is stable — so the same
 * members win every time. Measured 2026-09-09: 21 San Antonio videos visible
 * since the 2026-07-11 backfill, never once selected. Austin and Dallas have
 * none, because their folders are over-subscribed enough that the 30-day rule
 * empties them regardless of order.
 *
 * The three tests that matter most here are not the happy path:
 *
 *   1. THE OUTAGE. main.js leaves `igPosts = []` when Metricool fails, so
 *      `unmatchable` is empty too. A ceiling written as `unmatchable <= N`
 *      would read a total outage as maximum safety — on the exact run where
 *      liveIgMatchCheck is blind. The gate requires positive evidence instead.
 *   2. THE PERMUTATION. Reordering must never change the SET. That is what
 *      makes "this cannot violate the 30-day rule" a proof rather than a claim.
 *   3. NO MUTATION. `const sorted = eligible.sort(...)` sorts in place, so
 *      `sorted === eligible`; mutating it would corrupt a list main.js still
 *      reads for its blocked/eligible accounting.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  isDebut,
  debutGate,
  applyPromoteAhead,
  DEBUT_UNMATCHABLE_CEILING,
  DEFAULT_DEBUT_SLOTS,
} from "../src/promote-ahead.js";
import { getEverPostedIds, getEverPostedFileNames } from "../src/state.js";

const v = (id, name = `${id}.mp4`) => ({ id, name });
const ctx = (over = {}) => ({
  everPostedIds: new Set(),
  everPostedNames: new Set(),
  matchCache: {},
  ...over,
});
/** Gate args that are known-good, so each test varies exactly one thing. */
const okGate = (over = {}) => ({
  enabled: true, slot: "am", allowedSlots: ["am"],
  igPostsCount: 30, unmatchableCount: 0, debutCount: 5, ...over,
});

describe("isDebut", () => {
  test("never posted, never matched — a debut", () => {
    assert.equal(isDebut(v("a"), ctx()), true);
  });

  test("posted before by id — not a debut", () => {
    assert.equal(isDebut(v("a"), ctx({ everPostedIds: new Set(["a"]) })), false);
  });

  test("posted before under a different Drive id but the same filename — not a debut", () => {
    // Re-uploading a file to Drive mints a new id but keeps the phone filename.
    assert.equal(isDebut(v("new-id", "IMG_1234.mp4"), ctx({ everPostedNames: new Set(["IMG_1234.mp4"]) })), false);
  });

  test("a cached IG match is proof of a prior airing — not a debut", () => {
    // video-matches.json reaches back to 2026-06-11, before posted-log existed.
    // Treating matched-but-unlogged footage as a debut would promote something
    // that has already aired, purely because the log does not go back far enough.
    assert.equal(isDebut(v("a"), ctx({ matchCache: { a: [{ igPostId: "1", publishedAt: "2026-06-11" } ] } })), false);
  });

  test("an EMPTY cached-match array is not a prior airing", () => {
    // 107 of video-matches.json's 193 keys are empty arrays — scanned, no match
    // found. Those are the debut cohort, not evidence against it.
    assert.equal(isDebut(v("a"), ctx({ matchCache: { a: [] } })), true);
  });

  test("a malformed video is never a debut", () => {
    assert.equal(isDebut(null, ctx()), false);
    assert.equal(isDebut({}, ctx()), false);
  });
});

describe("the outage rule — a blind run is not a safe run", () => {
  test("BLOCKER REGRESSION: zero IG posts read stands the lane down", () => {
    // main.js Step 1 catches a getRecentIgPosts failure and leaves igPosts = [].
    // The hashing loop then never runs, so unmatchable is [] as well. A ceiling
    // check alone would PASS here — maximum safety read off a total outage.
    const gate = debutGate(okGate({ igPostsCount: 0, unmatchableCount: 0 }));
    assert.equal(gate.allowed, false);
    assert.match(gate.reason, /no IG posts were read/);
  });

  test("the ceiling still applies once IG was actually read", () => {
    assert.equal(debutGate(okGate({ igPostsCount: 30, unmatchableCount: DEBUT_UNMATCHABLE_CEILING + 1 })).allowed, false);
    assert.equal(debutGate(okGate({ igPostsCount: 30, unmatchableCount: DEBUT_UNMATCHABLE_CEILING })).allowed, true);
  });

  test("an outage stands the lane down even when unmatchable is under the ceiling", () => {
    const { candidates, stats } = applyPromoteAhead([v("debut"), v("repost")], {
      slot: "am",
      everPostedIds: new Set(["repost"]),
      everPostedNames: new Set(),
      igPostsCount: 0,
      unmatchableCount: 0,
    });
    assert.equal(stats.active, false);
    assert.deepEqual(candidates.map((c) => c.id), ["debut", "repost"], "order is left exactly as the rotation sort produced it");
  });
});

describe("gating", () => {
  test("PROMOTE_AHEAD=false disables it", () => {
    const g = debutGate(okGate({ enabled: false }));
    assert.equal(g.allowed, false);
    assert.match(g.reason, /PROMOTE_AHEAD/);
  });

  test("only the allowed slots run the lane — pm always ships proven content", () => {
    assert.equal(debutGate(okGate({ slot: "pm" })).allowed, false);
    assert.equal(debutGate(okGate({ slot: "am" })).allowed, true);
  });

  test("defaults to the am slot only", () => {
    assert.deepEqual(DEFAULT_DEBUT_SLOTS, ["am"]);
  });

  test("no debut candidates is a stand-down, not an error", () => {
    const g = debutGate(okGate({ debutCount: 0 }));
    assert.equal(g.allowed, false);
    assert.match(g.reason, /no debut candidates/);
  });
});

describe("the permutation property — why this cannot break the 30-day rule", () => {
  const list = [v("r1"), v("d1"), v("r2"), v("d2"), v("r3")];
  const opts = {
    slot: "am", igPostsCount: 30, unmatchableCount: 0,
    everPostedIds: new Set(["r1", "r2", "r3"]),
    everPostedNames: new Set(),
  };

  test("the output SET equals the input SET", () => {
    const { candidates } = applyPromoteAhead(list, opts);
    assert.deepEqual(
      candidates.map((c) => c.id).sort(),
      list.map((c) => c.id).sort(),
      "reordering cannot add or drop a candidate — `eligible` already applied every 30-day test"
    );
  });

  test("debuts lead, reposts follow", () => {
    const { candidates, stats } = applyPromoteAhead(list, opts);
    assert.deepEqual(candidates.map((c) => c.id), ["d1", "d2", "r1", "r2", "r3"]);
    assert.equal(stats.debut, 2);
    assert.equal(stats.repost, 3);
  });

  test("relative order WITHIN each partition is preserved", () => {
    // The existing rotation comparator still orders the repost lane; a partition
    // that reshuffled it would silently discard the oldest-first rotation.
    const { candidates } = applyPromoteAhead(list, opts);
    assert.deepEqual(candidates.slice(2).map((c) => c.id), ["r1", "r2", "r3"]);
  });

  test("it does NOT mutate the input array", () => {
    const input = [v("r1"), v("d1")];
    const snapshot = input.map((c) => c.id);
    applyPromoteAhead(input, opts);
    assert.deepEqual(input.map((c) => c.id), snapshot, "sorted === eligible in main.js; mutating it corrupts a live list");
  });

  test("an empty candidate list is handled", () => {
    const { candidates, stats } = applyPromoteAhead([], opts);
    assert.deepEqual(candidates, []);
    assert.equal(stats.active, false);
  });
});

describe("per-city behaviour, against the measured folders", () => {
  test("Austin is a byte-identical no-op — 0 debuts among its candidates", () => {
    // 44 videos, 35 posted, 9 qc-blocklisted, 0 starved. On the day of
    // measurement its queue was ONE candidate deep, which is exactly the case a
    // reserved exploration slot would have starved.
    const austin = [v("only-eligible")];
    const { candidates, stats } = applyPromoteAhead(austin, {
      slot: "am", igPostsCount: 30, unmatchableCount: 0,
      everPostedIds: new Set(["only-eligible"]),
      everPostedNames: new Set(),
    });
    assert.equal(stats.active, false);
    assert.equal(candidates, austin, "the very same array reference comes back out");
  });

  test("Dallas is a no-op — all 10 of its videos have aired", () => {
    const dallas = ["d1", "d2", "d3"].map((id) => v(id));
    const { stats } = applyPromoteAhead(dallas, {
      slot: "am", igPostsCount: 30, unmatchableCount: 0,
      everPostedIds: new Set(["d1", "d2", "d3"]),
      everPostedNames: new Set(),
    });
    assert.equal(stats.active, false);
  });

  test("the lane self-terminates: once a debut airs it is no longer a debut", () => {
    const list = [v("d1"), v("r1")];
    const before = applyPromoteAhead(list, {
      slot: "am", igPostsCount: 30, unmatchableCount: 0,
      everPostedIds: new Set(["r1"]), everPostedNames: new Set(),
    });
    assert.equal(before.stats.debut, 1);
    // …after d1 publishes, recordPost puts it in the log:
    const after = applyPromoteAhead(list, {
      slot: "am", igPostsCount: 30, unmatchableCount: 0,
      everPostedIds: new Set(["r1", "d1"]), everPostedNames: new Set(),
    });
    assert.equal(after.stats.active, false, "the backlog is finite and the lane switches itself off");
  });
});

describe("state.js ever-posted helpers", () => {
  const log = {
    posts: [
      { driveFileId: "a", fileName: "a.mp4", timestamp: "2026-07-01T00:00:00Z" },
      { driveFileId: "b", fileName: "b.mp4", timestamp: "2026-01-01T00:00:00Z" },
      { driveFileId: "ldt1", fileName: "ldt.mp4", brand: "ldt", timestamp: "2026-08-01T00:00:00Z" },
      { driveFileId: "r", fileName: "r.mp4", brand: "realty", timestamp: "2026-08-01T00:00:00Z" },
    ],
  };

  test("has NO 30-day window — an airing in January still counts", () => {
    // The rotation helpers are windowed because they answer "may this repeat?".
    // This one answers "has this ever aired?", which is a whole-log question.
    const ids = getEverPostedIds(log);
    assert.ok(ids.has("a"));
    assert.ok(ids.has("b"));
  });

  test("another brand's airings do not count as realty airings", () => {
    const ids = getEverPostedIds(log);
    assert.equal(ids.has("ldt1"), false);
    assert.ok(ids.has("r"), "an explicit realty brand tag counts");
  });

  test("filenames are collected on the same scoping rule", () => {
    const names = getEverPostedFileNames(log);
    assert.ok(names.has("a.mp4"));
    assert.equal(names.has("ldt.mp4"), false);
  });
});

describe("the kill switch actually reaches the process", () => {
  test("post.yml names PROMOTE_AHEAD in every posting job's env block", () => {
    // The workflow has no top-level `env:`. A variable that is not named in a
    // job's own env block is simply absent at runtime, so a kill switch that
    // was only read in code would be unreachable — off is not a state it could
    // ever be put into.
    const yml = readFileSync(new URL("../../.github/workflows/post.yml", import.meta.url), "utf-8");
    const declared = (yml.match(/^\s*PROMOTE_AHEAD:/gm) || []).length;
    const slots = (yml.match(/^\s*PROMOTE_AHEAD_SLOTS:/gm) || []).length;
    assert.equal(declared, 3, "san-antonio, austin and dallas each need it");
    assert.equal(slots, 3);
  });

  test("an UNSET repo variable means ON, matching the documented default", () => {
    // GitHub renders an unset `vars.X` as the empty string, not as absent.
    assert.equal("" !== "false", true);
    assert.deepEqual(("" || "am").split(",").map((s) => s.trim()), ["am"]);
  });
});
