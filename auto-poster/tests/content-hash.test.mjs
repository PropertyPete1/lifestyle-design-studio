/**
 * Content-level duplicate guard (incident 2026-07-31).
 *
 * Austin published the same footage twice in one day: two separate Drive
 * uploads, different driveFileId AND different fileName, so the id and fileName
 * guards both passed correctly. Nothing compared the pictures.
 *
 * These tests pin the comparison logic and the threshold. Real-file calibration
 * lives in scripts/calibrate-content-hash.mjs; the measured numbers it produced
 * are asserted here so a future edit to the threshold has to confront them.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  contentHashDistance,
  parseContentHash,
  findContentDuplicate,
  CONTENT_DUP_THRESHOLD,
  CONTENT_HASH_OFFSETS,
  MIN_COMPARABLE_FRAMES,
} from "../src/content-hash.js";

// Helpers to build fingerprints with a controlled bit-distance.
const H0 = "0000000000000000";
const hex = (n) => BigInt(n).toString(16).padStart(16, "0");
/** A 5-frame fingerprint where every frame differs from H0 by `bits` bits. */
const fpWithBits = (bits) => {
  const v = (1n << BigInt(bits)) - 1n; // `bits` low bits set
  return Array(5).fill(hex(v)).join(":");
};
const FP_ZERO = Array(5).fill(H0).join(":");

describe("parseContentHash", () => {
  test("splits a colon-joined fingerprint", () => {
    assert.equal(parseContentHash("aaaa:bbbb:cccc").length, 3);
  });

  for (const [label, val] of [["null", null], ["undefined", undefined], ["empty", ""], ["whitespace", "   "], ["number", 42]]) {
    test(`${label} yields an empty list rather than throwing`, () => {
      assert.deepEqual(parseContentHash(val), []);
    });
  }
});

describe("contentHashDistance", () => {
  test("identical fingerprints score 0", () => {
    assert.equal(contentHashDistance(FP_ZERO, FP_ZERO), 0);
  });

  test("averages the per-frame Hamming distance", () => {
    assert.equal(contentHashDistance(FP_ZERO, fpWithBits(6)), 6);
  });

  test("returns Infinity when either side is missing", () => {
    // Callers treat Infinity as "not a duplicate" without null-checking.
    assert.equal(contentHashDistance(FP_ZERO, null), Infinity);
    assert.equal(contentHashDistance(null, FP_ZERO), Infinity);
    assert.equal(contentHashDistance(null, null), Infinity);
  });

  test("refuses to judge on too few comparable frames", () => {
    const short = "aaaa:bbbb";
    assert.equal(contentHashDistance(short, short), Infinity);
    assert.ok(MIN_COMPARABLE_FRAMES >= 3, "need enough frames that one shared shot can't decide it");
  });

  test("compares only the frames both sides have", () => {
    const three = Array(3).fill(H0).join(":");
    assert.equal(contentHashDistance(three, FP_ZERO), 0);
  });
});

describe("threshold — calibrated on the real incident files", () => {
  // Measured 2026-07-31 via scripts/calibrate-content-hash.mjs against the two
  // incident uploads plus 5 other Austin tours.
  const SAME_FOOTAGE_WORST = 4.0;   // freshness re-encode / caption burn
  const INCIDENT_PAIR = 0.0;        // the two Drive uploads were pixel-identical
  const DIFFERENT_TOURS_BEST = 18.6;

  test("threshold clears the worst same-footage case", () => {
    assert.ok(CONTENT_DUP_THRESHOLD > SAME_FOOTAGE_WORST,
      `${CONTENT_DUP_THRESHOLD} must exceed ${SAME_FOOTAGE_WORST} or re-encodes stop matching`);
  });

  test("threshold stays under the closest genuinely-different pair", () => {
    assert.ok(CONTENT_DUP_THRESHOLD < DIFFERENT_TOURS_BEST,
      `${CONTENT_DUP_THRESHOLD} must stay below ${DIFFERENT_TOURS_BEST} or distinct tours collapse together`);
  });

  test("the incident pair would have been blocked", () => {
    assert.ok(INCIDENT_PAIR <= CONTENT_DUP_THRESHOLD);
  });

  test("samples 5 spread-out offsets", () => {
    assert.deepEqual(CONTENT_HASH_OFFSETS, [0.1, 0.3, 0.5, 0.7, 0.9]);
  });
});

describe("findContentDuplicate", () => {
  const now = Date.parse("2026-07-31T21:00:00Z");
  const ago = (h) => new Date(now - h * 3600_000).toISOString();

  test("catches same footage posted earlier today (the incident)", () => {
    const log = {
      posts: [{ city: "austin", fileName: "38AC81FB.mp4", timestamp: ago(4), content_hash: FP_ZERO }],
    };
    const hit = findContentDuplicate(log, FP_ZERO, { now });
    assert.ok(hit, "identical footage must be caught");
    assert.equal(hit.fileName, "38AC81FB.mp4");
    assert.equal(hit._distance, 0);
  });

  test("catches it ACROSS cities — all cities post to the same accounts", () => {
    const log = {
      posts: [{ city: "san_antonio", fileName: "sa.mp4", timestamp: ago(4), content_hash: FP_ZERO }],
    };
    assert.ok(findContentDuplicate(log, FP_ZERO, { now }), "city must not scope this guard");
  });

  test("tolerates re-encode drift up to the threshold", () => {
    const log = { posts: [{ city: "austin", fileName: "a.mp4", timestamp: ago(2), content_hash: fpWithBits(4) }] };
    assert.ok(findContentDuplicate(log, FP_ZERO, { now }), "a 4-bit re-encode delta must still match");
  });

  test("does NOT match a genuinely different tour", () => {
    const log = { posts: [{ city: "austin", fileName: "other.mp4", timestamp: ago(2), content_hash: fpWithBits(19) }] };
    assert.equal(findContentDuplicate(log, FP_ZERO, { now }), null);
  });

  test("ignores posts older than 30 days", () => {
    const log = {
      posts: [{ city: "austin", fileName: "old.mp4", timestamp: new Date(now - 31 * 86400_000).toISOString(), content_hash: FP_ZERO }],
    };
    assert.equal(findContentDuplicate(log, FP_ZERO, { now }), null);
  });

  test("still matches at 29 days", () => {
    const log = {
      posts: [{ city: "austin", fileName: "recent.mp4", timestamp: new Date(now - 29 * 86400_000).toISOString(), content_hash: FP_ZERO }],
    };
    assert.ok(findContentDuplicate(log, FP_ZERO, { now }));
  });

  test("returns the CLOSEST match when several are within threshold", () => {
    const log = {
      posts: [
        { fileName: "far.mp4", timestamp: ago(1), content_hash: fpWithBits(8) },
        { fileName: "near.mp4", timestamp: ago(2), content_hash: fpWithBits(1) },
      ],
    };
    assert.equal(findContentDuplicate(log, FP_ZERO, { now }).fileName, "near.mp4");
  });

  describe("graceful degradation — no backfill exists for old entries", () => {
    test("entries without content_hash are skipped, not matched", () => {
      const log = { posts: [{ city: "austin", fileName: "legacy.mp4", timestamp: ago(1) }] };
      assert.equal(findContentDuplicate(log, FP_ZERO, { now }), null);
    });

    test("a null candidate hash never blocks a post", () => {
      const log = { posts: [{ fileName: "x.mp4", timestamp: ago(1), content_hash: FP_ZERO }] };
      assert.equal(findContentDuplicate(log, null, { now }), null);
    });

    test("malformed stored hashes are ignored rather than throwing", () => {
      const log = {
        posts: [
          { fileName: "bad1.mp4", timestamp: ago(1), content_hash: "not-a-hash" },
          { fileName: "bad2.mp4", timestamp: ago(1), content_hash: "" },
          { fileName: "bad3.mp4", timestamp: ago(1), content_hash: 12345 },
        ],
      };
      assert.doesNotThrow(() => findContentDuplicate(log, FP_ZERO, { now }));
      assert.equal(findContentDuplicate(log, FP_ZERO, { now }), null);
    });

    test("entries with an unparseable timestamp are skipped", () => {
      const log = { posts: [{ fileName: "x.mp4", timestamp: "whenever", content_hash: FP_ZERO }] };
      assert.equal(findContentDuplicate(log, FP_ZERO, { now }), null);
    });

    test("empty and malformed logs are safe", () => {
      assert.equal(findContentDuplicate({ posts: [] }, FP_ZERO, { now }), null);
      assert.equal(findContentDuplicate({}, FP_ZERO, { now }), null);
      assert.equal(findContentDuplicate(null, FP_ZERO, { now }), null);
    });
  });
});
