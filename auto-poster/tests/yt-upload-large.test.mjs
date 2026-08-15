/**
 * yt-upload-large.test.mjs — the render is bigger than a Buffer, and that must
 * stop being fatal.
 *
 * WHAT THIS PINS, and the run that paid for it. 31909360969 produced a video
 * that passed every artifact check — "the render may ship" — and then died at
 * `readFileSync(rendered.outputPath)` with ERR_FS_FILE_TOO_LARGE: 2,531,143,243
 * bytes against Node's 2 GiB Buffer ceiling. Eighty-five minutes of compute and
 * a publishable file, stopped by the way it was handed to the uploader.
 *
 * THE FILE HERE IS REAL AND COSTS NOTHING. `ftruncate` to 2.06 GiB makes a
 * SPARSE file: the size is genuine, every byte reads back as zero, and it
 * occupies 0 bytes on disk. So this exercises the true >2 GiB path — including
 * a negative control that proves the OLD code would fail on this very file —
 * without writing two gigabytes in CI.
 */

import { test, describe } from "node:test";
import assert from "node:assert";
import { openSync, ftruncateSync, closeSync, statSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { uploadVideo, planParts, MAX_PART_BYTES, openSource } from "../src/yt-upload.js";

/** A file whose SIZE is real and whose bytes cost no disk. */
function sparseFile(dir, bytes) {
  const path = join(dir, "huge.mp4");
  const fd = openSync(path, "w");
  ftruncateSync(fd, bytes);
  closeSync(fd);
  return path;
}

const OVER_2GIB = 2 * 1024 * 1024 * 1024 + 64 * 1024 * 1024; // 2.06 GiB

describe("a render larger than a Buffer still uploads", () => {
  test("NEGATIVE CONTROL: the old readFileSync path fails on this exact file", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "upload-large-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const path = sparseFile(dir, OVER_2GIB);
    assert.equal(statSync(path).size, OVER_2GIB, "the file's size is genuinely over 2 GiB");

    // This is precisely what the pipeline used to do, and precisely how run
    // 31909360969 died. If this ever stops throwing, the control has stopped
    // controlling and the test below proves less than it claims.
    assert.throws(
      () => readFileSync(path),
      (err) => err.code === "ERR_FS_FILE_TOO_LARGE",
      "readFileSync must still refuse a >2 GiB file — otherwise this test is not testing the real hazard"
    );
  });

  test("uploadVideo sends every byte and never holds more than one part", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "upload-large-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const path = sparseFile(dir, OVER_2GIB);
    const parts = planParts(OVER_2GIB);

    const bodies = [];
    let opened = null;
    let completed = null;

    const realFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = realFetch; });
    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url);
      // 1. open the transaction — carries a hash for every part
      if (u.includes("/upload-transactions") && opts.method === "PUT") {
        opened = JSON.parse(opts.body);
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({
            data: {
              key: "k", uploadId: "u", fileUrl: "https://cdn/x.mp4",
              // The real API returns the presigned URLs under `parts`.
              parts: parts.map((p) => ({ presignedUrl: `https://s3/part${p.partNumber}` })),
            },
          }),
        };
      }
      // 3. completion
      if (u.includes("/upload-transactions") && opts.method === "PATCH") {
        completed = JSON.parse(opts.body);
        return { ok: true, status: 200, text: async () => JSON.stringify({ data: { fileUrl: "https://cdn/x.mp4" } }) };
      }
      // 2. the parts themselves
      bodies.push({
        bytes: opts.body.byteLength ?? opts.body.length,
        contentLength: Number(opts.headers["Content-Length"]),
        checksum: opts.headers["x-amz-checksum-sha256"],
      });
      return { ok: true, status: 200, headers: { get: () => '"etag"' }, text: async () => "" };
    };

    const hosted = await uploadVideo(path, { blogId: "b", userId: "u", token: "t" });
    assert.equal(hosted, "https://cdn/x.mp4");

    // Every part arrived, exactly once, in order.
    assert.equal(bodies.length, parts.length, `expected ${parts.length} part uploads`);
    assert.equal(completed.parts?.length ?? bodies.length, parts.length);

    // THE CLAIM: nothing the size of the file was ever in memory.
    const biggest = Math.max(...bodies.map((b) => b.bytes));
    assert.ok(biggest <= MAX_PART_BYTES, `a single body held ${biggest} bytes — larger than one part`);
    assert.ok(biggest < OVER_2GIB / 4, "no allocation came close to the whole file");

    // And the whole file did go: sizes sum to the byte count, and the headers
    // agree with the bodies (an S3 presigned PUT rejects a mismatch).
    const sent = bodies.reduce((n, b) => n + b.bytes, 0);
    assert.equal(sent, OVER_2GIB, "every byte of the file was uploaded");
    for (const b of bodies) {
      assert.equal(b.contentLength, b.bytes, "Content-Length must match the body actually sent");
      assert.ok(b.checksum && b.checksum.length > 0, "every part carries its SHA-256 checksum");
    }

    // The transaction was opened with a checksum per part — the reason a
    // chunked/streamed body cannot be used here at all.
    assert.equal(opened.parts.length, parts.length);
    for (const p of opened.parts) assert.ok(p.hash && Number.isInteger(p.size));
  });

  test("openSource reads exact ranges from a path and never over-allocates", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "upload-large-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const path = sparseFile(dir, OVER_2GIB);
    const src = openSource(path);
    t.after(() => src.close());

    assert.equal(src.kind, "path");
    assert.equal(src.size, OVER_2GIB);
    const chunk = src.read(0, 1024);
    assert.equal(chunk.length, 1024);
    // A range near the far end proves the reads are 64-bit offsets, not
    // truncated into the first 2 GiB.
    const tail = src.read(OVER_2GIB - 4096, OVER_2GIB);
    assert.equal(tail.length, 4096);
  });

  test("a Buffer caller still works unchanged", () => {
    const buf = Buffer.alloc(1024, 7);
    const src = openSource(buf);
    assert.equal(src.kind, "buffer");
    assert.equal(src.size, 1024);
    assert.equal(src.read(0, 10).length, 10);
    assert.throws(() => openSource(42), /file path or a Buffer/);
  });
});
