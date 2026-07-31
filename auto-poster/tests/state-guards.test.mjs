/**
 * Duplicate-post guards — the highest-consequence logic in the system.
 *
 * A silent bug here does not cause a missed post; it causes the SAME video to be
 * published to the same Instagram account twice, which is what triggers account
 * restrictions. These tests pin the exact guard semantics.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  hasRecentPost,
  getRecentlyPostedIds,
  getRecentlyPostedFileNames,
  getRecentlyPostedIdsAllCities,
  getRecentlyPostedFileNamesAllCities,
} from "../src/state.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

const mkLog = (posts) => ({ posts, lastTemplateIndex: -1 });

describe("hasRecentPost — slot guard + 2h hard cooldown", () => {
  test("allows a post when the log is empty", () => {
    assert.equal(hasRecentPost(mkLog([]), "san_antonio", "am").blocked, false);
  });

  test("BLOCKS same city + same slot inside 20h", () => {
    const log = mkLog([{ city: "san_antonio", slot: "am", timestamp: ago(19 * HOUR) }]);
    const r = hasRecentPost(log, "san_antonio", "am");
    assert.equal(r.blocked, true);
    assert.match(r.reason, /slot am/);
  });

  test("allows same city + same slot after 20h", () => {
    const log = mkLog([{ city: "san_antonio", slot: "am", timestamp: ago(21 * HOUR) }]);
    assert.equal(hasRecentPost(log, "san_antonio", "am").blocked, false);
  });

  test("BLOCKS same city, DIFFERENT slot, inside the 2h hard cooldown", () => {
    // This is the backup-cron overlap case: pm slot firing right after am posted.
    const log = mkLog([{ city: "san_antonio", slot: "am", timestamp: ago(30 * 60 * 1000) }]);
    const r = hasRecentPost(log, "san_antonio", "pm");
    assert.equal(r.blocked, true);
    assert.match(r.reason, /hard-cooldown/);
  });

  test("allows same city, different slot, outside the 2h cooldown", () => {
    const log = mkLog([{ city: "san_antonio", slot: "am", timestamp: ago(3 * HOUR) }]);
    assert.equal(hasRecentPost(log, "san_antonio", "pm").blocked, false);
  });

  test("does not block a DIFFERENT city", () => {
    const log = mkLog([{ city: "san_antonio", slot: "am", timestamp: ago(10 * 60 * 1000) }]);
    assert.equal(hasRecentPost(log, "austin", "am").blocked, false);
  });

  test("legacy entries with no slot field are treated as pm", () => {
    const log = mkLog([{ city: "dallas", timestamp: ago(10 * HOUR) }]);
    assert.equal(hasRecentPost(log, "dallas", "pm").blocked, true);
    assert.equal(hasRecentPost(log, "dallas", "am").blocked, false);
  });

  describe("entry types excluded from slot guards", () => {
    for (const entry of [
      { label: "linkedin", extra: { type: "linkedin" } },
      { label: "trial_variant", extra: { type: "trial_variant" } },
      { label: "trial_variant_confirm", extra: { type: "trial_variant_confirm" } },
      { label: "main IG manual receipt", extra: { platform: "instagram_main_native" } },
    ]) {
      test(`${entry.label} does NOT block a slot post`, () => {
        const log = mkLog([{ city: "austin", slot: "am", timestamp: ago(5 * 60 * 1000), ...entry.extra }]);
        assert.equal(hasRecentPost(log, "austin", "am").blocked, false);
      });
    }
  });

  test("blocks on ANY qualifying entry, not just the first in the array", () => {
    const log = mkLog([
      { city: "austin", slot: "pm", timestamp: ago(40 * DAY) },
      { city: "austin", slot: "am", timestamp: ago(1 * HOUR) }, // inside cooldown
    ]);
    assert.equal(hasRecentPost(log, "austin", "pm").blocked, true);
  });
});

describe("30-day duplicate-content guard", () => {
  const log = mkLog([
    { city: "san_antonio", driveFileId: "SA_OLD", fileName: "old.mp4", timestamp: ago(45 * DAY) },
    { city: "san_antonio", driveFileId: "SA_RECENT", fileName: "recent.mp4", timestamp: ago(10 * DAY) },
    { city: "austin", driveFileId: "ATX_RECENT", fileName: "shared.mp4", timestamp: ago(5 * DAY) },
  ]);

  test("includes ids inside the 30-day window, excludes older", () => {
    const ids = getRecentlyPostedIds(log, "san_antonio", 30);
    assert.ok(ids.has("SA_RECENT"));
    assert.ok(!ids.has("SA_OLD"));
  });

  test("fileName guard catches a re-upload with a NEW driveFileId", () => {
    // The regression that caused the real incident: same file re-uploaded to
    // Drive gets a fresh id, so the id check alone lets it through.
    const names = getRecentlyPostedFileNames(log, "san_antonio", 30);
    assert.ok(names.has("recent.mp4"));
  });

  test("per-city guard does NOT see another city's post (documents why the global guard exists)", () => {
    const saNames = getRecentlyPostedFileNames(log, "san_antonio", 30);
    assert.ok(!saNames.has("shared.mp4"));
  });

  test("cross-city guard DOES catch the same fileName posted under another city", () => {
    // All cities fan out to the same IG/TikTok/YouTube accounts, so this is a
    // real duplicate from the platform's point of view.
    const names = getRecentlyPostedFileNamesAllCities(log, 30);
    assert.ok(names.has("shared.mp4"));
    assert.ok(names.has("recent.mp4"));
  });

  test("cross-city id guard catches the same driveFileId under another city", () => {
    const ids = getRecentlyPostedIdsAllCities(log, 30);
    assert.ok(ids.has("ATX_RECENT"));
    assert.ok(!ids.has("SA_OLD"));
  });

  test("boundary: a post exactly 29 days old still blocks, 31 days does not", () => {
    const boundary = mkLog([
      { city: "dallas", driveFileId: "D29", fileName: "d29.mp4", timestamp: ago(29 * DAY) },
      { city: "dallas", driveFileId: "D31", fileName: "d31.mp4", timestamp: ago(31 * DAY) },
    ]);
    const ids = getRecentlyPostedIds(boundary, "dallas", 30);
    assert.ok(ids.has("D29"));
    assert.ok(!ids.has("D31"));
  });

  test("entries missing fileName do not produce an undefined member", () => {
    const partial = mkLog([{ city: "dallas", driveFileId: "X", timestamp: ago(1 * DAY) }]);
    const names = getRecentlyPostedFileNames(partial, "dallas", 30);
    assert.ok(!names.has(undefined));
    assert.equal(names.size, 0);
  });
});
