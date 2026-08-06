/**
 * The multipart uploader.
 *
 * planParts is where an off-by-one either drops bytes or produces an undersized
 * part — and an undersized part uploads FINE and returns an etag, failing only
 * at completion after the whole file has been transferred. So the bounds are
 * tested hard, at the sizes the real pipeline produces.
 *
 * The shapes here are not guesses: a live 3-part round-trip on 2026-08-05
 * established the completion body and both size bounds.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  planParts,
  completionBody,
  simpleCompletionBody,
  sha256b64,
  MIN_PART_BYTES,
  MAX_PART_BYTES,
  TARGET_PART_BYTES,
  SINGLE_PART_LIMIT,
} from "../src/yt-upload.js";

const MB = 1024 * 1024;

/** Every invariant a part plan must satisfy, checked together. */
function assertValidPlan(plan, total) {
  assert.ok(plan.length > 0, "a plan must have parts");
  assert.equal(plan.reduce((n, p) => n + p.size, 0), total, "the plan must cover every byte exactly once");
  assert.equal(plan[0].start, 0, "the first part must start at zero");
  assert.equal(plan[plan.length - 1].end, total, "the last part must end at the last byte");
  plan.forEach((p, i) => {
    assert.equal(p.partNumber, i + 1, "part numbers must be 1-based and contiguous");
    assert.ok(p.size > 0, `part ${p.partNumber} is empty`);
    assert.ok(p.size <= MAX_PART_BYTES, `part ${p.partNumber} is over Metricool's ceiling`);
    if (i > 0) assert.equal(p.start, plan[i - 1].end, "parts must be contiguous with no gap or overlap");
    // S3: every part but the last must clear 5 MiB.
    if (i < plan.length - 1) {
      assert.ok(p.size >= MIN_PART_BYTES, `part ${p.partNumber} is ${p.size}, under S3's 5 MiB minimum`);
    }
  });
}

describe("planParts — bounds that only fail after the whole transfer", () => {
  test("a small file stays single-part", () => {
    const plan = planParts(8 * MB);
    assert.equal(plan.length, 1);
    assertValidPlan(plan, 8 * MB);
  });

  test("exactly at the single-part limit stays single", () => {
    const plan = planParts(SINGLE_PART_LIMIT);
    assert.equal(plan.length, 1);
  });

  test("one byte over the limit goes multipart", () => {
    const plan = planParts(SINGLE_PART_LIMIT + 1);
    assert.ok(plan.length > 1);
    assertValidPlan(plan, SINGLE_PART_LIMIT + 1);
  });

  test("THE REAL CASE: a 320MB 1080p render", () => {
    const total = 321 * MB;
    const plan = planParts(total);
    assertValidPlan(plan, total);
    console.log(`      320MB -> ${plan.length} parts of ~${(plan[0].size / MB).toFixed(0)}MB`);
    assert.ok(plan.length >= 4 && plan.length <= 10, `${plan.length} parts is outside a sensible range`);
  });

  test("THE 4K CASE: a 1.05GB render", () => {
    const total = 1048 * MB;
    const plan = planParts(total);
    assertValidPlan(plan, total);
    assert.ok(plan.length >= 11, "a gigabyte needs at least 11 parts under the 100MB ceiling");
  });

  test("no part ever exceeds Metricool's ceiling, across a wide sweep", () => {
    for (let mb = 100; mb <= 2000; mb += 37) {
      const total = mb * MB;
      assertValidPlan(planParts(total), total);
    }
  });

  test("no NON-FINAL part is ever under S3's minimum, across a wide sweep", () => {
    // The nasty sizes are the ones just over a part boundary, where a naive
    // split leaves a runt final part or a runt part somewhere in the middle.
    for (let extra = 1; extra <= 6 * MB; extra += 521_437) {
      const total = MAX_PART_BYTES + extra;
      assertValidPlan(planParts(total), total);
    }
  });

  test("a size that would leave a runt final part uses fewer, bigger parts instead", () => {
    // 100MB + 1KB naively splits into 100MB + 1KB — the 1KB tail is legal
    // (final parts may be small) but the FIRST part must still be legal too.
    const total = MAX_PART_BYTES + 1024;
    const plan = planParts(total);
    assertValidPlan(plan, total);
  });

  test("honours a smaller target part size while respecting the floor", () => {
    const total = 300 * MB;
    const plan = planParts(total, { targetPartBytes: 10 * MB });
    assertValidPlan(plan, total);
    assert.ok(plan.length > 10, "a smaller target should mean more parts");
  });

  test("a target under the floor is raised to the floor rather than producing illegal parts", () => {
    const total = 300 * MB;
    const plan = planParts(total, { targetPartBytes: 1024 });
    assertValidPlan(plan, total);
  });

  test("a target over the ceiling is clamped down", () => {
    const total = 300 * MB;
    const plan = planParts(total, { targetPartBytes: 500 * MB });
    assertValidPlan(plan, total);
  });

  test("rejects nonsense sizes rather than producing an empty plan", () => {
    assert.throws(() => planParts(0));
    assert.throws(() => planParts(-1));
    assert.throws(() => planParts(null));
    assert.throws(() => planParts(1.5));
  });
});

describe("completionBody — the shape a live round-trip established", () => {
  const parts = [
    { partNumber: 1, etag: "aaa" },
    { partNumber: 2, etag: "bbb" },
    { partNumber: 3, etag: "ccc" },
  ];

  test("carries the key, which is what the first attempt was missing", () => {
    // The failure was: {"multipart.key":"Key is required"}
    const body = completionBody({ key: "planner/1/202608/x.mp4", uploadId: "u1", parts });
    assert.equal(body.multipart.key, "planner/1/202608/x.mp4");
    assert.equal(body.multipart.uploadId, "u1");
  });

  test("uses LOWERCASE partNumber and etag — the capitalised variant is rejected", () => {
    const body = completionBody({ key: "k", uploadId: "u", parts });
    assert.deepEqual(Object.keys(body.multipart.parts[0]).sort(), ["etag", "partNumber"]);
  });

  test("preserves part order — a wrong order stitches the file wrong", () => {
    const body = completionBody({ key: "k", uploadId: "u", parts });
    assert.deepEqual(body.multipart.parts.map((p) => p.partNumber), [1, 2, 3]);
    assert.deepEqual(body.multipart.parts.map((p) => p.etag), ["aaa", "bbb", "ccc"]);
  });

  test("carries nothing else — extra fields were rejected during discovery", () => {
    const body = completionBody({ key: "k", uploadId: "u", parts });
    assert.deepEqual(Object.keys(body), ["multipart"]);
    assert.deepEqual(Object.keys(body.multipart).sort(), ["key", "parts", "uploadId"]);
  });

  test("the single-part shape is unchanged from the Reels path", () => {
    assert.deepEqual(simpleCompletionBody("https://x/y.mp4"), { simple: { fileUrl: "https://x/y.mp4" } });
  });
});

describe("sha256b64", () => {
  test("is base64, not hex — Metricool signs the presigned URL with this exact value", () => {
    const h = sha256b64(Buffer.from("hello"));
    assert.equal(h, "LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=");
    assert.ok(!/^[0-9a-f]{64}$/.test(h), "a hex digest here yields a 403 from S3");
  });

  test("differs per part, which is what makes per-part checksums meaningful", () => {
    assert.notEqual(sha256b64(Buffer.from("part one")), sha256b64(Buffer.from("part two")));
  });
});

describe("the constants match what the live probe measured", () => {
  test("5 MiB floor, 100 MB ceiling", () => {
    assert.equal(MIN_PART_BYTES, 5 * MB);
    assert.equal(MAX_PART_BYTES, 100 * MB);
  });

  test("the target sits inside both bounds", () => {
    assert.ok(TARGET_PART_BYTES >= MIN_PART_BYTES);
    assert.ok(TARGET_PART_BYTES <= MAX_PART_BYTES);
  });
});
