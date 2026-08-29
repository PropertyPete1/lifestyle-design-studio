/**
 * Hook-style registry — the learning loop's shared vocabulary.
 *
 * The registry exists so the picker, the prompt builder, and the classifier
 * can never disagree about what a style is. These tests are the guarantee:
 * a style someone adds without an instruction or a classifier pattern fails
 * here, not in a Sunday-night posting run.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  HOOK_STYLE_IDS,
  HOOK_STYLES,
  LEGACY_STYLE_ALIASES,
  styleInstruction,
  classifyCanonicalStyle,
  toCanonicalStyle,
} from "../src/hook-styles.js";

describe("registry completeness", () => {
  test("there are exactly six canonical styles", () => {
    assert.equal(HOOK_STYLE_IDS.length, 6);
  });

  test("every canonical style has an instruction and at least one pattern", () => {
    for (const id of HOOK_STYLE_IDS) {
      const style = HOOK_STYLES[id];
      assert.ok(style, `${id} missing from HOOK_STYLES`);
      assert.equal(typeof style.instruction, "function", `${id} has no instruction`);
      assert.ok(style.instruction("San Antonio").length > 20, `${id} instruction is empty`);
      assert.ok(Array.isArray(style.patterns) && style.patterns.length > 0, `${id} has no classifier patterns`);
    }
  });

  test("every legacy alias maps to a canonical style", () => {
    for (const [legacy, canonical] of Object.entries(LEGACY_STYLE_ALIASES)) {
      assert.ok(HOOK_STYLE_IDS.includes(canonical), `${legacy} maps to unknown style ${canonical}`);
    }
  });

  test("styleInstruction returns null for an unknown style, never throws", () => {
    assert.equal(styleInstruction("made_up_style", "Austin"), null);
  });
});

describe("classifier", () => {
  test("classifies each style's own idiom", () => {
    assert.equal(classifyCanonicalStyle("would you believe this is brand new construction?"), "question");
    assert.equal(classifyCanonicalStyle("this might be the best new build I've toured this month"), "bold_claim");
    assert.equal(classifyCanonicalStyle("this is what new construction is supposed to feel like"), "pov");
    assert.equal(classifyCanonicalStyle("POV: you just walked into your first new home"), "pov");
    assert.equal(classifyCanonicalStyle("$379,990 for brand new construction"), "stat");
    assert.equal(classifyCanonicalStyle("I was speechless when I walked in"), "story_open");
    assert.equal(classifyCanonicalStyle("wait until you see the kitchen in this one"), "pattern_interrupt");
    assert.equal(classifyCanonicalStyle("stop scrolling. look at this ceiling."), "pattern_interrupt");
  });

  test("pattern interrupt wins over question when both could match", () => {
    // "wait until you see...?" ends in a question mark but IS an interrupt.
    assert.equal(classifyCanonicalStyle("wait until you see what this costs?"), "pattern_interrupt");
  });

  test("a leading emoji does not defeat classification", () => {
    assert.equal(classifyCanonicalStyle("😮‍💨 wait until you see the kitchen"), "pattern_interrupt");
  });

  test("a leading digit survives the emoji strip (stat hooks open on numbers)", () => {
    assert.equal(classifyCanonicalStyle("2,100 square feet and the payment surprises people"), "stat");
  });

  test("only the first line is classified", () => {
    assert.equal(classifyCanonicalStyle("a plain descriptive line\nwould you believe this?"), "unknown");
  });

  test("unclassifiable lines are unknown, never guessed", () => {
    assert.equal(classifyCanonicalStyle("brand new construction available now"), "unknown");
    assert.equal(classifyCanonicalStyle(""), "unknown");
    assert.equal(classifyCanonicalStyle(null), "unknown");
  });
});

describe("toCanonicalStyle", () => {
  test("canonical ids pass through", () => {
    assert.equal(toCanonicalStyle("stat"), "stat");
  });
  test("legacy ids map (vibe→pov, wait_tease→pattern_interrupt, reaction→story_open)", () => {
    assert.equal(toCanonicalStyle("vibe"), "pov");
    assert.equal(toCanonicalStyle("wait_tease"), "pattern_interrupt");
    assert.equal(toCanonicalStyle("reaction"), "story_open");
  });
  test("unknown ids return null", () => {
    assert.equal(toCanonicalStyle("no_such_style"), null);
    assert.equal(toCanonicalStyle(null), null);
  });
});
