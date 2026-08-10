/**
 * yt-rev7-phases.test.mjs — the graphic that resumes.
 *
 * Revision 6 capped a graphic at one scene because a second block replayed the
 * same animation from its first state. Phases replace that cap, and the way they
 * can silently fail is specific: a slice that seeks to a keyframe instead of the
 * requested moment lands the phase on the wrong state, and a phase that quietly
 * points at the whole clip replays it exactly as before. Both look like a working
 * render.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";

import { phaseArgs } from "../src/yt-visual-build.js";
import { renderAnimatedGraphic } from "../src/yt-visual-animate.js";
import { frameDifference, inspectRender } from "../src/yt-visual-qc.js";

const ffmpeg = (args) => execFileSync("ffmpeg", args, { stdio: "pipe" });

test("a phase slice seeks accurately, not to the nearest keyframe", () => {
  const args = phaseArgs("/in.mp4", "/out.mp4", 16, 8);
  const iAt = args.indexOf("-i");
  const ssAt = args.indexOf("-ss");
  // -ss BEFORE -i is the fast, keyframe-snapping form. A graphic's reveals are
  // ~0.14s apart, so snapping can open a phase on a state that already passed.
  assert.ok(ssAt > iAt, "-ss must come after -i so the seek is frame-accurate");
  assert.ok(!args.includes("-c") || !args.includes("copy"), "a stream copy would cut on keyframes for the same reason");
  assert.equal(args[args.indexOf("-t") + 1], "8");
});

test("a phase slice clamps rather than asking for time that does not exist", () => {
  const args = phaseArgs("/in.mp4", "/out.mp4", -5, 0);
  assert.equal(args[args.indexOf("-ss") + 1], "0", "a negative start becomes zero");
  assert.ok(Number(args[args.indexOf("-t") + 1]) > 0, "a zero duration becomes a real one");
});

test("phase two resumes the animation instead of restarting it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rev7-"));
  const spec = {
    eyebrow: "THE TEST",
    title: "What the inspection is for",
    items: ["Foundation movement", "Cast iron drain lines", "Thirty-year-old ductwork", "Original windows"],
  };
  const words = "you are inspecting foundations and cast iron drain lines and thirty year old ductwork and original windows"
    .split(" ")
    .map((w, i) => ({ word: w, start: 0.4 + i * 0.9, end: 0.4 + i * 0.9 + 0.7 }));

  const r = await renderAnimatedGraphic({
    type: "LIST", spec, seconds: 20, words, dir, index: 0, ffmpeg, writeFileSync,
  });
  assert.equal(r.deadStates.length, 0, "the render itself must be sound before slicing means anything");

  const p0 = join(dir, "p0.mp4");
  const p1 = join(dir, "p1.mp4");
  ffmpeg(phaseArgs(r.path, p0, 0, 6));
  ffmpeg(phaseArgs(r.path, p1, 12, 6));

  const f0 = join(dir, "f0.png");
  const f1 = join(dir, "f1.png");
  ffmpeg(["-y", "-ss", "0.4", "-i", p0, "-vframes", "1", f0]);
  ffmpeg(["-y", "-ss", "0.4", "-i", p1, "-vframes", "1", f1]);

  // If phase 2 replayed from zero these would be near-identical.
  const d = await frameDifference(f0, f1);
  assert.ok(d > 0.5, `phase 2 opened on the same state as phase 1 (diff ${d.toFixed(4)}) — it restarted`);

  // And it must be FURTHER ON, not merely different: more items drawn means more
  // ink. A phase that resumed correctly is strictly busier than the one before.
  const [v0, v1] = await Promise.all([
    inspectRender(f0, { label: "phase0", edgeCheck: false }),
    inspectRender(f1, { label: "phase1", edgeCheck: false }),
  ]);
  assert.ok(
    v1.metrics.inkRatio > v0.metrics.inkRatio,
    `phase 2 should show more revealed items (${(v0.metrics.inkRatio * 100).toFixed(2)}% -> ${(v1.metrics.inkRatio * 100).toFixed(2)}%)`
  );
  assert.ok(v1.ok, "and it must still be a legible frame");
});

test("no segment shape produces a scene over the cap, and none loses time", async () => {
  const { planSegmentCoverage } = await import("../src/yt-visual-plan.js");
  const { SCENE_MAX_SECONDS } = await import("../src/yt-config.js");
  const visuals = ["COMPARISON", "LIST", "MAP", "NUMBER_BREAKDOWN", "CALLOUT", "FOOTAGE", null];

  for (const seconds of [1.2, 3, 8, 8.5, 9, 12, 20, 30, 45, 60]) {
    for (const visual of visuals) {
      for (const graphicOk of [true, false]) {
        for (const stockSeconds of [0, 6, 30]) {
          const seg = { kind: "voiceover", visual, seconds, visualSpec: { keywords: stockSeconds ? ["x"] : [] } };
          const { blocks } = planSegmentCoverage(seg, { graphicOk, stockSeconds });
          const label = `${seconds}s ${visual} graphicOk=${graphicOk} stock=${stockSeconds}`;

          const longest = Math.max(...blocks.map((b) => b.seconds));
          assert.ok(longest <= SCENE_MAX_SECONDS + 0.001, `${label}: scene of ${longest}s exceeds the cap`);

          // Coverage is the property the renderer depends on: the blocks must
          // add up to the take, or the picture runs short and -shortest quietly
          // truncates the narration.
          const sum = blocks.reduce((a, b) => a + b.seconds, 0);
          assert.ok(Math.abs(sum - seconds) < 0.06, `${label}: blocks sum to ${sum}, not ${seconds}`);

          // Two adjacent stock or owned blocks point at one clip and would replay
          // it from the start — the loop phases exist to prevent.
          for (let i = 1; i < blocks.length; i++) {
            const same = blocks[i].kind === blocks[i - 1].kind;
            const oneClip = blocks[i].kind === "stock" || blocks[i].kind === "owned";
            assert.ok(!(same && oneClip), `${label}: adjacent ${blocks[i].kind} blocks would replay one clip`);
          }
        }
      }
    }
  }
});
