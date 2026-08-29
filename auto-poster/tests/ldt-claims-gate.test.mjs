/**
 * The honest-claims gate — nothing is promised that isn't built.
 *
 * ldt-claims.json mirrors the sales site's test-pinned copy; the gate makes
 * the doctrine mechanical: banned overclaims fail, and every enforceable
 * figure in a caption must appear EXACTLY in the pinned claims (the same
 * exact-equality rule source-respect Gate 3 uses for voiceovers — $2,500
 * never authorises $2,500,000, and here $99 never authorises $98).
 *
 * The teeth tests at the bottom matter most: the pinned fallback caption and
 * every self-made surface (deck, card, reel — every angle × hook style) are
 * run through the gate they exist to satisfy. A copy edit that drifts from
 * the claims list fails HERE, in CI, not on Instagram.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  loadLdtClaims, buildAllowedFigures, checkClaimsCompliance, describeViolations,
} from "../src/ldt-claims-gate.js";
import {
  validateLdtCaption, getLdtFallbackCaption, lockLdtHashtags,
} from "../src/ldt-caption.js";
import { carouselAngles, deckText, pickAngle } from "../src/ldt-carousel-gen.js";
import { cardText } from "../src/ldt-card-gen.js";
import { reelText } from "../src/ldt-text-reel.js";
import { HOOK_STYLE_IDS } from "../src/hook-styles.js";
import { loadBrandRegistry } from "../src/brands.js";

const claims = loadLdtClaims();
const allowed = buildAllowedFigures(claims);
const brand = loadBrandRegistry().brands.ldt;

describe("pinned figures pass, unpinned figures fail", () => {
  const PASSES = [
    "Solo starts at $99/mo with $0 setup.",
    "PRIMARY briefs you every morning at 7:05.",
    "A 20-person office pays under $90 per person.",
    "4,400+ contacts live on THE FLOOR today.",
    "150 nurture emails sent in one day, every one logged.",
    "Team is $449/mo with 5,000 contacts included.",
    "New leads contacted in under five minutes.",
  ];
  for (const text of PASSES) {
    test(`passes: ${JSON.stringify(text)}`, () => {
      const r = checkClaimsCompliance(text, claims, allowed);
      assert.equal(r.ok, true, describeViolations(r.violations));
    });
  }

  // NOTE: the figure pool is context-free by design (same as the voiceover
  // honesty gate) — "500 emails" would pass because $500 is pinned as the
  // website build price. The gate guarantees no NUMBER exists outside the
  // pinned pool; it does not check units. Test with numbers no claim pins.
  const FAILS = [
    ["$98/mo — one dollar off the pinned price", "It's just $98/mo."],
    ["an invented contact count", "Handles 10,000 contacts out of the box."],
    ["an invented email volume", "It sent 700 emails yesterday."],
  ];
  for (const [why, text] of FAILS) {
    test(`fails (${why})`, () => {
      const r = checkClaimsCompliance(text, claims, allowed);
      assert.equal(r.ok, false);
      assert.ok(r.violations.some(v => v.type === "number"), "flagged as a number violation");
    });
  }
});

describe("banned overclaims fail regardless of numbers", () => {
  const BANNED = [
    ["'never lies' — the doctrine is 'never guesses'", "PRIMARY never lies to you."],
    ["guarantees", "Guaranteed to double your closings."],
    ["retired tier name", "Sign up for our Starter plan today."],
    ["live scarcity count", "Only 2 spots remaining!"],
    ["founding-offer terms", "Founding clients get 25% off, locked for life."],
    ["invented discount — ANY percent off, not just the founding 25", "Get 50% off this month only."],
    ["invented discount with a pinned digit", "Save 20% off your first year."],
    ["invented free month", "First month free when you sign up today."],
    ["instant provisioning", "Instantly set up in minutes."],
    ["unlimited AI", "Unlimited AI usage on every plan."],
    ["autonomy overclaim", "Fully autonomous — no approval needed."],
    ["unsubstantiated superlative", "The best AI assistant on the market."],
  ];
  for (const [why, text] of BANNED) {
    test(`fails (${why})`, () => {
      const r = checkClaimsCompliance(text, claims, allowed);
      assert.equal(r.ok, false, `should have failed: ${text}`);
      assert.ok(r.violations.some(v => v.type === "banned_phrase"), "flagged as a banned phrase");
    });
  }

  test("the meta-angle line itself is clean", () => {
    const r = checkClaimsCompliance(claims.metaAngle.line, claims, allowed);
    assert.equal(r.ok, true);
  });
});

describe("validateLdtCaption structure rules", () => {
  test("the CTA must appear exactly once", () => {
    const base = getLdtFallbackCaption(brand, claims);
    const doubled = base + `\n\nComment ${brand.cta.keyword} again!`;
    const v = validateLdtCaption(doubled, brand, claims, allowed);
    assert.equal(v.valid, false);
    assert.ok(v.failures.some(f => f.includes("exactly once")), v.failures.join("; "));
  });

  test("a caption that never names the product fails", () => {
    // No product name anywhere — including no CTA, since the CTA keyword IS
    // the product name and legitimately satisfies the mention rule.
    const v = validateLdtCaption(
      "Great software, honestly. You should try it. Really changes the morning routine for any team out there today, and then some.",
      brand, claims, allowed
    );
    assert.equal(v.valid, false);
    assert.ok(v.failures.some(f => f.includes("must mention")), v.failures.join("; "));
  });

  test("lockLdtHashtags strips model hashtags and appends the locked set", () => {
    const out = lockLdtHashtags("PRIMARY is live. #hustle #ai4life", brand);
    assert.ok(!out.includes("#hustle"));
    assert.ok(out.endsWith(brand.hashtags), "locked set is the final line");
  });

  // validateLdtCaption is the SOLE runtime arbiter of generated-vs-fallback,
  // so every rule needs its negative — a loosened check must fail a test.
  test("a caption with NO CTA fails the exactly-once rule", () => {
    const v = validateLdtCaption(
      "PRIMARY watches your pipeline and briefs you every morning. Born inside a working Texas brokerage, running live today, for any business that books customers.",
      brand, claims, allowed
    );
    assert.equal(v.valid, false);
    assert.ok(v.failures.some(f => f.includes("exactly once (found 0)")), v.failures.join("; "));
  });

  test("too short, markdown, and em-dashes are each rejected", () => {
    const short = validateLdtCaption("PRIMARY.", brand, claims, allowed);
    assert.ok(short.failures.some(f => f.includes("too short")));

    const base = getLdtFallbackCaption(brand, claims);
    const markdown = validateLdtCaption("**PRIMARY** is live.\n" + base, brand, claims, allowed);
    assert.ok(markdown.failures.some(f => f.includes("markdown")));

    const dashed = validateLdtCaption(base.replace("PRIMARY, working.", "PRIMARY — working."), brand, claims, allowed);
    assert.ok(dashed.failures.some(f => f.includes("dashes")), dashed.failures.join("; "));
  });

  test("an over-long caption is rejected", () => {
    const long = getLdtFallbackCaption(brand, claims) + "\n" + "PRIMARY watches the pipeline. ".repeat(60);
    const v = validateLdtCaption(long, brand, claims, allowed);
    assert.ok(v.failures.some(f => f.includes("too long")));
  });
});

describe("TEETH — the shipped copy passes its own gate", () => {
  // A fallback that fails validation would mean captions can NEVER post
  // (generate fails → retry fails → fallback fails). This is the guard
  // against that dead-end, and against claims drift in the pinned copy.
  for (const kind of ["clip", "carousel", "card", "text_reel"]) {
    test(`the pinned fallback caption (${kind}) is gate-clean`, () => {
      const caption = getLdtFallbackCaption(brand, claims, kind);
      const v = validateLdtCaption(caption, brand, claims, allowed);
      assert.equal(v.valid, true, v.failures.join("; "));
    });
  }

  // The self-made sweep, against the REAL claims file (ldt-selfmade.test.mjs
  // runs the same sweep hermetically against its fixture — this one is what
  // catches a drift between ldt-claims.json and the shipped angle tables).
  test("every angle × hook style × format's full visible copy is gate-clean", () => {
    const angles = carouselAngles(claims);
    assert.ok(angles.length >= 4, "rotation has enough angles to avoid repetition");
    for (const angle of angles) {
      for (const style of HOOK_STYLE_IDS) {
        for (const [format, textOf] of [["deck", deckText], ["card", cardText], ["reel", reelText]]) {
          const r = checkClaimsCompliance(textOf(angle, style, { claims, brand }), claims, allowed);
          assert.equal(r.ok, true, `${format} '${angle.key}' × '${style}': ${describeViolations(r.violations)}`);
        }
      }
    }
  });

  test("angle rotation is deterministic and covers the whole table", () => {
    const angles = carouselAngles(claims);
    const seen = new Set();
    for (let i = 0; i < angles.length; i++) {
      const d = new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10);
      seen.add(pickAngle({ claims, dateStr: d }).key);
    }
    assert.equal(seen.size, angles.length, "consecutive days walk the whole rotation");
    // Pinned date→angle mappings, carried over from the retired promo lane's
    // guard: these catch an off-by-one in pickAngle's day-number arithmetic
    // that a determinism check would wave through (comparing a pure function
    // to itself can never fail). An off-by-one tells the wrong day's story on
    // every self-made post at once.
    assert.equal(pickAngle({ claims, dateStr: "2026-09-01" }).key, "honest_numbers");
    assert.equal(pickAngle({ claims, dateStr: "2026-09-02" }).key, "any_business");
    assert.equal(pickAngle({ claims, dateStr: "2026-09-03" }).key, "meta");
    assert.equal(pickAngle({ claims, dateStr: "2027-01-15" }).key, "any_business");
    // The no-immediate-repeat rule: yesterday's angle is excluded.
    for (let i = 0; i < angles.length; i++) {
      const d = new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10);
      for (const prev of angles.map(a => a.key)) {
        assert.notEqual(pickAngle({ claims, dateStr: d, previousAngle: prev }).key, prev);
      }
    }
  });
});
