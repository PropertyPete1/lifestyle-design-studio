import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { differentiateMp4Bytes } from "./videoVariant";

/**
 * The serverless differentiation must:
 *  1. Preserve the original source bytes verbatim as a prefix (so the decoded
 *     video/audio is byte-for-byte identical to the source — appended `free`
 *     boxes are ignored by every player).
 *  2. Produce a DIFFERENT overall byte stream (different SHA-256) than the
 *     source, so exact-file fingerprinting sees a new file.
 *  3. Produce a DIFFERENT byte stream on each call (so 3 IG brands + TikTok +
 *     YouTube + LinkedIn each get a distinct file from the same source).
 *  4. Append only valid top-level MP4 `free` boxes.
 */
describe("differentiateMp4Bytes (serverless byte differentiation)", () => {
  const source = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]), // fake ftyp size
    Buffer.from("ftyp", "ascii"),
    crypto.randomBytes(4096),
  ]);

  it("preserves the exact source bytes as a prefix", () => {
    const out = differentiateMp4Bytes(source);
    expect(out.length).toBeGreaterThan(source.length);
    expect(out.subarray(0, source.length).equals(source)).toBe(true);
  });

  it("changes the overall SHA-256 vs the source", () => {
    const out = differentiateMp4Bytes(source);
    const srcHash = crypto.createHash("sha256").update(source).digest("hex");
    const outHash = crypto.createHash("sha256").update(out).digest("hex");
    expect(outHash).not.toBe(srcHash);
  });

  it("produces a distinct file on each call", () => {
    const a = differentiateMp4Bytes(source);
    const b = differentiateMp4Bytes(source);
    const ha = crypto.createHash("sha256").update(a).digest("hex");
    const hb = crypto.createHash("sha256").update(b).digest("hex");
    expect(ha).not.toBe(hb);
  });

  it("appends only well-formed `free` boxes after the source", () => {
    const out = differentiateMp4Bytes(source);
    let offset = source.length;
    let boxes = 0;
    while (offset < out.length) {
      const size = out.readUInt32BE(offset);
      const type = out.toString("ascii", offset + 4, offset + 8);
      expect(type).toBe("free");
      expect(size).toBeGreaterThanOrEqual(8);
      expect(offset + size).toBeLessThanOrEqual(out.length);
      offset += size;
      boxes++;
    }
    expect(offset).toBe(out.length); // boxes tile exactly to EOF
    expect(boxes).toBeGreaterThanOrEqual(1);
    expect(boxes).toBeLessThanOrEqual(2);
  });
});
