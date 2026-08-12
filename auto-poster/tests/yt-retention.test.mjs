import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  parseSilenceLog, normaliseSilences, buildEditList, splitForPunchIns, pieceArgs,
  MIN_SILENCE_SECONDS, KEEP_SILENCE_SECONDS, PUNCH_MIN_TAKE_SECONDS,
  PUNCH_INTERVAL_MAX, PUNCH_INTERVAL_MIN, FRAMING_WIDE, FRAMING_TIGHT, MIN_PIECE_SECONDS,
} from "../src/yt-oncamera-edit.js";
import { buildStateTimeline, auditCadence, MAX_STATIC_SECONDS } from "../src/yt-cadence.js";
import {
  gateCutout, pipPlacement, pipCompositeArgs, planPip,
  CAPTION_SAFE_BOTTOM, PIP_HEIGHT_MIN, PIP_HEIGHT_MAX, MIN_COVERAGE, MAX_COVERAGE,
} from "../src/yt-pip.js";

const DIM = { w: 1920, h: 1080 };

describe("silence log parsing", () => {
  test("pairs starts with ends", () => {
    const log = `
[silencedetect @ 0x1] silence_start: 5.01551
[silencedetect @ 0x1] silence_end: 6.222948 | silence_duration: 1.207438
[silencedetect @ 0x1] silence_start: 12.004717
[silencedetect @ 0x1] silence_end: 13.514014 | silence_duration: 1.509297`;
    const out = parseSilenceLog(log);
    assert.equal(out.length, 2);
    assert.ok(Math.abs(out[0].start - 5.0155) < 0.001);
    assert.ok(Math.abs(out[1].end - 13.514) < 0.001);
  });

  test("closes a silence the file ended inside, when a duration is known", () => {
    // Most takes fade out on a pause; dropping it leaves dead air on every one.
    const log = "silence_start: 27.5";
    assert.equal(parseSilenceLog(log).length, 0, "unterminated and no duration — cannot close it");
    const closed = parseSilenceLog(log, { duration: 30 });
    assert.equal(closed.length, 1);
    assert.equal(closed[0].end, 30);
  });

  test("an empty log is no silences, not a crash", () => {
    assert.deepEqual(parseSilenceLog(""), []);
    assert.deepEqual(parseSilenceLog(null), []);
  });

  test("ignores an end with no start", () => {
    assert.deepEqual(parseSilenceLog("silence_end: 4.0 | silence_duration: 1.0"), []);
  });
});

describe("silence normalisation", () => {
  test("merges overlapping intervals", () => {
    // Unsorted or overlapping input produces negative-length spans, which
    // become ffmpeg trims that output nothing at all.
    const out = normaliseSilences([{ start: 5, end: 7 }, { start: 6, end: 9 }], 30);
    assert.equal(out.length, 1);
    assert.deepEqual([out[0].start, out[0].end], [5, 9]);
  });

  test("sorts out-of-order input", () => {
    const out = normaliseSilences([{ start: 12, end: 14 }, { start: 2, end: 4 }], 30);
    assert.deepEqual(out.map((s) => s.start), [2, 12]);
  });

  test("drops anything under the minimum", () => {
    assert.equal(normaliseSilences([{ start: 1, end: 1 + MIN_SILENCE_SECONDS / 2 }], 30).length, 0);
  });

  test("clamps to the take's duration", () => {
    const out = normaliseSilences([{ start: 25, end: 999 }], 30);
    assert.equal(out[0].end, 30);
  });
});

describe("the edit list", () => {
  test("removes dead air and leaves a little of it behind", () => {
    const plan = buildEditList(30, [{ start: 10, end: 12 }]);
    assert.ok(plan.removedSeconds > 1.5, `removed ${plan.removedSeconds}`);
    assert.ok(plan.removedSeconds < 2, "should keep some of the pause, not all of it");

    // The seam is where the pause was. There are more pieces than that, because
    // a 30s take also gets punch-ins — the two features share one edit list.
    const beforeGap = plan.pieces.find((p) => p.srcEnd > 10 && p.srcEnd < 11);
    const afterGap = plan.pieces.find((p) => p.srcStart > 11 && p.srcStart < 12);
    assert.ok(beforeGap, `no piece ends just after the words: ${JSON.stringify(plan.pieces)}`);
    assert.ok(afterGap, "no piece starts just before the next words");
    assert.ok(afterGap.srcStart > beforeGap.srcEnd, "the pause should have been cut out between them");
  });

  test("a take mostly made of silence is disbelieved, not deleted", () => {
    // One surviving span cleared the per-piece minimum, so the zero-span
    // fallback never fired and a 20s take came out as 0.575s — silently.
    const plan = buildEditList(20, [{ start: 0.2, end: 19.5 }]);
    assert.equal(plan.editedSeconds, 20, "the take should have been restored whole");
    assert.equal(plan.pieces[0].srcStart, 0);
    assert.ok(plan.warnings.some((w) => /uncut/.test(w)), plan.warnings.join("; "));
  });

  test("the framing alternates at every seam — that is what hides the cut", () => {
    const plan = buildEditList(40, [{ start: 10, end: 11 }, { start: 20, end: 21 }, { start: 30, end: 31 }]);
    const scales = plan.pieces.map((p) => p.scale);
    for (let i = 1; i < scales.length; i++) {
      assert.notEqual(scales[i], scales[i - 1], `pieces ${i - 1} and ${i} share a framing — the cut would show`);
    }
    assert.ok(scales.includes(FRAMING_WIDE) && scales.includes(FRAMING_TIGHT));
  });

  test("a take with NO silence still gets punch-ins", () => {
    const plan = buildEditList(30, []);
    assert.equal(plan.removedSeconds, 0);
    assert.ok(plan.pieces.length >= 3, `a 30s take should break up, got ${plan.pieces.length}`);
    assert.ok(plan.pieces.every((p) => p.seconds <= PUNCH_INTERVAL_MAX + 0.01));
  });

  test("a take too short for punch-ins is left as one piece", () => {
    const plan = buildEditList(PUNCH_MIN_TAKE_SECONDS - 2, []);
    assert.equal(plan.pieces.length, 1);
    assert.equal(plan.pieces[0].scale, FRAMING_WIDE);
  });

  test("trimming below the narration budget restores the take", () => {
    // The picture must still cover the words. A video missing a sentence is
    // worse than a video with a pause in it.
    //
    // 12s of pause in a 30s take leaves 18s — comfortably over the retained-
    // share floor, so this isolates the narration-budget guard rather than
    // tripping the "that is a bad recording" one.
    const plan = buildEditList(30, [{ start: 5, end: 17 }], { minKeep: 25 });
    assert.equal(plan.editedSeconds, 30);
    assert.ok(plan.warnings.some((w) => /narration budget/.test(w)), plan.warnings.join("; "));
  });

  test("the two restore guards are distinguishable in the report", () => {
    // They mean different things: one is "this pause is too long for the
    // narration", the other is "this recording is not what we think it is".
    const budget = buildEditList(30, [{ start: 5, end: 17 }], { minKeep: 25 });
    const bad = buildEditList(20, [{ start: 0.2, end: 19.5 }]);
    assert.ok(budget.warnings.some((w) => /narration budget/.test(w)));
    assert.ok(bad.warnings.some((w) => /bad recording/.test(w)), bad.warnings.join("; "));
  });

  test("the opening take gets the push and no punch-ins", () => {
    const plan = buildEditList(20, [], { isOpening: true });
    assert.ok(plan.pieces[0].push, "the opening should push");
    assert.equal(plan.pieces[0].push.from, 1.0);
    assert.ok(plan.pieces[0].push.to > 1.0);
    assert.ok(plan.pieces.every((p) => p.scale === 1.0), "no punch-in framing on the opening");
  });

  test("a zero-length take reports rather than producing pieces", () => {
    const plan = buildEditList(0, []);
    assert.deepEqual(plan.pieces, []);
    assert.ok(plan.warnings.length > 0);
  });

  test("never produces a piece too short to read as a shot", () => {
    const plan = buildEditList(30, [{ start: 5, end: 5.5 }, { start: 5.6, end: 6.2 }, { start: 12, end: 14 }]);
    assert.ok(plan.pieces.every((p) => p.seconds >= MIN_PIECE_SECONDS), JSON.stringify(plan.pieces));
  });

  test("pieces never overlap and never run backwards", () => {
    const plan = buildEditList(60, [{ start: 10, end: 11 }, { start: 25, end: 27 }, { start: 40, end: 41 }]);
    for (const p of plan.pieces) assert.ok(p.srcEnd > p.srcStart, `${p.srcStart}->${p.srcEnd}`);
    for (let i = 1; i < plan.pieces.length; i++) {
      assert.ok(plan.pieces[i].srcStart >= plan.pieces[i - 1].srcEnd - 0.001, "pieces overlap");
    }
  });
});

describe("punch-in splitting", () => {
  test("a long span is broken up", () => {
    const out = splitForPunchIns({ start: 0, end: 30 });
    assert.ok(out.length >= 3);
    assert.ok(out.every((s) => s.end - s.start <= PUNCH_INTERVAL_MAX + 0.01));
  });

  test("the interval varies so the rhythm is not metronomic", () => {
    const out = splitForPunchIns({ start: 0, end: 40 });
    const lengths = out.slice(0, -1).map((s) => +(s.end - s.start).toFixed(2));
    assert.ok(new Set(lengths).size > 1, `all identical: ${lengths.join(",")}`);
  });

  test("a span inside the interval stays whole", () => {
    // Under the max there is nothing to break up. The fixture is derived from
    // the configured bounds rather than hard-coded: at the old 7-9s cadence
    // this test used 7.2s, which stopped meaning anything the moment the
    // interval moved to 3 — it was asserting "does not split" against a value
    // that no longer sits below the threshold.
    const out = splitForPunchIns({ start: 0, end: PUNCH_INTERVAL_MAX - 0.2 });
    assert.equal(out.length, 1, `${PUNCH_INTERVAL_MAX - 0.2}s should stay whole`);
  });

  test("a short remainder joins the previous piece rather than becoming a stub", () => {
    // Lengths chosen to leave a tail well under MIN_PIECE_SECONDS. The tail
    // must be absorbed: a 0.2s flash frame at the end of a take reads as a
    // decode error, not as a cut.
    for (const extra of [0.05, 0.15, 0.3]) {
      const end = PUNCH_INTERVAL_MAX * 3 + extra;
      const out = splitForPunchIns({ start: 0, end });
      assert.ok(
        out.every((s) => s.end - s.start >= MIN_PIECE_SECONDS),
        `stub piece at end=${end}: ${JSON.stringify(out.map((s) => +(s.end - s.start).toFixed(3)))}`
      );
      assert.ok(Math.abs(out[out.length - 1].end - end) < 1e-9, "the span must still be fully covered");
    }
  });

  test("the cadence follows the configured interval", () => {
    const out = splitForPunchIns({ start: 0, end: 30 });
    const lengths = out.slice(0, -1).map((s) => s.end - s.start);
    for (const l of lengths) {
      assert.ok(l >= PUNCH_INTERVAL_MIN - 0.01 && l <= PUNCH_INTERVAL_MAX + 0.01, `piece of ${l}s is outside the bounds`);
    }
    // At a 3s cadence a 30-second span is roughly ten cuts, not three.
    assert.ok(out.length >= 8, `expected a tight cadence, got ${out.length} pieces`);
  });

  test("disabled means one span", () => {
    assert.equal(splitForPunchIns({ start: 0, end: 60 }, { enabled: false }).length, 1);
  });
});

describe("piece rendering arguments", () => {
  test("seeks BEFORE the input, so the filter graph's clock is the piece's", () => {
    // THIS TEST USED TO ASSERT THE OPPOSITE, on the reasoning that output-side
    // seeking is frame-accurate and input-side seeking lands on a keyframe.
    // Modern ffmpeg seeks to the keyframe and then decodes forward to the exact
    // frame, so both are accurate — verified against a per-frame luminance
    // stamp, where the two methods land on the same source frame to the pixel.
    //
    // What output-side seeking does NOT do is move the filter graph's clock.
    // Frames are filtered on the source timeline and discarded afterwards, so
    // the declick fades — computed relative to the piece — were evaluated
    // against the source. `afade=t=out` holds silence once its ramp completes,
    // and its ramp completed before the retained window opened: every piece
    // with srcStart > 0 rendered at peak 0. Silent. Card 8 lost most of Peter's
    // voice this way, and the zoom pulses never fired off the first piece for
    // the same reason.
    //
    // See tests/yt-artifact-qc.test.mjs §7, which renders the pieces and
    // measures them rather than arguing about argument order.
    const args = pieceArgs("in.mp4", "out.mp4", { srcStart: 5, srcEnd: 9, seconds: 4, scale: 1 }, DIM);
    assert.ok(args.indexOf("-ss") < args.indexOf("-i"), "-ss must come before -i");
    assert.ok(args.indexOf("-to") < args.indexOf("-i"), "-to must come before -i");
    assert.equal(args[args.indexOf("-to") + 1], "9");
    assert.equal(args[args.indexOf("-ss") + 1], "5");
  });

  test("a tight framing CROPS rather than scaling", () => {
    // Scaling alone makes a smaller picture; cropping is what a longer lens does.
    const vf = pieceArgs("in.mp4", "out.mp4", { srcStart: 0, srcEnd: 4, seconds: 4, scale: 1.08 }, DIM).join(" ");
    assert.match(vf, /crop=iw\/1\.08:ih\/1\.08/);
  });

  test("the push is a function of the frame counter, not a constant", () => {
    const vf = pieceArgs("in.mp4", "o.mp4", { srcStart: 0, srcEnd: 4, seconds: 4, scale: 1, push: { from: 1, to: 1.08, seconds: 3.5 } }, DIM).join(" ");
    const z = /z='([^']+)'/.exec(vf)[1];
    assert.match(z, /\bon\b/, `"${z}" would be a still zoom`);
  });

  test("every piece carries the same audio format concat needs", () => {
    const args = pieceArgs("in.mp4", "o.mp4", { srcStart: 0, srcEnd: 4, seconds: 4, scale: 1 }, DIM).join(" ");
    assert.match(args, /-ar 48000/);
    assert.match(args, /-ac 2/);
    assert.match(args, /setsar=1/);
  });
});

describe("pattern-interrupt cadence", () => {
  const vo = (id, clips) => ({ kind: "voiceover", takeId: id, seconds: clips.reduce((n, c) => n + c.seconds, 0), broll: clips });

  test("an edited on-camera take is many states, not one", () => {
    const states = buildStateTimeline([
      { kind: "on_camera", takeId: "t1", seconds: 24, editPieces: [{ seconds: 8, scale: 1 }, { seconds: 8, scale: 1.08 }, { seconds: 8, scale: 1 }] },
    ]);
    assert.equal(states.length, 3);
    assert.ok(states.every((s) => s.varied));
  });

  test("a long unbroken clip is a violation", () => {
    const audit = auditCadence([vo("t1", [{ driveFileId: "a", seconds: 26 }])]);
    assert.equal(audit.ok, false);
    assert.equal(audit.violations[0].seconds, 26);
    assert.ok(audit.violations[0].remedy.length > 10, "a violation should name a remedy");
  });

  test("normal cutting passes", () => {
    const audit = auditCadence([vo("t1", [{ driveFileId: "a", seconds: 6 }, { driveFileId: "b", seconds: 6 }])]);
    assert.equal(audit.ok, true);
  });

  test("a PIP buys a longer hold, but not forever", () => {
    const withPip = { ...vo("t1", [{ driveFileId: "a", seconds: 13 }]), pip: { placement: {} } };
    assert.equal(auditCadence([withPip]).ok, true, "13s under a moving bubble is fine");
    const tooLong = { ...vo("t2", [{ driveFileId: "a", seconds: 20 }]), pip: { placement: {} } };
    assert.equal(auditCadence([tooLong]).ok, false, "20s is too long even with a bubble");
  });

  test("an uncut on-camera take is caught", () => {
    const audit = auditCadence([{ kind: "on_camera", takeId: "t1", seconds: 25 }]);
    assert.equal(audit.ok, false);
    assert.match(audit.violations[0].remedy, /silence detection/);
  });

  test("a segment with no picture is reported as such", () => {
    const audit = auditCadence([{ kind: "voiceover", takeId: "t1", seconds: 20, broll: [] }]);
    assert.equal(audit.violations[0].kind, "empty");
  });

  test("states are timestamped so a violation can be found in the file", () => {
    const audit = auditCadence([vo("t1", [{ driveFileId: "a", seconds: 5 }]), vo("t2", [{ driveFileId: "b", seconds: 5 }])]);
    assert.equal(audit.states[0].at, 0);
    assert.equal(audit.states[1].at, 5);
  });

  test("an empty plan is not a violation", () => {
    assert.equal(auditCadence([]).ok, true);
  });
});

describe("PIP placement", () => {
  test("stays clear of the burned caption band", () => {
    // Captions carry the words; if they collide, captions win.
    const p = pipPlacement(DIM);
    assert.ok(p.y + p.h <= Math.round(DIM.h * (1 - CAPTION_SAFE_BOTTOM)) + 1, `bubble bottom ${p.y + p.h}`);
    assert.equal(p.collidesWithCaptions, false);
  });

  test("alternates corners", () => {
    assert.equal(pipPlacement(DIM, { index: 0 }).corner, "right");
    assert.equal(pipPlacement(DIM, { index: 1 }).corner, "left");
    assert.equal(pipPlacement(DIM, { index: 2 }).corner, "right");
  });

  test("height stays inside the 22-28% band whatever it is asked for", () => {
    for (const share of [0.01, 0.25, 0.9]) {
      const p = pipPlacement(DIM, { heightShare: share });
      const got = p.h / DIM.h;
      assert.ok(got >= PIP_HEIGHT_MIN - 0.01 && got <= PIP_HEIGHT_MAX + 0.01, `${got}`);
    }
  });

  test("never places the bubble off-frame", () => {
    for (let i = 0; i < 4; i++) {
      const p = pipPlacement(DIM, { index: i });
      assert.ok(p.x >= 0 && p.x + p.w <= DIM.w, `x ${p.x} w ${p.w}`);
      assert.ok(p.y >= 0 && p.y + p.h <= DIM.h);
    }
  });
});

describe("PIP quality gate", () => {
  const clean = { coverage: 0.28, holeRatio: 0.01, edgeRoughness: 0.2, frames: 900 };

  test("accepts a clean matte", () => {
    assert.equal(gateCutout(clean).ok, true);
  });

  test("rejects a mask that found almost nothing", () => {
    const g = gateCutout({ ...clean, coverage: MIN_COVERAGE / 2 });
    assert.equal(g.ok, false);
    assert.match(g.reasons[0], /too little to be a person/);
  });

  test("rejects a mask that swallowed the background", () => {
    const g = gateCutout({ ...clean, coverage: MAX_COVERAGE + 0.1 });
    assert.equal(g.ok, false);
    assert.match(g.reasons[0], /background/);
  });

  test("rejects holes and ragged edges", () => {
    assert.match(gateCutout({ ...clean, holeRatio: 0.4 }).reasons[0], /holes/);
    assert.match(gateCutout({ ...clean, edgeRoughness: 0.95 }).reasons[0], /ragged/);
  });

  test("rejects missing or unreadable metrics rather than assuming the best", () => {
    assert.equal(gateCutout(null).ok, false);
    assert.equal(gateCutout({}).ok, false);
    assert.equal(gateCutout({ coverage: "lots" }).ok, false);
  });

  test("every rejection says why, in words a build summary can print", () => {
    const g = gateCutout({ ...clean, coverage: 0.01 });
    assert.ok(g.reasons.every((r) => r.length > 15), JSON.stringify(g.reasons));
  });
});

describe("PIP planning", () => {
  const vo = (id, narrationSource) => ({ kind: "voiceover", takeId: id, narrationSource });

  test("only segments he narrated himself get a bubble", () => {
    // The clone speaking means there is no footage of him saying these words.
    const { plan, skipped } = planPip([vo("a", "/tmp/a.mp4"), vo("b", null)]);
    assert.deepEqual(plan.map((p) => p.takeId), ["a"]);
    assert.match(skipped[0].reason, /cloned voice/);
  });

  test("the config flag disables it entirely, and says so", () => {
    const { plan, skipped } = planPip([vo("a", "/tmp/a.mp4")], { enabled: false });
    assert.equal(plan.length, 0);
    assert.match(skipped[0].reason, /disabled/);
  });

  test("on-camera segments are never candidates", () => {
    const { plan } = planPip([{ kind: "on_camera", takeId: "x", source: "/tmp/x.mp4" }]);
    assert.equal(plan.length, 0);
  });

  test("indices increment so corners alternate across the video", () => {
    const { plan } = planPip([vo("a", "/1.mp4"), vo("b", "/2.mp4"), vo("c", "/3.mp4")]);
    assert.deepEqual(plan.map((p) => p.index), [0, 1, 2]);
  });
});

describe("PIP compositing arguments", () => {
  test("scales the cutout to the placement and keeps alpha", () => {
    const args = pipCompositeArgs("v.mp4", "c.mov", "o.mp4", { x: 100, y: 200, w: 480, h: 270 }).join(" ");
    assert.match(args, /scale=480:270/);
    assert.match(args, /format=rgba/);
    assert.match(args, /overlay=100:200/);
  });

  test("draws a shadow underneath, offset from the cutout", () => {
    const args = pipCompositeArgs("v.mp4", "c.mov", "o.mp4", { x: 100, y: 200, w: 480, h: 270 }).join(" ");
    assert.match(args, /boxblur/);
    // The shadow overlay must be a different position from the cutout overlay.
    const positions = [...args.matchAll(/overlay=(\d+):(\d+)/g)].map((m) => `${m[1]},${m[2]}`);
    assert.equal(new Set(positions).size, 2, "shadow and cutout should not sit at the same offset");
  });

  test("copies the audio rather than re-encoding it", () => {
    assert.match(pipCompositeArgs("v.mp4", "c.mov", "o.mp4", { x: 0, y: 0, w: 10, h: 10 }).join(" "), /-c:a copy/);
  });
});

describe("audio-only narration and the PIP", () => {
  test("an audio-only take is named as such, not 'could not open'", async () => {
    // Video 1's real voiceover takes were .m4a voice memos. The report must
    // say the fix is a recording choice, not a broken file.
    const { execFileSync } = await import("child_process");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const { segmentTake } = await import("../src/yt-pip.js");
    const m4a = join(tmpdir(), `audio-only-${Date.now()}.m4a`);
    execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=220:duration=2", "-c:a", "aac", m4a], { stdio: ["pipe", "pipe", "pipe"] });
    const r = segmentTake(m4a, join(tmpdir(), "never-written.mov"));
    assert.equal(r.ok, false);
    assert.equal(r.audioOnly, true, `expected the audio-only verdict, got: ${r.reason}`);
    assert.match(r.reason, /audio-only/);
    assert.match(r.reason, /video/i, "the reason must say what recording choice fixes it");
  });
});

describe("the vertical blur-fill treatment", () => {
  const piece = { srcStart: 0, srcEnd: 4, seconds: 4, scale: 1.0, push: null };

  test("blur-fill is the default and composes fg over blurred bg", () => {
    const args = pieceArgs("in.mp4", "o.mp4", piece, DIM).join(" ");
    assert.match(args, /-filter_complex/);
    assert.match(args, /gblur=sigma=/);
    assert.match(args, /overlay=\(W-w\)\/2:0/, "the take must be centered");
    assert.match(args, /scale=-2:1080/, "the take must fill the full height");
  });

  test("the gold vignette sits on the background only, and 0 disables it", () => {
    const withV = pieceArgs("in.mp4", "o.mp4", piece, DIM, { treatment: { mode: "blur-fill", blur: 24, darken: 0.4, bgZoom: 1.1, vignette: 0.35 } }).join(" ");
    assert.match(withV, /vignette=angle/);
    assert.match(withV, /colorbalance=rs=0\.028/, "warm shift scales with the knob");
    const noV = pieceArgs("in.mp4", "o.mp4", piece, DIM, { treatment: { mode: "blur-fill", blur: 24, darken: 0.4, bgZoom: 1.1, vignette: 0 } }).join(" ");
    assert.ok(!/vignette=angle/.test(noV), "vignette 0 must remove the filter entirely");
  });

  test("pillarbox mode remains the escape hatch", () => {
    const args = pieceArgs("in.mp4", "o.mp4", piece, DIM, { treatment: { mode: "pillarbox" } }).join(" ");
    assert.match(args, /pad=1920:1080/);
    assert.ok(!/gblur/.test(args));
  });

  test("the punch-in crops the SOURCE, before composition", () => {
    // Cropping after composition would zoom the blurred background too — a
    // digital zoom, not a second camera.
    const args = pieceArgs("in.mp4", "o.mp4", { ...piece, scale: 1.08 }, DIM).join(" ");
    const graph = /-filter_complex (\S+)/.exec(args)[1];
    assert.ok(graph.indexOf("crop=iw/1.08") < graph.indexOf("split"), "punch crop must precede the fg/bg split");
  });

  test("the push rides the COMPOSED frame and varies with the frame counter", () => {
    const args = pieceArgs("in.mp4", "o.mp4", { ...piece, push: { from: 1, to: 1.08, seconds: 3.5 } }, DIM).join(" ");
    assert.match(args, /zoompan=z='1\+0\.08\*sin/);
    assert.match(args, /\bon\b/, "a constant zoom is a still — that mistake shipped once");
  });

  test("audio is mapped through the filter graph", () => {
    // filter_complex drops implicit stream mapping; without -map 0:a? every
    // edited take would go silent. Optional-mapped because a video-only
    // fixture must not fail the render.
    const args = pieceArgs("in.mp4", "o.mp4", piece, DIM);
    const i = args.indexOf("-map");
    assert.ok(i > 0 && args.slice(i).join(" ").includes("0:a?"), "audio map missing");
    assert.match(args.join(" "), /-ar 48000/);
  });
});
