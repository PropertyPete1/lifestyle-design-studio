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
