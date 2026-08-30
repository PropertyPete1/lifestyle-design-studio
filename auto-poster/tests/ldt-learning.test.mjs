/**
 * The LDT lane's learning-loop brief — brand scoping on the shared engine.
 *
 * PR #114's learn step builds learning/brief-<brand>.json per BRANDS-roster
 * entry, and the variation engine steers each caption from its brand's brief.
 * These tests pin the multi-brand contract this feature adds to that seam:
 *
 *   - reelEntries is brand-scoped: one brand's brief never scores another
 *     brand's posts. Legacy untagged entries belong to the default brand;
 *     LDT clip entries (type:"ldt_clip") and self-made text reels
 *     (type:"ldt_text_reel") are the ldt brand's reels — the types keep
 *     every realty guard blind to them, the brand field is what the learn
 *     step separates on, and image formats (carousel/card) stay out.
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
import { planLdtVoice, pickLdtVariation } from "../src/ldt-caption.js";

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
const ldtTextReel = {
  brand: "ldt", type: "ldt_text_reel", city: "ldt", slot: "pm",
  caption: "New leads contacted in under five minutes.\nPRIMARY at work.",
  timestamp: iso(20), success: true, driveFileId: "selfmade:2026-08-28:text_reel:after_hours",
  generation: { hook_style: "stat", caption_length_bucket: null },
};
const ldtCarousel = {
  brand: "ldt", type: "ldt_carousel", city: "ldt", slot: "am",
  caption: "How many of your leads went cold this week?\nPRIMARY at work.",
  timestamp: iso(15), success: true, driveFileId: "selfmade:2026-08-29:carousel:leads_going_cold",
  hook_style: "question",
  generation: { hook_style: "question", caption_length_bucket: null },
};
const linkedinEntry = { type: "linkedin", topic: "recruiting", timestamp: iso(10), success: true };

const LOG = { posts: [realtyEntry, ldtClip, ldtTextReel, ldtCarousel, linkedinEntry] };

describe("reelEntries is brand-scoped", () => {
  test("the default brand sees only its own reels — no LDT, no receipts", () => {
    const entries = reelEntries(LOG, { now: NOW });
    assert.deepEqual(entries.map(e => e.driveFileId), ["r1"]);
  });

  test("the ldt brand sees its clips AND its text reels — image formats and realty excluded", () => {
    // Everything the lane publishes AS A REEL gets scored: clips and
    // self-made text reels both land in reel analytics. Carousels and cards
    // are image posts — admitting them would only add unjoined noise.
    const entries = reelEntries(LOG, { brand: "ldt", now: NOW });
    assert.deepEqual(entries.map(e => e.driveFileId), ["l1", "selfmade:2026-08-28:text_reel:after_hours"]);
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
  test("the LDT plan excludes the lane's newest style across formats, not realty's", () => {
    // The lane's newest post is the self-made carousel ('question'); one
    // rotation covers clips AND self-made formats, so 'question' is what the
    // next post must not repeat. An unscoped scan would land on realty's
    // newest instead.
    const plan = pickLdtVariation(LOG, { brief: null, rand: () => 0.99, now: NOW });
    assert.equal(plan.excluded_style, "question");
    assert.notEqual(plan.hook_style, "question", "never repeats the lane's previous style");
  });

  test("a clip-only history still rotates on the clip's style", () => {
    const plan = pickLdtVariation({ posts: [realtyEntry, ldtClip] }, { brief: null, rand: () => 0.99, now: NOW });
    assert.equal(plan.excluded_style, "pov");
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

describe("voice and closer are tagged for the learn step", () => {
  test("the voice rotates and never repeats the lane's previous voice", () => {
    assert.deepEqual(planLdtVoice({ posts: [] }).voice, "operator");
    const after = (v) => planLdtVoice({ posts: [{ brand: "ldt", generation: { voice: v }, timestamp: iso(2), success: true }] });
    assert.equal(after("operator").voice, "primary");
    assert.equal(after("primary").voice, "operator");
    assert.equal(after("operator").excluded_voice, "operator");
  });

  test("another brand's voice never steers the LDT rotation", () => {
    const log = { posts: [{ brand: "other", generation: { voice: "primary" }, timestamp: iso(2), success: true }] };
    assert.equal(planLdtVoice(log).voice, "operator", "no LDT history means no exclusion");
  });

  test("the variation plan carries voice alongside hook style, as its own axis", () => {
    // Voice and hook style must be independent: the same hook can be spoken
    // by either voice, so they cannot share one rotation slot.
    const plan = pickLdtVariation(LOG, { brief: null, rand: () => 0.99, now: NOW });
    assert.ok(["operator", "primary"].includes(plan.voice));
    assert.ok(plan.hook_style, "hook style still planned");
    assert.ok("voice_source" in plan, "the choice records how it was made");
  });

  test("ldt-main stamps voice and meta_closer on BOTH paths — clips get a null closer", () => {
    const src = readFileSync(join(ROOT, "src", "ldt-main.js"), "utf-8");
    const voices = src.match(/^\s+voice,$/gm) || [];
    assert.equal(voices.length, 2, "both recordPost calls persist the voice");
    // The clip path must stamp the closer as an explicit null, so "no closer"
    // is distinguishable from an entry written before closers existed.
    assert.match(src, /meta_closer: null,/, "clip entries record an explicit null closer");
    assert.match(src, /meta_closer: metaCloser \|\| null,/, "self-made entries record the line they used");
  });
});
