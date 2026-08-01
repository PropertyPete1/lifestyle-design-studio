/**
 * Final hardening: the skip-list interface, and defensive reads of posted-log.
 *
 * Both close gaps found by the integration audit (issue #7):
 *   - a video the owner skipped in the dashboard stayed fully eligible, because
 *     the auto-poster reads nothing back from the dashboard
 *   - a null/malformed entry in posts[] threw out of hasRecentPost, the FIRST
 *     guard every run touches, turning a data blemish into a dead slot
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  validPosts,
  getSkippedDriveIds,
  isSkipped,
  hasRecentPost,
  wasPostedRecently,
  getRecentlyPostedIds,
  getRecentlyPostedFileNames,
  getRecentlyPostedIdsAllCities,
  getRecentlyPostedFileNamesAllCities,
} from "../src/state.js";
import { pickPersona, getLastPersonaForCity, getRecentTranscripts } from "../src/voiceover-style.js";
import { findContentDuplicate } from "../src/content-hash.js";
import { mergeSkipList } from "../merge-strategies.mjs";

// ─── Skip list ───────────────────────────────────────────────────────────────

describe("skip list — schema handling", () => {
  test("extracts driveFileIds", () => {
    const ids = getSkippedDriveIds([
      { driveFileId: "A", fileName: "a.mp4", skippedAt: "2026-08-01T00:00:00Z", source: "dashboard" },
      { driveFileId: "B" },
    ]);
    assert.deepEqual([...ids].sort(), ["A", "B"]);
  });

  test("isSkipped matches by driveFileId", () => {
    const list = [{ driveFileId: "A" }];
    assert.equal(isSkipped(list, "A"), true);
    assert.equal(isSkipped(list, "B"), false);
  });

  test("only driveFileId is load-bearing — the other fields are optional", () => {
    assert.equal(isSkipped([{ driveFileId: "A" }], "A"), true);
  });

  describe("a partially-written file can never take down a run", () => {
    for (const [label, list] of [
      ["empty array", []],
      ["null", null],
      ["undefined", undefined],
      ["entries missing driveFileId", [{ fileName: "x.mp4" }]],
      ["null entries", [null, { driveFileId: "A" }]],
      ["non-object entries", ["A", 42, [], { driveFileId: "A" }]],
      ["empty-string id", [{ driveFileId: "" }]],
      ["non-string id", [{ driveFileId: 123 }]],
    ]) {
      test(label, () => {
        assert.doesNotThrow(() => getSkippedDriveIds(list));
        assert.doesNotThrow(() => isSkipped(list, "A"));
      });
    }
  });

  test("malformed entries are ignored but valid ones still count", () => {
    const ids = getSkippedDriveIds([null, { fileName: "no-id.mp4" }, { driveFileId: "KEEP" }]);
    assert.deepEqual([...ids], ["KEEP"]);
  });

  test("an empty skip list changes nothing (default state until the dashboard is wired)", () => {
    assert.equal(getSkippedDriveIds([]).size, 0);
    assert.equal(isSkipped([], "anything"), false);
  });
});

describe("skip list — concurrent runner merge", () => {
  const quiet = () => {};

  test("unions both sides", () => {
    const m = mergeSkipList([{ driveFileId: "LOCAL" }], [{ driveFileId: "REMOTE" }], quiet);
    assert.deepEqual(m.map(e => e.driveFileId).sort(), ["LOCAL", "REMOTE"]);
  });

  test("a remote skip is never dropped by a local merge", () => {
    // The dashboard writes skips; a concurrent poster run must not undo them.
    const m = mergeSkipList([], [{ driveFileId: "KEEP" }], quiet);
    assert.equal(m.length, 1);
  });

  test("dedupes by driveFileId", () => {
    const m = mergeSkipList([{ driveFileId: "A", source: "local" }], [{ driveFileId: "A", source: "remote" }], quiet);
    assert.equal(m.length, 1);
  });

  test("drops malformed entries rather than propagating them", () => {
    const m = mergeSkipList([null, "x", { fileName: "no-id" }, { driveFileId: "OK" }], [], quiet);
    assert.deepEqual(m.map(e => e.driveFileId), ["OK"]);
  });

  test("tolerates a non-array file (hand-edited to an object)", () => {
    assert.doesNotThrow(() => mergeSkipList({ nope: true }, null, quiet));
    assert.deepEqual(mergeSkipList({ nope: true }, null, quiet), []);
  });
});

// ─── Defensive posted-log reads (LOW-3) ──────────────────────────────────────

describe("validPosts", () => {
  test("keeps real entries, drops the rest", () => {
    const got = validPosts({ posts: [null, undefined, "s", 42, [], { city: "austin" }] });
    // [] is an object, so it survives the type check but carries no fields —
    // harmless, every reader looks for named properties.
    assert.ok(got.some(p => p.city === "austin"));
    assert.ok(!got.includes(null));
    assert.ok(!got.includes("s"));
  });

  for (const [label, log] of [["null log", null], ["no posts key", {}], ["posts not an array", { posts: "nope" }]]) {
    test(`${label} yields an empty list`, () => {
      assert.deepEqual(validPosts(log), []);
    });
  }
});

describe("every posted-log reader survives a malformed entry", () => {
  // Regression for LOW-3: hasRecentPost is the FIRST guard a run touches, so a
  // throw here killed the slot before any other protection could run.
  const bad = {
    posts: [
      null, undefined, "string", 42, [],
      { city: "austin", timestamp: new Date().toISOString(), fileName: "x.mp4", driveFileId: "X", voiceover_persona: "storyteller", content_hash: "a:b:c:d:e" },
    ],
  };
  const FP = "aaaa:bbbb:cccc:dddd:eeee";

  const cases = [
    ["wasPostedRecently", () => wasPostedRecently(bad, "X", 30)],
    ["hasRecentPost", () => hasRecentPost(bad, "austin", "am")],
    ["getRecentlyPostedIds", () => getRecentlyPostedIds(bad, "austin", 30)],
    ["getRecentlyPostedFileNames", () => getRecentlyPostedFileNames(bad, "austin", 30)],
    ["getRecentlyPostedIdsAllCities", () => getRecentlyPostedIdsAllCities(bad, 30)],
    ["getRecentlyPostedFileNamesAllCities", () => getRecentlyPostedFileNamesAllCities(bad, 30)],
    ["getLastPersonaForCity", () => getLastPersonaForCity(bad, "austin")],
    ["pickPersona", () => pickPersona(bad, "austin")],
    ["getRecentTranscripts", () => getRecentTranscripts(bad, 5)],
    ["findContentDuplicate", () => findContentDuplicate(bad, FP, {})],
  ];

  for (const [name, fn] of cases) {
    test(name, () => assert.doesNotThrow(fn));
  }

  test("the valid entry is still read, not thrown away with the junk", () => {
    assert.equal(getLastPersonaForCity(bad, "austin"), "storyteller");
    assert.ok(getRecentlyPostedFileNamesAllCities(bad, 30).has("x.mp4"));
    assert.equal(wasPostedRecently(bad, "X", 30), true);
  });
});
