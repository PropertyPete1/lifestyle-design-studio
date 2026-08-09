/**
 * The three or four words on the thumbnail.
 *
 * The failure this exists to prevent: a thumbnail that restates the title in
 * fewer words. thumbnailText() derives its words by dropping filler, which
 * turns "Best North San Antonio Neighborhoods for Veterans" into "BEST NORTH
 * SAN ANTONIO NEIGHBORHOODS" — the viewer reads the same sentence twice.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  contentWords, redundancyAgainst, validateHook, scoresPass,
  generateThumbnailHook, MAX_REDUNDANCY, PASS_MARK,
} from "../src/yt-thumbnail-hook.js";

const TITLE = "Best North San Antonio Neighborhoods for Veterans, Compared";

/** A model that answers the writer and the critic from the same function. */
function scripted(hooks, scores) {
  let h = 0, s = 0;
  return async (system) => {
    if (/judge the text/i.test(system)) {
      const next = scores[Math.min(s, scores.length - 1)];
      s++;
      return JSON.stringify({ curiosity: next[0], legibility: next[1], emotional_trigger: next[2] ?? next[1], worst_problem: "p", fix: "f" });
    }
    const next = hooks[Math.min(h, hooks.length - 1)];
    h++;
    return JSON.stringify({ hook: next });
  };
}

describe("redundancy — the gate the critic is worst at", () => {
  test("ignores stopwords, which cannot make a line redundant", () => {
    assert.deepEqual(contentWords("YOUR EXEMPTION MISSES THIS"), ["exemption", "misses"]);
  });

  test("Peter's own example scores zero overlap", () => {
    assert.equal(redundancyAgainst("YOUR EXEMPTION MISSES THIS", TITLE), 0);
  });

  test("THE CUT-DOWN TITLE SCORES 100% and is rejected", () => {
    const hook = "BEST NORTH SAN ANTONIO NEIGHBORHOODS";
    assert.equal(redundancyAgainst(hook, TITLE), 1);
    const v = validateHook(hook, TITLE);
    assert.equal(v.valid, false);
    assert.ok(v.failures.some((f) => /already in the title/.test(f)));
  });

  test("measured against the thumbnail's own words, not the union", () => {
    // Two of four content words shared -> 50%, regardless of title length.
    assert.equal(redundancyAgainst("NEIGHBORHOODS VETERANS NEVER CHECK", TITLE), 0.5);
  });

  test("sharing the subject is allowed — obliqueness is worse than overlap", () => {
    assert.ok(MAX_REDUNDANCY >= 0.5, "the threshold must permit a shared subject");
    assert.equal(validateHook("NOBODY WARNS VETERANS", TITLE).valid, true);
  });

  test("an empty line is rejected by word count, not by redundancy", () => {
    assert.equal(redundancyAgainst("", TITLE), 0);
    assert.equal(validateHook("", TITLE).valid, false);
  });
});

describe("validateHook — what a thumbnail can physically be", () => {
  test("rejects a word too long to read at 120px", () => {
    const v = validateHook("UNDERSTANDING EXEMPTIONS", TITLE);
    assert.equal(v.valid, false);
    assert.ok(v.failures.some((f) => /too long to read small/.test(f)));
  });

  test("rejects more than five words", () => {
    assert.ok(validateHook("ONE TWO THREE FOUR FIVE SIX", TITLE).failures.some((f) => /max 5/.test(f)));
  });

  test("rejects a single word", () => {
    assert.ok(validateHook("EXEMPTION", TITLE).failures.some((f) => /at least 2/.test(f)));
  });

  test("accepts three or four short, complementary words", () => {
    for (const h of ["YOUR EXEMPTION MISSES THIS", "THE SCHOOL LINE LIES", "NOBODY TOLD YOU"]) {
      assert.equal(validateHook(h, TITLE).valid, true, `${h} should pass`);
    }
  });
});

describe("generateThumbnailHook — gates in the right order", () => {
  test("returns the first line that clears every axis", async () => {
    const r = await generateThumbnailHook({
      title: TITLE,
      modelCall: scripted(["YOUR EXEMPTION MISSES THIS"], [[9, 9, 9]]),
    });
    assert.equal(r.hook, "YOUR EXEMPTION MISSES THIS");
    assert.equal(r.belowBar, false);
    assert.equal(r.attemptsUsed, 1);
  });

  test("A REDUNDANT LINE NEVER REACHES THE CRITIC", async () => {
    // The mechanical gate rejects it, so the critic is never asked and the
    // scores below are never consumed by the first attempt.
    let criticCalls = 0;
    let writerCalls = 0;
    const model = async (system) => {
      if (/judge the text/i.test(system)) {
        criticCalls++;
        return JSON.stringify({ curiosity: 9, legibility: 9, emotional_trigger: 9 });
      }
      // First the cut-down title, then a real line. Keyed off WRITER calls:
      // the writer runs before the critic, so keying off the critic would hand
      // back the redundant line forever.
      writerCalls++;
      return JSON.stringify({
        hook: writerCalls === 1 ? "BEST NORTH SAN ANTONIO NEIGHBORHOODS" : "THE SCHOOL LINE LIES",
      });
    };
    const r = await generateThumbnailHook({ title: TITLE, modelCall: model });
    assert.equal(writerCalls, 2, "the redundant line forced a regeneration");
    assert.equal(criticCalls, 1, "the critic saw only the line that passed the mechanical gate");
    assert.equal(r.hook, "THE SCHOOL LINE LIES");
  });

  test("regenerates on a below-bar score and keeps the best of what it got", async () => {
    const r = await generateThumbnailHook({
      title: TITLE,
      modelCall: scripted(["NOBODY WARNS VETERANS", "THE SCHOOL LINE LIES", "YOUR EXEMPTION FAILS"], [[5, 9, 9], [6, 9, 9], [7, 9, 9]]),
    });
    assert.equal(r.belowBar, true, "nothing cleared the bar");
    assert.equal(r.hook, "YOUR EXEMPTION FAILS", "best-of by weakest axis");
    assert.equal(r.attemptsUsed, 3);
  });

  test("NEVER THROWS for a content reason — a dull thumbnail must not stop a video", async () => {
    const r = await generateThumbnailHook({ title: TITLE, modelCall: async () => "not json at all" });
    assert.equal(r.hook, null);
    assert.equal(r.belowBar, true);
    assert.ok(r.reason);
  });

  test("a critic outage degrades to unscored rather than throwing", async () => {
    const model = async (system) =>
      /judge the text/i.test(system) ? "broken" : JSON.stringify({ hook: "THE SCHOOL LINE LIES" });
    const r = await generateThumbnailHook({ title: TITLE, modelCall: model });
    assert.equal(r.criticUnavailable, true);
    assert.equal(r.hook, "THE SCHOOL LINE LIES");
  });

  test("every axis must clear the bar, not their average", () => {
    assert.equal(scoresPass({ curiosity: 10, legibility: 6, emotional_trigger: 10 }), false, "unreadable is unreadable");
    assert.equal(scoresPass({ curiosity: 10, legibility: 10, emotional_trigger: 5 }), false, "a line with no stakes does not get clicked");
    assert.equal(scoresPass({ curiosity: 10, legibility: 10 }), false, "two-axis scores from an older critic must not pass by absence");
    assert.equal(scoresPass({ curiosity: PASS_MARK, legibility: PASS_MARK, emotional_trigger: PASS_MARK }), true);
  });
});

describe("C2 — three candidates, the scorer picks", () => {
  const TITLE2 = "Best North San Antonio Neighborhoods for Veterans, Compared";

  /** A model that returns three candidates and per-line critic scores. */
  function candidateModel(lines, scoreByLine) {
    let writerCalls = 0;
    return async (system, prompt) => {
      if (/judge the text/i.test(system)) {
        const line = /THUMBNAIL TEXT: (.+)\n/.exec(prompt)?.[1];
        const sc = scoreByLine[line] || [1, 1, 1];
        return JSON.stringify({ curiosity: sc[0], legibility: sc[1], emotional_trigger: sc[2], worst_problem: "p", fix: "f" });
      }
      writerCalls++;
      return JSON.stringify({ candidates: lines });
    };
  }

  test("all structural survivors are scored and the strongest wins", async () => {
    const r = await generateThumbnailHook({
      title: TITLE2,
      modelCall: candidateModel(
        ["THE SCHOOL LINE LIES", "YOUR EXEMPTION MISSES THIS", "NOBODY TOLD YOU"],
        {
          "THE SCHOOL LINE LIES": [8, 10, 8],
          "YOUR EXEMPTION MISSES THIS": [9, 9, 10],
          "NOBODY TOLD YOU": [8, 8, 8],
        }
      ),
    });
    assert.equal(r.belowBar, false);
    // All three pass; the pick is by weakest axis (9 beats 8s), not order.
    assert.equal(r.hook, "YOUR EXEMPTION MISSES THIS");
    assert.equal(r.candidatesConsidered, 3);
    assert.equal(r.attemptsUsed, 1);
  });

  test("the weakest axis ranks, not the sum", async () => {
    // 10/10/6 sums to 26 but its weak axis is what the viewer experiences;
    // 8/8/8 sums to 24 and has no weak axis. The 8s must win.
    const r = await generateThumbnailHook({
      title: TITLE2,
      modelCall: candidateModel(
        ["THE SCHOOL LINE LIES", "NOBODY TOLD YOU"],
        { "THE SCHOOL LINE LIES": [10, 10, 6], "NOBODY TOLD YOU": [8, 8, 8] }
      ),
    });
    assert.equal(r.hook, "NOBODY TOLD YOU");
  });

  test("a redundant candidate is dropped structurally, the rest still compete", async () => {
    const r = await generateThumbnailHook({
      title: TITLE2,
      modelCall: candidateModel(
        ["BEST NORTH SAN ANTONIO NEIGHBORHOODS", "THE SCHOOL LINE LIES"],
        { "THE SCHOOL LINE LIES": [9, 9, 9] }
      ),
    });
    assert.equal(r.hook, "THE SCHOOL LINE LIES");
    assert.equal(r.candidatesConsidered, 1, "the redundant line never reached the critic");
  });

  test("the old single-hook shape still works — one candidate considered", async () => {
    const r = await generateThumbnailHook({
      title: TITLE2,
      modelCall: scripted(["THE SCHOOL LINE LIES"], [[9, 9, 9]]),
    });
    assert.equal(r.hook, "THE SCHOOL LINE LIES");
  });

  test("duplicate candidates are scored once", async () => {
    let criticCalls = 0;
    const model = async (system, prompt) => {
      if (/judge the text/i.test(system)) {
        criticCalls++;
        return JSON.stringify({ curiosity: 9, legibility: 9, emotional_trigger: 9 });
      }
      return JSON.stringify({ candidates: ["THE SCHOOL LINE LIES", "the school line lies", "THE SCHOOL LINE LIES"] });
    };
    const r = await generateThumbnailHook({ title: TITLE2, modelCall: model });
    assert.equal(criticCalls, 1, "three copies of one line must cost one critic call");
    assert.equal(r.hook, "THE SCHOOL LINE LIES");
  });
});
