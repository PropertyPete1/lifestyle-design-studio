/**
 * Subject headers.
 *
 * Every email this system sends went out with raw UTF-8 bytes in the Subject
 * header, so an em dash arrived as "Ã¢Â€Â”". A subject that looks like mojibake
 * reads as spam, which is the exact opposite of what a notification needs to do
 * — and two held-script notices were missed in an inbox taking twenty automated
 * mails a day.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { encodeSubject, MAIL_PREFIX } from "../src/delivery.js";

const decode = (h) =>
  h.split("\r\n ").map((w) => Buffer.from(w.slice(10, -2), "base64").toString("utf8")).join("");

describe("encodeSubject — RFC 2047", () => {
  test("leaves a pure-ASCII subject completely alone", () => {
    const plain = "[REELS] Ready to Post: SAN_ANTONIO reel - 8/7/2026";
    assert.equal(encodeSubject(plain), plain);
  });

  test("encodes the real mojibake case and round-trips it exactly", () => {
    const real = "[YT PIPELINE] Script held back (8/8/6) — Best Neighborhoods in North San Antonio for Veterans";
    const header = encodeSubject(real);
    assert.notEqual(header, real, "must be encoded");
    assert.equal(decode(header), real, "must survive the round trip byte for byte");
  });

  test("no encoded-word exceeds the 75-character limit", () => {
    const long = "[YT PIPELINE] " + "— a very long subject line with an em dash ".repeat(6);
    for (const word of encodeSubject(long).split("\r\n ")) {
      assert.ok(word.length <= 75, `encoded-word is ${word.length} chars: ${word}`);
    }
  });

  test("folds continuation lines with CRLF + space, per RFC 5322", () => {
    const long = "— " + "x".repeat(200);
    const header = encodeSubject(long);
    assert.ok(header.includes("\r\n "), "must fold");
    assert.equal(decode(header), long);
  });

  test("never splits a multi-byte character across two encoded-words", () => {
    // 40 em dashes: 3 bytes each, so the chunker has to cut mid-run.
    const dashes = "—".repeat(40);
    assert.equal(decode(encodeSubject(dashes)), dashes);
    assert.ok(!decode(encodeSubject(dashes)).includes("�"), "no replacement chars");
  });

  test("handles emoji, which the other mail classes use", () => {
    const s = "📸 Ready to Post — carousel";
    assert.equal(decode(encodeSubject(s)), s);
  });

  test("tolerates junk rather than throwing", () => {
    assert.equal(encodeSubject(null), "");
    assert.equal(encodeSubject(""), "");
    assert.equal(encodeSubject(undefined), "");
  });
});

describe("MAIL_PREFIX — a scannable inbox", () => {
  test("each class has its own prefix", () => {
    assert.deepEqual(
      Object.values(MAIL_PREFIX).sort(),
      ["[CAROUSEL]", "[REELS]", "[YT PIPELINE]"]
    );
  });

  test("prefixes are pure ASCII, so they survive in the clear even when encoded", () => {
    for (const p of Object.values(MAIL_PREFIX)) {
      assert.match(p, /^\[[A-Z ]+\]$/);
    }
  });
});
