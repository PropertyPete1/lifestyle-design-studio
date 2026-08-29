/**
 * Cadence guard — the anti-spam rule the LDT lane (and every future brand)
 * lives under.
 *
 * The contract, verbatim from the spec: default 2/day per platform, HARD CAP
 * 6/day requiring an explicit config change plus a logged warning, and the
 * system REFUSES cadences above the cap. Refusal is a throw at config-load
 * time — before discovery, before download, before upload — so a bad config
 * can never post even once. These tests pin the refusal, the warning, the
 * default, and the day-boundary arithmetic (cadence days are America/Chicago
 * days, because that is the timezone every schedule in this repo thinks in).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  loadBrandRegistry, resolveCadence, cadenceFor, chicagoDayOf,
  countBrandPostsToday, cadenceAllows, minGapOk,
  DEFAULT_CADENCE_PER_DAY, CADENCE_HARD_CAP_PER_DAY,
} from "../src/brands.js";

const registry = loadBrandRegistry();

describe("resolveCadence refusal and warnings", () => {
  test("the shipped LDT config resolves at 3/day, under the cap, and says so every run", () => {
    // 3/day is ABOVE the 2/day default and below the 6/day hard cap, so it
    // resolves — but never silently. The warning per platform is the point of
    // the tier: an elevated cadence is a deliberate config decision, and every
    // run restates it in the log so it can't become invisible background.
    const warned = [];
    const resolved = resolveCadence(registry.brands.ldt, registry, (m) => warned.push(m));
    assert.deepEqual(resolved.perPlatform, { instagram: 3, tiktok: 3 });
    assert.equal(resolved.warnings.length, 2, "one warning per configured platform");
    assert.deepEqual(warned, resolved.warnings, "every warning is actually logged, not just collected");
    for (const w of resolved.warnings) {
      assert.match(w, /3\/day/, "the warning names the configured rate");
      assert.match(w, /hard cap 6\/day/, "the warning names the ceiling it is still under");
    }
    // The raise must not have touched the ceiling itself.
    assert.equal(resolved.hardCap, 6);
    assert.equal(resolved.defaultPerDay, 2);
  });

  test("above the hard cap is REFUSED, not clamped", () => {
    const brand = { label: "Test", cadence: { instagram: 7 } };
    assert.throws(() => resolveCadence(brand, registry, () => {}), /REFUSED/);
    assert.throws(() => resolveCadence(brand, registry, () => {}), /hard cap/);
  });

  test("the registry cannot raise the cap above the code constant", () => {
    // brands.json sets both the cap and the cadences — if one config edit
    // could raise both, the refusal would be decoration. The code constant
    // is the ceiling; the registry may only lower it.
    const permissive = { ...registry, cadenceHardCapPerDay: 20 };
    assert.throws(
      () => resolveCadence({ label: "T", cadence: { instagram: 7 } }, permissive, () => {}),
      /REFUSED/
    );
  });

  test("the registry CAN lower the cap", () => {
    const strict = { ...registry, cadenceHardCapPerDay: 3 };
    assert.throws(
      () => resolveCadence({ label: "T", cadence: { instagram: 4 } }, strict, () => {}),
      /REFUSED/
    );
  });

  test("the shipped registry's cap is the spec's 6", () => {
    assert.equal(registry.cadenceHardCapPerDay, CADENCE_HARD_CAP_PER_DAY);
    assert.equal(CADENCE_HARD_CAP_PER_DAY, 6);
  });

  test("exactly the hard cap is allowed — with a logged warning", () => {
    const warned = [];
    const brand = { label: "Test", cadence: { instagram: CADENCE_HARD_CAP_PER_DAY } };
    const resolved = resolveCadence(brand, registry, (m) => warned.push(m));
    assert.equal(resolved.perPlatform.instagram, 6);
    assert.equal(warned.length, 1);
    assert.match(warned[0], /above the default/);
  });

  test("between default and cap warns; at or below default stays silent", () => {
    const warned = [];
    resolveCadence({ label: "T", cadence: { instagram: 3 } }, registry, (m) => warned.push(m));
    assert.equal(warned.length, 1, "3/day warns");
    warned.length = 0;
    resolveCadence({ label: "T", cadence: { instagram: 2 } }, registry, (m) => warned.push(m));
    assert.equal(warned.length, 0, "2/day is the default — no warning");
  });

  for (const bad of [0, -1, 2.5, "lots", null]) {
    test(`invalid cadence value ${JSON.stringify(bad)} is refused`, () => {
      assert.throws(
        () => resolveCadence({ label: "T", cadence: { instagram: bad } }, registry, () => {}),
        /invalid cadence/
      );
    });
  }

  test("an unconfigured platform falls back to the default", () => {
    const resolved = resolveCadence({ label: "T", cadence: {} }, registry, () => {});
    assert.equal(cadenceFor(resolved, "instagram"), DEFAULT_CADENCE_PER_DAY);
  });
});

describe("daily counting is Chicago-day and brand-scoped", () => {
  // 2026-08-29 16:00 UTC = 11:00 AM CT — mid-morning on the CT day 2026-08-29.
  const NOW = new Date("2026-08-29T16:00:00Z");
  const resolved = { perPlatform: { instagram: 2, tiktok: 2 } };

  const entry = (over) => ({
    brand: "ldt", type: "ldt_clip", platforms: ["instagram", "tiktok"],
    timestamp: "2026-08-29T15:00:00.000Z", success: true, ...over,
  });

  test("chicagoDayOf: 04:00 UTC belongs to the PREVIOUS Chicago day", () => {
    assert.equal(chicagoDayOf("2026-08-29T04:00:00Z"), "2026-08-28");
    assert.equal(chicagoDayOf("2026-08-29T16:00:00Z"), "2026-08-29");
  });

  test("chicagoDayOf handles CST too — the boundary moves to 06:00 UTC in winter", () => {
    // A hardcoded UTC-5 offset passes every August fixture and then
    // miscounts the daily budget all winter. Pin both sides of the CST edge.
    assert.equal(chicagoDayOf("2026-01-15T05:59:59Z"), "2026-01-14");
    assert.equal(chicagoDayOf("2026-01-15T06:00:00Z"), "2026-01-15");
  });

  test("counts today's posts, per platform", () => {
    const log = { posts: [entry(), entry({ platforms: ["instagram"] })] };
    assert.equal(countBrandPostsToday(log, "ldt", "instagram", NOW), 2);
    assert.equal(countBrandPostsToday(log, "ldt", "tiktok", NOW), 1);
  });

  test("yesterday's post (by CT boundary, not UTC) does not count", () => {
    // 04:00 UTC on the 29th is 11 PM CT on the 28th.
    const log = { posts: [entry({ timestamp: "2026-08-29T04:00:00.000Z" })] };
    assert.equal(countBrandPostsToday(log, "ldt", "instagram", NOW), 0);
  });

  test("realty entries never count against the LDT cadence — and vice versa", () => {
    const log = {
      posts: [
        { city: "san_antonio", platforms: ["instagram", "tiktok", "youtube"], timestamp: "2026-08-29T15:00:00.000Z", success: true },
        entry(),
      ],
    };
    assert.equal(countBrandPostsToday(log, "ldt", "instagram", NOW), 1);
    assert.equal(countBrandPostsToday(log, "realty", "instagram", NOW), 0, "legacy realty entries carry no brand field");
  });

  test("cadenceAllows blocks the third post of the day and not the second", () => {
    const one = { posts: [entry()] };
    const two = { posts: [entry(), entry({ timestamp: "2026-08-29T15:30:00.000Z" })] };
    assert.equal(cadenceAllows(one, "ldt", "instagram", resolved, NOW).allowed, true);
    const blocked = cadenceAllows(two, "ldt", "instagram", resolved, NOW);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.used, 2);
    assert.equal(blocked.limit, 2);
  });

  test("failed posts do not consume cadence", () => {
    const log = { posts: [entry({ success: false }), entry({ success: false })] };
    assert.equal(cadenceAllows(log, "ldt", "instagram", resolved, NOW).allowed, true);
  });
});

describe("minimum gap between brand posts", () => {
  const NOW = new Date("2026-08-29T16:00:00Z");
  test("a post 2h ago blocks a 3h-gap brand; 4h ago does not", () => {
    const recent = { posts: [{ brand: "ldt", platforms: ["instagram"], timestamp: "2026-08-29T14:00:00.000Z", success: true }] };
    const old = { posts: [{ brand: "ldt", platforms: ["instagram"], timestamp: "2026-08-29T12:00:00.000Z", success: true }] };
    assert.equal(minGapOk(recent, "ldt", 3, NOW).ok, false);
    assert.equal(minGapOk(old, "ldt", 3, NOW).ok, true);
  });

  test("no gap configured, or no prior post → always ok", () => {
    assert.equal(minGapOk({ posts: [] }, "ldt", 3, NOW).ok, true);
    const recent = { posts: [{ brand: "ldt", platforms: ["instagram"], timestamp: "2026-08-29T15:59:00.000Z", success: true }] };
    assert.equal(minGapOk(recent, "ldt", 0, NOW).ok, true);
    assert.equal(minGapOk(recent, "ldt", undefined, NOW).ok, true);
  });
});
