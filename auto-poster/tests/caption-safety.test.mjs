/**
 * Caption safety rules — the two ways a caption bug becomes a business incident:
 *
 *   1. A gated community/builder name leaks, giving away the information the
 *      whole lead-gen model exists to gate.
 *   2. A specific monthly payment figure is published, which is both a leak and
 *      an advertising-compliance problem.
 *
 * Both were previously enforced only by prompt text and one strict regex.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { scanAndStripLeaks } from "../src/caption.js";
import { findMonthlyPaymentFigure, validateCaption } from "../src/caption-validator.js";

const leaked = (text) => scanAndStripLeaks(text, null).leaksFound > 0;
const strip = (text) => scanAndStripLeaks(text, null).caption;

describe("leak scanner — gated community names", () => {
  test("catches the plain name", () => {
    assert.ok(leaked("Come tour Esperanza today."));
    assert.match(strip("Come tour Esperanza today."), /this community/);
  });

  test("catches a possessive", () => {
    assert.ok(leaked("Esperanza's amenity center is stunning."));
  });

  test("catches a plural", () => {
    assert.ok(leaked("The Esperanzas have great homes."));
  });

  test("catches a name split across a line break", () => {
    // Captions are multi-line; models wrap mid-phrase constantly.
    assert.ok(leaked("Check out The Club at\nEsperanza this weekend."));
  });

  test("catches a name with a non-breaking space", () => {
    assert.ok(leaked("Welcome to Walsh Ranch, gorgeous."));
  });

  test("catches a name hyphenated instead of spaced", () => {
    assert.ok(leaked("Welcome to Walsh-Ranch, gorgeous."));
  });

  test("catches a name with zero-width characters injected", () => {
    assert.ok(leaked("Welcome to Espe​ranza, gorgeous."));
  });

  test("leaves clean copy untouched", () => {
    const clean = "Brand new construction in San Antonio. Comment TOUR for details.";
    const r = scanAndStripLeaks(clean, null);
    assert.equal(r.leaksFound, 0);
    assert.equal(r.caption, clean);
  });
});

describe("leak scanner — branded amenities and builders", () => {
  test("catches a branded amenity with a typographic apostrophe", () => {
    // Models emit U+2019 far more often than ASCII "'".
    assert.ok(leaked("Happy’s Splash Park is a blast for kids."));
  });

  test("catches a branded amenity with diacritics stripped", () => {
    // KB has "Reunión Parque"; models routinely drop the accent.
    assert.ok(leaked("Reunion Parque has a resort pool."));
  });

  test("catches a builder name", () => {
    assert.ok(leaked("Built by Perry Homes."));
    assert.match(strip("Built by Perry Homes."), /the builder/);
  });

  test("repairs the possessive artifact left behind by replacement", () => {
    assert.match(strip("Built by Perry Homes' design team."), /the builder's design team/);
  });
});

describe("leak scanner — builder shopping", () => {
  test("catches a numeric builder count", () => {
    assert.ok(leaked("Choose from 5 different builders here."));
    assert.match(strip("Choose from 5 different builders here."), /multiple floor plan options/);
  });

  test("catches a SPELLED-OUT builder count", () => {
    // Voiceover prompts explicitly instruct the model to spell numbers as words,
    // so this form is at least as likely as the numeric one.
    assert.ok(leaked("Choose from five different builders here."));
  });

  test("catches vague quantifiers", () => {
    assert.ok(leaked("There are several builders in this area."));
  });
});

describe("monthly payment figure guard", () => {
  describe("MUST detect", () => {
    for (const bad of [
      "Your payment would be $1,850/mo.",
      "That's $1850 per month.",
      "About $2,100 a month for this one.",
      "The monthly payment of $1,750 is a steal.",
      "Estimated mortgage payment: $1,999.",
      "Just 1,850 dollars a month.",
      "$1,650 monthly and it's yours.",
      "You're looking at eighteen hundred a month.",
      "The monthly payment is around two thousand dollars per month.",
    ]) {
      test(JSON.stringify(bad), () => {
        assert.equal(findMonthlyPaymentFigure(bad).found, true);
      });
    }
  });

  describe("MUST NOT fire on legitimate copy", () => {
    for (const ok of [
      "Brand new construction starting at $389,000.",
      "The monthly payment on this one is lower than most people guess.",
      "Comment TOUR and I'll send you the exact payment breakdown.",
      "With the 4.99% fixed rate, the payment surprises people.",
      "Homes from the $300s in this community.",
      "The tax rate is 2.5% — confirm per address before writing the offer.",
      "Wait until you hear what this costs per month.",
    ]) {
      test(JSON.stringify(ok), () => {
        assert.equal(findMonthlyPaymentFigure(ok).found, false);
      });
    }
  });

  test("validateCaption REJECTS a caption containing a payment figure", () => {
    const caption = [
      "Brand new construction in San Antonio ✨",
      "Three bedrooms, quartz counters, and a huge yard.",
      "Your payment would be $1,850/mo — unbeatable for this area.",
      "Lifestyle Design Realty",
      "comment TOUR and I'll DM you today's available homes.",
    ].join("\n").padEnd(220, " ");
    const r = validateCaption(caption);
    assert.equal(r.valid, false);
    assert.ok(
      r.failures.some((f) => /monthly payment figure/.test(f)),
      `expected a payment-figure failure, got: ${JSON.stringify(r.failures)}`
    );
  });

  test("validateCaption ACCEPTS the same caption with the figure teased instead", () => {
    const caption = [
      "Brand new construction in San Antonio ✨",
      "Three bedrooms, quartz counters, and a huge yard.",
      "The monthly payment is lower than most people guess.",
      "Lifestyle Design Realty",
      "comment TOUR and I'll DM you today's available homes.",
    ].join("\n").padEnd(220, " ");
    const r = validateCaption(caption);
    assert.equal(r.valid, true, `unexpected failures: ${JSON.stringify(r.failures)}`);
  });
});

describe("markdown headers — the 2026-09-15 '# OUTPUT' caption", () => {
  // The caption as it was published, first lines verbatim: three Instagram
  // accounts and TikTok opened on "# OUTPUT", and it became the YouTube Short's
  // title. Everything AFTER the first line was a perfectly valid caption —
  // which is why the old /^##\s/ rule, which only knew second-level headers,
  // passed the whole thing.
  const body = [
    "would you believe this is brand new construction in San Antonio?",
    "",
    "new construction like this doesn't stay on the market long.",
    "",
    "✨ open floor plan with tons of natural light, modern finishes throughout, and a kitchen built for real living.",
    "",
    "💸 VA, FHA, USDA, and conventional financing all welcome here",
    "",
    "📲 comment TOUR and I'll DM you today's available homes. pick your favorite and I'll send the full monthly payment breakdown on it",
    "Lifestyle Design Realty",
    "#texas #sanantonio #realestate #military #veteran #newconstruction",
  ].join("\n");

  const headerFailure = (r) => (r.failures || []).some((f) => /markdown header/.test(f));

  test("the published caption is REFUSED, and the reason names the header", () => {
    const r = validateCaption(`# OUTPUT\n\n${body}`);
    assert.equal(r.valid, false);
    assert.ok(headerFailure(r), `expected a markdown-header failure, got: ${JSON.stringify(r.failures)}`);
  });

  test("the same caption WITHOUT that line is valid — the header is the only fault", () => {
    const r = validateCaption(body);
    assert.equal(r.valid, true, `unexpected failures: ${JSON.stringify(r.failures)}`);
  });

  test("every header level is refused, wherever in the caption it sits", () => {
    for (const header of ["# Caption", "## Caption", "### Instagram caption", "###### deep", "  # indented", "#\tTabbed"]) {
      assert.ok(headerFailure(validateCaption(`${header}\n\n${body}`)), `leading ${JSON.stringify(header)}`);
      assert.ok(headerFailure(validateCaption(body.replace("\n\n✨", `\n\n${header}\n\n✨`))), `mid-caption ${JSON.stringify(header)}`);
    }
  });

  test("HASHTAGS ARE NOT HEADERS — the locked hashtag line and '#1' must pass", () => {
    // The whitespace after the hashes is the whole distinction. Every caption
    // this pipeline publishes ends in a line that starts with '#'.
    for (const line of [
      "#texas #austin #realestate #military #veteran #newconstruction",
      "#1 reason people tour this one twice",
      "#newconstruction",
      "this one is # 1 on my list", // a '#' that does not open the line
    ]) {
      const r = validateCaption(`${body}\n${line}`);
      assert.equal(headerFailure(r), false, `${JSON.stringify(line)} was mistaken for a header`);
    }
  });
});
