import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { findImpossibleCta, ctaIsPossible, VALID_MECHANICS } from "../src/yt-cta.js";
import { buildDescription, buildPinnedComment, validatePackaging, ctaConfig } from "../src/yt-packaging.js";
import { validateCaption } from "../src/caption-validator.js";

describe("YouTube has no direct messages", () => {
  describe("flags copy promising a message the platform cannot send", () => {
    for (const line of [
      "Comment MATH and I'll DM you the breakdown",
      "comment MATH and I will DM you",
      "Comment MATH below and I'll send it over.",
      "Drop your city and I'll send you the numbers",
      "I'll direct message you the payment breakdown",
      "DM you within the hour",
    ]) {
      test(JSON.stringify(line.slice(0, 46)), () => {
        assert.equal(findImpossibleCta(line).length, 1, "should have been flagged");
      });
    }
  });

  describe("leaves the four mechanics that actually work alone", () => {
    for (const line of [
      "Comment MATH and I'll reply with the breakdown.",
      "Comment the city you're coming from and I'll answer you.",
      "Text me at 210-555-0142",
      "Or text me directly: 210-555-0142",
      "Email me at peter@lifestyledesignrealty.com",
      "Everything else is linked in the description",
      "My number is on the screen and down in the description. Text me.",
      "I'll send a link in the description",
    ]) {
      test(JSON.stringify(line.slice(0, 46)), () => {
        assert.deepEqual(findImpossibleCta(line), [], "should be allowed");
      });
    }
  });

  test("the valid mechanics are documented for the prompt to quote", () => {
    assert.equal(VALID_MECHANICS.length, 4);
    assert.ok(VALID_MECHANICS.some((m) => /reply/i.test(m)));
    assert.ok(VALID_MECHANICS.some((m) => /text/i.test(m)));
  });

  test("empty and junk input never throws", () => {
    for (const junk of ["", null, undefined, 0, [], {}]) assert.doesNotThrow(() => findImpossibleCta(junk));
  });
});

describe("the generated YouTube copy", () => {
  test("the description CTA replies rather than sending", () => {
    const { text } = buildDescription({ hook: "h", promise: "p" });
    assert.match(text, /I'll reply with it/);
    assert.deepEqual(findImpossibleCta(text), []);
  });

  test("the pinned comment replies rather than sending", () => {
    const pinned = buildPinnedComment({ cta: { phone: "210-555-0142", links: null, email: null } });
    assert.match(pinned, /I'll reply with/);
    assert.deepEqual(findImpossibleCta(pinned), []);
  });

  test("the pinned comment offers a private channel as the second option", () => {
    const withPhone = buildPinnedComment({ cta: { phone: "210-555-0142", links: null, email: null } });
    assert.match(withPhone, /text me/i);
    // No phone configured: it should fall back to email rather than dropping
    // the contact path entirely.
    const withEmail = buildPinnedComment({ cta: { phone: null, links: null, email: "peter@example.com" } });
    assert.match(withEmail, /email me/i);
  });

  test("packaging validation REJECTS a DM promise rather than publishing it", () => {
    const pkg = {
      title: "Moving to San Antonio: what $400K buys",
      description: "A hook line.\nA promise line.\n\nComment MATH below and I'll DM you the breakdown.",
      tags: ["san antonio"],
      pinnedComment: "Comment MATH and I'll reply with the breakdown.",
    };
    const v = validatePackaging(pkg);
    assert.equal(v.valid, false);
    assert.ok(v.failures.some((f) => /YouTube cannot send/.test(f)), v.failures.join("; "));
  });

  test("packaging validation catches it in the pinned comment too", () => {
    const pkg = {
      title: "Moving to San Antonio: what $400K buys",
      description: "A hook line.\nA promise line.",
      tags: ["san antonio"],
      pinnedComment: "Comment MATH and I'll send you the breakdown.",
    };
    assert.ok(validatePackaging(pkg).failures.some((f) => /pinned comment promises/.test(f)));
  });

  test("clean copy passes the CTA check", () => {
    const pkg = {
      title: "Moving to San Antonio: what $400K buys",
      description: buildDescription({ hook: "h", promise: "p" }).text,
      tags: ["san antonio"],
      pinnedComment: buildPinnedComment(),
    };
    assert.ok(!validatePackaging(pkg).failures.some((f) => /YouTube cannot send/.test(f)));
  });
});

describe("the Instagram path is NOT affected — DMs are real there", () => {
  test("the IG caption CTA still uses DM and still validates", () => {
    // If the YouTube ban ever leaked into the carousel path, this is what would
    // catch it: the IG primary CTA is built on a DM and must stay legal.
    const caption = [
      "🏡 Three neighborhoods people actually move to",
      "",
      "✨ Big lots and grown trees",
      "💸 Taxes are the part nobody explains",
      "🌳 Quiet streets, real sidewalks",
      "🎓 Schools worth checking by address",
      "",
      "📲 comment TOUR and I'll DM you today's available homes. pick your favorite and I'll send the full monthly payment breakdown on it",
      "📩 or DM LIST for a custom lineup of every similar option plus a fast approval game plan",
      "",
      "#sanantonio #realestate #movingtotexas",
    ].join("\n");
    const v = validateCaption(caption);
    assert.ok(!v.failures.some((f) => /DM/.test(f) && /max/.test(f)), `IG DM CTA was rejected: ${v.failures.join("; ")}`);
  });

  test("the YouTube ban would flag that same IG caption — which is why it is never applied to it", () => {
    // Stated as a test so the separation is deliberate and visible rather than
    // an accident of which module imports which.
    assert.ok(findImpossibleCta("📲 comment TOUR and I'll DM you today's available homes").length > 0);
    assert.equal(ctaIsPossible("Comment MATH and I'll reply with the breakdown."), true);
  });
});

describe("a named channel makes 'send' fulfillable", () => {
  test("'I'll send you X' with no channel is a DM promise", () => {
    assert.equal(findImpossibleCta("Drop your city and I'll send you the numbers.").length, 1);
  });

  test("'I'll send you X' WITH a channel is fine", () => {
    // Video 1's close reads this way and is good copy. A blunt rule flagged it
    // and would have forced a regeneration of a take that is already correct.
    assert.deepEqual(findImpossibleCta("Text me at 210-555-0142 and I'll send you the numbers."), []);
    assert.deepEqual(findImpossibleCta("My number is on the screen. Text me, and I'll send you the breakdown in writing."), []);
  });

  test("naming a channel never rescues an explicit DM", () => {
    assert.equal(findImpossibleCta("I'll DM you the breakdown. Or text 210-555-0142.").length, 1);
  });

  test("video 1's actual close passes", () => {
    const close = "Here's what I'd do. Send me the address you're looking at, or just the area and your rating, and I'll run the real numbers. Then I'll send you your actual monthly payment in writing, before you fall in love with anything. My number is on the screen and down in the description. Text me, or comment the city you're coming from and I'll answer you.";
    assert.deepEqual(findImpossibleCta(close), []);
  });

  test("blocks are evaluated whole, so the ask and the channel can be different sentences", () => {
    const twoBlocks = "Comment MATH and I'll send you the breakdown.\n\nSomething unrelated about schools.";
    assert.equal(findImpossibleCta(twoBlocks).length, 1, "the channel is not in that block, so it should flag");
  });
});
