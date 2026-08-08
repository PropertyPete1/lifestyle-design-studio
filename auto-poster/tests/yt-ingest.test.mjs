/**
 * Getting Peter's recordings out of Drive.
 *
 * The case that matters is the mistyped upload. The dashboard sent the first
 * take up as text/plain with valid mp4 bytes inside, and a mimeType filter
 * drops that file silently — which the pipeline reads as "he has not recorded
 * that take yet" and reports as a missing take. Wrong, and quietly wrong.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { looksLikeRecording, listRecordings } from "../src/yt-ingest.js";

/** A Drive files.list entry, with only the fields the ingest reads. */
function driveFile(name, mimeType, extra = {}) {
  return { id: `id-${name}`, name, mimeType, createdTime: "2026-08-01T10:00:00Z", ...extra };
}

describe("looksLikeRecording", () => {
  test("keeps a take whose mimeType Drive got wrong", () => {
    assert.equal(looksLikeRecording(driveFile("s1t1.mp4", "text/plain")), true);
  });

  test("keeps takes typed correctly, video and audio alike", () => {
    assert.equal(looksLikeRecording(driveFile("s1t2.mov", "video/quicktime")), true);
    assert.equal(looksLikeRecording(driveFile("s2t1.m4a", "audio/mp4")), true);
  });

  test("keeps a clip that arrived with a type but no extension", () => {
    assert.equal(looksLikeRecording(driveFile("IMG_4021", "video/mp4")), true);
  });

  test("drops files that are neither by name nor by type", () => {
    assert.equal(looksLikeRecording(driveFile("shot-list.txt", "text/plain")), false);
    assert.equal(looksLikeRecording(driveFile("thumbnail.png", "image/png")), false);
    assert.equal(looksLikeRecording(driveFile("notes", "application/octet-stream")), false);
  });

  test("drops Google's own doc types — alt=media cannot fetch their bytes", () => {
    // Named like a take, and still not one: exporting is a different call.
    assert.equal(
      looksLikeRecording(driveFile("s1t1.mp4", "application/vnd.google-apps.document")),
      false
    );
    assert.equal(
      looksLikeRecording(driveFile("takes", "application/vnd.google-apps.folder")),
      false
    );
  });

  test("survives a file entry missing the fields it reads", () => {
    assert.equal(looksLikeRecording({}), false);
    assert.equal(looksLikeRecording(null), false);
  });
});

describe("listRecordings", () => {
  /** Serve one canned files.list page and capture the query that asked for it. */
  function stubDrive(files) {
    const realFetch = globalThis.fetch;
    const realLog = console.log;
    const seen = { queries: [], logs: [] };
    globalThis.fetch = async (url) => {
      seen.queries.push(new URL(String(url)).searchParams.get("q"));
      return { ok: true, status: 200, json: async () => ({ files }), text: async () => "" };
    };
    console.log = (...a) => seen.logs.push(a.join(" "));
    return {
      seen,
      restore: () => {
        globalThis.fetch = realFetch;
        console.log = realLog;
      },
    };
  }

  test("returns the mistyped take and leaves the shot list behind", async () => {
    const stub = stubDrive([
      driveFile("s1t1.mp4", "text/plain"),
      driveFile("shot-list.txt", "text/plain"),
      driveFile("s1t2.mov", "video/quicktime"),
    ]);
    try {
      const files = await listRecordings("folder1", "token");
      assert.deepEqual(files.map((f) => f.name), ["s1t1.mp4", "s1t2.mov"]);
      assert.ok(
        stub.seen.logs.some((l) => l.includes("shot-list.txt")),
        "a skipped file should say so — a silent drop is what caused this bug"
      );
    } finally {
      stub.restore();
    }
  });

  test("does not ask Drive to filter on the mimeType it gets wrong", async () => {
    const stub = stubDrive([]);
    try {
      await listRecordings("folder1", "token");
      const q = stub.seen.queries[0];
      assert.ok(!q.includes("video/"), `query still filters on type: ${q}`);
      assert.ok(!q.includes("audio/"), `query still filters on type: ${q}`);
      assert.ok(q.includes("'folder1' in parents"), q);
      assert.ok(q.includes("trashed = false"), q);
    } finally {
      stub.restore();
    }
  });
});
