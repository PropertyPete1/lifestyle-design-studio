/**
 * decision-hooks-prompt.test.mjs — the decision file's hook preferences as
 * they are FRAMED in the caption prompt.
 *
 * Two things are pinned here, and they fail for different reasons.
 *
 * THE NO-OP. With no hooks, renderDecisionHooks returns the empty string, so
 * the assembled prompt is byte-identical to the one that shipped before this
 * wiring. That covers every run where the decision file is missing, stale,
 * unreadable, the wrong schema, empty after sanitizing, or switched off with
 * HOOK_GUIDANCE=false — which today is every run, because the file the reader
 * would find carries safe_to_act:false and no run has yet executed the widened
 * scoping. A regression here changes captions on a path nobody is watching.
 *
 * THE NO-INVENTED-NUMBER CLAUSE. The likeliest entry in hooks_that_work[] is
 * some form of "open on a low dollar figure" — that is what the 2026-09-10 run
 * found. Read as an instruction, it orders a number into line one, and if the
 * video's facts carry no price the only way to comply is to invent one. The
 * clause is the thing standing between an observed preference and a made-up
 * figure in front of a client. These tests exist so it cannot be reworded away
 * silently.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderDecisionHooks } from "../src/caption.js";

const REAL_FINDINGS = [
  "Winning hooks open on a low dollar figure in line one ($254k-$369k)",
  "A binary choice question outperforms an open one",
  "First-person reaction framing beats third-person description",
];

describe("the no-op path is byte-identical to the pre-wiring prompt", () => {
  test("absent, empty and non-array inputs all render the empty string", () => {
    for (const input of [undefined, null, [], "", 0, {}, "a string"]) {
      assert.equal(renderDecisionHooks(input), "", `input ${JSON.stringify(input)}`);
    }
  });

  test("the empty render contributes NO whitespace to the prompt", () => {
    // It is interpolated mid-line inside a template literal. A stray newline
    // or space here would shift the prompt for every run with no decision
    // file — which is currently all of them.
    assert.equal(renderDecisionHooks([]).length, 0);
  });
});

describe("the no-invented-number clause", () => {
  const rendered = renderDecisionHooks(REAL_FINDINGS);

  test("is present whenever any hook guidance renders", () => {
    // Present for ANY guidance, not only figure-shaped guidance: the model
    // reads the whole block, and a preference about question shape must not
    // arrive with the number rules quietly absent.
    for (const hooks of [REAL_FINDINGS, ["ask a binary choice question"], ["use first-person framing"]]) {
      const out = renderDecisionHooks(hooks);
      assert.match(out, /NEVER permission to invent/i);
      assert.match(out, /DO NOT OPEN ON A NUMBER/i);
    }
  });

  test("names every way a number gets fabricated", () => {
    for (const verb of ["invent", "estimate", "round", "guess", "placeholder"]) {
      assert.match(rendered, new RegExp(verb, "i"), `missing "${verb}"`);
    }
  });

  test("bans the bracketed placeholder by name", () => {
    // The concrete failure this clause was written for.
    assert.match(rendered, /\[price\]/);
    assert.match(rendered, /never acceptable/i);
  });

  test("states the fallback, not just the prohibition", () => {
    // A prohibition with no alternative is a prompt the model satisfies by
    // guessing at the nearest thing.
    assert.match(rendered, /most concrete visible detail/i);
  });

  test("permission is scoped to numbers the facts already provide", () => {
    assert.match(rendered, /the facts above already provide/i);
  });
});

describe("the block stays subordinate to the style instruction", () => {
  const rendered = renderDecisionHooks(REAL_FINDINGS);

  test("says the style instruction wins any conflict", () => {
    // Without this the variation engine's pick is recorded on the posted-log
    // entry while a different style was actually used, and learn.js scores a
    // style that never ran.
    assert.match(rendered, /HOOK STYLE instruction above WINS/i);
  });

  test("frames the entries as preferences, not instructions", () => {
    assert.match(rendered, /PREFERENCES, NOT INSTRUCTIONS/i);
  });

  test("grants no permission the rules above withhold", () => {
    assert.match(rendered, /NO permission/i);
    assert.match(rendered, /no-invented-facts/i);
  });

  test("renders every entry it is given, verbatim", () => {
    for (const h of REAL_FINDINGS) assert.ok(rendered.includes(h), `dropped: ${h}`);
  });
});
