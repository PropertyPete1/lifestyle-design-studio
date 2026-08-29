/**
 * Brand isolation — the guard that keeps realty content off the LDT accounts.
 *
 * Both realty fan-outs (metricool.js getAllBrands, carousel-distribute.js
 * getCarouselBrands) post to every profile discovered on the Metricool
 * account. Before brands.json, "connected to Metricool" WAS the membership
 * rule — so the day the LDT accounts get connected, realty reels would have
 * auto-published to them within the hour. These tests pin the two properties
 * that make the fix safe in both directions:
 *
 *   1. BYTE-IDENTICAL REALTY: with no claimed profile present, the filter
 *      returns the same profiles, same objects, same order. Today's realty
 *      behavior cannot have changed.
 *   2. FAIL-CLOSED LDT: the LDT lane posts only to profiles matched by
 *      handle/label, and matches nothing when the brand isn't connected.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadBrandRegistry, normalizeHandle, profileClaimedBy, claimingBrandKey,
  excludeClaimedProfiles, findBrandProfiles,
} from "../src/brands.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

const registry = loadBrandRegistry();
const ldt = registry.brands.ldt;

/** Fixtures shaped like /admin/simpleProfiles rows. */
const REALTY_PROFILES = [
  { id: 4807109, label: "LIFESTYLE", instagram: "lifestyledesignrealtytexas", tiktok: "lifestyledesignrealty", facebook: "lifestylerealty", youtube: "lifestyle" },
  { id: 5555001, label: "SA Satellite", instagram: "satx.newhomes", tiktok: "" },
  { id: 5555002, label: "ATX Satellite", instagram: "atxnewbuilds" },
];

const LDT_BY_IG = { id: 7000001, label: "Lifestyle Design Technologies", instagram: "lifestyledesigntechnologies", tiktok: "lifestyledesigntech" };
const LDT_BY_TIKTOK_ONLY = { id: 7000002, label: "New Brand", instagram: "", tiktok: "lifestyledesigntech" };
const LDT_BY_LABEL_ONLY = { id: 7000003, label: "LDT (connecting…)", instagram: "", tiktok: "" };

describe("registry", () => {
  test("brands.json loads and knows both brands", () => {
    assert.ok(registry.brands.realty, "realty brand present");
    assert.ok(registry.brands.ldt, "ldt brand present");
    assert.equal(registry.brands.realty.discovery, "unclaimed");
  });
});

describe("realty behavior is byte-identical without LDT connected", () => {
  test("no claimed profiles → same array content, same objects, same order", () => {
    const out = excludeClaimedProfiles(REALTY_PROFILES, registry, () => {});
    assert.deepEqual(out, REALTY_PROFILES);
    for (let i = 0; i < out.length; i++) {
      assert.equal(out[i], REALTY_PROFILES[i], `element ${i} is the same object, not a copy`);
    }
  });

  test("a realty-adjacent handle is NOT a match (no substring false positives)", () => {
    // "lifestyledesignrealtytexas" contains "lifestyledesign" — handle
    // matching must be exact-equality, or the main brand itself would vanish.
    assert.equal(profileClaimedBy(REALTY_PROFILES[0], ldt), false);
    assert.equal(claimingBrandKey(REALTY_PROFILES[0], registry), null);
  });
});

describe("the LDT profile is excluded from realty discovery", () => {
  for (const [name, profile] of [
    ["by Instagram handle", LDT_BY_IG],
    ["by TikTok handle alone", LDT_BY_TIKTOK_ONLY],
    ["by label pattern before any network connects", LDT_BY_LABEL_ONLY],
  ]) {
    test(name, () => {
      const mixed = [...REALTY_PROFILES, profile];
      const out = excludeClaimedProfiles(mixed, registry, () => {});
      assert.deepEqual(out, REALTY_PROFILES, "only the LDT profile was removed");
      assert.equal(claimingBrandKey(profile, registry), "ldt");
    });
  }

  test("handle matching survives @, case, and URL forms", () => {
    for (const raw of [
      "@lifestyledesigntechnologies",
      "LifestyleDesignTechnologies",
      "https://instagram.com/lifestyledesigntechnologies/",
    ]) {
      assert.equal(normalizeHandle(raw), "lifestyledesigntechnologies", raw);
      assert.equal(profileClaimedBy({ instagram: raw }, ldt), true, raw);
    }
  });
});

describe("the LDT lane is fail-closed", () => {
  test("no matching profile → empty list, never a fallback", () => {
    assert.deepEqual(findBrandProfiles(REALTY_PROFILES, ldt), []);
    assert.deepEqual(findBrandProfiles([], ldt), []);
    assert.deepEqual(findBrandProfiles(null, ldt), []);
  });

  test("the connected LDT profile is found, and only it", () => {
    const mixed = [...REALTY_PROFILES, LDT_BY_IG];
    const found = findBrandProfiles(mixed, ldt);
    assert.equal(found.length, 1);
    assert.equal(found[0], LDT_BY_IG);
  });

  test("the realty brand never claims anything (discovery: unclaimed)", () => {
    // If realty could claim, it would steal its own satellites out of the
    // unclaimed remainder and the exclusion filter would empty the realty set.
    for (const p of [...REALTY_PROFILES, LDT_BY_IG]) {
      const key = claimingBrandKey(p, registry);
      assert.notEqual(key, "realty", `${p.label} must never be claimed by realty`);
    }
  });

  test("a malformed label pattern cannot break discovery", () => {
    const broken = { ...ldt, labelPatterns: ["("] };
    assert.equal(profileClaimedBy({ label: "anything" }, broken), false);
    // Handles still work even with the broken pattern present.
    assert.equal(profileClaimedBy(LDT_BY_IG, broken), true);
  });

  test("a deleted or demo LDT profile is never selected as the target", () => {
    // A lingering deleted row must not swallow the live profile's slot —
    // ldt-main takes ldtProfiles[0] and would post into a dead blogId.
    const dead = { ...LDT_BY_IG, id: 6999999, deleted: true };
    const demo = { ...LDT_BY_IG, id: 6999998, isDemo: true };
    const found = findBrandProfiles([dead, demo, LDT_BY_IG], ldt);
    assert.equal(found.length, 1);
    assert.equal(found[0], LDT_BY_IG);
  });
});

describe("TEETH — the tested seam IS the production path", () => {
  // These tests exercise excludeClaimedProfiles/findBrandProfiles directly,
  // which proves nothing if production quietly stops calling them. Pin the
  // call sites in source, the same way workflow-env pins env keys.
  test("both realty fan-outs route discovery through excludeClaimedProfiles", () => {
    const metricool = readFileSync(join(SRC, "metricool.js"), "utf-8");
    const carousel = readFileSync(join(SRC, "carousel-distribute.js"), "utf-8");
    assert.ok(/excludeClaimedProfiles\(/.test(metricool), "getAllBrands must filter through excludeClaimedProfiles");
    assert.ok(/excludeClaimedProfiles\(/.test(carousel), "getCarouselBrands must filter through excludeClaimedProfiles");
  });

  test("the LDT lane resolves its target through findBrandProfiles and stamps brand entries", () => {
    const ldtMain = readFileSync(join(SRC, "ldt-main.js"), "utf-8");
    assert.ok(/findBrandProfiles\(/.test(ldtMain), "ldt-main must resolve its profile via findBrandProfiles (fail-closed)");
    assert.ok(/const BRAND_KEY = "ldt"/.test(ldtMain), "the brand key is the literal 'ldt' the guards filter on");
    const stamps = ldtMain.match(/brand: BRAND_KEY/g) || [];
    assert.equal(stamps.length, 2, "both recordPost calls (clip + promo) stamp brand: BRAND_KEY — the field every scoping guard keys on");
  });
});
