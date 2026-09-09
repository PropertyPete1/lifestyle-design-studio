/**
 * The main account's Instagram must never be auto-published. (Issue #134.)
 *
 * mainBrandSkipIG exists so @lifestyledesignrealtytexas is posted by hand.
 * The guard compared `brand.blogId === defaultBlogId`, where defaultBlogId is
 * Number(process.env.METRICOOL_BLOG_ID) — a number — while BOTH of
 * getAllBrands' fallback returns handed back the raw env value, a string.
 * "6804409" === 6804409 is false, so on either fallback path the guard did not
 * fire and the flagship account received an automated duplicate of the reel
 * Peter was about to post natively.
 *
 * The same mismatch also broke the upload-reuse branch, which is the second
 * and third consequence: the run either re-uploaded ~90MB needlessly, or — with
 * no prefetched bytes — pushed { ok: false, error: "no upload data available" }
 * for the only brand in the list and published nothing at all, while the
 * satellites were already absent because the fallback list has one entry.
 *
 * These tests pin the invariant rather than the line: for EVERY brand list
 * getAllBrands can return, the main brand must be recognised as the main brand.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { sameBlogId, getAllBrands } from "../src/metricool.js";

const MAIN = "6804409";
let realFetch;
let savedEnv;

beforeEach(() => {
  realFetch = globalThis.fetch;
  savedEnv = { ...process.env };
  process.env.METRICOOL_BLOG_ID = MAIN;
  process.env.METRICOOL_USER_ID = "u1";
  process.env.METRICOOL_API_TOKEN = "t1";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = savedEnv;
});

/** Stub /admin/simpleProfiles with a status and body. */
const stubProfiles = (ok, body) => {
  globalThis.fetch = async () => ({
    ok,
    status: ok ? 200 : 503,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
};

describe("sameBlogId", () => {
  test("a string id from the environment matches the numeric id from the API", () => {
    // This single assertion is the whole bug.
    assert.equal(sameBlogId("6804409", 6804409), true);
    assert.equal("6804409" === 6804409, false, "which is why === was wrong here");
  });

  test("different profiles do not match", () => {
    assert.equal(sameBlogId(6804409, 9999999), false);
    assert.equal(sameBlogId("6804409", "9999999"), false);
  });

  test("an unknown id matches nothing — never assume it is the main brand", () => {
    // "we were not sure, so we published" is the failure this guards against.
    for (const bad of [undefined, null, "", "abc", NaN, 0, -1, {}, []]) {
      assert.equal(sameBlogId(bad, 6804409), false, `${JSON.stringify(bad)} must not match`);
      assert.equal(sameBlogId(6804409, bad), false, `${JSON.stringify(bad)} must not match`);
    }
  });
});

describe("getAllBrands fallbacks return a usable blogId — the branch that had no coverage", () => {
  test("REGRESSION: a non-2xx from /admin/simpleProfiles yields a NUMERIC blogId", () => {
    // This is the live failure: any Metricool hiccup took this path.
    stubProfiles(false, null);
    return getAllBrands().then((brands) => {
      assert.equal(brands.length, 1);
      assert.equal(typeof brands[0].blogId, "number");
      assert.equal(sameBlogId(brands[0].blogId, Number(process.env.METRICOOL_BLOG_ID)), true,
        "the fallback brand must be recognised as the main brand, or its Instagram is not withheld");
    });
  });

  test("REGRESSION: an empty qualifying set yields a NUMERIC blogId", async () => {
    // Second fallback: profiles listed fine, but none had Instagram connected.
    stubProfiles(true, [{ id: 111, label: "tiktok-only", tiktok: "someone" }]);
    const brands = await getAllBrands();
    assert.equal(brands.length, 1);
    assert.equal(typeof brands[0].blogId, "number");
    assert.equal(sameBlogId(brands[0].blogId, Number(MAIN)), true);
  });

  test("the happy path still yields numeric ids", async () => {
    stubProfiles(true, [
      { id: 6804409, label: "main", instagram: "lifestyledesignrealtytexas", tiktok: "x", youtube: "y" },
      { id: 222, label: "sat1", instagram: "lifestyledesignrealty" },
    ]);
    const brands = await getAllBrands();
    assert.equal(brands.length, 2);
    brands.forEach((b) => assert.equal(typeof b.blogId, "number"));
  });

  test("THE INVARIANT: across every shape getAllBrands can return, the main brand is recognised", async () => {
    const shapes = [
      { name: "api down", ok: false, body: null },
      { name: "no qualifying profiles", ok: true, body: [] },
      { name: "only a tiktok-only profile", ok: true, body: [{ id: 5, label: "t", tiktok: "a" }] },
      { name: "main present among satellites", ok: true, body: [
        { id: 6804409, label: "main", instagram: "main_ig" },
        { id: 222, label: "sat", instagram: "sat_ig" },
      ] },
    ];
    for (const s of shapes) {
      stubProfiles(s.ok, s.body);
      const brands = await getAllBrands();
      const main = brands.filter((b) => sameBlogId(b.blogId, Number(MAIN)));
      assert.equal(main.length, 1, `shape "${s.name}" must contain exactly one recognisable main brand`);
    }
  });
});

describe("the source text — so the strict comparison cannot come back", () => {
  test("no blogId is compared with === against defaultBlogId", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/metricool.js", import.meta.url), "utf-8");
    assert.ok(
      !/blogId === defaultBlogId/.test(src),
      "blogId comparisons must go through sameBlogId — === between a string and a number is silently false"
    );
  });

  test("neither fallback hands back the raw env string", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/metricool.js", import.meta.url), "utf-8");
    assert.ok(
      !/blogId: process\.env\.METRICOOL_BLOG_ID\b/.test(src),
      "fallback brands must coerce with Number() at the source"
    );
  });

  test("both comparison sites use sameBlogId", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/metricool.js", import.meta.url), "utf-8");
    const uses = (src.match(/sameBlogId\(brand\.blogId, defaultBlogId\)/g) || []).length;
    assert.equal(uses, 2, "the upload-reuse branch and the Instagram withhold both need it");
  });
});
