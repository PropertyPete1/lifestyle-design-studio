/**
 * The variation engine — deliberate rotation, every choice tagged.
 *
 * The rules under test are the ones the learning loop cannot work without:
 * no two consecutive posts share a hook style, the kill list is obeyed (but
 * never into silence), 70% of picks exploit the brief's winners and 30% keep
 * exploring, and the pick NEVER fails — a variation bug must not cost a
 * posting slot.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  planVariation,
  previousHookStyle,
  previousLengthBucket,
  pickWithExploration,
  briefWinners,
  killedValues,
  briefIsFresh,
  CAPTION_LENGTH_IDS,
  EXPLOIT_RATIO,
} from "../src/variation.js";
import { HOOK_STYLE_IDS } from "../src/hook-styles.js";

/** A deterministic rand fed from a queue; repeats the last value when empty. */
const seq = (...values) => {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
};

const reelEntry = (over = {}) => ({
  driveFileId: "f1",
  fileName: "a.mp4",
  city: "san_antonio",
  slot: "am",
  caption: "a plain line\nbody",
  timestamp: "2026-08-28T16:00:00.000Z",
  success: true,
  ...over,
});

const freshBrief = (over = {}) => ({
  brand: "lifestyle",
  generated_at: "2026-08-28T15:30:00.000Z",
  hook_styles: {
    question: { n: 5, score: 1000, verdict: "winner" },
    bold_claim: { n: 4, score: 800, verdict: "mid" },
    pov: { n: 3, score: 100, verdict: "kill" },
  },
  caption_lengths: {},
  kill_list: [{ axis: "hook_style", value: "pov", n: 3, score: 100, reason: "test" }],
  ...over,
});

const NOW = new Date("2026-08-29T12:00:00.000Z");

describe("previousHookStyle", () => {
  test("reads the tag from a tagged entry", () => {
    const log = { posts: [reelEntry({ generation: { hook_style: "stat" } })] };
    assert.equal(previousHookStyle(log), "stat");
  });

  test("classifies a legacy entry from its caption", () => {
    const log = { posts: [reelEntry({ caption: "would you believe this is new?\nbody" })] };
    assert.equal(previousHookStyle(log), "question");
  });

  test("maps a legacy-tagged style to canonical", () => {
    const log = { posts: [reelEntry({ generation: { hook_style: "vibe" } })] };
    assert.equal(previousHookStyle(log), "pov");
  });

  test("skips LinkedIn entries and manual-confirm receipts", () => {
    const log = {
      posts: [
        reelEntry({ generation: { hook_style: "stat" } }),
        { type: "linkedin", topic: "x", timestamp: "2026-08-29T01:00:00.000Z" },
        { platform: "instagram_main_native", source: "manual_confirm", timestamp: "2026-08-29T02:00:00.000Z" },
      ],
    };
    assert.equal(previousHookStyle(log), "stat");
  });

  test("an unclassifiable previous caption imposes no constraint", () => {
    const log = { posts: [reelEntry({ caption: "brand new construction available\nbody" })] };
    assert.equal(previousHookStyle(log), null);
  });
});

describe("the no-consecutive-repeat rule", () => {
  test("the previous style is never picked, across many rolls", () => {
    const log = { posts: [reelEntry({ generation: { hook_style: "question" } })] };
    for (let i = 0; i < 200; i++) {
      const roll = (i % 100) / 100;
      const plan = planVariation({ log, rand: seq(roll, roll, roll), now: NOW, brief: null });
      assert.notEqual(plan.hook_style, "question", `picked the previous style on roll ${roll}`);
      assert.equal(plan.excluded_style, "question");
    }
  });
});

describe("kill list", () => {
  test("a killed style is never picked", () => {
    const log = { posts: [reelEntry({ generation: { hook_style: "question" } })] };
    for (let i = 0; i < 200; i++) {
      const roll = (i % 100) / 100;
      const plan = planVariation({ log, rand: seq(roll, roll, roll), now: NOW, brief: freshBrief() });
      assert.notEqual(plan.hook_style, "pov", "picked a kill-listed style");
    }
  });

  test("a kill list that swallows every style is ignored, loudly", () => {
    const killAll = freshBrief({
      kill_list: HOOK_STYLE_IDS.map((id) => ({ axis: "hook_style", value: id, n: 3, score: 1, reason: "test" })),
    });
    const plan = planVariation({ log: { posts: [] }, rand: seq(0.9, 0.5), now: NOW, brief: killAll });
    assert.ok(HOOK_STYLE_IDS.includes(plan.hook_style), "still picks a style");
    assert.equal(plan.kill_list_ignored, true);
  });

  test("killedValues reads only the asked-for axis", () => {
    const brief = freshBrief({
      kill_list: [
        { axis: "hook_style", value: "pov" },
        { axis: "caption_length", value: "short" },
      ],
    });
    assert.deepEqual([...killedValues(brief, "hook_style")], ["pov"]);
    assert.deepEqual([...killedValues(brief, "caption_length")], ["short"]);
    assert.equal(killedValues(null, "hook_style").size, 0);
  });
});

describe("70/30 exploit vs explore", () => {
  test("a roll under the exploit ratio picks from the winners, weighted", () => {
    const { value, source } = pickWithExploration({
      pool: ["question", "bold_claim", "stat"],
      winners: { question: 1000, bold_claim: 800 },
      rand: seq(0.1, 0.0), // 0.1 < 0.7 → exploit arm; 0.0 → heaviest winner
    });
    assert.equal(source, "exploit");
    assert.equal(value, "question");
  });

  test("a roll past the exploit ratio explores the whole pool uniformly", () => {
    const { value, source } = pickWithExploration({
      pool: ["question", "bold_claim", "stat"],
      winners: { question: 1000 },
      rand: seq(0.9, 0.99), // 0.9 ≥ 0.7 → explore arm; 0.99 → last pool entry
    });
    assert.equal(source, "explore");
    assert.equal(value, "stat");
  });

  test("explore can land on an under-sampled style the winners table omits", () => {
    // Exploration is what fixes an insufficient sample — the pool includes
    // everything not killed, not just ranked winners.
    const picks = new Set();
    for (let i = 0; i < 40; i++) {
      const { value } = pickWithExploration({
        pool: ["question", "stat", "story_open"],
        winners: { question: 1000 },
        rand: seq(0.95, i / 40),
      });
      picks.add(value);
    }
    assert.ok(picks.has("stat") && picks.has("story_open"), "explore reaches unranked styles");
  });

  test("no winners at all still yields a pick (pure exploration)", () => {
    const { value, source } = pickWithExploration({ pool: ["stat"], winners: {}, rand: seq(0.1, 0.1) });
    assert.equal(value, "stat");
    assert.equal(source, "explore");
  });

  test("the exploit ratio is the documented 70%", () => {
    assert.equal(EXPLOIT_RATIO, 0.7);
  });
});

describe("brief handling", () => {
  test("briefWinners drops killed and insufficient-sample rows", () => {
    const winners = briefWinners(freshBrief(), "hook_styles");
    assert.deepEqual(Object.keys(winners).sort(), ["bold_claim", "question"]);
  });

  test("a stale brief is not used to steer (falls back to legacy weights)", () => {
    const stale = freshBrief({ generated_at: "2026-07-01T00:00:00.000Z" });
    assert.equal(briefIsFresh(stale, NOW), false);
    const plan = planVariation({ log: { posts: [] }, rand: seq(0.1, 0.1), now: NOW, brief: stale });
    assert.match(plan.hook_style_source, /^legacy_weights_/);
    assert.equal(plan.brief_generated_at, null);
  });

  test("a fresh brief stamps its generated_at onto the plan", () => {
    const plan = planVariation({ log: { posts: [] }, rand: seq(0.1, 0.1), now: NOW, brief: freshBrief() });
    assert.equal(plan.brief_generated_at, "2026-08-28T15:30:00.000Z");
    assert.match(plan.hook_style_source, /^brief_/);
  });
});

describe("caption length rotation", () => {
  test("the previous bucket is never repeated", () => {
    const log = {
      posts: [reelEntry({ generation: { hook_style: "stat", caption_length_bucket: "long" } })],
    };
    for (let i = 0; i < 100; i++) {
      const plan = planVariation({ log, rand: seq(i / 100, i / 100, i / 100, i / 100), now: NOW, brief: null });
      assert.notEqual(plan.caption_length_bucket, "long");
    }
  });

  test("a restructured previous entry imposes no length constraint", () => {
    const log = {
      posts: [reelEntry({ generation: { hook_style: "stat", caption_length_bucket: null, caption_source: "restructured" } })],
    };
    assert.equal(previousLengthBucket(log), null);
  });

  test("every bucket id resolves", () => {
    assert.deepEqual(CAPTION_LENGTH_IDS.sort(), ["long", "medium", "short"]);
  });
});

describe("the plan never fails", () => {
  test("empty log, no brief, no weights context — still a full plan", () => {
    const plan = planVariation({ log: { posts: [] }, rand: seq(0.5, 0.5, 0.5), now: NOW, brief: null });
    assert.ok(HOOK_STYLE_IDS.includes(plan.hook_style));
    assert.ok(CAPTION_LENGTH_IDS.includes(plan.caption_length_bucket));
    assert.equal(plan.engine, "variation-v1");
  });

  test("a malformed log shape does not throw", () => {
    const plan = planVariation({ log: { posts: [null, "junk", {}] }, rand: seq(0.5, 0.5), now: NOW, brief: null });
    assert.ok(HOOK_STYLE_IDS.includes(plan.hook_style));
  });
});
