import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { applyRetentionStage, renderRetentionSummary } from "../src/yt-retention-stage.js";
import { buildEditList } from "../src/yt-oncamera-edit.js";

const WORK = join(tmpdir(), `retention-stage-${Date.now()}`);
mkdirSync(WORK, { recursive: true });

/** A real encoded take with a real 1.2s silence in the middle. */
function makeTake(name, seconds = 12, gap = [5, 6.2]) {
  const out = join(WORK, `${name}.mp4`);
  execFileSync("ffmpeg", ["-y", "-v", "error",
    "-f", "lavfi", "-i", `testsrc2=size=320x180:rate=30:duration=${seconds}`,
    "-f", "lavfi", "-i", `sine=frequency=220:duration=${seconds}`,
    "-filter_complex", `[1:a]volume='if(between(t,${gap[0]},${gap[1]}),0,1)':eval=frame[a]`,
    "-map", "0:v", "-map", "[a]",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", out],
    { stdio: ["pipe", "pipe", "pipe"] });
  return out;
}

const DIM = { w: 640, h: 360 };

describe("applyRetentionStage — the stage that was missing", () => {
  test("attaches editPlan AND editPieces to on-camera segments, and updates seconds", () => {
    // This is the wiring whose absence made the whole retention edit a silent
    // no-op: yt-assemble consumed seg.editPlan and nothing produced it.
    const take = makeTake("wired", 12);
    const plan = { segments: [
      { kind: "on_camera", takeId: "t1", seconds: 12, source: take },
      { kind: "voiceover", takeId: "t2", seconds: 10, narrationSource: null, broll: [{ driveFileId: "c", seconds: 10 }] },
    ]};
    const report = applyRetentionStage(plan, { workDir: join(WORK, "w1"), dim: DIM, flags: { pip: false } });

    const seg = plan.segments[0];
    assert.ok(seg.editPlan, "editPlan must be attached — the assembler reads it");
    assert.ok(Array.isArray(seg.editPieces), "editPieces must be attached — the cadence audit reads it");
    assert.ok(seg.editPlan.removedSeconds > 0.5, `should have cut the 1.2s gap, removed ${seg.editPlan.removedSeconds}`);
    assert.ok(Math.abs(seg.seconds - seg.editPlan.editedSeconds) < 0.01, "seconds must follow the edit or captions drift");
    assert.equal(report.edit.takes.length, 1);
    assert.ok(report.edit.totalRemovedSeconds > 0.5);
  });

  test("the first segment gets the opening push, later ones get punch-in framing", () => {
    const a = makeTake("open", 10, [4, 4.8]);
    const b = makeTake("later", 20, [9, 10]);
    const plan = { segments: [
      { kind: "on_camera", takeId: "t1", seconds: 10, source: a },
      { kind: "on_camera", takeId: "t2", seconds: 20, source: b },
    ]};
    applyRetentionStage(plan, { workDir: join(WORK, "w2"), dim: DIM, flags: { pip: false } });
    assert.ok(plan.segments[0].editPlan.pieces[0].push, "segment 0 is the opening and must push");
    const scales = plan.segments[1].editPlan.pieces.map((p) => p.scale);
    assert.ok(scales.length >= 2, "a 20s take should be several pieces");
    assert.ok(new Set(scales).size > 1, "later takes must alternate framing");
  });

  test("flags: jump cuts off leaves silence in; punch-ins off leaves one framing", () => {
    const take = makeTake("flags", 20, [9, 10.5]);
    const plan1 = { segments: [{ kind: "on_camera", takeId: "x", seconds: 20, source: take }, { kind: "on_camera", takeId: "y", seconds: 20, source: take }] };
    applyRetentionStage(plan1, { workDir: join(WORK, "w3"), dim: DIM, flags: { pip: false, jumpCuts: false } });
    assert.equal(plan1.segments[1].editPlan.removedSeconds, 0, "no silence removed with jump cuts off");
    assert.ok(plan1.segments[1].editPlan.pieces.length > 1, "punch-ins still break the take up");

    const plan2 = { segments: [{ kind: "on_camera", takeId: "x", seconds: 20, source: take }, { kind: "on_camera", takeId: "y", seconds: 20, source: take }] };
    applyRetentionStage(plan2, { workDir: join(WORK, "w4"), dim: DIM, flags: { pip: false, punchIns: false } });
    const later = plan2.segments[1].editPlan;
    assert.ok(later.removedSeconds > 0.5, "jump cuts still fire");
    // Punch-ins OFF stops the PERIODIC splits — but a framing flip at a
    // SILENCE seam stays, because that flip is what hides the removed pause.
    // Turning it off would make every jump cut a visible position jump, which
    // is the failure the whole design exists to avoid. One 1.5s gap in a 20s
    // take = exactly two speech spans, no 7-9s subdivisions.
    assert.equal(later.pieces.length, 2, "no periodic splits, only the silence seam");
    assert.notEqual(later.pieces[0].scale, later.pieces[1].scale, "the seam still flips framing to hide the cut");
  });

  test("PIP disabled by flag reports itself and touches nothing", () => {
    const plan = { segments: [{ kind: "voiceover", takeId: "v", seconds: 10, narrationSource: "/tmp/x.mp4", broll: [] }] };
    const report = applyRetentionStage(plan, { workDir: join(WORK, "w5"), dim: DIM, flags: { pip: false, jumpCuts: false, punchIns: false } });
    assert.equal(report.pip.enabled, false);
    assert.equal(plan.segments[0].pip, undefined);
    assert.match(renderRetentionSummary(report), /PIP: disabled/);
  });

  test("a missing on-camera source is skipped, not fatal", () => {
    const plan = { segments: [{ kind: "on_camera", takeId: "t1", seconds: 12, source: null }] };
    const report = applyRetentionStage(plan, { workDir: join(WORK, "w6"), dim: DIM, flags: { pip: false } });
    assert.equal(report.edit.takes.length, 0);
    assert.equal(plan.segments[0].editPlan, undefined);
  });

  test("creates its own work directory — the bug the first chain run hit", () => {
    const vanished = join(WORK, "never", "created", "before");
    assert.ok(!existsSync(vanished));
    const plan = { segments: [] };
    assert.doesNotThrow(() => applyRetentionStage(plan, { workDir: vanished, dim: DIM, flags: { pip: false } }));
    assert.ok(existsSync(vanished), "the stage must mkdir its own workDir");
  });

  test("the summary carries the numbers Peter asked to see", () => {
    const take = makeTake("summary", 12);
    const plan = { segments: [{ kind: "on_camera", takeId: "s1t1", seconds: 12, source: take }] };
    const report = applyRetentionStage(plan, { workDir: join(WORK, "w7"), dim: DIM, flags: { pip: false } });
    const text = renderRetentionSummary(report);
    assert.match(text, /dead air removed/);
    assert.match(text, /s1t1: [\d.]+s -> [\d.]+s/, "before/after per take");
    assert.match(text, /Cadence:/);
  });
});
