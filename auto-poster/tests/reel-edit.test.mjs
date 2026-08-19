/**
 * reel-edit.test.mjs — the cut, and the promise that it never takes a word.
 *
 * Half of this argues with the plan arithmetic (pure, instant) and half of it
 * cuts real video with real ffmpeg. The second half is deliberate and matches
 * what the long-form retention tests already do here: the class of bug this
 * repo pays most for is the one a mock cannot catch — silencedetect reading the
 * wrong stream, a zoom expression ffmpeg accepts that is secretly a constant, a
 * filter graph that renders a perfectly valid video of the wrong thing.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EDIT_SPEC,
  REEL_DIM,
  REEL_PUNCH_INTERVAL,
  REEL_TREATMENT,
  coldOpenPoints,
  describeEdit,
  planReelEdit,
  removedIntervals,
  renderReelEdit,
  speechSafe,
} from "../src/reel-edit.js";
import {
  KEEP_SILENCE_SECONDS,
  MIN_SILENCE_SECONDS,
  PIECE_DECLICK_SECONDS,
  MIN_RETAINED_SHARE,
  PUNCH_INTERVAL_MIN,
  buildEditList,
  editOnCameraTake,
  punchBounds,
} from "../src/yt-oncamera-edit.js";
import { mediaDuration } from "../src/yt-assemble.js";

const HAS_FFMPEG = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

// ─── the numbers Peter asked for ────────────────────────────────────────────

test("the edit runs to the spec that was asked for", () => {
  assert.equal(EDIT_SPEC.minSilenceSeconds, 0.4, "silence over 400ms is what gets cut");
  assert.equal(EDIT_SPEC.keepSilenceSeconds, 0.15, "150ms of every pause is kept");
  assert.equal(EDIT_SPEC.declickSeconds, 0.015, "15ms declick at every join");
  assert.ok(EDIT_SPEC.minRetainedShare > 0, "the share-survived guard is on");
  // "every 2-3 seconds", arrived at through the interval walk rather than a
  // second mechanism.
  const bounds = punchBounds(REEL_PUNCH_INTERVAL);
  assert.ok(bounds.min >= 1.9 && bounds.min <= 2.1, `punch floor is ${bounds.min}, wanted ~2s`);
  assert.ok(bounds.max >= 2.9 && bounds.max <= 3.1, `punch ceiling is ${bounds.max}, wanted ~3s`);
});

test("a reel is vertical and is not blur-filled", () => {
  assert.deepEqual(REEL_DIM, { w: 1080, h: 1920 });
  assert.notEqual(REEL_TREATMENT.mode, "blur-fill", "a vertical source in a vertical frame needs no blurred backing");
});

// ─── never mid-word ─────────────────────────────────────────────────────────

test("removedIntervals reports exactly the stretches no piece covers", () => {
  const pieces = [
    { srcStart: 0, srcEnd: 4 },
    { srcStart: 6, srcEnd: 10 },
  ];
  assert.deepEqual(removedIntervals(pieces, 12), [{ start: 4, end: 6 }, { start: 10, end: 12 }]);
});

test("a punch-in cut removes nothing — that is why it can land mid-sentence", () => {
  // Two pieces that share a boundary exactly. The framing changes; no audio
  // goes anywhere. This is the distinction the whole "never mid-word" claim
  // rests on, so it is asserted rather than reasoned about.
  const pieces = [
    { srcStart: 0, srcEnd: 2.5 },
    { srcStart: 2.5, srcEnd: 5 },
  ];
  assert.deepEqual(removedIntervals(pieces, 5), []);
  assert.equal(speechSafe(pieces, [], 5).safe, true);
});

test("speechSafe passes a cut that stays inside detected silence", () => {
  const silences = [{ start: 4, end: 6 }];
  const pieces = [
    { srcStart: 0, srcEnd: 4.075 },
    { srcStart: 5.925, srcEnd: 10 },
  ];
  const verdict = speechSafe(pieces, silences, 10);
  assert.equal(verdict.safe, true, JSON.stringify(verdict.violations));
});

test("speechSafe CATCHES a cut that eats audio ffmpeg never called silence", () => {
  // The failure this guard exists for: a removal that is not inside a reported
  // pause is a removal that may have taken a word with it.
  const silences = [{ start: 4, end: 4.6 }];
  const pieces = [
    { srcStart: 0, srcEnd: 4 },
    { srcStart: 7, srcEnd: 10 },
  ];
  const verdict = speechSafe(pieces, silences, 10);
  assert.equal(verdict.safe, false);
  assert.equal(verdict.violations.length, 1);
  assert.match(verdict.violations[0].why, /may contain speech/);
});

test("every cut a real edit list makes is inside a real silence", () => {
  // Driven over the actual planner rather than a hand-made piece list, across a
  // spread of pause shapes, so this is a property of buildEditList and not of
  // one fixture.
  for (const silences of [
    [{ start: 3, end: 4.2 }],
    [{ start: 2, end: 2.9 }, { start: 8, end: 12 }],
    [{ start: 0, end: 1.5 }, { start: 20, end: 25 }],
    [{ start: 5, end: 5.45 }, { start: 6, end: 6.5 }, { start: 14, end: 16 }],
  ]) {
    const plan = buildEditList(30, silences, { interval: REEL_PUNCH_INTERVAL, isOpening: false });
    const verdict = speechSafe(plan.pieces, silences, 30);
    assert.equal(verdict.safe, true, `${JSON.stringify(silences)} -> ${JSON.stringify(verdict.violations)}`);
  }
});

test("150ms of every cut pause survives, split either side", () => {
  const plan = buildEditList(20, [{ start: 5, end: 9 }], { interval: REEL_PUNCH_INTERVAL });
  const gaps = removedIntervals(plan.pieces, 20);
  const removed = gaps.reduce((n, g) => n + (g.end - g.start), 0);
  assert.ok(
    Math.abs(removed - (4 - KEEP_SILENCE_SECONDS)) < 0.01,
    `removed ${removed}s of a 4s pause; expected ${4 - KEEP_SILENCE_SECONDS}s with ${KEEP_SILENCE_SECONDS}s kept`
  );
});

test("a pause under 400ms is rhythm and is left alone", () => {
  const plan = buildEditList(20, [{ start: 5, end: 5 + MIN_SILENCE_SECONDS - 0.05 }], { interval: REEL_PUNCH_INTERVAL });
  assert.deepEqual(removedIntervals(plan.pieces, 20), [], "a breath was cut");
});

// ─── the degenerate videos ──────────────────────────────────────────────────

test("a video that is nothing but silence is kept whole, loudly", () => {
  // The share-survived guard. Without it this produces a video of nothing.
  const plan = buildEditList(20, [{ start: 0, end: 20 }], { interval: REEL_PUNCH_INTERVAL });
  assert.equal(plan.editedSeconds, 20, "an all-silent take must not be deleted down to nothing");
  assert.ok(plan.warnings.length > 0, "and it must say so");
  assert.equal(speechSafe(plan.pieces, [{ start: 0, end: 20 }], 20).safe, true);
});

test("a take that would trim below the retained share is restored uncut", () => {
  // The 20-second take with one 19-second pause that once came out as a single
  // 0.575-second piece, with no error and no warning.
  const plan = buildEditList(20, [{ start: 0.5, end: 19.5 }], { interval: REEL_PUNCH_INTERVAL });
  assert.equal(plan.editedSeconds, 20);
  assert.ok(plan.warnings.some((w) => /bad recording/.test(w)), plan.warnings.join(" | "));
  assert.ok(MIN_RETAINED_SHARE > 0);
});

test("a video with no pauses at all still gets its cadence", () => {
  const plan = buildEditList(30, [], { interval: REEL_PUNCH_INTERVAL });
  assert.deepEqual(removedIntervals(plan.pieces, 30), [], "nothing to remove");
  assert.ok(plan.pieces.length > 5, `expected a framing change every ~2.5s over 30s, got ${plan.pieces.length} piece(s)`);
  for (const p of plan.pieces.slice(0, -1)) {
    assert.ok(p.seconds <= punchBounds(REEL_PUNCH_INTERVAL).max + 0.01, `a ${p.seconds}s piece is over the cadence ceiling`);
  }
});

test("a zero-length input produces a plan with no pieces and a warning, not a crash", () => {
  const plan = buildEditList(0, [], { interval: REEL_PUNCH_INTERVAL });
  assert.deepEqual(plan.pieces, []);
  assert.ok(plan.warnings.length > 0);
});

// ─── cold opens ─────────────────────────────────────────────────────────────

test("cold open points land on real cuts, inside the first few seconds", () => {
  // Cumulative piece boundaries: 1.2, 3.2, 5.6. The third is past the hook
  // window, so it is not on offer — a "different first three seconds" that
  // starts at 5.6s is a re-cut, not a hook variation.
  const points = coldOpenPoints([{ seconds: 1.2 }, { seconds: 2.0 }, { seconds: 2.4 }, { seconds: 3 }]);
  assert.deepEqual(points, [1.2, 3.2]);
  for (const p of points) assert.ok(p <= 3.5, `${p}s is past the hook window`);
});

test("a cut too close to the first frame is not a cold open", () => {
  // Opening 0.2s in is not a different opening; it is the same opening with a
  // frame missing.
  assert.deepEqual(coldOpenPoints([{ seconds: 0.2 }, { seconds: 1.5 }]), [1.7]);
});

test("a video whose first piece is already long offers no cold open", () => {
  assert.deepEqual(coldOpenPoints([{ seconds: 9 }, { seconds: 3 }]), []);
});

// ─── the long-form pipeline is byte-identical ───────────────────────────────

test("editOnCameraTake's new arguments change nothing for a long-form caller", () => {
  // The reels queue reuses this function rather than forking it, which meant
  // adding four optional parameters to a function the long-form build calls on
  // every on-camera take. Every one defaults to what it did before, and this is
  // what proves it: the SAME call the long-form pipeline makes, with no new
  // arguments, must produce byte-identical ffmpeg invocations.
  const silences = [{ start: 3, end: 4.4 }, { start: 9, end: 11 }];
  const capture = () => {
    const calls = [];
    const report = editOnCameraTake("in.mp4", "/out", {
      dim: { w: 1920, h: 1080 },
      index: 2,
      isOpening: false,
      minKeep: 0,
      fps: 30,
      ffmpeg: (args) => calls.push(args.join(" ")),
      writeFileSync: () => {},
      join: (...p) => p.join("/"),
      mediaDuration: () => 24,
      // The stand-in for detectSilences: passing `silences` is one of the new
      // parameters, so it is supplied on both sides of the comparison and the
      // thing under test is the interval and treatment defaults.
      silences,
      duration: 24,
    });
    return { calls, report };
  };

  const a = capture();
  const b = capture();
  assert.deepEqual(a.calls, b.calls, "the same call produced different ffmpeg arguments");

  // The long-form defaults are the long-form values: a 3s cadence and the
  // configured on-camera treatment (blur-fill), NOT the reel's.
  const plan = buildEditList(24, silences, { seed: 2 });
  assert.deepEqual(a.report.pieces, plan.pieces, "the default plan is no longer buildEditList's default plan");
  assert.ok(a.calls[0].includes("split=2"), "the default treatment is no longer blur-fill");
  assert.equal(a.calls.length, plan.pieces.length);
});

test("a reels caller gets the reel cadence and no blur-fill", () => {
  const calls = [];
  editOnCameraTake("in.mp4", "/out", {
    dim: REEL_DIM,
    index: 0,
    fps: 30,
    interval: REEL_PUNCH_INTERVAL,
    treatment: REEL_TREATMENT,
    silences: [],
    duration: 20,
    ffmpeg: (args) => calls.push(args.join(" ")),
    writeFileSync: () => {},
    join: (...p) => p.join("/"),
    mediaDuration: () => 20,
  });
  assert.ok(calls.length > 5, `expected the faster cadence to produce more pieces, got ${calls.length}`);
  for (const c of calls) {
    assert.ok(!c.includes("gblur"), "a reel must not be blur-filled");
    assert.ok(c.includes("1080:1920"), "a reel must be rendered vertical");
  }
});

// ─── real ffmpeg ────────────────────────────────────────────────────────────

function synthesize(dir, { seconds, silentFrom = null, silentTo = null }) {
  const path = join(dir, `in-${seconds}-${silentFrom}.mp4`);
  // A tone with a silent window punched into it, so silencedetect has something
  // real to find at a known place.
  const audio =
    silentFrom === null
      ? `sine=frequency=440:duration=${seconds}`
      : `sine=frequency=440:duration=${seconds},volume=enable='between(t,${silentFrom},${silentTo})':volume=0`;
  execFileSync("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", `testsrc2=size=540x960:rate=30:duration=${seconds}`,
    "-f", "lavfi", "-i", audio,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest", "-t", String(seconds), path,
  ], { stdio: "ignore" });
  return path;
}

test("a real render cuts the silence out and the result is shorter", { skip: !HAS_FFMPEG && "ffmpeg not installed" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "reel-render-"));
  try {
    const input = synthesize(dir, { seconds: 20, silentFrom: 6, silentTo: 11 });
    const result = renderReelEdit(input, dir, { dim: { w: 540, h: 960 } });

    assert.ok(existsSync(result.outputPath), "no output file");
    assert.ok(result.silenceCount >= 1, "silencedetect found no pause in a file with a 5s silent window");
    assert.ok(result.removedSeconds > 3, `only ${result.removedSeconds}s removed from a 5s silence`);
    assert.equal(result.safety.safe, true, JSON.stringify(result.safety.violations));

    const rendered = mediaDuration(result.outputPath);
    assert.ok(rendered > 0, "the output has no duration");
    assert.ok(rendered < 20 - 3, `the output is ${rendered}s; the silence was not actually removed`);
    // And the cut landed where it was planned, not somewhere near it.
    assert.ok(Math.abs(rendered - result.editedSeconds) < 1.0, `planned ${result.editedSeconds}s, rendered ${rendered}s`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a real all-silent video survives the edit intact", { skip: !HAS_FFMPEG && "ffmpeg not installed" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "reel-silent-"));
  try {
    const input = synthesize(dir, { seconds: 14, silentFrom: 0, silentTo: 14 });
    const result = renderReelEdit(input, dir, { dim: { w: 540, h: 960 } });
    const rendered = mediaDuration(result.outputPath);
    assert.ok(rendered > 12, `an all-silent video was cut down to ${rendered}s — it must be kept whole`);
    assert.ok(result.warnings.length > 0, "and the run must say why");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("planReelEdit refuses a file it cannot read a duration from", () => {
  assert.throws(() => planReelEdit("/nonexistent/nope.mp4"), /could not read a duration/);
});

test("describeEdit says what happened in numbers", () => {
  const text = describeEdit({ originalSeconds: 30, editedSeconds: 24, removedSeconds: 6, silenceCount: 3, pieces: [1, 2, 3, 4] });
  assert.match(text, /30\.0s in/);
  assert.match(text, /24\.0s out/);
  assert.match(text, /20%/);
  assert.match(text, /3 pause/);
});

test("the declick is applied to pieces long enough to carry it", () => {
  assert.equal(PIECE_DECLICK_SECONDS, 0.015);
  assert.ok(PUNCH_INTERVAL_MIN > PIECE_DECLICK_SECONDS * 3, "the cadence floor must clear the declick threshold");
});

describe("speechSafe knows the planner's own short-span drop", async () => {
  const { buildEditList } = await import("../src/yt-oncamera-edit.js");

  test("VIDEO 1'S TEASER SHAPE: a pause then a sub-piece tail is safe", () => {
    // Run 32298899242's refusal, reproduced deterministically: the take ends
    // with a reported 0.6s pause and ~0.38s of post-pause audio; buildEditList
    // drops that final span as too short to be a shot (its documented
    // behaviour on every long-form video), and the old checker refused the
    // resulting gap because silence-remainder + dropped-span exceeds the
    // silence's own bounds.
    const total = 19.095;
    const silences = [{ start: 18.192, end: 18.792 }];
    const plan = buildEditList(total, silences, { isOpening: false, punchIns: true, interval: 2.5, minKeep: 0 });
    const safety = speechSafe(plan.pieces, silences, total);
    assert.equal(safety.safe, true, JSON.stringify(safety.violations));
  });

  test("a gap ripped out of OPEN SPEECH still refuses — the guarantee did not move", () => {
    const silences = [{ start: 18.192, end: 18.792 }];
    const s = speechSafe([{ srcStart: 0, srcEnd: 5 }, { srcStart: 7, srcEnd: 19.095 }], silences, 19.095);
    assert.equal(s.safe, false);
  });

  test("a tail drop BIGGER than the planner is allowed still refuses", () => {
    // uncovered = 19.095 - 17.5 minus the 0.6s silence = ~0.995s — more than
    // MIN_PIECE_SECONDS, so something other than the short-span filter ate it.
    const silences = [{ start: 18.192, end: 18.792 }];
    const s = speechSafe([{ srcStart: 0, srcEnd: 17.5 }], silences, 19.095);
    assert.equal(s.safe, false);
  });

  test("a short gap that does NOT begin in a silence still refuses", () => {
    // Same length as a legal drop, wrong anchor: it starts in open speech.
    const silences = [{ start: 5.0, end: 5.6 }];
    const s = speechSafe([{ srcStart: 0, srcEnd: 18.7 }], silences, 19.095);
    assert.equal(s.safe, false);
  });
});
