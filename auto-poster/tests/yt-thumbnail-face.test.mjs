/**
 * The face-thumbnail contest.
 *
 * The failure this guards against is the DEFENSIBLE frame: eyes open, face
 * sharp, expression dead — a thumbnail nobody clicks that every gate passes.
 * The contest exists to force three real alternatives to beat each other, and
 * these tests pin that machinery: candidate selection spans the take,
 * fallbacks are recorded rather than silent, and a scoring outage degrades to
 * a shipped thumbnail with a reason, never a dead build.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  selectCandidateFrames,
  buildFaceThumbnail,
  pickWinningComposite,
  preserveCandidates,
  CANDIDATE_COUNT,
  MIN_FRAME_SEPARATION_SECONDS,
} from "../src/yt-thumbnail-face.js";

let workDir;
let sourcePath;

before(() => {
  workDir = mkdtempSync(join(tmpdir(), "thumb-face-test-"));
  // A 10-second synthetic "take": moving colour so sampled frames differ.
  sourcePath = join(workDir, "take.mp4");
  execFileSync("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "testsrc2=size=640x1136:rate=30:duration=10",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", sourcePath,
  ], { stdio: "pipe", timeout: 60_000 });
});

after(() => rmSync(workDir, { recursive: true, force: true }));

describe("selectCandidateFrames — three MOMENTS, not three adjacent frames", () => {
  const at = (s, score) => ({ path: `/f${s}.png`, at: s, score });

  test("takes the top-ranked frames that are far enough apart", () => {
    const ranked = [at(5.0, 9), at(5.2, 8.5), at(1.0, 8), at(8.0, 7)];
    const picked = selectCandidateFrames(ranked, null);
    assert.deepEqual(picked.map((c) => c.at), [5.0, 1.0, 8.0], "5.2 is the same expression as 5.0");
  });

  test("fills from the top when the take is too short for separated moments", () => {
    const ranked = [at(1.0, 9), at(1.2, 8), at(1.4, 7)];
    const picked = selectCandidateFrames(ranked, null);
    assert.equal(picked.length, CANDIDATE_COUNT, "never returns fewer than asked when frames exist");
  });

  test("with no ranking (scorer down) it spans the sampled frames positionally", () => {
    const sampled = [at(1), at(2), at(3), at(4), at(5)];
    const picked = selectCandidateFrames(null, sampled);
    assert.deepEqual(picked.map((c) => c.at), [1, 3, 5], "first, middle, last");
  });

  test("separation constant is meaningfully smaller than one held expression", () => {
    // The kit holds each expression ~3s; the guard is that two candidates a
    // blink apart cannot both qualify while a 3s-apart pair always does.
    assert.ok(MIN_FRAME_SEPARATION_SECONDS > 0.5 && MIN_FRAME_SEPARATION_SECONDS < 3);
  });
});

describe("pickWinningComposite — the emotional trigger decides", () => {
  const cands = (paths) => paths.map((p, i) => ({ index: i, path: p, frameAt: i }));

  test("ranks by emotional_trigger, legibility breaking ties", async () => {
    const files = [join(workDir, "a.png"), join(workDir, "b.png"), join(workDir, "c.png")];
    for (const f of files) execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=red:size=64x36:duration=0.1:rate=10", "-frames:v", "1", f], { stdio: "pipe" });
    const { winner, ranked } = await pickWinningComposite(cands(files), {
      visionCall: async () => [
        { index: 0, emotional_trigger: 6, legibility: 9 },
        { index: 1, emotional_trigger: 8, legibility: 5 },
        { index: 2, emotional_trigger: 8, legibility: 7 },
      ],
    });
    assert.equal(winner.index, 2, "8/7 beats 8/5 beats 6/9");
    assert.deepEqual(ranked.map((r) => r.index), [2, 1, 0]);
  });

  test("a scoring outage ships the first candidate WITH the reason attached", async () => {
    const f = join(workDir, "solo.png");
    execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=red:size=64x36:duration=0.1:rate=10", "-frames:v", "1", f], { stdio: "pipe" });
    const files = [f, f, f].map(() => f);
    const r = await pickWinningComposite(cands(files), { visionCall: async () => { throw new Error("model down"); } });
    assert.equal(r.winner.index, 0);
    assert.match(r.reason, /model down/, "the degradation must carry its cause");
  });

  test("nothing to judge is a null winner with a reason, not a throw", async () => {
    const r = await pickWinningComposite([], {});
    assert.equal(r.winner, null);
    assert.ok(r.reason);
  });
});

describe("buildFaceThumbnail — the whole contest, offline", () => {
  // A fake matte cutter: succeeds by copying the frame, so composites render.
  const copyCutout = (framePath, outPath) => {
    execFileSync("cp", [framePath, outPath]);
    return { ok: true, path: outPath, metrics: { coverage: 0.3, holeRatio: 0.01 } };
  };
  const frameScorer = async (candidates) => candidates.map((c, i) => ({ index: i, score: 10 - i, why: "test" }));
  const compositeScorer = async (candidates) =>
    candidates.map((c, i) => ({ index: i, emotional_trigger: i === 1 ? 9 : 5, legibility: 7, why: "test" }));

  test("produces three scored composites and a winner", async () => {
    const face = await buildFaceThumbnail({
      hookText: "THE FEE NOBODY MENTIONS",
      kicker: "SAN ANTONIO",
      source: { path: sourcePath, seconds: 10, takeId: "thumbnail" },
      workDir,
      visionCall: frameScorer,
      compositeVision: compositeScorer,
      cutout: copyCutout,
    });
    assert.equal(face.candidates.length, 3);
    assert.equal(face.winner.index, 1, "the composite scorer's favourite wins");
    assert.ok(face.candidates.every((c) => existsSync(c.path) && c.bytes > 1000));
    assert.equal(face.fallbacks.length, 0);
    assert.equal(face.source, "thumbnail");
  });

  test("a refused matte falls back to the raw frame — recorded, never silent", async () => {
    const refuse = () => ({ ok: false, reason: "coverage 0.01 outside [0.06, 0.72]" });
    const face = await buildFaceThumbnail({
      hookText: "THE FEE NOBODY MENTIONS",
      kicker: "SAN ANTONIO",
      source: { path: sourcePath, seconds: 10, takeId: "s1t1" },
      workDir,
      visionCall: frameScorer,
      compositeVision: compositeScorer,
      cutout: refuse,
    });
    assert.equal(face.candidates.length, 3, "raw frames still composite");
    assert.ok(face.candidates.every((c) => c.cutout === false));
    assert.equal(face.fallbacks.length, 3, "every refusal is in the report");
    assert.match(face.fallbacks[0].reason, /coverage/);
  });

  test("no source clip is a reasoned no-winner, not a throw", async () => {
    const face = await buildFaceThumbnail({ hookText: "X", kicker: "K", source: null, workDir });
    assert.equal(face.winner, null);
    assert.match(face.reason, /no source clip/);
  });

  test("no hook text refuses before touching ffmpeg", async () => {
    const face = await buildFaceThumbnail({ hookText: "", source: { path: sourcePath, seconds: 10 }, workDir });
    assert.equal(face.winner, null);
    assert.match(face.reason, /no hook text/);
  });

  test("preserveCandidates names the winner in the filename", async () => {
    const face = await buildFaceThumbnail({
      hookText: "THE FEE NOBODY MENTIONS",
      kicker: "SAN ANTONIO",
      source: { path: sourcePath, seconds: 10, takeId: "thumbnail" },
      workDir,
      visionCall: frameScorer,
      compositeVision: compositeScorer,
      cutout: copyCutout,
    });
    const dest = mkdtempSync(join(tmpdir(), "thumb-evidence-"));
    try {
      const kept = preserveCandidates(face, dest);
      assert.equal(kept.length, 3);
      const names = readdirSync(dest);
      assert.equal(names.filter((n) => n.includes("WINNER")).length, 1);
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });
});
