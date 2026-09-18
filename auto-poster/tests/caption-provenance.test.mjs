/**
 * Caption provenance — is the "original" ours, and does the caption claim an
 * amenity or a rating its source never made?
 *
 * Every fixture below is REAL. The pipeline caption is what the flagship
 * carried on 2026-07-17 and what the restructure lane was handed as an
 * "original" on 2026-09-18. The hand-written lines are Peter's, from before
 * this pipeline existed — and they are here because the first cut of the
 * fingerprint list flagged three of them.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BOT_CAPTION_FINGERPRINTS,
  GATED_CLAIMS,
  botCaptionFingerprints,
  isBotAuthoredCaption,
  findUnsupportedClaims,
  stripUnsupportedClaims,
} from "../src/caption-provenance.js";
import {
  generateCaption,
  generateCaptionFromOriginal,
  getFallbackCaption,
  enforceClaimSupport,
  claimRetryInstruction,
  matchCommunityForVideo,
} from "../src/caption.js";
import { validateCaption } from "../src/caption-validator.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

// ─── real fixtures ──────────────────────────────────────────────────────────

/** Flagship, 2026-07-17. Typographic apostrophes exactly as Instagram returns them. */
const PIPELINE_CAPTION_0717 = `this is what new construction in Austin is supposed to feel like

new construction like this doesn’t sit long in this market

✨ everyday living hits
open floor plan that actually flows. natural light pouring in. modern finishes throughout. kitchen built for real life. this is the kind of space that makes you want to be home

🌳 full amenity and community rundown available. it’s worth asking about

🎓 school ratings, HOA and taxes vary by address. exact numbers on request

💸 buyer wins
starting at $455,000. VA, FHA, USDA, and conventional financing all welcome here. builder incentives are live. rate buydowns available to bring your payment down even further

perfect for growing families, military and veteran buyers, or anyone ready to stop renting and build equity in Austin

📲 comment TOUR and I’ll DM you today’s available homes. pick your favorite and I’ll send the full monthly payment breakdown on it

📩 or DM LIST for a custom lineup of every similar option plus a fast approval game plan

⭐ link in bio to get started with us today

Lifestyle Design Realty
#texas #austin #realestate #military #veteran newconstruction`;

/** Peter's, 2026-07-06 — a caption the restructure lane EXISTS to reuse. */
const HANDWRITTEN_0706 = `🪟 first look the windows then the backyard glow
🏡 one and two story layouts with smart flow natural light and multiple quick move ins so you can move on your timeline
📐 plans roughly 1,566 to 2,703 sq ft with 3 to 5 bedrooms and 2 to 4 baths so you can go cozy or go roomy

💰 numbers that matter
🏷️ homes start at about $398,000 in this section based on current listings
🏠 the exact home in my video is priced at $546,000
🎯 ask about the 4.99 percent fixed-rate promo available on select homes for a limited time

🌳 everyday lifestyle hits
🏊 resort-style pools splash zones and dual waterslides plus the Wellness Barn trails parks and new Ranch Camp amenities for daily reset time

🧾 master HOA is shown around $116 per month confirm per address before writing the offer

📲 comment RANCH and I will DM you today’s available homes with exact payments incentives and tour times
📩 or DM LIST for a private lineup plus a fast approval plan for VA FHA or conventional Lifestyle Design Realty

#texas #austin #veteran #military #realestate`;

/** Peter's own lines that the first fingerprint list mistook for the pipeline's. */
const HIS_LINES_THAT_LOOK_LIKE_OURS = [
  // 2026-07-09 — two days before the first auto-poster commit. A top-ten post.
  "📲 comment TOUR and I will DM you exact payments incentives and private tour times",
  "📩 or DM LIST for every similar option in San Antonio plus a fast approval plan for VA FHA or conventional",
  // 2026-06-11
  "⭐️ Comment INFO and I’ll DM you everything you need to know or tap the link in bio to get started with us today ⭐️",
  // 2026-07-03
  "📲 Comment AUSTIN and I will DM you today's available homes or DM me LIST for a custom lineup with tour times incentives and a fast payment game plan",
  // 2026-06-16
  "📩 or DM LIST for a private lineup plus a quick approval game plan that fits your budget and timeline",
];

/**
 * What the restructure lane PUBLISHED on 2026-09-18 from PIPELINE_CAPTION_0717 —
 * the 🌳 and 🎓 sections verbatim, read back from Metricool (post 378262626).
 * The repo's own records cut off before them: 200 characters in the posted-log,
 * 500 in the manifest.
 */
const PADDED_SECTION_0918 = `🌳 amenity energy you will actually use
• full community amenity lineup worth asking about
• resort-style pool and gathering spaces
• trails and green space throughout
• designed so you'll actually use it, not just pay for it`;

const PADDED_SCHOOLS_0918 = `🎓 school and numbers
• top-rated school district serving the area
• HOA and taxes vary by address. confirm per address before writing the offer`;

// ─── 1. is the "original" ours? ─────────────────────────────────────────────

describe("a caption this pipeline wrote is recognised as its own", () => {
  test("the real 2026-07-17 flagship caption is ours, by four separate lines", () => {
    assert.deepEqual(botCaptionFingerprints(PIPELINE_CAPTION_0717).sort(), [
      "amenity_placeholder",
      "custom_lineup_cta",
      "payment_breakdown_cta",
      "school_placeholder",
    ]);
    assert.equal(isBotAuthoredCaption(PIPELINE_CAPTION_0717), true);
  });

  test("the hardcoded fallback caption is ours too — it can be hand-posted like any other", () => {
    assert.equal(isBotAuthoredCaption(getFallbackCaption("austin")), true);
  });

  test("typography does not hide it — straight apostrophes, capitals, a wrapped line", () => {
    assert.ok(isBotAuthoredCaption("Pick your favorite and I'll send the full monthly\npayment breakdown on it"));
    assert.ok(isBotAuthoredCaption("SCHOOL RATINGS, HOA AND TAXES VARY BY ADDRESS"));
    assert.ok(isBotAuthoredCaption("📩 or DM LIST for a custom lineup of every similar option"));
  });

  test("the first day's wording of each line is covered (2026-07-13, d09f266)", () => {
    assert.ok(isBotAuthoredCaption("🌳 want the full community rundown and today's available homes? comment TOUR"));
    assert.ok(isBotAuthoredCaption("comment TOUR and I'll DM you today's available homes with a complete monthly payment breakdown, current incentives, and private tour times"));
    assert.ok(isBotAuthoredCaption("or DM LIST and I'll build you a custom lineup of every similar option, with payments"));
  });

  test("empty and non-string input is simply not ours", () => {
    for (const input of [null, undefined, "", "   ", 7, {}, []]) assert.deepEqual(botCaptionFingerprints(input), []);
  });
});

describe("PETER'S CAPTIONS ARE NEVER MISTAKEN FOR OURS — the prompt's CTA was copied from him", () => {
  test("a whole hand-written caption, with his own 'comment WORD and I will DM you' CTA", () => {
    assert.deepEqual(botCaptionFingerprints(HANDWRITTEN_0706), []);
  });

  for (const line of HIS_LINES_THAT_LOOK_LIKE_OURS) {
    test(`not ours: ${line.slice(0, 70)}…`, () => {
      assert.deepEqual(botCaptionFingerprints(line), []);
    });
  }

  test("no fingerprint is built on 'comment TOUR', 'DM LIST' or 'link in bio' alone", () => {
    // The regression this list exists to prevent: these are HIS phrases.
    for (const phrase of ["comment tour and i will dm you", "or dm list for", "link in bio to get started with us today", "lifestyle design realty"]) {
      assert.deepEqual(botCaptionFingerprints(phrase), [], `"${phrase}" must not identify a caption as ours`);
    }
    assert.ok(BOT_CAPTION_FINGERPRINTS.length >= 4);
  });
});

// ─── 2. amenity support ─────────────────────────────────────────────────────

describe("an amenity may be named only if the source names it", () => {
  test("THE 2026-09-18 POST: padded amenities are caught against the template they came from", () => {
    const found = findUnsupportedClaims(PADDED_SECTION_0918, [PIPELINE_CAPTION_0717, "Austin"]);
    assert.deepEqual([...new Set(found.map((f) => f.id))].sort(), ["pool", "trails"]);
    assert.ok(found.every((f) => f.line.startsWith("•")), "each finding carries the caption line it sits on");
  });

  test("the vague line is NOT a claim and is left alone", () => {
    assert.deepEqual(findUnsupportedClaims("• full community amenity lineup worth asking about", []), []);
    assert.deepEqual(findUnsupportedClaims("🌳 full amenity and community rundown available. it's worth asking about", []), []);
  });

  test("a restructure of a REAL original keeps its real amenities — 'resort style pool' supports 'resort-style pools'", () => {
    const restructured = "🌳 amenity energy you will actually use\n• resort-style pools, splash zones and dual waterslides\n• trails and parks for daily reset time";
    assert.deepEqual(findUnsupportedClaims(restructured, [HANDWRITTEN_0706]), []);
    // …and the same lines with no such source are all unsupported.
    assert.ok(findUnsupportedClaims(restructured, []).length >= 3);
  });

  test("an amenity written ON THE VIDEO is a source", () => {
    const overlay = "STARTING AT $389,990 · COMMUNITY POOL + PLAYGROUND";
    assert.deepEqual(findUnsupportedClaims("• community pool and a playground two streets over", [overlay]), []);
    assert.deepEqual(findUnsupportedClaims("• community pool and a dog park", [overlay]).map((f) => f.id), ["dog park"]);
  });

  test("place names and our own headers never trip it", () => {
    for (const line of [
      "brand new construction in Cedar Park",
      "ten minutes from Lake Travis, close to Lakeway",
      "🌳 amenity energy you will actually use",
      "minutes from Zilker Park",
      "the golf cart crowd will love this street",
      "✨ chef's kitchen with island, walk-in pantry and soaring ceilings",
      "carpool-friendly three car garage",
    ]) {
      assert.deepEqual(findUnsupportedClaims(line, []), [], line);
    }
  });

  test("each entry is a FAMILY: a plural, a synonym and a respelling are all supported by one source word", () => {
    assert.deepEqual(findUnsupportedClaims("• resort-style pools", ["one community pool"]), []);
    assert.deepEqual(findUnsupportedClaims("• an outdoor fitness area", ["outdoor gym"]), []);
    assert.deepEqual(findUnsupportedClaims("• an 11-acre community park", ["11-acre city park inside the community"]), []);
    assert.deepEqual(findUnsupportedClaims("• dog parks for the pups", ["Rover Oaks Bark Parque (dog park)"]), []);
    // …but one family never vouches for another.
    assert.deepEqual(findUnsupportedClaims("• dog park", ["11-acre city park"]).map((f) => f.id), ["dog park"]);
    assert.deepEqual(findUnsupportedClaims("• clubhouse", ["resort-style pool"]).map((f) => f.id), ["clubhouse"]);
  });

  test("'resort-style' is puffery, not an amenity — the noun beside it is what gets checked", () => {
    assert.deepEqual(findUnsupportedClaims("• resort-style living every day", []), []);
    assert.deepEqual(findUnsupportedClaims("• resort-style pool", []).map((f) => f.id), ["pool"]);
  });

  describe("THE PROMPT'S OWN PRESCRIBED REWRITES pass against the community they describe", () => {
    // LEAD_GATING_RULES tells the model to turn branded amenities into these
    // exact generic phrases. Each must be supported by the REAL knowledge-base
    // entry of the community it was written about — otherwise the gate refuses
    // what the prompt orders, and the caption loses a retry it cannot win.
    // ("a two-story fitness barn" failed this on the first cut: Rancho Sienna's
    // entry says "Wellness Barn" and never says "fitness".)
    const kb = JSON.parse(readFileSync(join(SRC, "..", "communities.json"), "utf-8"));
    const facts = (name) => [...(kb[name].amenities || []), kb[name].notes || ""].join("\n");
    const prescribed = [
      ["a sand volleyball beach", "Esperanza"],
      ["an 11-acre resort-style amenity club", "Esperanza"],
      ["a two-story fitness barn", "Rancho Sienna"],
      ["a 9-acre clubhouse with resort pool", "Travisso"],
      ["kids adventure camp", "Rancho Sienna"],
    ];
    for (const [phrase, community] of prescribed) {
      test(`"${phrase}" is supported by ${community}'s real entry`, () => {
        assert.ok(kb[community], `${community} is no longer in communities.json — re-home this rewrite`);
        assert.deepEqual(findUnsupportedClaims(phrase, [facts(community)]), []);
      });
    }

    test("…and the same phrase about a community WITHOUT that amenity is refused", () => {
      assert.deepEqual(findUnsupportedClaims("a sand volleyball beach", [facts("Rancho Sienna")]).map((f) => f.id), ["courts"]);
      assert.deepEqual(findUnsupportedClaims("a 9-acre clubhouse with resort pool", [facts("Ventana")]).map((f) => f.id).sort(), ["clubhouse", "pool"]);
    });
  });

  test("the hardcoded fallback names no gated amenity — it must survive its own gate", () => {
    for (const city of ["austin", "san_antonio", "dallas"]) {
      assert.deepEqual(findUnsupportedClaims(getFallbackCaption(city), []), []);
    }
  });

  test("every gated amenity has an id and a pattern that is not global (no lastIndex state)", () => {
    for (const a of GATED_CLAIMS) {
      assert.equal(typeof a.id, "string");
      assert.ok(a.pattern instanceof RegExp && !a.pattern.global && !a.pattern.sticky, a.id);
    }
  });
});

describe("a RATING needs a source too — the 2026-09-18 'top-rated school district'", () => {
  test("the published line is caught: nothing behind it says anything about schools", () => {
    const found = findUnsupportedClaims(PADDED_SCHOOLS_0918, [PIPELINE_CAPTION_0717, "Austin"]);
    assert.deepEqual(found.map((f) => [f.id, f.match]), [["rating", "top-rated"]]);
    const r = stripUnsupportedClaims(PADDED_SCHOOLS_0918, [PIPELINE_CAPTION_0717]);
    assert.equal(r.caption, "🎓 school and numbers\n• HOA and taxes vary by address. confirm per address before writing the offer");
  });

  test("the dictated no-KB line and our own header make no claim", () => {
    for (const line of [
      "🎓 school ratings, HOA and taxes vary by address. exact numbers on request",
      "🎓 school and numbers",
      "• Boerne ISD, confirm per address before writing the offer",
    ]) assert.deepEqual(findUnsupportedClaims(line, []), [], line);
  });

  test("PETER'S OWN claim carries through a restructure of his caption", () => {
    // Flagship, 2026-07-02, hand-written: the one rating claim in the whole cache.
    assert.deepEqual(findUnsupportedClaims("• top-rated schools just minutes away", ["• Top-rated schools nearby"]), []);
  });

  test("the knowledge base's own rating supports it — and only for the community that has one", () => {
    const kb = JSON.parse(readFileSync(join(SRC, "..", "communities.json"), "utf-8"));
    assert.match(kb.Esperanza.school_district, /A-rated/, "Esperanza's entry no longer carries a rating — re-home this test");
    assert.deepEqual(findUnsupportedClaims("🎓 A-rated Boerne ISD with an elementary on-site", [kb.Esperanza.school_district]), []);
    assert.deepEqual(findUnsupportedClaims("🎓 highly rated Boerne ISD", [kb.Esperanza.school_district]), [], "one family: any sourced rating supports a rating");
    assert.deepEqual(findUnsupportedClaims("🎓 top-rated Liberty Hill ISD", [kb["Rancho Sienna"].school_district]).map((f) => f.id), ["rating"]);
  });

  test("the usual spellings are all caught, and ordinary copy is not", () => {
    for (const claim of ["top rated schools", "highly-rated district", "best-rated in the county", "an A-rated district", "A+-rated schools", "award-winning schools", "exemplary campuses", "great schools nearby", "a sought-after district", "blue ribbon elementary"]) {
      assert.equal(findUnsupportedClaims(claim, []).map((f) => f.id).join(), "rating", claim);
    }
    for (const fine of ["the payment rated a second look", "a great school run from here", "schools, HOA and taxes vary by address", "rate buydowns available", "this is a top floor plan"]) {
      assert.deepEqual(findUnsupportedClaims(fine, []), [], fine);
    }
  });
});

describe("the last resort deletes the line, and a header left over nothing", () => {
  test("only the unsupported lines go; the vague lines and the header stay", () => {
    const r = stripUnsupportedClaims(PADDED_SECTION_0918, [PIPELINE_CAPTION_0717]);
    assert.deepEqual(r.removed, ["• resort-style pool and gathering spaces", "• trails and green space throughout"]);
    assert.equal(
      r.caption,
      "🌳 amenity energy you will actually use\n• full community amenity lineup worth asking about\n• designed so you'll actually use it, not just pay for it"
    );
  });

  test("a header whose WHOLE body was unsupported goes with it", () => {
    const caption = "✨ everyday living hits\n• open floor plan\n\n🌳 amenity energy you will actually use\n• resort-style pool\n• dog park and trails\n\n💸 buyer wins\n• VA and FHA welcome";
    const r = stripUnsupportedClaims(caption, []);
    assert.equal(r.caption, "✨ everyday living hits\n• open floor plan\n\n💸 buyer wins\n• VA and FHA welcome");
    assert.ok(r.removed.includes("🌳 amenity energy you will actually use"));
  });

  test("a header is NOT removed when nothing under it was deleted", () => {
    const caption = "🎓 school and numbers\n\n💸 buyer wins\n• community pool";
    const r = stripUnsupportedClaims(caption, []);
    assert.ok(r.caption.includes("🎓 school and numbers"), "an already-empty header is not this function's business");
  });

  test("a SENTENCE that opens with an emoji is not a header", () => {
    const caption = "🌳 the pool is steps away. bring the kids.\n• shaded seating";
    const r = stripUnsupportedClaims(caption, []);
    assert.deepEqual(r.removed, ["🌳 the pool is steps away. bring the kids."]);
    assert.equal(r.caption, "• shaded seating");
  });

  test("a clean caption comes back byte-identical, with nothing removed", () => {
    const r = stripUnsupportedClaims(PIPELINE_CAPTION_0717, []);
    assert.equal(r.caption, PIPELINE_CAPTION_0717);
    assert.deepEqual(r.removed, []);
  });
});

describe("enforceClaimSupport — one retry, then the knife", () => {
  test("nothing unsupported: the caption is returned untouched, no retry", () => {
    assert.deepEqual(enforceClaimSupport("• open floor plan", [], { attempt: 1 }), { caption: "• open floor plan" });
  });

  test("attempt 1: a retry suffix that NAMES the amenity", () => {
    const r = enforceClaimSupport(PADDED_SECTION_0918, [], { attempt: 1, lane: "fresh" });
    assert.equal(r.caption, undefined);
    assert.match(r.retry, /REJECTED for stating things that appear NOWHERE/);
    assert.match(r.retry, /"pool"/);
    assert.match(r.retry, /"trails"/);
  });

  test("attempt 2: no third try — the lines are deleted and reported", () => {
    const r = enforceClaimSupport(PADDED_SECTION_0918, [], { attempt: 2, lane: "fresh" });
    assert.equal(r.retry, undefined);
    assert.equal(r.removed.length, 2);
    assert.doesNotMatch(r.caption, /pool|trails/);
  });

  test("the retry instruction lists each amenity once", () => {
    const text = claimRetryInstruction([{ match: "pool" }, { match: "pool" }, { match: "trails" }]);
    assert.equal(text.match(/"pool"/g).length, 1);
  });
});

// ─── 3. the generators, driven end to end with a stub model ─────────────────

/** A caption body that passes validateCaption; `amenities` is spliced into the 🌳 section. */
function modelCaption({ amenities = [], first = "would you believe this is brand new construction in Austin?" } = {}) {
  const amenityBlock = amenities.length ? `\n🌳 amenity energy you will actually use\n${amenities.map((a) => `• ${a}`).join("\n")}\n` : "";
  return `${first}

new construction like this doesn't sit long in this market

✨ everyday living hits
• open floor plan that actually flows
• natural light pouring in from everywhere
• modern finishes throughout
${amenityBlock}
💸 buyer wins
• VA, FHA, USDA and conventional financing all welcome here
• builder incentives and rate buydowns available

perfect for growing families, military/veteran buyers, or anyone ready to stop renting

📲 comment TOUR and I'll DM you today's available homes. pick your favorite and I'll send the full monthly payment breakdown on it
📩 or DM LIST for a custom lineup of every similar option plus a fast approval game plan
⭐️ link in bio to get started with us today

Lifestyle Design Realty`;
}

function stubClient(replies) {
  const prompts = [];
  return {
    prompts,
    messages: {
      create: async ({ messages }) => {
        prompts.push(messages[0].content);
        const text = replies[Math.min(prompts.length - 1, replies.length - 1)];
        return { content: [{ text }] };
      },
    },
  };
}

const PADDED = ["resort-style pool and gathering spaces", "trails and green space to unwind"];

describe("fresh lane — generateCaption", () => {
  test("a padded first attempt is sent back with the amenity named, and the clean second attempt ships", async () => {
    const client = stubClient([modelCaption({ amenities: PADDED }), modelCaption()]);
    const caption = await generateCaption("austin", { price: "$455,000", city: "Austin" }, { hookStyle: "question", client });
    assert.equal(client.prompts.length, 2);
    assert.match(client.prompts[1], /REJECTED for stating things that appear NOWHERE/);
    assert.match(client.prompts[1], /"pool"/);
    assert.doesNotMatch(client.prompts[1], /CRITICAL CORRECTION/, "an amenity retry must not be told its caption was malformed");
    assert.doesNotMatch(caption, /pool|trails/);
    assert.equal(validateCaption(caption).valid, true);
  });

  test("padded TWICE: the lines are deleted, the emptied header goes, and what ships is still a valid caption", async () => {
    const client = stubClient([modelCaption({ amenities: PADDED })]);
    const caption = await generateCaption("austin", { price: "$455,000", city: "Austin" }, { hookStyle: "question", client });
    assert.equal(client.prompts.length, 2);
    assert.doesNotMatch(caption, /pool|trails|amenity energy/);
    assert.match(caption, /everyday living hits/);
    assert.equal(validateCaption(caption).valid, true);
  });

  test("an amenity WRITTEN ON THE VIDEO ships on the first attempt", async () => {
    const client = stubClient([modelCaption({ amenities: ["community pool two streets over"] })]);
    const caption = await generateCaption("austin", { price: "$455,000", city: "Austin", raw_text: "$455,000 · COMMUNITY POOL" }, { hookStyle: "question", client });
    assert.equal(client.prompts.length, 1);
    assert.match(caption, /community pool/);
  });

  test("a VALIDATION failure still gets the validation retry — the two suffixes are not confused", async () => {
    const client = stubClient([modelCaption({ first: "# OUTPUT\n\nwould you believe this is brand new construction in Austin?" }), modelCaption()]);
    const caption = await generateCaption("austin", { price: "$455,000" }, { hookStyle: "question", client });
    assert.equal(client.prompts.length, 2);
    assert.match(client.prompts[1], /CRITICAL CORRECTION/);
    assert.doesNotMatch(client.prompts[1], /REJECTED for stating things that appear NOWHERE/);
    assert.doesNotMatch(caption, /# OUTPUT/);
  });

  test("'# OUTPUT' twice lands on the hardcoded fallback, never on the platform", async () => {
    const client = stubClient([modelCaption({ first: "# OUTPUT\n\nwould you believe it?" })]);
    const caption = await generateCaption("austin", null, { hookStyle: "question", client });
    assert.doesNotMatch(caption, /# OUTPUT/);
    assert.equal(caption.split("\n")[0], getFallbackCaption("austin").split("\n")[0]);
  });
});

describe("restructure lane — generateCaptionFromOriginal", () => {
  test("OUR OWN caption is refused as an original: the model is asked for a FRESH caption instead", async () => {
    const client = stubClient([modelCaption()]);
    await generateCaptionFromOriginal(PIPELINE_CAPTION_0717, "austin", null, { hookStyle: "question", client });
    assert.equal(client.prompts.length, 1);
    assert.match(client.prompts[0], /^Write an Instagram Reel caption/);
    assert.doesNotMatch(client.prompts[0], /ORIGINAL CAPTION:/);
    assert.ok(!client.prompts[0].includes("supposed to feel like"), "the refused caption's words never reach the model");
  });

  test("Peter's caption IS restructured, and its real amenities survive on the first attempt", async () => {
    const client = stubClient([modelCaption({ amenities: ["resort-style pools, splash zones and dual waterslides", "trails and parks for daily reset time"] })]);
    const caption = await generateCaptionFromOriginal(HANDWRITTEN_0706, "austin", null, { hookStyle: "question", client });
    assert.equal(client.prompts.length, 1);
    assert.match(client.prompts[0], /ORIGINAL CAPTION:/);
    assert.match(caption, /resort-style pools/);
    assert.match(caption, /trails and parks/);
  });

  test("an original with NO amenities cannot be padded — named on the retry, deleted on the second", async () => {
    const original = "soaring ceilings and walls of glass in Hill Country for $524k\n🎓 Boerne ISD\n📲 comment HILL and I will DM you today's available homes\nLifestyle Design Realty";
    const client = stubClient([modelCaption({ amenities: PADDED })]);
    const caption = await generateCaptionFromOriginal(original, "san_antonio", null, { hookStyle: "question", client });
    assert.equal(client.prompts.length, 2);
    assert.match(client.prompts[1], /REJECTED for stating things that appear NOWHERE/);
    assert.doesNotMatch(caption, /pool|trails/);
    assert.equal(validateCaption(caption).valid, true);
  });

  test("a padded SCHOOLS section is named on the retry and deleted on the second attempt", async () => {
    const original = "soaring ceilings and walls of glass in Hill Country for $524k\n📲 comment HILL and I will DM you today's available homes\nLifestyle Design Realty";
    const padded = modelCaption().replace("\n💸 buyer wins", "\n🎓 school and numbers\n• top-rated school district serving the area\n\n💸 buyer wins");
    const client = stubClient([padded]);
    const caption = await generateCaptionFromOriginal(original, "san_antonio", null, { hookStyle: "question", client });
    assert.equal(client.prompts.length, 2);
    assert.match(client.prompts[1], /"top-rated"/);
    assert.doesNotMatch(caption, /top-rated|school and numbers/, "the claim goes, and the header it emptied goes with it");
    assert.equal(validateCaption(caption).valid, true);
  });

  test("the prompt forbids padding in words too, and names the section to omit", async () => {
    const client = stubClient([modelCaption()]);
    await generateCaptionFromOriginal(HANDWRITTEN_0706, "austin", null, { hookStyle: "question", client });
    assert.match(client.prompts[0], /NO PADDING/);
    assert.match(client.prompts[0], /OMIT the 🌳 section/);
    assert.match(client.prompts[0], /never describe schools or a district as "top-rated"/);
  });
});

// ─── 4. main.js routes on it, and tags what it did ──────────────────────────

describe("main.js refuses our own caption BEFORE any reuse branch can run", () => {
  const main = readFileSync(join(SRC, "main.js"), "utf-8");

  test("the fingerprint check precedes every call into the restructure lane", () => {
    const check = main.indexOf("botCaptionFingerprints(cachedMatch[0].caption)");
    const firstReuse = main.indexOf("generateCaptionFromOriginal(matchCaption");
    assert.ok(check > 0, "main.js must fingerprint the cached caption");
    assert.ok(firstReuse > check, "…and must do it before the first restructure call");
  });

  test("the refusal is its own branch, ahead of the distance branches, and writes fresh", () => {
    const branch = main.slice(main.indexOf("if (ownFingerprints.length > 0) {"), main.indexOf("} else if (cachedMatch && cachedMatch.length > 0 && cachedMatch[0].caption) {"));
    assert.ok(branch.length > 0, "the refusal must be the FIRST arm of the caption if/else chain");
    assert.match(branch, /originalRefused = "bot_authored"/);
    assert.match(branch, /generateCaption\(CITY, videoOverlays, captionOptions\)/);
    assert.doesNotMatch(branch, /captionSource = "restructured"/, "a refused original must not be tagged restructured");
  });

  test("the posted-log says WHY a matched file was captioned fresh", () => {
    assert.match(main, /original_refused: originalRefused \|\| undefined/);
  });
});

describe("generation.topic.community_kb means a knowledge-base match", () => {
  const main = readFileSync(join(SRC, "main.js"), "utf-8");

  test("the tag is the caption lane's own lookup, and the old reading keeps an honest name", () => {
    assert.match(main, /community_kb: !!matchCommunityForVideo\(CITY, videoOverlays\)/);
    assert.match(main, /overlay_community: !!videoOverlays\?\.community/);
    assert.doesNotMatch(main, /community_kb: !!videoOverlays\?\.community/);
  });

  test("THE REAL OVERLAY STRINGS of 2026-09-10..18 match nothing — all ten were tagged true", () => {
    const seen = [
      ["san_antonio", "North West"], ["san_antonio", "Highland"], ["san_antonio", "Northwest"],
      ["austin", "Leander"], ["austin", "Lake Travis"], ["san_antonio", "Alamo Ranch"],
      ["san_antonio", "Far West"], ["san_antonio", "Perry Homes"], ["austin", "North Austin"],
    ];
    for (const [city, community] of seen) {
      assert.equal(matchCommunityForVideo(city, { community }), null, `${community} is not in communities.json`);
    }
  });

  test("a real knowledge-base community matches; no overlay community is simply null", () => {
    assert.equal(matchCommunityForVideo("san_antonio", { community: "Esperanza" })?.name, "Esperanza");
    assert.equal(matchCommunityForVideo("austin", { community: null }), null);
    assert.equal(matchCommunityForVideo("austin", null), null);
  });
});
