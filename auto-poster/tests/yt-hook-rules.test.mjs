import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  hookOpensQualified, findPreamble, validateScript, scoresPass, SCORE_AXES,
  writerSystem, criticSystem, PASS_MARK, repairConnectiveOpeners, findConnectiveOpeners,
} from "../src/yt-script.js";

/** A minimal script that clears every structural check. */
function goodScript(overrides = {}) {
  const take = (id, mode = "VOICEOVER") => ({
    id, mode,
    text: "This take carries enough words to clear the minimum length gate for a spoken unit of this format comfortably.",
    direction: "steady",
  });
  return {
    title: "Moving to San Antonio: what your exemption misses",
    hook: "Your hundred percent disability exemption doesn't cover this. And most veterans moving to San Antonio don't find out until the first bill shows up.",
    promise: "By the end you will know which line survives the exemption.",
    sections: [1, 2, 3, 4].map((i) => ({
      title: `Section ${i}`,
      boundaryPull: "The next number is the one that decides it.",
      takes: [take(`s${i}t1`, "ON_CAMERA"), take(`s${i}t2`)],
    })),
    softCta: { mode: "ON_CAMERA", text: "Drop your base in the comments and I'll reply with where I'd start.", direction: "light" },
    close: { mode: "ON_CAMERA", text: "Text me at the number on screen and I'll run your real monthly number.", direction: "direct" },
    ...overrides,
  };
}

describe("B1 — the hook must punch in the first six words", () => {
  test("video 1's actual hook is rejected — it is the cited weak example", () => {
    const v1 = "If you're a veteran with a hundred percent rating, Texas can knock your property tax bill down to nothing.";
    const reason = hookOpensQualified(v1);
    assert.ok(reason, "the conditional opener should have been rejected");
    assert.match(reason, /conditional/);
  });

  test("the cited strong example passes", () => {
    assert.equal(hookOpensQualified("Your hundred percent disability exemption doesn't cover this. And most veterans moving to San Antonio don't find out until the first bill shows up."), null);
  });

  test("each listed qualifier form is caught", () => {
    for (const hook of [
      "If you're thinking about moving here, wait.",
      "When you get orders to Randolph, the clock starts.",
      "Whether you're renting or buying, this applies.",
      "For those who just sold in California, listen close.",
      "Are you a veteran moving to Texas?",
    ]) {
      assert.ok(hookOpensQualified(hook), `should reject: "${hook}"`);
    }
  });

  test("claims that merely CONTAIN those words are not rejected", () => {
    for (const hook of [
      "Nobody tells you what happens when the exemption runs out.",
      "The bill arrives even if your rating is a hundred percent.",
      "Texas taxes look different for anyone coming from California.",
    ]) {
      assert.equal(hookOpensQualified(hook), null, `should pass: "${hook}"`);
    }
  });

  test("a qualified hook fails validateScript, so it regenerates", () => {
    const v = validateScript(goodScript({ hook: "If you're a veteran, this matters." }));
    assert.ok(v.failures.some((f) => /^hook: /.test(f)), v.failures.join("; "));
  });
});

describe("B6 — no preamble, ever", () => {
  test("greetings, channel talk and self-introduction are caught", () => {
    for (const opener of [
      "Hey everyone, let's talk taxes.",
      "Welcome back to the channel.",
      "My name is Peter and I sell homes here.",
      "In this video we'll cover the north side.",
      "Today I'm going to walk you through it.",
      "Thanks for watching, before we start...",
    ]) {
      assert.equal(findPreamble({ hook: opener }).length, 1, `should catch: "${opener}"`);
    }
  });

  test("the first take is checked too, not only the hook", () => {
    const script = goodScript();
    script.sections[0].takes[0].text = "What's up, it's your boy Peter, and today we're covering the loop.";
    assert.ok(validateScript(script).failures.some((f) => /first take opens with preamble/.test(f)));
  });

  test("a cold open passes", () => {
    assert.deepEqual(findPreamble(goodScript()), []);
  });

  test("words like 'today' inside a sentence do not false-positive", () => {
    assert.deepEqual(findPreamble({ hook: "The market today is nothing like last spring." }), []);
  });
});

describe("the seven critic axes", () => {
  test("all seven are required to pass", () => {
    assert.equal(SCORE_AXES.length, 7);
    const all8 = Object.fromEntries(SCORE_AXES.map((a) => [a, PASS_MARK]));
    assert.equal(scoresPass(all8), true);
    for (const axis of SCORE_AXES) {
      assert.equal(scoresPass({ ...all8, [axis]: PASS_MARK - 1 }), false, `${axis} below bar should fail`);
    }
  });

  test("a missing axis fails rather than passing by absence", () => {
    // Scores from an older critic (three axes) must not sail through the new
    // gate — that would be the silent-success class again.
    assert.equal(scoresPass({ clarity: 9, retention: 9, authenticity: 9 }), false);
  });

  test("the critic prompt carries all four new axes with their calibration", () => {
    const c = criticSystem();
    for (const needle of ['"hook_punch"', '"story"', '"loop"', '"payoff"', "FIRST SIX WORDS", "PLANTED", "SUSTAINED", "PAID", "counted or named claim", "statistic wearing a coat"]) {
      assert.ok(c.toLowerCase().includes(needle.toLowerCase()), `critic prompt missing: ${needle}`);
    }
  });

  test("the writer prompt carries the new requirements", () => {
    const w = writerSystem();
    for (const needle of [
      "THE SURPRISING CLAIM COMES FIRST",
      "CASH OUT EVERY COUNTED CLAIM",
      "THE LONG OPEN LOOP",
      "STORY BEATS ARE MANDATORY",
      "EMOTIONAL STAKES RIDE WITH THE NUMBERS",
      "YOUTUBE HAS NO DIRECT MESSAGES",
    ]) {
      assert.ok(w.includes(needle), `writer prompt missing: ${needle}`);
    }
  });
});

describe("repairConnectiveOpeners — repair beats regeneration", () => {
  const take = (id, text) => ({ id, mode: "VOICEOVER", text, direction: "d" });
  const LONG = (t) => `${t} the appraisal district mails a number in April and the protest clock starts running for everyone.`;

  test("strips pure discourse markers and the take then passes the gate", () => {
    const { script, repaired } = repairConnectiveOpeners({
      sections: [{ takes: [take("a", LONG("So")), take("b", LONG("Then")), take("c", LONG("And"))] }],
    });
    assert.equal(repaired.length, 3);
    for (const t of script.sections[0].takes) {
      assert.match(t.text, /^The appraisal/, t.id);
    }
    assert.deepEqual(findConnectiveOpeners(script), []);
  });

  test("a back-reference is NOT repairable and stays for regeneration", () => {
    // "And that's why..." minus "And" still points at the previous take.
    const { script, repaired } = repairConnectiveOpeners({
      sections: [{ takes: [take("a", LONG("And that's why")), take("b", LONG("Which brings me to"))] }],
    });
    assert.equal(repaired.length, 0);
    assert.equal(findConnectiveOpeners(script).length, 2, "both must still be flagged");
  });

  test("a repair that would drop the take under the length floor is refused", () => {
    const short = { sections: [{ takes: [take("a", "So fifteen words is the floor and this take sits right on it exactly here now.")] }] };
    const words = short.sections[0].takes[0].text.split(/\s+/).length;
    assert.equal(words, 16, "fixture: 16 words, 15 after stripping");
    const { repaired } = repairConnectiveOpeners(short);
    assert.equal(repaired.length, 1, "15 words after the strip still clears the floor");

    const shorter = { sections: [{ takes: [take("a", "So fourteen words is under the floor once the marker comes off this take.")] }] };
    assert.equal(repairConnectiveOpeners(shorter).repaired.length, 0, "14 words after the strip is refused");
  });

  test("clean takes are untouched, softCta and close are covered", () => {
    const clean = LONG("The");
    const { script, repaired } = repairConnectiveOpeners({
      sections: [{ takes: [take("a", clean)] }],
      softCta: take("cta", LONG("So")),
      close: take("close", LONG("Plus")),
    });
    assert.equal(script.sections[0].takes[0].text, clean);
    assert.deepEqual(repaired.map((r) => r.id), ["cta", "close"]);
  });

  test("this run's actual killers would have been saved", () => {
    // Run 31283932043: budget died on s2t3 ("Then..."), schools on
    // s3t6 ("And...") + s4t5 ("So...") — every one a strippable marker.
    for (const opener of ["Then", "And", "So"]) {
      const { repaired } = repairConnectiveOpeners({ sections: [{ takes: [take("x", LONG(opener))] }] });
      assert.equal(repaired.length, 1, `"${opener}" should be repairable`);
    }
  });
});
