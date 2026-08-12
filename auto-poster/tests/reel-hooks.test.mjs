/**
 * reel-hooks.test.mjs — a hook may not promise what the video does not contain.
 *
 * That rule is the reason this module has a gate at all, and it is the one
 * thing here that would be genuinely damaging to get wrong: a variant whose
 * first three seconds claim a price the video never mentions is a lie with
 * Peter's name on it. So the honesty gate is tested the way yt-punch.js tests
 * its verbatim property — by trying to get a dishonest string past it.
 *
 * The model is never called. `generateHookLines` takes its `modelCall` as an
 * argument for exactly this reason: what needs testing is what the gates do
 * with a candidate, and a real model would make that non-deterministic while
 * testing nothing extra.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  HOOK_HOLD_SECONDS,
  MAX_HOOK_WORDS,
  MAX_VARIANTS,
  MIN_HOOK_WORDS,
  contentWords,
  figureSupported,
  figureTokens,
  firstSix,
  generateHookLines,
  planVariants,
  rankScore,
  validateHookLine,
} from "../src/reel-hooks.js";
import { hookPlateSvg, overlayArgs, wrapHook, coldOpenArgs } from "../src/reel-variant.js";

const TRANSCRIPT =
  "This three bedroom sits about twelve minutes from the interstate. " +
  "The kitchen island is quartz and the counters run the whole wall. " +
  "They are asking 340,000 and taxes here are the part most buyers forget to check.";

// ─── honesty ────────────────────────────────────────────────────────────────

test("a figure the video actually says is allowed", () => {
  const check = validateHookLine("Asking 340,000 for this kitchen", TRANSCRIPT);
  assert.equal(check.valid, true, check.failures.join("; "));
});

test("a figure the video NEVER says is rejected", () => {
  const check = validateHookLine("Asking 450,000 for this kitchen", TRANSCRIPT);
  assert.equal(check.valid, false);
  assert.ok(check.failures.some((f) => /never says/.test(f)), check.failures.join("; "));
});

test("a figure spelled differently from the transcript still passes on its digits", () => {
  // Whisper writes the same spoken amount several ways. Comparing strings would
  // reject an honest hook most of the time.
  assert.equal(figureSupported("340000", "they are asking 340,000 today"), true);
  assert.equal(figureSupported("$340,000", "they are asking 340000 today"), true);
  assert.equal(figureSupported("450,000", "they are asking 340,000 today"), false);
});

test("figureTokens finds figures whatever punctuation hangs off them", () => {
  assert.deepEqual(figureTokens("Asking $340,000. Really?"), ["$340,000"]);
  assert.deepEqual(figureTokens("It is 12 minutes, 3% down"), ["12", "3%"]);
  assert.deepEqual(figureTokens("no numbers here"), []);
});

test("an invented superlative is rejected", () => {
  for (const line of [
    "The best kitchen in the whole county",
    "The only three bedroom left here",
    "Taxes here are never going up",
    "Guaranteed the cheapest on this street",
  ]) {
    const check = validateHookLine(line, TRANSCRIPT);
    assert.equal(check.valid, false, `"${line}" got through`);
    assert.ok(check.failures.some((f) => /absolute/.test(f)), check.failures.join("; "));
  }
});

test("a superlative the video DOES say is allowed", () => {
  const said = "this is the best kitchen I have shown all month and the counters are quartz";
  const check = validateHookLine("The best kitchen this month", said);
  assert.equal(check.valid, true, check.failures.join("; "));
});

test("a hook about some other video is rejected", () => {
  const check = validateHookLine("Downtown parking changes everything", "the kitchen island is quartz and the counters run the wall");
  assert.equal(check.valid, false);
  assert.ok(check.failures.some((f) => /some other video/.test(f)), check.failures.join("; "));
});

// ─── the stopping-power rules we already have ───────────────────────────────

test("a hook that spends its opening qualifying the audience is rejected", () => {
  // hookOpensQualified, imported unchanged from the long-form script rules.
  for (const line of [
    "If you are looking at kitchen upgrades",
    "For anyone shopping for a kitchen",
    "When you are comparing kitchen counters",
  ]) {
    const check = validateHookLine(line, TRANSCRIPT);
    assert.equal(check.valid, false, `"${line}" got through`);
  }
});

test("a hook that opens with preamble is rejected", () => {
  // findPreamble, likewise imported rather than re-listed.
  for (const line of [
    "Welcome back to the kitchen tour",
    "Hey guys the kitchen is quartz",
    "In this video the kitchen counters",
  ]) {
    const check = validateHookLine(line, TRANSCRIPT);
    assert.equal(check.valid, false, `"${line}" got through`);
  }
});

test("a hook outside the word bounds is rejected", () => {
  assert.equal(validateHookLine("Quartz counters", TRANSCRIPT).valid, false, "under the floor");
  assert.equal(
    validateHookLine("The quartz kitchen counters run the whole wall and the island is enormous too", TRANSCRIPT).valid,
    false,
    "over the ceiling"
  );
  assert.equal(validateHookLine("", TRANSCRIPT).valid, false);
  assert.ok(MIN_HOOK_WORDS >= 3 && MAX_HOOK_WORDS <= 10);
});

test("the first six words are what gets scored", () => {
  assert.equal(firstSix("Taxes here are the part most buyers forget"), "Taxes here are the part most");
  assert.equal(firstSix("Short one"), "Short one");
});

test("ranking rewards a figure or a concrete noun in the first six words", () => {
  const withFigure = rankScore("340,000 buys this quartz kitchen", TRANSCRIPT);
  const vague = rankScore("Something here is worth a look", TRANSCRIPT);
  assert.ok(withFigure > vague, `${withFigure} should beat ${vague}`);
});

test("ranking is deterministic — a re-edit must not reshuffle which line is A", () => {
  const line = "Taxes here catch most buyers out";
  assert.equal(rankScore(line, TRANSCRIPT), rankScore(line, TRANSCRIPT));
});

// ─── generation ─────────────────────────────────────────────────────────────

function fakeModel(candidates) {
  return async () => JSON.stringify({ candidates });
}

test("only honest candidates survive generation", async () => {
  const result = await generateHookLines({
    transcript: TRANSCRIPT,
    modelCall: fakeModel([
      "Asking 340,000 for this quartz kitchen",
      "The cheapest three bedroom in Texas",
      "Taxes here catch most buyers out",
      "If you are a first time buyer",
    ]),
    maxRetries: 0,
  });
  const kept = result.lines.map((l) => l.line);
  assert.ok(kept.includes("Asking 340,000 for this quartz kitchen"));
  assert.ok(kept.includes("Taxes here catch most buyers out"));
  assert.ok(!kept.includes("The cheapest three bedroom in Texas"), "an invented superlative survived");
  assert.ok(!kept.some((l) => l.startsWith("If you")), "a qualifying opener survived");
  assert.equal(result.rejected.length, 2);
});

test("generation never throws when every candidate is dishonest", async () => {
  // A render is still worth reviewing without its variants. Throwing here would
  // discard a finished edit over a hook line.
  const result = await generateHookLines({
    transcript: TRANSCRIPT,
    modelCall: fakeModel(["The best home in America", "Guaranteed 900,000 value", "Only one left anywhere"]),
    maxRetries: 0,
  });
  assert.deepEqual(result.lines, []);
  assert.equal(result.rejected.length, 3);
});

test("a video with no transcript produces no hooks and says why", async () => {
  const result = await generateHookLines({ transcript: "  ", modelCall: fakeModel(["anything at all here"]) });
  assert.deepEqual(result.lines, []);
  assert.match(result.reason, /no transcript/);
});

test("unparseable model output is retried, not fatal", async () => {
  let call = 0;
  const flaky = async () => (++call === 1 ? "I'm afraid I can't do that" : JSON.stringify({ candidates: ["Taxes here catch most buyers out"] }));
  const result = await generateHookLines({ transcript: TRANSCRIPT, modelCall: flaky, maxRetries: 2 });
  assert.equal(result.lines.length, 1);
  assert.ok(call >= 2);
});

test("duplicate candidates across retries are not counted twice", async () => {
  const result = await generateHookLines({
    transcript: TRANSCRIPT,
    modelCall: fakeModel(["Taxes here catch most buyers out", "taxes here catch most buyers out"]),
    maxRetries: 0,
  });
  assert.equal(result.lines.length, 1);
});

// ─── the variant plan ───────────────────────────────────────────────────────

test("variants differ in the hook, and A is the control", () => {
  const lines = [{ line: "One", score: 5 }, { line: "Two", score: 4 }, { line: "Three", score: 3 }];
  const plan = planVariants(lines, [1.2, 2.8]);
  assert.equal(plan.length, 3);
  assert.deepEqual(plan.map((v) => v.label), ["A", "B", "C"]);
  assert.equal(plan[0].coldOpenAt, 0, "A must open where the master does, or there is no control");
  assert.ok(plan[1].coldOpenAt > 0, "B should move the cold open");
  assert.equal(new Set(plan.map((v) => v.hookLine)).size, 3, "the hook is the axis of difference");
});

test("a video with no cold-open candidates still produces valid variants", () => {
  const plan = planVariants([{ line: "One" }, { line: "Two" }], []);
  assert.equal(plan.length, 2);
  for (const v of plan) {
    assert.equal(v.coldOpenAt, 0);
    assert.match(v.treatment, /own opening/);
  }
});

test("never more than three variants, however many lines survive", () => {
  const plan = planVariants([1, 2, 3, 4, 5].map((n) => ({ line: `Line ${n}` })), [1, 2, 3]);
  assert.equal(plan.length, MAX_VARIANTS);
});

// ─── the plate ──────────────────────────────────────────────────────────────

test("a hook line wraps without splitting a word", () => {
  const lines = wrapHook("Taxes here are the part most buyers forget to check");
  assert.ok(lines.length > 1);
  assert.equal(lines.join(" "), "Taxes here are the part most buyers forget to check");
  for (const l of lines) assert.ok(!l.startsWith(" ") && !l.endsWith(" "));
});

test("the plate is valid SVG at the reel's size and escapes its input", () => {
  const svg = hookPlateSvg('Asking 340,000 & <rising>');
  assert.match(svg, /^<svg /);
  assert.match(svg, /width="1080" height="1920"/);
  assert.ok(svg.includes("&amp;"), "an ampersand would break the SVG parse");
  assert.ok(!svg.includes("<rising>"), "unescaped angle brackets would break the SVG parse");
});

test("the overlay is enabled for the first three seconds and no longer", () => {
  // An overlay that never enables renders perfectly and produces a variant
  // identical to the master — an A/B with nothing in it.
  const args = overlayArgs("in.mp4", "plate.png", "out.mp4").join(" ");
  assert.match(args, /enable='between\(t,0,3\)'/);
  assert.ok(args.includes("overlay=0:0"));
  assert.ok(args.includes("-map 0:a?"), "the variant must keep the master's audio");
  assert.equal(HOOK_HOLD_SECONDS, 3);
});

test("a cold open seeks before it encodes", () => {
  const args = coldOpenArgs("in.mp4", "out.mp4", 1.2);
  assert.ok(args.includes("-ss"));
  assert.equal(args[args.indexOf("-ss") + 1], "1.2");
  assert.ok(args.indexOf("-i") < args.indexOf("-ss"), "-ss after -i is the frame-accurate form");
});

test("contentWords drops the words that prove nothing", () => {
  assert.deepEqual(contentWords("the kitchen is in the house"), ["kitchen", "house"]);
});
