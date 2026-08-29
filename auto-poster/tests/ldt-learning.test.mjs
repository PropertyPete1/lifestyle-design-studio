/**
 * The LDT lane's learning-loop brief — brand scoping on the shared engine.
 *
 * PR #114's learn step builds learning/brief-<brand>.json per BRANDS-roster
 * entry, and the variation engine steers each caption from its brand's brief.
 * These tests pin the multi-brand contract this feature adds to that seam:
 *
 *   - reelEntries is brand-scoped: one brand's brief never scores another
 *     brand's posts. Legacy untagged entries belong to the default brand;
 *     LDT clip entries (brand:"ldt", type:"ldt_clip") are the ldt brand's
 *     reels — the type keeps every realty guard blind to them, the brand
 *     field is what the learn step separates on.
 *   - The LDT variation plan excludes ITS OWN previous hook style, not the
 *     realty lane's — brand-scoped anti-repeat.
 *   - An LDT brief with zero posts builds and renders without inventing a
 *     number (the pre-connect steady state, emailed weekly).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { reelEntries, generationFor, buildBrief, renderBriefEmail } from "../src/learn.js";
import { pickLdtVariation } from "../src/ldt-caption.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const NOW = new Date("2026-08-29T16:00:00Z");
const iso = (hoursAgo) => new Date(NOW.getTime() - hoursAgo * 3600_000).toISOString();

const realtyEntry = {
  city: "austin", slot: "pm", caption: "Would you believe this backyard?\nMore lines here",
  timestamp: iso(30), success: true, driveFileId: "r1", fileName: "r1.mp4",
  generation: { hook_style: "question", caption_length_bucket: "long" },
};
const ldtClip = {
  brand: "ldt", type: "ldt_clip", city: "ldt", slot: "am",
  caption: "7:05 AM. The briefing is already on my phone.\nPRIMARY at work.",
  timestamp: iso(26), success: true, driveFileId: "l1", fileName: "l1.mp4",
  generation: { hook_style: "pov", caption_length_bucket: null },
};
const ldtPromo = {
  brand: "ldt", type: "ldt_promo", city: "ldt", slot: "pm",
  caption: "Meet PRIMARY.", timestamp: iso(20), success: true,
};
const linkedinEntry = { type: "linkedin", topic: "recruiting", timestamp: iso(10), success: true };

const LOG = { posts: [realtyEntry, ldtClip, ldtPromo, linkedinEntry] };

describe("reelEntries is brand-scoped", () => {
  test("the default brand sees only its own reels — no LDT, no receipts", () => {
    const entries = reelEntries(LOG, { now: NOW });
    assert.deepEqual(entries.map(e => e.driveFileId), ["r1"]);
  });

  test("the ldt brand sees only its clip posts — promos and realty excluded", () => {
    const entries = reelEntries(LOG, { brand: "ldt", now: NOW });
    assert.deepEqual(entries.map(e => e.driveFileId), ["l1"]);
  });

  test("an LDT entry's tags read as tagged provenance with a canonical style", () => {
    const g = generationFor(ldtClip);
    assert.equal(g.provenance, "tagged");
    assert.equal(g.hook_style, "pov");
  });
});

describe("the LDT brief builds honestly at every data stage", () => {
  test("zero posts: builds, renders, invents nothing", () => {
    const brief = buildBrief({ brand: "ldt", log: { posts: [realtyEntry] }, analytics: { recent_posts: [] }, now: NOW });
    assert.equal(brief.brand, "ldt");
    assert.equal(brief.sample.posts_scored, 0);
    assert.deepEqual(brief.kill_list, []);
    const email = renderBriefEmail(brief);
    assert.ok(email.includes("ldt"));
  });

  test("an LDT clip with a joined analytics row scores under the ldt brand only", () => {
    const analytics = {
      recent_posts: [{
        slug: "7:05 AM. The briefing is already on my phone.",
        published: iso(25),
        platform: "instagram",
        account: "lifestyledesigntechnologies",
        metrics: { views: 100, likes: 5, comments: 1, shares: 0 },
      }],
    };
    const ldtBrief = buildBrief({ brand: "ldt", log: LOG, analytics, now: NOW });
    assert.equal(ldtBrief.sample.posts_scored, 1);
    const realtyBrief = buildBrief({ brand: "lifestyle", log: LOG, analytics, now: NOW });
    assert.equal(realtyBrief.sample.posts_scored, 0, "the LDT row must not attribute to the realty brief");
  });
});

describe("brand-scoped anti-repeat in the variation plan", () => {
  test("the LDT plan excludes the LDT lane's own previous style, not realty's", () => {
    // Realty's newest reel is 'question'; the LDT lane's own last clip is
    // 'pov'. An unscoped scan would exclude 'question'.
    const plan = pickLdtVariation(LOG, { brief: null, rand: () => 0.99, now: NOW });
    assert.equal(plan.excluded_style, "pov");
    assert.notEqual(plan.hook_style, "pov", "never repeats its own previous style");
  });

  test("with no LDT history the plan imposes no exclusion", () => {
    const plan = pickLdtVariation({ posts: [realtyEntry] }, { brief: null, rand: () => 0.99, now: NOW });
    assert.equal(plan.excluded_style, null);
  });
});

describe("TEETH — the roster and the stamps that make all of this run", () => {
  test("run-learning-loop.mjs builds a brief for the ldt brand", () => {
    const src = readFileSync(join(ROOT, "scripts", "run-learning-loop.mjs"), "utf-8");
    assert.match(src, /const BRANDS = \[DEFAULT_BRAND, "ldt"\]/, "ldt must be on the BRANDS roster or its brief is never built");
  });

  test("ldt-main stamps city+slot+generation — the fields reelEntries and the tag reader require", () => {
    const src = readFileSync(join(ROOT, "src", "ldt-main.js"), "utf-8");
    assert.match(src, /city: BRAND_KEY/, "entries carry city:'ldt'");
    assert.match(src, /slot: chicagoSlot\(\)/, "entries carry a slot");
    const tagged = src.match(/^\s+generation,$/gm) || [];
    assert.equal(tagged.length, 2, "both recordPost calls persist the generation tag block");
  });
});
