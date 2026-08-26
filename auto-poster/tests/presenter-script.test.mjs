/**
 * presenter-script.test.mjs — no guest ever claims Peter's identity or
 * experiences, proven by planting the claims and watching them die.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  findOwnerClaims,
  neutralizeOwnerClaims,
  adaptScriptForPresenter,
  guestPresenterBlock,
  vetAdaptedScript,
} from "../src/presenter-script.js";
import { findImpossibleCta } from "../src/yt-cta.js";
import { writerSystem } from "../src/yt-script.js";

const GUEST = { id: "steven-van-orden", name: "Steven Van Orden", role: "guest", email: "s@x.com" };
const OWNER = { id: "peter", name: "Peter Allen", role: "owner" };

/** A minimal script that passes structure, with a planting slot per field. */
function scriptWith({ hook = "The number on your tax bill is wrong.", takeText, close }) {
  const take = (id, mode, text) => ({ id, mode, text, direction: "steady" });
  return {
    title: "San Antonio Property Taxes Explained",
    hook,
    promise: "By the end you'll know the real bill.",
    openingOverlay: "The bill nobody explains",
    sections: [
      {
        title: "The rate",
        boundaryPull: "The next number is the one that moves your payment.",
        takes: [
          take("s1t1", "ON_CAMERA", takeText || "Here is the thing about the rate. It moves every single year and nobody tells you until the bill lands in the mailbox."),
          take("s1t2", "VOICEOVER", "The county sets one line and the school district sets another, and the two together are what you actually pay."),
        ],
      },
    ],
    softCta: { mode: "ON_CAMERA", text: "Drop your city in the comments and we'll reply with the district lines.", direction: "warm" },
    close: { mode: "ON_CAMERA", text: close || "Text us at the number on the screen and we'll run your actual monthly payment in writing.", direction: "direct" },
  };
}

describe("the claim scanner", () => {
  test("identity claims are found and marked unresolvable", () => {
    for (const planted of ["I'm Peter and I know this market.", "My name is Peter.", "Hey, this is Peter."]) {
      const found = findOwnerClaims(planted);
      assert.ok(found.length > 0, `missed: "${planted}"`);
      assert.ok(found.some((f) => f.resolvable === false), `should be unresolvable: "${planted}"`);
    }
  });

  test("ownership claims are found and resolvable", () => {
    for (const planted of [
      "A family I worked with picked the bigger house.",
      "My clients ask this every week.",
      "I've sold forty homes on this road.",
      "Text me at the number on screen.",
      "I'll reply with the district lines.",
      "My number is on the screen.",
    ]) {
      const found = findOwnerClaims(planted);
      assert.ok(found.length > 0, `missed: "${planted}"`);
      assert.ok(found.every((f) => f.resolvable === true), `should be resolvable: "${planted}"`);
    }
  });

  test("plain presenting first-person is NOT a claim", () => {
    for (const fine of [
      "I want you to look at this road.",
      "I'm going to show you the number nobody quotes.",
      "I think the second option wins for most families.",
    ]) {
      assert.deepEqual(findOwnerClaims(fine), [], `false positive on: "${fine}"`);
    }
  });
});

describe("the neutralizer", () => {
  test("rewrites ownership into team framing, preserving sentence capitals", () => {
    const { text } = neutralizeOwnerClaims("I've worked with a family on 281. My clients regret it. Text me at the number.");
    assert.equal(text, "We've worked with a family on 281. Our clients regret it. Text us at the number.");
  });

  test("mid-sentence claims stay lowercase", () => {
    const { text } = neutralizeOwnerClaims("Last spring I helped a couple relocate.");
    assert.equal(text, "Last spring we helped a couple relocate.");
  });

  test("reports every change it made", () => {
    const { changes } = neutralizeOwnerClaims("My clients text me constantly.");
    assert.equal(changes.length, 2);
  });
});

describe("whole-script adaptation", () => {
  test("owner scripts pass through untouched", () => {
    const script = scriptWith({ takeText: "A family I worked with picked the bigger house on the north side and they regretted the commute badly." });
    const r = adaptScriptForPresenter(script, OWNER);
    assert.equal(r.adapted, false);
    assert.equal(r.script, script);
    assert.deepEqual(r.changes, []);
  });

  test("a planted ownership claim in a guest script is caught and neutralized — and PROVEN gone", () => {
    const script = scriptWith({ takeText: "A family I worked with picked the bigger house on the north side and my clients still ask about that exact street." });
    const r = adaptScriptForPresenter(script, GUEST);
    assert.ok(r.changes.length >= 2, `expected neutralizations, got ${JSON.stringify(r.changes)}`);
    assert.deepEqual(r.unresolved, []);
    const adaptedText = r.script.sections[0].takes[0].text;
    assert.match(adaptedText, /family we worked with/);
    assert.match(adaptedText, /our clients/);
    assert.deepEqual(findOwnerClaims(adaptedText), [], "the sweep must come back clean on its own output");
  });

  test("a planted IDENTITY claim survives as unresolved and must block the kit", () => {
    const script = scriptWith({ takeText: "I'm Peter, and after ten years selling here the pattern is obvious to me every single spring season." });
    const r = adaptScriptForPresenter(script, GUEST);
    assert.ok(r.unresolved.length > 0, "an identity claim must be reported, never dropped");
    assert.match(r.unresolved[0].match, /I'm Peter/i);
  });

  test("boundaryPull, hook, overlay, softCta and close are all swept", () => {
    const script = scriptWith({});
    script.hook = "My clients never see this coming.";
    script.openingOverlay = "What my clients regret";
    script.sections[0].boundaryPull = "I'll send the list next.";
    const r = adaptScriptForPresenter(script, GUEST);
    assert.match(r.script.hook, /^Our clients/);
    assert.match(r.script.openingOverlay, /our clients/);
    assert.match(r.script.sections[0].boundaryPull, /^We'll send/);
  });

  test("a clean guest script adapts with zero changes", () => {
    const r = adaptScriptForPresenter(scriptWith({}), GUEST);
    assert.deepEqual(r.changes, []);
    assert.deepEqual(r.unresolved, []);
  });
});

describe("team-framed CTAs stay valid CTAs", () => {
  test('"text us" names a channel — the neutralized close is not an impossible promise', () => {
    const close = "Send us the address and we'll send you your actual monthly payment in writing. Text us at the number on the screen.";
    assert.deepEqual(findImpossibleCta(close), []);
  });

  test('"we\'ll reply" carries the comment CTA', () => {
    assert.deepEqual(findImpossibleCta("Drop your city below and we'll reply with the district lines."), []);
  });

  test('a DM promise is still banned in team framing', () => {
    assert.ok(findImpossibleCta("Comment MATH and we'll DM you the sheet.").length > 0);
  });
});

describe("generation-time framing", () => {
  test("the guest block names the presenter and the rules, and rides writerSystem last", () => {
    const block = guestPresenterBlock(GUEST);
    assert.match(block, /Steven Van Orden/);
    assert.match(block, /never claims to be Peter/);
    assert.match(block, /text us/);
    assert.match(block, /we'll reply/);
    const system = writerSystem({ presenterBlock: block });
    assert.ok(system.endsWith(block), "overrides must come last to read as overrides");
  });

  test("the owner gets no block at all", () => {
    assert.equal(guestPresenterBlock(OWNER), "");
    assert.equal(guestPresenterBlock(null), "");
  });
});

describe("vetAdaptedScript — the full gate set on adapted words", () => {
  const passingCritic = async () =>
    JSON.stringify({ clarity: 9, retention: 9, authenticity: 9, hook_punch: 9, story: 9, loop: 9, payoff: 9, worst_problem: "", worst_boundary: "", fix: "" });

  test("a clean adapted script passes with real scores", async () => {
    const r = await vetAdaptedScript(scriptWith({}), { modelCall: passingCritic });
    assert.ok(r.ok, JSON.stringify(r.failures));
    assert.equal(r.scores.clarity, 9);
  });

  test("a below-bar rescore refuses the kit", async () => {
    const weakCritic = async () =>
      JSON.stringify({ clarity: 5, retention: 9, authenticity: 9, hook_punch: 9, story: 9, loop: 9, payoff: 9, worst_problem: "muddy", worst_boundary: "", fix: "clarify" });
    const r = await vetAdaptedScript(scriptWith({}), { modelCall: weakCritic });
    assert.equal(r.ok, false);
    assert.match(r.failures[0], /below the bar/);
  });

  test("a critic outage refuses rather than shipping unjudged", async () => {
    const dead = async () => { throw new Error("no credit"); };
    const r = await vetAdaptedScript(scriptWith({}), { modelCall: dead });
    assert.equal(r.ok, false);
    assert.match(r.failures[0], /critic/);
  });

  test("a payment figure in the adapted script is fatal before the critic is even asked", async () => {
    const r = await vetAdaptedScript(
      scriptWith({ close: "Your payment lands right around $2,400 a month, and you can text us at the number on the screen." }),
      { modelCall: passingCritic }
    );
    assert.equal(r.ok, false);
    assert.match(r.failures[0], /payment figure/);
  });
});
