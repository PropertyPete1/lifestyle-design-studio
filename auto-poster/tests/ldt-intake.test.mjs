/**
 * Intake-folder flow — the LDT lane's content source, and the brand scoping
 * of the shared posted-log.
 *
 * Two rule sets meet here:
 *   - SELECTION: oldest clip first, each clip posts exactly ONCE (no 30-day
 *     rotation — screen recordings are not evergreen city footage), re-uploads
 *     caught by fileName, blocklist respected, octet-stream .mov files kept
 *     (the phone-sync posture drive.js documents).
 *   - SCOPING: LDT entries live in the same posted-log.json as everything
 *     else, distinguished by brand:"ldt". The realty cross-city guards must
 *     not see them (an LDT clip named IMG_1234.MOV must not block a realty
 *     video of the same name), and the LDT guards must not see realty.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isVideoLike, pickIntakeCandidates, hasBrandTypeToday } from "../src/ldt-intake.js";
import {
  getBrandPostedIds, getBrandPostedFileNames,
  getRecentlyPostedIdsAllCities, getRecentlyPostedFileNamesAllCities,
} from "../src/state.js";

const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();

const FILES = [
  { id: "vid-new", name: "floor-demo.mp4", mimeType: "video/mp4", createdTime: iso(1 * 3600_000) },
  { id: "vid-old", name: "compose-card.mov", mimeType: "application/octet-stream", createdTime: iso(72 * 3600_000) },
  { id: "vid-mid", name: "voice-turn.mp4", mimeType: "video/mp4", createdTime: iso(24 * 3600_000) },
  { id: "doc-1", name: "notes.txt", mimeType: "text/plain", createdTime: iso(3600_000) },
];

describe("isVideoLike", () => {
  test("mimeType video/* is a video", () => {
    assert.equal(isVideoLike({ mimeType: "video/mp4", name: "a.mp4" }), true);
  });
  test("octet-stream .mov is a video (phone-sync posture)", () => {
    assert.equal(isVideoLike({ mimeType: "application/octet-stream", name: "clip.MOV" }), true);
  });
  test("a text file is not, even from a video folder", () => {
    assert.equal(isVideoLike({ mimeType: "text/plain", name: "notes.txt" }), false);
    assert.equal(isVideoLike({ mimeType: "application/octet-stream", name: "archive.zip" }), false);
  });
});

describe("candidate selection", () => {
  test("oldest first, non-videos skipped with a reason", () => {
    const { eligible, skipped } = pickIntakeCandidates(FILES, { posts: [] }, null);
    assert.deepEqual(eligible.map(f => f.id), ["vid-old", "vid-mid", "vid-new"]);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].reason, "not a video");
  });

  test("a clip posts exactly once — driveFileId match, no time window", () => {
    // 100 days old: outside every realty rotation window, still excluded.
    const log = { posts: [{ brand: "ldt", type: "ldt_clip", driveFileId: "vid-old", fileName: "compose-card.mov", timestamp: iso(100 * 24 * 3600_000), success: true }] };
    const { eligible, skipped } = pickIntakeCandidates(FILES, log, null);
    assert.deepEqual(eligible.map(f => f.id), ["vid-mid", "vid-new"]);
    assert.ok(skipped.some(s => s.reason.includes("driveFileId")));
  });

  test("a re-upload with a new id but a posted fileName is excluded", () => {
    const log = { posts: [{ brand: "ldt", type: "ldt_clip", driveFileId: "gone", fileName: "voice-turn.mp4", timestamp: iso(3600_000), success: true }] };
    const { eligible } = pickIntakeCandidates(FILES, log, null);
    assert.ok(!eligible.some(f => f.name === "voice-turn.mp4"));
  });

  test("a REALTY post of the same driveFileId does not block the LDT lane", () => {
    const log = { posts: [{ city: "austin", driveFileId: "vid-old", fileName: "compose-card.mov", timestamp: iso(3600_000), success: true }] };
    const { eligible } = pickIntakeCandidates(FILES, log, null);
    assert.ok(eligible.some(f => f.id === "vid-old"), "brand scoping: realty history is not LDT history");
  });

  test("blocklisted clips are excluded", () => {
    const blocklist = { blockedDriveIds: { "vid-mid": { filename: "voice-turn.mp4", reason: "too short", blockedAt: iso(0) } } };
    const { eligible, skipped } = pickIntakeCandidates(FILES, { posts: [] }, blocklist);
    assert.ok(!eligible.some(f => f.id === "vid-mid"));
    assert.ok(skipped.some(s => s.reason === "qc-blocklist"));
  });
});

describe("brand scoping of the shared posted-log", () => {
  const log = {
    posts: [
      { city: "austin", driveFileId: "realty-1", fileName: "IMG_1234.MOV", timestamp: iso(3600_000), success: true },
      { brand: "ldt", type: "ldt_clip", driveFileId: "ldt-1", fileName: "IMG_1234.MOV", timestamp: iso(3600_000), success: true },
    ],
  };

  test("realty cross-city guards do not see LDT entries", () => {
    // Same phone filename on both brands: without the brand filter, the LDT
    // clip would block realty's IMG_1234.MOV for 30 days — different account,
    // different folder, not a repost.
    assert.equal(getRecentlyPostedIdsAllCities(log, 30).has("ldt-1"), false);
    assert.equal(getRecentlyPostedIdsAllCities(log, 30).has("realty-1"), true);
    const names = getRecentlyPostedFileNamesAllCities(log, 30);
    assert.equal(names.has("IMG_1234.MOV"), true, "realty's own entry still counts");
  });

  test("LDT guards see only LDT entries", () => {
    assert.deepEqual([...getBrandPostedIds(log, "ldt")], ["ldt-1"]);
    assert.deepEqual([...getBrandPostedFileNames(log, "ldt")], ["IMG_1234.MOV"]);
    assert.deepEqual([...getBrandPostedIds(log, "realty")], [], "legacy realty entries carry no brand field");
  });
});

describe("one post per format per day", () => {
  // The self-made angle is deterministic per Chicago DATE — without this
  // guard a second same-day post of one format would tell the same story
  // (cadence 2/day and the 3h gap both pass at the second slot, and the
  // rotation only DEMOTES the previous kind — a walk whose other generators
  // fail lands right back on the morning's format).
  const NOW = new Date("2026-08-29T22:00:00Z"); // 5 PM CT, the second slot
  const entry = (over) => ({
    brand: "ldt", type: "ldt_carousel", platforms: ["instagram", "tiktok"],
    timestamp: "2026-08-29T15:05:00.000Z", success: true, ...over,
  });

  test("a carousel posted this CT morning blocks the evening carousel", () => {
    assert.equal(hasBrandTypeToday({ posts: [entry()] }, "ldt", "ldt_carousel", NOW), true);
  });

  test("the dedup is PER FORMAT — a morning carousel does not block a card or a text reel", () => {
    const log = { posts: [entry()] };
    assert.equal(hasBrandTypeToday(log, "ldt", "ldt_card", NOW), false);
    assert.equal(hasBrandTypeToday(log, "ldt", "ldt_text_reel", NOW), false);
  });

  test("yesterday's post does not block today", () => {
    const log = { posts: [entry({ timestamp: "2026-08-28T15:05:00.000Z" })] };
    assert.equal(hasBrandTypeToday(log, "ldt", "ldt_carousel", NOW), false);
  });

  test("other types do not count, failures do not count, brands do not cross", () => {
    assert.equal(hasBrandTypeToday({ posts: [entry({ type: "ldt_clip" })] }, "ldt", "ldt_carousel", NOW), false);
    assert.equal(hasBrandTypeToday({ posts: [entry({ success: false })] }, "ldt", "ldt_carousel", NOW), false);
    assert.equal(hasBrandTypeToday({ posts: [entry()] }, "otherbrand", "ldt_carousel", NOW), false);
  });
});
