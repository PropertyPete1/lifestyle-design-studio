/**
 * The performance decision file reader.
 *
 * A scheduled Claude task writes ig_posting_decision_latest.json to Drive twice
 * a week. As of 2026-09-09 that file does not exist — searched by title, by
 * mimeType, by full text for "safe_to_act" and across sharedWithMe, on the same
 * Drive account the bot authenticates as; it holds zero JSON files. So the path
 * these tests exercise hardest is the one production takes today: no file, no
 * change, run exactly as before.
 *
 * The invariant underneath all of it: this module is ADVICE. `applyDecision`
 * reorders and removes, never inserts, so nothing Step 3's filters excluded can
 * be reintroduced by anything the file says. The 30-day rule stays law.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseDecision,
  planFromDecision,
  applyDecision,
  loadDecision,
  DECISION_FILENAME,
  SUPPORTED_SCHEMA_VERSIONS,
  MAX_AGE_DAYS,
} from "../src/drive-decision.js";

const NOW = Date.parse("2026-09-09T18:00:00Z");
const fresh = (over = {}) => JSON.stringify({
  schema_version: "1.1",
  safe_to_act: true,
  safe_to_act_reason: "",
  post: [], dont_post: [], how_many: {}, hooks_that_work: [],
  data_gaps: [], changes_since_last_run: [],
  ...over,
});
const modified = new Date(NOW - 2 * 86400000).toISOString();

describe("refusing to act — every path ends in 'run as today'", () => {
  test("safe_to_act false is refused, and the writer's own reason is carried", () => {
    const r = parseDecision(fresh({ safe_to_act: false, safe_to_act_reason: "only 4 days of data" }), { now: NOW, modifiedTime: modified });
    assert.equal(r.usable, false);
    assert.match(r.reason, /only 4 days of data/);
    assert.equal(r.decision, null, "a false run's post[] is never handed on");
  });

  test("safe_to_act missing or non-true is refused, not coerced", () => {
    for (const v of [undefined, null, "true", 1, 0]) {
      assert.equal(parseDecision(fresh({ safe_to_act: v }), { now: NOW, modifiedTime: modified }).usable, false);
    }
  });

  test("an unrecognised schema_version is refused rather than guessed at", () => {
    // A future writer may change what post[] MEANS. Guessing would act on a
    // misread ranking, which is worse than not acting.
    const r = parseDecision(fresh({ schema_version: "2.0" }), { now: NOW, modifiedTime: modified });
    assert.equal(r.usable, false);
    assert.match(r.reason, /unrecognised schema_version/);
  });

  test("the supported version is exactly 1.1", () => {
    assert.deepEqual(SUPPORTED_SCHEMA_VERSIONS, ["1.1"]);
    assert.equal(parseDecision(fresh(), { now: NOW, modifiedTime: modified }).usable, true);
  });

  test("stale beyond a week is refused — the eligible pool has moved underneath it", () => {
    const old = new Date(NOW - (MAX_AGE_DAYS + 1) * 86400000).toISOString();
    const r = parseDecision(fresh(), { now: NOW, modifiedTime: old });
    assert.equal(r.usable, false);
    assert.match(r.reason, /stale/);
  });

  test("exactly at the age limit is still usable", () => {
    const edge = new Date(NOW - MAX_AGE_DAYS * 86400000 + 1000).toISOString();
    assert.equal(parseDecision(fresh(), { now: NOW, modifiedTime: edge }).usable, true);
  });

  test("malformed JSON is refused without throwing", () => {
    const r = parseDecision("{not json", { now: NOW, modifiedTime: modified });
    assert.equal(r.usable, false);
    assert.match(r.reason, /unreadable JSON/);
  });

  test("a JSON array or scalar is refused", () => {
    assert.equal(parseDecision("[]", { now: NOW, modifiedTime: modified }).usable, false);
    assert.equal(parseDecision("42", { now: NOW, modifiedTime: modified }).usable, false);
  });
});

describe("loadDecision never throws", () => {
  test("no file in Drive is a normal outcome", async () => {
    const r = await loadDecision({ now: NOW, deps: { findDecisionFile: async () => null } });
    assert.equal(r.usable, false);
    assert.match(r.reason, new RegExp(DECISION_FILENAME));
    assert.equal(r.plan, null);
  });

  test("a Drive search failure is caught and reported, not thrown", async () => {
    const r = await loadDecision({ now: NOW, deps: { findDecisionFile: async () => { throw new Error("401 unauthorized"); } } });
    assert.equal(r.usable, false);
    assert.match(r.reason, /read failed.*401/);
  });

  test("a download failure is caught", async () => {
    const r = await loadDecision({
      now: NOW,
      deps: {
        findDecisionFile: async () => ({ id: "f1", modifiedTime: modified }),
        downloadFileById: async () => { throw new Error("network reset"); },
      },
    });
    assert.equal(r.usable, false);
    assert.match(r.reason, /network reset/);
  });

  test("a good file yields a plan", async () => {
    const r = await loadDecision({
      now: NOW,
      deps: {
        findDecisionFile: async () => ({ id: "f1", modifiedTime: modified }),
        downloadFileById: async () => Buffer.from(fresh({ post: [{ rank: 1, drive_file_id: "a", confidence: 0.9 }] })),
      },
    });
    assert.equal(r.usable, true);
    assert.equal(r.plan.ranked.length, 1);
  });
});

describe("a null drive_file_id is not actionable", () => {
  test("the row is dropped and named — never resolved by guessing a filename", () => {
    // 124 of the library's 142 filenames are iPhone UUIDs. A guess would land
    // on the wrong video, silently.
    const plan = planFromDecision({
      post: [
        { rank: 1, drive_file_id: null, source_file: "June winner.mp4", reason: "top performer" },
        { rank: 2, drive_file_id: "b" },
      ],
    });
    assert.equal(plan.ranked.length, 1);
    assert.equal(plan.ranked[0].driveFileId, "b");
    assert.equal(plan.skipped.length, 1);
    assert.equal(plan.skipped[0].source_file, "June winner.mp4");
    assert.match(plan.skipped[0].why, /null drive_file_id/);
  });

  test("empty-string and non-string ids are equally unactionable", () => {
    const plan = planFromDecision({ post: [{ rank: 1, drive_file_id: "" }, { rank: 2, drive_file_id: 123 }] });
    assert.equal(plan.ranked.length, 0);
    assert.equal(plan.skipped.length, 2);
  });
});

describe("applying a plan — reorder and remove, never insert", () => {
  const cands = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];

  test("ranked candidates lead, in rank order", () => {
    const plan = planFromDecision({ post: [{ rank: 2, drive_file_id: "d" }, { rank: 1, drive_file_id: "c" }] });
    const { candidates, stats } = applyDecision(cands, plan);
    assert.deepEqual(candidates.map((c) => c.id), ["c", "d", "a", "b"]);
    assert.equal(stats.promoted, 2);
  });

  test("unranked candidates keep their rotation order behind the ranked ones", () => {
    const plan = planFromDecision({ post: [{ rank: 1, drive_file_id: "c" }] });
    const { candidates } = applyDecision(cands, plan);
    assert.deepEqual(candidates.slice(1).map((c) => c.id), ["a", "b", "d"]);
  });

  test("dont_post entries are removed", () => {
    const plan = planFromDecision({ post: [], dont_post: [{ drive_file_id: "b" }, "d"] });
    const { candidates, stats } = applyDecision(cands, plan);
    assert.deepEqual(candidates.map((c) => c.id), ["a", "c"]);
    assert.equal(stats.excluded, 2);
  });

  test("THE INVARIANT: the output is always a subset of the input", () => {
    // post[] naming a Drive file that Step 3 excluded cannot bring it back.
    const plan = planFromDecision({ post: [{ rank: 1, drive_file_id: "NOT-ELIGIBLE" }] });
    const { candidates } = applyDecision(cands, plan);
    const inputIds = new Set(cands.map((c) => c.id));
    assert.ok(candidates.every((c) => inputIds.has(c.id)), "nothing was inserted");
    assert.equal(candidates.length, 4);
  });

  test("exclusions that would empty the pool are ignored, loudly", () => {
    // The file is advice. Advice that takes the account dark for a slot has
    // overreached, and a bad decision run must not be able to silence it.
    const plan = planFromDecision({ dont_post: ["a", "b", "c", "d"] });
    const { candidates, stats } = applyDecision(cands, plan);
    assert.equal(candidates.length, 4);
    assert.equal(stats.applied, false);
    assert.match(stats.reason, /would exclude all 4/);
  });

  test("no plan is a clean no-op", () => {
    const { candidates, stats } = applyDecision(cands, null);
    assert.equal(candidates, cands);
    assert.equal(stats.applied, false);
  });

  test("an empty candidate list does not trip the empty-pool guard", () => {
    const plan = planFromDecision({ dont_post: ["a"] });
    const { candidates } = applyDecision([], plan);
    assert.deepEqual(candidates, []);
  });
});

describe("cadence is read, not enforced", () => {
  test("posts_per_day and its rationale are surfaced on the plan", () => {
    const plan = planFromDecision({ how_many: { posts_per_day: 2, rationale: "median views fall past 3/day" } });
    assert.equal(plan.postsPerDay, 2);
    assert.match(plan.postsPerDayRationale, /median views/);
  });

  test("a missing or non-numeric posts_per_day reads as null, not as a default", () => {
    assert.equal(planFromDecision({}).postsPerDay, null);
    assert.equal(planFromDecision({ how_many: { posts_per_day: "two" } }).postsPerDay, null);
  });

  test("applying a plan does not truncate the candidate list to posts_per_day", () => {
    // Enforcement is a separate change: cadence is cron-set in post.yml and the
    // realty lane has no per-day counter. Half-enforcing it here — by trimming
    // one run's candidates — would look like a cap while capping nothing.
    const plan = planFromDecision({ how_many: { posts_per_day: 1 } });
    const { candidates } = applyDecision([{ id: "a" }, { id: "b" }, { id: "c" }], plan);
    assert.equal(candidates.length, 3);
  });
});

describe("empty sections and missing values", () => {
  test("empty arrays and absent sections are handled identically", () => {
    const a = planFromDecision({ post: [], dont_post: [], hooks_that_work: [], data_gaps: [] });
    const b = planFromDecision({});
    assert.deepEqual([a.ranked.length, a.exclude.size, a.hooks.length], [0, 0, 0]);
    assert.deepEqual([b.ranked.length, b.exclude.size, b.hooks.length], [0, 0, 0]);
  });

  test("a null confidence is preserved as null, not defaulted to a number", () => {
    const plan = planFromDecision({ post: [{ rank: 1, drive_file_id: "a", confidence: null }] });
    assert.equal(plan.ranked[0].confidence, null);
  });

  test("rows missing a rank fall back to their position rather than being dropped", () => {
    const plan = planFromDecision({ post: [{ drive_file_id: "a" }, { drive_file_id: "b" }] });
    assert.deepEqual(plan.ranked.map((r) => r.driveFileId), ["a", "b"]);
  });

  test("hooks_that_work and data_gaps are carried through for the caption lane", () => {
    const plan = planFromDecision({ hooks_that_work: ["reaction opener"], data_gaps: ["no June per-post views"] });
    assert.deepEqual(plan.hooks, ["reaction opener"]);
    assert.deepEqual(plan.dataGaps, ["no June per-post views"]);
  });
});
