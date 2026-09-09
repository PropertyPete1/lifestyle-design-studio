/**
 * The publish manifest, and the postId regression that made it necessary.
 *
 * Nothing in this pipeline joined a published reel to its Drive file. Two
 * separate defects produced that gap and both are pinned here:
 *
 *   1. metricool.js's multi-brand path read `raw.id`, but Metricool wraps the
 *      scheduler response in `data`. Every realty publish therefore recorded
 *      postId "unknown", main.js:524 filtered those out, and verification never
 *      ran — so no permalinks were ever written. The single-brand path (:452)
 *      and carousel-distribute.js:143 always read the wrapper; only the lane
 *      that does all the posting did not.
 *
 *   2. There was no manifest at all.
 *
 * The merge test is the one that matters most for durability: a state file with
 * no registered strategy is written locally and then discarded by
 * merge-log-push.mjs's `git reset --hard origin/main`. It would look written on
 * every run and never reach the repo.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildManifestRow,
  loadManifest,
  recordPublish,
  recordPublishVerification,
  instagramShortcode,
  MANIFEST_SCHEMA_VERSION,
} from "../src/publish-manifest.js";
import { MERGE_STRATEGIES, MERGE_FILES, mergePublishManifest } from "../merge-strategies.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "manifest-test-"));

describe("buildManifestRow", () => {
  test("carries every field the decision task needs to trace a winner", () => {
    const row = buildManifestRow({
      driveFileId: "1abc",
      fileName: "AE582A40.mp4",
      market: "san_antonio",
      community: "Stone Oak",
      caption: "look at this kitchen",
      slot: "am",
      runId: "42",
      postedAt: "2026-09-09T18:00:00.000Z",
      brands: [
        { ok: true, label: "sat1", blogId: 1, postId: "p1", providers: ["instagram"] },
        { ok: true, label: "sat2", blogId: 2, postId: "p2", providers: ["instagram", "tiktok"] },
      ],
    });
    assert.equal(row.drive_file_id, "1abc");
    assert.equal(row.market, "san_antonio");
    assert.equal(row.community, "Stone Oak");
    assert.equal(row.caption, "look at this kitchen");
    assert.equal(row.posted_at, "2026-09-09T18:00:00.000Z");
    assert.equal(row.schema_version, MANIFEST_SCHEMA_VERSION);
    assert.equal(row.targets.length, 2);
    assert.deepEqual(row.targets[1].networks, ["instagram", "tiktok"]);
  });

  test("missing values are null, never invented — community is not defaulted to the city", () => {
    const row = buildManifestRow({ driveFileId: "1abc", market: "austin" });
    assert.equal(row.community, null);
    assert.equal(row.file_name, null);
    assert.equal(row.caption, null);
    assert.deepEqual(row.reel_urls, []);
  });

  test('a postId of "unknown" is recorded as null, not as the string', () => {
    const row = buildManifestRow({
      driveFileId: "1abc",
      brands: [{ ok: true, label: "s", blogId: 1, postId: "unknown", providers: ["instagram"] }],
    });
    assert.equal(row.targets[0].post_id, null);
  });

  test("failed brands are not recorded as targets", () => {
    const row = buildManifestRow({
      driveFileId: "1abc",
      brands: [
        { ok: false, label: "bad", error: "429" },
        { ok: true, label: "good", blogId: 2, postId: "p2", providers: ["instagram"] },
      ],
    });
    assert.equal(row.targets.length, 1);
    assert.equal(row.targets[0].label, "good");
  });

  test("refuses a row with no Drive file id — an untraceable row is the bug, not a record", () => {
    assert.throws(() => buildManifestRow({ market: "austin" }), /driveFileId/);
  });
});

describe("persistence never costs a post", () => {
  test("a corrupt manifest reads as empty rather than throwing", () => {
    const dir = tmp();
    const p = join(dir, "publish-manifest.json");
    writeFileSync(p, "{not json");
    assert.deepEqual(loadManifest(p).publishes, []);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a manifest whose publishes is not an array reads as empty", () => {
    const dir = tmp();
    const p = join(dir, "publish-manifest.json");
    writeFileSync(p, JSON.stringify({ publishes: "nope" }));
    assert.deepEqual(loadManifest(p).publishes, []);
    rmSync(dir, { recursive: true, force: true });
  });

  test("an unwritable path warns and returns the row instead of throwing", () => {
    // The post has already gone out by the time this runs. Losing the audit row
    // must not turn a successful publish into a red run.
    const row = recordPublish(
      { driveFileId: "1abc", market: "austin" },
      { path: "/nonexistent-dir-xyz/publish-manifest.json" }
    );
    assert.equal(row.drive_file_id, "1abc");
  });

  test("rows append across calls", () => {
    const dir = tmp();
    const p = join(dir, "publish-manifest.json");
    recordPublish({ driveFileId: "a", postedAt: "2026-09-09T10:00:00.000Z" }, { path: p });
    recordPublish({ driveFileId: "b", postedAt: "2026-09-09T11:00:00.000Z" }, { path: p });
    assert.equal(loadManifest(p).publishes.length, 2);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("permalink attachment", () => {
  test("attaches Instagram permalinks and their shortcodes to the matching row", () => {
    const dir = tmp();
    const p = join(dir, "publish-manifest.json");
    recordPublish({ driveFileId: "1abc", postedAt: "2026-09-09T10:00:00.000Z" }, { path: p });
    recordPublishVerification(
      "1abc",
      [
        { network: "instagram", label: "sat1", publicUrl: "https://www.instagram.com/reel/Dcr3FtyiuBZ/", verified: true },
        { network: "tiktok", label: "sat1", publicUrl: "https://tiktok.com/@x/video/123", verified: true },
        { network: "youtube", label: "sat1", verdict: "pending" },
      ],
      { path: p }
    );
    const [row] = loadManifest(p).publishes;
    assert.equal(row.reel_urls.length, 2, "rows without a publicUrl are not recorded");
    assert.equal(row.reel_urls[0].shortcode, "Dcr3FtyiuBZ");
    assert.equal(row.reel_urls[1].shortcode, null, "non-Instagram URLs are kept whole, not mis-parsed");
    rmSync(dir, { recursive: true, force: true });
  });

  test("attaches to the MOST RECENT row for a Drive file, not the first", () => {
    const dir = tmp();
    const p = join(dir, "publish-manifest.json");
    recordPublish({ driveFileId: "1abc", postedAt: "2026-08-01T10:00:00.000Z" }, { path: p });
    recordPublish({ driveFileId: "1abc", postedAt: "2026-09-09T10:00:00.000Z" }, { path: p });
    recordPublishVerification("1abc", [{ network: "instagram", publicUrl: "https://www.instagram.com/reel/AAA/" }], { path: p });
    const rows = loadManifest(p).publishes;
    assert.deepEqual(rows[0].reel_urls, [], "the older airing keeps its own (empty) record");
    assert.equal(rows[1].reel_urls[0].shortcode, "AAA");
    rmSync(dir, { recursive: true, force: true });
  });

  test("an unmatched Drive file warns rather than corrupting another row", () => {
    const dir = tmp();
    const p = join(dir, "publish-manifest.json");
    recordPublish({ driveFileId: "1abc", postedAt: "2026-09-09T10:00:00.000Z" }, { path: p });
    const out = recordPublishVerification("1zzz", [{ network: "instagram", publicUrl: "https://www.instagram.com/reel/AAA/" }], { path: p });
    assert.equal(out, null);
    assert.deepEqual(loadManifest(p).publishes[0].reel_urls, []);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("instagramShortcode", () => {
  test("parses reel, reels and p permalinks", () => {
    assert.equal(instagramShortcode("https://www.instagram.com/reel/Dcr3FtyiuBZ/"), "Dcr3FtyiuBZ");
    assert.equal(instagramShortcode("https://instagram.com/reels/Ab-c_1/"), "Ab-c_1");
    assert.equal(instagramShortcode("https://www.instagram.com/p/XYZ123/?igsh=1"), "XYZ123");
  });

  test("returns null rather than guessing at an unknown shape", () => {
    assert.equal(instagramShortcode("https://tiktok.com/@x/video/1"), null);
    assert.equal(instagramShortcode(null), null);
    assert.equal(instagramShortcode(""), null);
  });
});

describe("write-back — the silent-discard trap", () => {
  test("publish-manifest.json is registered in MERGE_STRATEGIES", () => {
    // Without this the file is written locally every run and never committed:
    // merge-log-push.mjs takes its file list from Object.keys(MERGE_STRATEGIES)
    // and then hard-resets the working tree to origin/main.
    assert.ok(MERGE_FILES.includes("publish-manifest.json"));
    assert.equal(typeof MERGE_STRATEGIES["publish-manifest.json"], "function");
  });

  test("merge is union-append — a row present only remotely is never dropped", () => {
    const remote = { publishes: [{ posted_at: "t1", drive_file_id: "a", reel_urls: [] }] };
    const local = { publishes: [{ posted_at: "t2", drive_file_id: "b", reel_urls: [] }] };
    const out = mergePublishManifest(local, remote, () => {});
    assert.equal(out.publishes.length, 2);
    assert.deepEqual(out.publishes.map((r) => r.drive_file_id).sort(), ["a", "b"]);
  });

  test("on a key collision the side with MORE permalinks wins, not the local side", () => {
    // video-matches.json's local-wins merge has destroyed 10 Instagram ids
    // across 7 commits, several from runs whose local copy was simply older.
    // A concurrent city's run must not revert a sibling's verification.
    const remote = {
      publishes: [{ posted_at: "t1", drive_file_id: "a", reel_urls: [{ url: "u1" }, { url: "u2" }] }],
    };
    const local = { publishes: [{ posted_at: "t1", drive_file_id: "a", reel_urls: [] }] };
    const out = mergePublishManifest(local, remote, () => {});
    assert.equal(out.publishes.length, 1);
    assert.equal(out.publishes[0].reel_urls.length, 2, "the enriched remote row survived a bare local one");
  });

  test("local enrichment of a remote row is kept", () => {
    const remote = { publishes: [{ posted_at: "t1", drive_file_id: "a", reel_urls: [] }] };
    const local = { publishes: [{ posted_at: "t1", drive_file_id: "a", reel_urls: [{ url: "u1" }] }] };
    const out = mergePublishManifest(local, remote, () => {});
    assert.equal(out.publishes[0].reel_urls.length, 1);
  });

  test("rows with an unparseable posted_at are KEPT, not silently deleted", () => {
    const out = mergePublishManifest(
      { publishes: [{ posted_at: "not-a-date", drive_file_id: "a" }] },
      { publishes: [] },
      () => {}
    );
    assert.equal(out.publishes.length, 1);
  });

  test("rows past the retention window are trimmed", () => {
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    const out = mergePublishManifest(
      { publishes: [{ posted_at: old, drive_file_id: "a" }] },
      { publishes: [] },
      () => {}
    );
    assert.equal(out.publishes.length, 0);
  });

  test("a missing remote file is tolerated by the dispatch entry", () => {
    const out = MERGE_STRATEGIES["publish-manifest.json"](
      { publishes: [{ posted_at: "t1", drive_file_id: "a" }] },
      null,
      () => {}
    );
    assert.equal(out.publishes.length, 1);
  });
});

describe("metricool postId extraction — the regression that broke verification", () => {
  test("the multi-brand path reads the data wrapper, like every sibling reader", () => {
    // Pinned as source text: extracting this expression would mean refactoring
    // the fan-out loop, and the point of the test is that the two paths agree.
    const src = readFileSync(new URL("../src/metricool.js", import.meta.url), "utf-8");
    const readers = src.match(/raw\?\.data\?\.id \|\| raw\?\.id \|\| raw\?\.postId/g) || [];
    assert.ok(
      readers.length >= 2,
      "both the multi-brand and single-brand paths must read raw.data.id first"
    );
    assert.ok(
      !/const postId = raw\?\.id \|\| raw\?\.postId \|\| "unknown"/.test(src),
      "the wrapper-blind extraction must not come back"
    );
  });
});
