/**
 * yt-rev5-gaps.test.mjs — the four gaps revision 4 shipped with.
 *
 * Every one of these was a feature that existed, was tested, and did nothing in
 * production. That is the failure this codebase pays for most, so each gets a
 * test that would have caught the DISCONNECTION rather than only the mechanism.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { attachEmphasis } from "../src/yt-retention-stage.js";
import { buildEditList } from "../src/yt-oncamera-edit.js";
import { buildStates } from "../src/yt-visual-animate.js";
import { countUp } from "../src/yt-card-render.js";

// ─── the pulses were never connected ───────────────────────────────────────

test("attachEmphasis leaves emphasis words on every on-camera take", async () => {
  const plan = {
    segments: [
      { kind: "on_camera", takeId: "s1t1", source: "/take1.mp4" },
      { kind: "voiceover", takeId: "s1t2", source: "/vo.m4a" },
      { kind: "on_camera", takeId: "s1t3", source: "/take3.mp4" },
    ],
  };
  const words = [
    { word: "Boerne", start: 1.0, end: 1.4 },
    { word: "is", start: 1.4, end: 1.5 },
    { word: "not", start: 3.6, end: 3.8 },
    { word: "1604", start: 6.2, end: 6.8 },
  ];

  const report = await attachEmphasis(plan, {
    getWordTimestamps: async () => words,
    existsSync: () => true,
  });

  assert.ok(plan.segments[0].emphasis.length > 0, "on-camera takes get emphasis words");
  assert.ok(plan.segments[2].emphasis.length > 0);
  assert.equal(plan.segments[1].emphasis, undefined, "voiceover takes are not on camera and get nothing");
  assert.equal(report.withTiming, 2);
});

test("a take whose audio cannot be transcribed still gets a list, just an empty one", async () => {
  const plan = { segments: [{ kind: "on_camera", takeId: "s1t1", source: "/take1.mp4" }] };
  await attachEmphasis(plan, {
    getWordTimestamps: async () => {
      throw new Error("whisper unavailable");
    },
    existsSync: () => true,
  });
  // An empty array, never undefined: buildEditList defaults `emphasis = []`, so
  // undefined would work by accident and hide the failure. The cadence must
  // still run — losing pulses is a degradation, losing the edit is a bug.
  assert.deepEqual(plan.segments[0].emphasis, []);
});

test("a missing source file does not stop the pass", async () => {
  const plan = { segments: [{ kind: "on_camera", takeId: "s1t1", source: "/gone.mp4" }] };
  const report = await attachEmphasis(plan, { getWordTimestamps: async () => [], existsSync: () => false });
  assert.deepEqual(plan.segments[0].emphasis, []);
  assert.equal(report.without, 1);
});

test("emphasis words handed to buildEditList actually become pulses", () => {
  const emphasis = [
    { at: 3.0, word: "1604", kind: "number" },
    { at: 11.5, word: "MUD", kind: "acronym" },
  ];
  const withPulses = buildEditList(19, [{ start: 6, end: 8 }], { seed: 1, emphasis });
  const without = buildEditList(19, [{ start: 6, end: 8 }], { seed: 1 });

  assert.ok(withPulses.cadence.pulsesAssigned > 0, "pulses land when emphasis is supplied");
  assert.equal(without.cadence.pulsesAssigned, 0, "and not when it is not — this is what revision 4 shipped");
  // The edit itself must be unchanged: pulses are an overlay on the cadence, not
  // an input to it. If adding emphasis moved the cuts, a pulse could clip a word.
  assert.deepEqual(
    withPulses.pieces.map((p) => [p.srcStart, p.srcEnd]),
    without.pieces.map((p) => [p.srcStart, p.srcEnd]),
    "emphasis must not move a single cut point"
  );
});

test("a pulse never lands on a take too short for the cadence", () => {
  const short = buildEditList(2.4, [], { seed: 0, emphasis: [{ at: 1.0, word: "no", kind: "negation" }] });
  assert.equal(short.pieces.length, 1, "a 2.4s take is one piece");
  const pulses = short.pieces.flatMap((p) => p.pulses || []);
  for (const p of pulses) {
    assert.ok(p.at >= 0 && p.at <= short.pieces[0].seconds, `a pulse must sit inside its piece: ${p.at}`);
  }
});

// ─── the CALLOUT that fell back twice ──────────────────────────────────────

test("a CALLOUT with no label emits no states that render identically", () => {
  for (const value of ["Free", "$3", "3", "N/A"]) {
    const states = buildStates({
      type: "CALLOUT",
      labels: [value],
      spec: { value, label: null },
      reveals: [{ at: 0.4 }],
      beats: [],
      seconds: 9,
    });
    // The dead-state check compares consecutive states whose `progress` differs.
    // Without a label nothing else in the frame reads progress, so any pair that
    // shows the same figure AND differs in progress is a guaranteed rejection.
    // Compute the figure the way the renderer will, rather than trusting a flag
    // on the state — the first version of this test checked `s.figureSame`,
    // which nothing ever sets, so it passed unconditionally and proved nothing.
    // Mirror the real predicate in renderAnimatedGraphic: a pair is required to
    // move the pixels when `visible` changes or the displayed FIGURE changes. Any
    // such pair that would in fact rasterise the same is a guaranteed rejection.
    const doomed = states.filter((s, i) => {
      if (i === 0) return false;
      const prev = states[i - 1];
      const mustChange = s.visible !== prev.visible || s.figure !== prev.figure;
      if (!mustChange) return false;
      const sameFigure = countUp(value, s.progress ?? 1) === countUp(value, prev.progress ?? 1);
      return sameFigure && s.visible === prev.visible;
    });
    assert.equal(doomed.length, 0, `${value}: no state pair may be a guaranteed dead-state rejection`);
    assert.ok(states.length >= 2, `${value}: a CALLOUT must still animate`);
  }
});

test("a CALLOUT with a label keeps its fade states", () => {
  // A COUNTABLE value, because the fade band only exists inside a count. "Free"
  // has no digits and takes the arrival path instead, where the label rides in
  // with the figure and earns no extra states — which is correct, and is why the
  // first version of this test asserted the wrong thing about the wrong value.
  const withLabel = buildStates({
    type: "CALLOUT", labels: ["$3"], spec: { value: "$3", label: "median" },
    reveals: [{ at: 0.4 }], beats: [], seconds: 9,
  });
  const without = buildStates({
    type: "CALLOUT", labels: ["$3"], spec: { value: "$3", label: null },
    reveals: [{ at: 0.4 }], beats: [], seconds: 9,
  });
  assert.ok(
    withLabel.length > without.length,
    "a label is something that can fade, so it earns the extra states an unlabelled figure does not"
  );
});
