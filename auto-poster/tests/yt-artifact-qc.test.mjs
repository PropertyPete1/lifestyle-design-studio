/**
 * yt-artifact-qc.test.mjs — the checks are proved by making them fail.
 *
 * EVERY CHECK HERE IS TESTED TWICE: once on material that should pass and once
 * on material built to break it. The second half is the half that matters. A
 * check that has only ever returned `ok: true` is indistinguishable from
 * `return { ok: true }`, and this repo has shipped that exact shape before — a
 * whole retention feature set wired into assembler branches nothing fed, all
 * machinery green, zero effect on the video.
 *
 * So these tests render real files with ffmpeg and measure them. They are slower
 * than the rest of the suite and that is the price of the checks being real.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkAudioLevels, checkJoinClicks, checkMotion, checkOverlayText, checkDuration,
  speechWindows, decodePcm, rmsDb, ocrAvailable, ocrNormalise, runArtifactQc,
  preserveFailedRender, timestamp,
} from "../src/yt-artifact-qc.js";
import { assertRenderableText, describeTextProblem, isRenderableText } from "../src/yt-text-safety.js";
import { punchSvg, renderPunchPng, punchCandidatesFor, selectPunches, PUNCH_CLASS } from "../src/yt-punch.js";
import { pieceArgs, pieceExtension } from "../src/yt-oncamera-edit.js";
import { programmeGainDb, bedRelativeGainDb, parseLoudnessJson, duckArgs, levelProgrammeArgs, concatArgs, muxNarrationArgs, segmentDeclickArgs } from "../src/yt-assemble.js";

const ff = (args) => execFileSync("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
const have = (bin) => !spawnSync(bin, ["-version"], { encoding: "utf-8" }).error;

let dir;
before(() => { dir = mkdtempSync(join(tmpdir(), "yt-qc-test-")); });
after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

/**
 * A stand-in for narration: bursts of noise with real gaps between them, so
 * silencedetect has something to find. Speech is what this has to look like to
 * the check, and "band-limited energy with pauses in it" is that.
 */
function makeVoice(path, { seconds = 12, db = -20 } = {}) {
  // Three 3-second bursts separated by 1-second gaps.
  const gate = "between(t,0,3)+between(t,4,7)+between(t,8,11)";
  ff(["-y", "-v", "error",
    "-f", "lavfi", "-i", `anoisesrc=d=${seconds}:c=pink:a=0.9:r=48000`,
    "-af", `volume='(${gate})':eval=frame,lowpass=f=3400,highpass=f=200,volume=${db}dB,` +
           `aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=stereo`,
    "-c:a", "pcm_s16le", path]);
}

/** A continuous bed at a chosen level. */
function makeBed(path, { seconds = 12, db = -40 } = {}) {
  ff(["-y", "-v", "error",
    "-f", "lavfi", "-i", `sine=frequency=220:duration=${seconds}:sample_rate=48000`,
    "-af", `volume=${db}dB,aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=stereo`,
    "-c:a", "pcm_s16le", path]);
}

// ─── 1. the audio-level check ───────────────────────────────────────────────

describe("1. music is measured against the voice in every speech window", () => {
  test("speech windows come from the FILE, not from any plan", (t) => {
    if (!have("ffmpeg")) return t.skip("ffmpeg not installed");
    const voice = join(dir, "v1.wav");
    makeVoice(voice);
    const w = speechWindows(voice, { duration: 12 });
    // Three bursts in, three windows out — and nothing was told where they were.
    assert.equal(w.length, 3, `expected 3 speech windows, got ${JSON.stringify(w)}`);
    assert.ok(Math.abs(w[0].start - 0) < 0.3, `first window starts at ${w[0].start}`);
    assert.ok(Math.abs(w[1].start - 4) < 0.3, `second window starts at ${w[1].start}`);
    assert.ok(Math.abs(w[2].start - 8) < 0.3, `third window starts at ${w[2].start}`);
  });

  test("a bed sitting properly under the voice PASSES", (t) => {
    if (!have("ffmpeg")) return t.skip("ffmpeg not installed");
    const voice = join(dir, "v2.wav");
    const bed = join(dir, "b2.wav");
    makeVoice(voice, { db: -20 });
    makeBed(bed, { db: -45 });          // 25 dB under, comfortably clear
    const r = checkAudioLevels({ voicePath: voice, bedPath: bed, duration: 12, margin: 10 });
    assert.ok(r.ok, `should pass: ${JSON.stringify(r.failures, null, 1)}`);
    assert.ok(r.stats.measured >= 3, `it must actually have measured windows: ${JSON.stringify(r.stats)}`);
    assert.ok(r.stats.tightest.margin > 10, `tightest margin ${r.stats.tightest.margin}`);
  });

  test("A DELIBERATELY OVER-LOUD BED FAILS, and the failure carries the timestamp", (t) => {
    if (!have("ffmpeg")) return t.skip("ffmpeg not installed");
    const voice = join(dir, "v3.wav");
    const bed = join(dir, "b3.wav");
    makeVoice(voice, { db: -20 });
    makeBed(bed, { db: -22 });          // 2 dB under the voice — this is the defect
    const r = checkAudioLevels({ voicePath: voice, bedPath: bed, duration: 12, margin: 10 });

    assert.equal(r.ok, false, "an over-loud bed must fail the build");
    assert.ok(r.failures.length >= 3, `every speech window is covered: ${r.failures.length}`);
    // THE TIMESTAMP IS THE DELIVERABLE. A failure that says "the music is too
    // loud somewhere in twelve minutes" costs a full scrub to act on.
    for (const f of r.failures) {
      assert.ok(Number.isFinite(f.at), `each failure names a time: ${JSON.stringify(f)}`);
      assert.match(f.reason, /\d+:\d\d\.\d/, `the reason contains a readable timestamp: ${f.reason}`);
      assert.match(f.reason, /dB under the voice/);
    }
    assert.ok(r.failures.some((f) => f.at < 4), "the first burst is one of them");
  });

  test("a bed exactly at the margin passes and one a hair over it does not", (t) => {
    if (!have("ffmpeg")) return t.skip("ffmpeg not installed");
    const voice = join(dir, "v4.wav");
    makeVoice(voice, { db: -20 });
    const at = (bedDb) => {
      const bed = join(dir, `b4-${Math.abs(bedDb)}.wav`);
      makeBed(bed, { db: bedDb });
      return checkAudioLevels({ voicePath: voice, bedPath: bed, duration: 12, margin: 10 });
    };
    // The voice measures a few dB below its nominal level because it is gated
    // noise, so these are checked as a PAIR rather than against an absolute:
    // whatever the voice measures, 20 dB down passes and 4 dB down does not.
    assert.ok(at(-40).ok, "20 dB of separation is clear");
    assert.equal(at(-24).ok, false, "4 dB of separation is not");
  });

  test("no bed is an honest skip, but a MISSING bed file is a failure", () => {
    const none = checkAudioLevels({ voicePath: "/nope.wav", bedPath: null, duration: 10 });
    assert.ok(none.ok);
    assert.match(none.skipped, /no music bed/);

    // The difference that matters: "there is no music" is provable, "the file we
    // were going to measure is gone" is nobody having looked.
    const gone = checkAudioLevels({ voicePath: "/nope.wav", bedPath: "/also-nope.wav", duration: 10 });
    assert.equal(gone.ok, false);
    assert.match(gone.failures[0].reason, /Nobody looked/);
  });
});

// ─── 2. join clicks ─────────────────────────────────────────────────────────

describe("2. a splice that clicks is caught in the finished audio", () => {
  test("clean speech has no clicks in it", (t) => {
    if (!have("ffmpeg")) return t.skip("ffmpeg not installed");
    const voice = join(dir, "c1.wav");
    makeVoice(voice, { db: -20 });
    const r = checkJoinClicks({ path: voice });
    assert.ok(r.ok, `clean audio must pass: ${JSON.stringify(r.failures, null, 1)}`);
  });

  test("A PLANTED DISCONTINUITY FAILS, and names when it happens", (t) => {
    if (!have("ffmpeg")) return t.skip("ffmpeg not installed");
    // A PHASE DISCONTINUITY, which is what an undeclicked join actually is: the
    // first tone ends at zero and the second starts at full amplitude, so the
    // waveform steps in a single sample.
    //
    // Inverting the second tone instead does NOT work and the reason is worth
    // recording — a sine and its inverse are both zero at the splice, so the
    // join is perfectly continuous and there is no click to find. The first
    // version of this test did that and passed for the wrong reason.
    const a = join(dir, "click-a.wav");
    const b = join(dir, "click-b.wav");
    const spliced = join(dir, "clicked.wav");
    ff(["-y", "-v", "error", "-f", "lavfi", "-i", "aevalsrc=0.7*sin(2*PI*440*t):d=1:s=48000", "-c:a", "pcm_s16le", a]);
    ff(["-y", "-v", "error", "-f", "lavfi", "-i", "aevalsrc=0.7*cos(2*PI*440*t):d=1:s=48000", "-c:a", "pcm_s16le", b]);
    const list = join(dir, "click-list.txt");
    writeFileSync(list, [a, b].map((p) => `file '${p}'`).join("\n"));
    ff(["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", spliced]);

    const r = checkJoinClicks({ path: spliced });
    assert.equal(r.ok, false, "a hard splice must be caught");
    assert.ok(r.failures.some((f) => Math.abs(f.at - 1.0) < 0.05),
      `the click is at 1.0s: ${JSON.stringify(r.failures)}`);
    assert.match(r.failures[0].reason, /declick did not land/);
  });
});

// ─── 3. frame-step motion ───────────────────────────────────────────────────

describe("3. a picture that steps instead of moving is caught", () => {
  test("real motion passes", (t) => {
    if (!have("ffmpeg")) return t.skip("ffmpeg not installed");
    const moving = join(dir, "moving.mp4");
    ff(["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30:duration=12",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", moving]);
    const r = checkMotion({ path: moving, duration: 12 });
    assert.ok(r.ok, `a moving picture must pass: ${JSON.stringify(r.failures, null, 1)}`);
  });

  test("A CLIP DRAWN AT 5FPS INSIDE A 30FPS ENCODE FAILS — the 'laggy' defect", (t) => {
    if (!have("ffmpeg")) return t.skip("ffmpeg not installed");
    // Drawn at 5fps then resampled to 30: every frame held for six. This is
    // exactly what revision 8's graphics did.
    const stepped = join(dir, "stepped.mp4");
    ff(["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=5:duration=12",
        "-vf", "fps=30", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", stepped]);
    const r = checkMotion({ path: stepped, duration: 12 });
    assert.equal(r.ok, false, "a stepped picture must fail");
    assert.ok(r.failures.length > 0);
    assert.match(r.failures[0].reason, /stepping, not moving/);
    assert.ok(r.stats.overallRatio > 0.5, `most frames are duplicates: ${r.stats.overallRatio}`);
  });
});

// ─── 4. OCR on the overlays ─────────────────────────────────────────────────

describe("4. the on-screen text is read back off the picture", () => {
  /**
   * Burn one plate over black, the way burnArgs composites it.
   *
   * Rasterised with sharp rather than by handing ffmpeg the SVG — ffmpeg is
   * built without an SVG decoder on plenty of machines, including this
   * developer's, and the pipeline itself goes through sharp for exactly the
   * same reason. The test should exercise the path the render uses.
   */
  async function renderPlate(text, out, { seconds = 3 } = {}) {
    const png = join(dir, `plate-${Buffer.from(text).toString("hex").slice(0, 12)}.png`);
    writeFileSync(png, await renderPunchPng(text, { w: 1280, h: 720 }));
    ff(["-y", "-v", "error",
        "-f", "lavfi", "-i", `color=c=black:s=1280x720:r=30:d=${seconds}`,
        "-i", png,
        "-filter_complex", "[0:v][1:v]overlay=0:0[v]",
        "-map", "[v]", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", out]);
    return out;
  }

  /** The same, for a string punchSvg would (correctly) refuse to draw. */
  async function renderRawText(svgText, out, { seconds = 3 } = {}) {
    const png = join(dir, "raw-plate.png");
    const sharp = (await import("sharp")).default;
    writeFileSync(png, await sharp(Buffer.from(svgText)).png().toBuffer());
    ff(["-y", "-v", "error", "-loop", "1", "-i", png, "-t", String(seconds),
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-r", "30", out]);
    return out;
  }

  test("a plate that says what the punch list says PASSES", async (t) => {
    if (!have("ffmpeg") || !ocrAvailable()) return t.skip("ffmpeg or tesseract not installed");
    const v = await renderPlate("$4,500", join(dir, "ocr-ok.mp4"));
    const r = checkOverlayText({
      videoPath: v,
      punches: [{ at: 0.5, seconds: 2, text: "$4,500" }],
      workDir: dir,
    });
    assert.ok(r.ok, `should pass: ${JSON.stringify(r.failures, null, 1)}`);
    assert.equal(r.stats.read, 1, "it actually read the frame");
  });

  test("A PLANTED PLACEHOLDER FAILS — the template reached pixels and the check saw it", async (t) => {
    if (!have("ffmpeg") || !ocrAvailable()) return t.skip("ffmpeg or tesseract not installed");
    // punchSvg refuses this now, so the plate is drawn by going AROUND the
    // guard — which is the honest test. The question this check answers is
    // "what if something drew it anyway", and the answer has to come from the
    // pixels rather than from the guard that was bypassed.
    const v = await renderRawText(
      `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">` +
      `<rect width="1280" height="720" fill="#ffffff"/>` +
      `<text x="640" y="380" text-anchor="middle" ` +
      `font-family="DejaVu Sans, Arial, sans-serif" font-size="120" font-weight="700" fill="#000000">{{PRICE}}</text></svg>`,
      join(dir, "ocr-placeholder.mp4")
    );

    const r = checkOverlayText({
      videoPath: v,
      punches: [{ at: 0.5, seconds: 2, text: "$4,500" }],
      workDir: dir,
    });
    assert.equal(r.ok, false, "a placeholder on screen must fail the build");
    assert.ok(r.failures.length > 0);
    // Either route is a pass for this test: the braces are recognised as a
    // template, or the reading simply is not the punch. Both stop the build,
    // and which one fires depends on how cleanly tesseract reads a brace.
    assert.match(
      r.failures[0].reason,
      /unrenderable text|does not say what the punch list says/,
      `the failure must name the problem: ${r.failures[0].reason}`
    );
  });

  test("A BLANK WINDOW FAILS — a plate that did not render is not a pass", (t) => {
    if (!have("ffmpeg") || !ocrAvailable()) return t.skip("ffmpeg or tesseract not installed");
    // This is the `setpts` bug from burnArgs' own comment: the plate faded out
    // before its window opened and the punch rendered as nothing at all.
    const blank = join(dir, "ocr-blank.mp4");
    ff(["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=1280x720:r=30:d=3",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", blank]);
    const r = checkOverlayText({
      videoPath: blank,
      punches: [{ at: 0.5, seconds: 2, text: "$4,500" }],
      workDir: dir,
    });
    assert.equal(r.ok, false, "an empty punch window must fail");
    assert.match(r.failures[0].reason, /nothing is on screen|does not say what/);
  });

  test("missing tesseract FAILS the check rather than skipping it", () => {
    const r = checkOverlayText({
      videoPath: "/whatever.mp4",
      punches: [{ at: 1, seconds: 2, text: "$0" }],
      workDir: dir,
      run: () => ({ error: new Error("ENOENT"), status: 127 }),
    });
    assert.equal(r.ok, false, "an unread overlay is not a clean overlay");
    assert.match(r.failures[0].reason, /never read/);
  });

  test("no punches is an honest skip", () => {
    const r = checkOverlayText({ videoPath: "/x.mp4", punches: [], workDir: dir });
    assert.ok(r.ok);
    assert.match(r.skipped, /no punch overlays/);
  });
});

// ─── 5. the gate itself ─────────────────────────────────────────────────────

describe("5. the gate refuses to pass what it could not check", () => {
  test("a check that throws is a failure, never a pass", () => {
    const r = runArtifactQc({
      videoPath: "/does-not-exist.mp4",
      duration: 10,
      qcInputs: {},
      workDir: dir,
      log: () => {},
    });
    assert.equal(r.ok, false);
    assert.ok(r.failures.length > 0, "a missing file cannot produce a clean report");
  });

  test("every failure carries which check found it", () => {
    const r = runArtifactQc({ videoPath: "/nope.mp4", duration: 10, qcInputs: {}, workDir: dir, log: () => {} });
    for (const f of r.failures) assert.ok(f.check, `each failure names its check: ${JSON.stringify(f)}`);
  });

  test("timestamps are scrubber-ready", () => {
    assert.equal(timestamp(0), "0:00.0");
    assert.equal(timestamp(71.5), "1:11.5");
    assert.equal(timestamp(3671.5), "1:01:11.5");
  });
});

// ─── 5b. the render is the length the plan asked for ────────────────────────

describe("5b. a render that stopped matching its plan is caught", () => {
  test("a render within tolerance passes", () => {
    const r = checkDuration({ actualSeconds: 668, plannedSeconds: 671.8, segments: [] });
    assert.ok(r.ok, `4s short of an 11-minute plan is codec rounding: ${JSON.stringify(r.failures)}`);
    assert.equal(r.stats.driftSeconds, -3.8);
  });

  test("THE 2026-08-12 RENDER FAILS, with the number in the message", () => {
    // The actual figures from run 31631297976. This check did not exist, so the
    // one sentence that described the defect was never printed — it was inferred
    // afterwards from ninety-five duplicate-frame reports, which are the symptom
    // two steps downstream.
    const r = checkDuration({
      actualSeconds: 1231.2,
      plannedSeconds: 671.8,
      segments: [
        { takeId: "s1t1", kind: "on_camera", planned: 16.7, measured: 16.7 },
        { takeId: "s1t2", kind: "voiceover", planned: 21.4, measured: 58.9 },
        { takeId: "s1t3", kind: "voiceover", planned: 18.2, measured: 46.1 },
      ],
    });
    assert.equal(r.ok, false);
    assert.match(r.failures[0].reason, /20\.5 min against a 11\.2 min plan/);
    assert.match(r.failures[0].reason, /\+559s \(83\.3%\)/);
    // THE SEGMENT TABLE IS THE DIAGNOSIS. "The voiceover segments are the ones
    // that overran" is very nearly the fix, and it is the difference between
    // this and another fifty-five minute bisect.
    assert.match(r.failures[0].reason, /s1t2 \(voiceover\) planned 21\.40s, rendered 58\.90s/);
    assert.ok(!/s1t1/.test(r.failures[0].reason), "a segment that matched its plan is not named");
  });

  test("a render SHORT of its plan fails too — a lost segment is not a pass", () => {
    const r = checkDuration({ actualSeconds: 400, plannedSeconds: 671.8, segments: [] });
    assert.equal(r.ok, false);
    assert.match(r.failures[0].reason, /-272s/);
  });

  test("no plan to compare against is a failure, not a skip", () => {
    const r = checkDuration({ actualSeconds: 600, plannedSeconds: null });
    assert.equal(r.ok, false);
    assert.match(r.failures[0].reason, /nobody looked/);
  });

  test("an unreadable render is a failure", () => {
    const r = checkDuration({ actualSeconds: 0, plannedSeconds: 671.8 });
    assert.equal(r.ok, false);
    assert.match(r.failures[0].reason, /ffprobe could not read it/);
  });

  test("duration is checked FIRST, so the cause is read before the symptoms", () => {
    const r = runArtifactQc({ videoPath: "/nope.mp4", duration: 10, qcInputs: {}, workDir: dir, log: () => {} });
    assert.equal(r.results[0].name, "duration");
  });
});

// ─── 5c. the evidence survives the failure ──────────────────────────────────

describe("5c. a render that fails its checks is kept", () => {
  test("THE RENDER AND THE REPORT BOTH SURVIVE", (t) => {
    if (!have("ffmpeg")) return t.skip("ffmpeg not installed");
    const keepDir = join(dir, "kept");
    const render = join(dir, "to-keep.mp4");
    ff(["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=30:d=1",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", render]);

    const qc = { ok: false, results: [{ name: "duration", ok: false, failures: [{ reason: "too long" }] }], failures: [{ check: "duration", reason: "too long" }] };
    const kept = preserveFailedRender({ videoPath: render, qc, plan: { plannedSeconds: 671.8 }, dir: keepDir, log: () => {} });

    assert.ok(kept.video && existsSync(kept.video), "the render itself is kept");
    assert.ok(kept.report && existsSync(kept.report), "the report is kept");
    assert.deepEqual(kept.errors, []);

    const report = JSON.parse(readFileSync(kept.report, "utf-8"));
    assert.equal(report.ok, false);
    assert.equal(report.plan.plannedSeconds, 671.8);
    assert.equal(report.failures[0].check, "duration");
    assert.ok(report.failedAt, "the report is dated");
  });

  test("the ORIGINAL is not moved — preserving must not disturb the render", (t) => {
    if (!have("ffmpeg")) return t.skip("ffmpeg not installed");
    assert.ok(existsSync(join(dir, "to-keep.mp4")), "the source file is still where the pipeline left it");
  });

  test("a preservation that cannot happen REPORTS rather than throwing", () => {
    // This runs on the way to throwing an error that already says what is
    // wrong. Throwing here would replace a useful failure with a confusing one.
    const kept = preserveFailedRender({
      videoPath: "/does/not/exist.mp4",
      qc: { ok: false, results: [], failures: [] },
      dir: join(dir, "kept2"),
      log: () => {},
    });
    assert.equal(kept.video, null);
    assert.ok(kept.errors.some((e) => /already gone/.test(e)));
    // The report still lands, because the failure list is worth keeping even
    // when the file is not.
    assert.ok(kept.report && existsSync(kept.report));
  });
});

// ─── 6. text that cannot be drawn ───────────────────────────────────────────

describe("6. an unsubstituted template crashes rather than rendering", () => {
  const templates = [
    "{{PRICE}}", "${amount}", "<% total %>", "[[NAME]]", "%(city)s",
    "{unclosed", "<NEIGHBORHOOD>", "undefined", "null", "   ", "",
  ];
  for (const bad of templates) {
    test(`"${bad}" cannot be drawn`, () => {
      assert.throws(() => assertRenderableText(bad, "a test"), /not renderable/);
      assert.equal(isRenderableText(bad), false);
    });
  }

  const fine = ["$4,500", "100%", "MONTH NINE", "10 minutes", "a < b", "he said \"no\"", "3–5 years"];
  for (const good of fine) {
    test(`"${good}" draws normally`, () => {
      assert.equal(describeTextProblem(good), null, `${good} should be renderable`);
      assert.equal(assertRenderableText(good, "a test"), good);
    });
  }

  test("the error says what the value was, so the fix does not need another build", () => {
    try {
      assertRenderableText("{{PRICE}}", "a micro-punch plate");
      assert.fail("should have thrown");
    } catch (err) {
      assert.match(err.message, /a micro-punch plate/);
      assert.match(err.message, /\{\{PRICE\}\}/);
      assert.match(err.message, /substitution failure/);
    }
  });

  test("punchSvg refuses a template instead of drawing its insides", () => {
    assert.throws(() => punchSvg("{{PRICE}}", { w: 1920, h: 1080 }), /not renderable/);
  });

  test("a caption chunk containing a template stops the build", async () => {
    const { buildAssFile } = await import("../src/yt-assemble.js");
    assert.throws(
      () => buildAssFile([{ start: 0, end: 2, text: "the fee is {{PRICE}} at closing" }], { w: 1920, h: 1080 }),
      /not renderable/,
      "escapeAss used to strip the braces and render PRICE as though it were a word"
    );
  });
});

// ─── 7. the seek that silenced the takes ────────────────────────────────────

describe("7. every piece of an on-camera take keeps its audio", () => {
  test("A PIECE FROM THE MIDDLE OF A TAKE IS NOT SILENT", (t) => {
    if (!have("ffmpeg")) return t.skip("ffmpeg not installed");
    // THE CARD 8 DEFECT, MEASURED RATHER THAN ARGUED. With the seek after -i,
    // pieces 1 and 2 here came out at peak 0 — the declick's fade-out ran on
    // the source clock, completed before the retained window opened, and afade
    // holds silence forever afterwards.
    const take = join(dir, "take.mp4");
    ff(["-y", "-v", "error",
        "-f", "lavfi", "-i", "testsrc=size=320x568:rate=30:duration=10",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=10:sample_rate=48000",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-ar", "48000", "-ac", "2", "-shortest", take]);

    const dim = { w: 640, h: 360 };
    const peaks = [];
    [
      { srcStart: 0, srcEnd: 3, seconds: 3, scale: 1.0 },
      { srcStart: 3, srcEnd: 6, seconds: 3, scale: 1.08 },
      { srcStart: 6, srcEnd: 9, seconds: 3, scale: 1.0 },
    ].forEach((piece, i) => {
      const out = join(dir, `piece${i}.${pieceExtension()}`);
      ff(pieceArgs(take, out, piece, dim, { fps: 30 }));
      const s = decodePcm(out);
      // The middle of the piece, clear of both declick ramps.
      peaks.push(rmsDb(s, 48000 * 1.0, 48000 * 2.0));
    });

    for (const [i, db] of peaks.entries()) {
      assert.ok(Number.isFinite(db) && db > -40,
        `piece ${i} is silent (${db} dBFS) — the seek is on the wrong side of -i again`);
    }
    // And they are all at the SAME level, which is the positive claim: the take
    // sounds continuous across its own cuts.
    const spread = Math.max(...peaks) - Math.min(...peaks);
    assert.ok(spread < 3, `pieces differ by ${spread.toFixed(1)} dB: ${peaks.map((p) => p.toFixed(1))}`);
  });

  test("THE AUDIO DOES NOT WALK BEHIND THE PICTURE ACROSS THE JOINS", (t) => {
    if (!have("ffmpeg")) return t.skip("ffmpeg not installed");
    // An impulse 1.5s into each of four 3-second pieces. Concatenated, the four
    // markers must land at 1.5, 4.5, 7.5 and 10.5 — anywhere else is the audio
    // sliding against the video, which no duration check can see because the
    // video stream stays exactly right.
    //
    // With an AAC encode per piece they landed at 1.5214, 4.5507, 7.5801 and
    // 10.6094: a 21.3 ms priming frame at the head of every piece, stacked by
    // the concat demuxer into 29.3 ms per join. Card 8 cut twelve takes into
    // seventy-six pieces, so that is close to two seconds of lip-sync error by
    // the close of the video.
    const src = join(dir, "marked.mp4");
    ff(["-y", "-v", "error",
        "-f", "lavfi", "-i", "testsrc=size=320x568:rate=30:duration=12",
        "-f", "lavfi", "-i",
        "aevalsrc=0.9*sin(2*PI*900*t)*if(lt(mod(t+1.5\\,3)\\,0.004)\\,1\\,0)+0.05*sin(2*PI*200*t):d=12:s=48000",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-ar", "48000", "-ac", "2", "-shortest", src]);

    const ext = pieceExtension();
    const files = [[0, 3], [3, 6], [6, 9], [9, 12]].map(([a, b], i) => {
      const out = join(dir, `mp${i}.${ext}`);
      ff(pieceArgs(src, out, { srcStart: a, srcEnd: b, seconds: b - a, scale: 1.0 }, { w: 640, h: 360 }, { fps: 30 }));
      return out;
    });
    const list = join(dir, "mp.txt");
    writeFileSync(list, files.map((p) => `file '${p}'`).join("\n"));
    const joinedPath = join(dir, `mpcat.${ext}`);
    ff(concatArgs(list, joinedPath));

    const s = decodePcm(joinedPath);
    const markers = [];
    for (let i = 0; i < s.length; i++) {
      if (Math.abs(s[i]) > 6000) { markers.push(i / 48000); i += 48000; }
    }
    assert.equal(markers.length, 4, `four markers, one per piece: ${JSON.stringify(markers)}`);
    markers.forEach((m, i) => {
      const ideal = 1.5 + i * 3;
      assert.ok(Math.abs(m - ideal) < 0.01,
        `marker ${i} is ${((m - ideal) * 1000).toFixed(1)} ms off (${m} vs ${ideal}) — the joins are accumulating an offset`);
    });
  });

  test("the declick still lands, at both edges of every piece", (t) => {
    if (!have("ffmpeg")) return t.skip("ffmpeg not installed");
    const s = decodePcm(join(dir, `piece1.${pieceExtension()}`));
    const edge = rmsDb(s, 0, 48000 * 0.004);
    const body = rmsDb(s, 48000 * 1.0, 48000 * 1.1);
    assert.ok(edge < body - 6, `the piece opens on a fade: edge ${edge.toFixed(1)} vs body ${body.toFixed(1)}`);
  });
});

// ─── 7b. the voiceover picture is bounded by its narration ──────────────────

describe("7b. a segment is the length the plan allocated it", () => {
  before(() => {
    if (!have("ffmpeg")) return;
    // A 12s picture and 8s of narration against a 5s allocation.
    ff(["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30:duration=12",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-an", join(dir, "vo-picture.mp4")]);
    ff(["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=8:sample_rate=48000",
        "-c:a", "pcm_s16le", join(dir, "vo-narration.wav")]);
  });

  const durationOf = (f) => Number.parseFloat(execFileSync("ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f], { encoding: "utf-8" }).trim());

  test("A NARRATION LONGER THAN ITS ALLOCATION DOES NOT STRETCH THE SEGMENT", (t) => {
    if (!have("ffmpeg")) return t.skip("ffmpeg not installed");
    // THE PROPERTY THAT MATTERS, and the one -shortest does not provide.
    // Captions are laid out from seg.seconds, so a segment that renders longer
    // than its allocation drifts every caption after it for the rest of the
    // video. Reachable under YT_NARRATION_MODE=peter: generateNarration only
    // updates seg.seconds from audio it GENERATED, and it skips every take that
    // already carries Peter's own recording.
    const out = join(dir, "vo-bounded.mp4");
    ff(muxNarrationArgs(join(dir, "vo-picture.mp4"), join(dir, "vo-narration.wav"), out, { seconds: 5 }));
    assert.ok(Math.abs(durationOf(out) - 5) < 0.2,
      `the segment must be its 5s allocation, not its 8s narration: got ${durationOf(out)}s`);
  });

  test("-shortest alone gives the narration's length, which is the gap -t closes", (t) => {
    if (!have("ffmpeg")) return t.skip("ffmpeg not installed");
    // The control that establishes -t is doing something. -shortest DOES work
    // under -c:v copy — it correctly ends a 12s picture at 5s of narration —
    // it just answers a different question from "how long is this segment
    // supposed to be".
    const out = join(dir, "vo-unbounded.mp4");
    ff(muxNarrationArgs(join(dir, "vo-picture.mp4"), join(dir, "vo-narration.wav"), out));
    assert.ok(durationOf(out) > 7,
      `without -t the segment takes the narration's length: got ${durationOf(out)}s`);
  });

  test("a picture SHORTER than its narration is still ended by -shortest", (t) => {
    if (!have("ffmpeg")) return t.skip("ffmpeg not installed");
    // -t is a ceiling; this is the floor it does not cover. A picture that ran
    // out early would otherwise freeze its last frame to fill the gap.
    const shortPic = join(dir, "vo-short.mp4");
    ff(["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30:duration=3",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-an", shortPic]);
    const out = join(dir, "vo-floor.mp4");
    ff(muxNarrationArgs(shortPic, join(dir, "vo-narration.wav"), out, { seconds: 5 }));
    assert.ok(durationOf(out) < 4, `the segment ends with the picture: got ${durationOf(out)}s`);
  });

  test("renderTimeline hands the allocation through", () => {
    const a = muxNarrationArgs("p.mp4", "n.wav", "o.mp4", { seconds: 12.5 });
    assert.equal(a[a.indexOf("-t") + 1], "12.5");
    assert.ok(a.includes("-shortest"), "the floor stays");
  });
});

// ─── 7c. the zoom does not stretch the piece ────────────────────────────────

describe("7c. a piece with a camera move is the length it was cut to", () => {
  /**
   * A 60fps SOURCE, WHICH IS THE POINT OF THIS SUITE.
   *
   * Peter's takes are 4K60 phone footage. Every earlier fixture in this file is
   * 30fps, and at 30fps this defect does not appear at all — which is exactly
   * why four hypotheses were tested and cleared while the real render was
   * inflating 83%. The rate of the fixture was the bug's hiding place.
   */
  before(() => {
    if (!have("ffmpeg")) return;
    ff(["-y", "-v", "error",
        "-f", "lavfi", "-i", "testsrc=size=540x960:rate=60:duration=12",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=12:sample_rate=48000",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-ar", "48000", "-ac", "2", "-shortest", join(dir, "src60.mp4")]);
  });

  const render = (piece, name) => {
    const out = join(dir, `${name}.${pieceExtension()}`);
    ff(pieceArgs(join(dir, "src60.mp4"), out, piece, { w: 1920, h: 1080 }, { fps: 30 }));
    return out;
  };
  const frames = (f) => Number.parseInt(execFileSync("ffprobe",
    ["-v", "error", "-count_frames", "-select_streams", "v:0",
     "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", f], { encoding: "utf-8" }).trim(), 10);

  test("THE OPENING PUSH DOES NOT INFLATE THE PIECE", (t) => {
    if (!have("ffmpeg")) return t.skip("ffmpeg not installed");
    // With `fps` inside zoompan instead of ahead of it, this rendered 1536.000s
    // and 46080 frames — 512 output frames per input frame. Every on-camera
    // piece carrying a push or a pulse had been doing that since the retention
    // edit shipped; output-side seeking trimmed it back to the right duration
    // and hid it as slow motion.
    const out = render({ srcStart: 0, srcEnd: 3, seconds: 3, scale: 1.0, push: { from: 1.0, to: 1.08, seconds: 3 } }, "zoom-push");
    assert.equal(frames(out), 90, "3 seconds at 30fps");
  });

  test("A ZOOM PULSE DOES NOT INFLATE THE PIECE", (t) => {
    if (!have("ffmpeg")) return t.skip("ffmpeg not installed");
    const out = render({ srcStart: 3, srcEnd: 6, seconds: 3, scale: 1.0, pulses: [{ at: 1.0, seconds: 0.5, strength: 0.05 }] }, "zoom-pulse");
    assert.equal(frames(out), 90);
  });

  test("a piece with no camera move is unchanged by the fix", (t) => {
    if (!have("ffmpeg")) return t.skip("ffmpeg not installed");
    const out = render({ srcStart: 3, srcEnd: 6, seconds: 3, scale: 1.0 }, "zoom-none");
    assert.equal(frames(out), 90);
  });

  test("AND THE PICTURE ACTUALLY MOVES — length alone is not the property", (t) => {
    if (!have("ffmpeg")) return t.skip("ffmpeg not installed");
    // The duration could be made right by any number of wrong things. What was
    // actually broken was motion: the old path measured 74% duplicate frames on
    // a piece like this, which is what "the whole video feels laggy" was.
    const r = checkMotion({ path: join(dir, `zoom-push.${pieceExtension()}`), duration: 3, maxRatio: 0.5 });
    assert.ok(r.ok, `a pushed piece must still move: ${JSON.stringify(r.stats)}`);
    assert.ok(r.stats.overallRatio < 0.2,
      `the old path sat at 0.74 here; got ${r.stats.overallRatio}`);
  });

  test("the rate is fixed on BOTH sides of zoompan", () => {
    // Dropping either one is a different defect. Without the leading fps,
    // zoompan generates a 30fps timeline to cover 60fps of arriving frames and
    // the piece inflates 512x. Without zoompan's own fps it falls back to its
    // default of 25 and the trailing fps=30 pads 90 frames into 108.
    const g = pieceArgs("in.mp4", "out.mkv",
      { srcStart: 0, srcEnd: 3, seconds: 3, scale: 1.0, push: { from: 1, to: 1.08, seconds: 3 } },
      { w: 1920, h: 1080 }, { fps: 30 });
    const graph = g[g.indexOf("-filter_complex") + 1];
    const zoom = graph.split(";").find((p) => p.includes("zoompan"));
    assert.match(zoom, /fps=30,scale=.*zoompan/, "the fps filter must precede zoompan");
    assert.match(zoom, /zoompan=[^;]*:fps=30/, "zoompan must also be told the rate, or it uses 25");
  });
});

// ─── 7d. the seam between segments ──────────────────────────────────────────

describe("7d. segment boundaries are declicked too, not just piece boundaries", () => {
  test("A SEGMENT FADES AT BOTH EDGES", (t) => {
    if (!have("ffmpeg")) return t.skip("ffmpeg not installed");
    // THE ONE CLICK THE 2026-08-13 RENDER WAS FLAGGED FOR, at 297.523s — which
    // is 0.16s into segment s4t1, the seam where a voiceover segment meets an
    // on-camera take. pieceArgs fades the joins INSIDE a take; nothing faded the
    // join between takes, and that seam splices two unrelated recordings.
    const pic = join(dir, "seam-pic.mp4");
    const narr = join(dir, "seam-narr.wav");
    ff(["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30:duration=4",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-an", pic]);
    // A tone that is at full amplitude at both ends, so an unfaded edge is a step.
    ff(["-y", "-v", "error", "-f", "lavfi", "-i", "aevalsrc=0.7*cos(2*PI*440*t):d=4:s=48000",
        "-c:a", "pcm_s16le", narr]);
    const out = join(dir, "seam-seg.mp4");
    ff(muxNarrationArgs(pic, narr, out, { seconds: 4 }));

    const s = decodePcm(out);
    const head = rmsDb(s, 0, 48000 * 0.004);
    const body = rmsDb(s, 48000 * 1.0, 48000 * 1.1);
    const tail = rmsDb(s, s.length - 48000 * 0.004, s.length);
    assert.ok(head < body - 6, `the segment opens on a fade: ${head.toFixed(1)} vs ${body.toFixed(1)} dBFS`);
    assert.ok(tail < body - 6, `the segment closes on a fade: ${tail.toFixed(1)} vs ${body.toFixed(1)} dBFS`);
  });

  test("a segment too short to fade gets none rather than being all fade", () => {
    assert.deepEqual(segmentDeclickArgs(0.03), []);
    assert.deepEqual(segmentDeclickArgs(0), []);
  });

  test("the fade lands at the segment's own end", () => {
    const a = segmentDeclickArgs(12.5);
    assert.match(a[1], /afade=t=in:st=0:d=0\.015/);
    assert.match(a[1], /afade=t=out:st=12\.485:d=0\.015/);
  });
});

// ─── 8. the programme level ─────────────────────────────────────────────────

describe("8. the programme is levelled before anything is mixed under it", () => {
  test("the gain is what it takes to reach the target", () => {
    const g = programmeGainDb({ inputI: -28, inputTp: -20 }, { targetLufs: -16 });
    assert.equal(g.db, 12, "12 dB up from -28 LUFS reaches -16");
    assert.equal(g.limitedByPeak, false);
  });

  test("a peaky quiet take is held back by its true peak, not clipped", () => {
    const g = programmeGainDb({ inputI: -28, inputTp: -2 }, { targetLufs: -16, ceilingDbTp: -1.5 });
    assert.equal(g.db, 0.5, "only 0.5 dB of headroom exists above a -2 dBTP peak");
    assert.equal(g.limitedByPeak, true);
  });

  test("THE BED IS PLACED UNDER WHAT THE PROGRAMME REACHED, not under what it aimed at", () => {
    // A quiet peaky recording lands at -18.5 LUFS instead of the -16 it wanted.
    // A bed placed relative to the TARGET would sit 2.5 dB closer to his voice
    // than the knob says, on exactly the recordings that can least afford it.
    const achieved = -28 + 0.5;
    const bed = bedRelativeGainDb({ bedLufs: -12, programmeLufs: achieved, under: -14 });
    assert.equal(bed.measured, true);
    assert.equal(bed.targetLufs, -41.5, "14 dB under a -27.5 LUFS programme");
    assert.equal(bed.db, -29.5, "a -12 LUFS track needs -29.5 dB to land there");
  });

  test("an unmeasurable bed falls back to the absolute knob and says so", () => {
    const bed = bedRelativeGainDb({ bedLufs: NaN, programmeLufs: -16, under: -14, fallback: -14 });
    assert.equal(bed.db, -14);
    assert.equal(bed.measured, false);
    assert.match(bed.reason, /falling back/);
  });

  test("silence is left alone rather than amplified by 60 dB", () => {
    const g = programmeGainDb({ inputI: -91, inputTp: -91 }, { targetLufs: -16 });
    assert.equal(g.db, 0);
    assert.match(g.reason, /no measurable/);
  });

  test("loudnorm's JSON is parsed off the end of the log", () => {
    const log = `[Parsed_loudnorm_0 @ 0x1] \n{\n"input_i" : "-27.35",\n"input_tp" : "-4.12",\n"input_lra" : "7.10"\n}\n`;
    const m = parseLoudnessJson(log);
    assert.equal(m.inputI, -27.35);
    assert.equal(m.inputTp, -4.12);
  });

  test("levelProgrammeArgs copies the picture and never re-encodes it", () => {
    const a = levelProgrammeArgs("in.mp4", "out.mp4", 6.5);
    assert.ok(a.includes("-c:v"));
    assert.equal(a[a.indexOf("-c:v") + 1], "copy");
    assert.ok(a.join(" ").includes("volume=6.50dB"));
  });

  test("amix no longer halves the narration", () => {
    const a = duckArgs("v.mp4", "m.mp3", "out.mp4", { envelope: { expr: "0.2", body: 0.2 } }).join(" ");
    assert.match(a, /amix=inputs=2:duration=first:normalize=0/,
      "without normalize=0 amix divides both inputs by two");
  });

  test("the duck can hand back the bed on its own, from the same filter graph", () => {
    const a = duckArgs("v.mp4", "m.mp3", "out.mp4", { envelope: { expr: "0.2" }, bedOnlyOutput: "bed.wav" });
    assert.ok(a.includes("bed.wav"), "the bed-only branch is written out");
    assert.match(a.join(" "), /\[ducked\]asplit=2\[duck1\]\[duck2\]/,
      "the measured bed must be the same samples the mix used, not a second render");
  });
});

// ─── 9. the punches that shipped on card 8 ──────────────────────────────────

describe("9. the strings card 8 put on screen cannot come back", () => {
  const seg = (text) => ({ takeId: "t", kind: "voiceover", text, seconds: 30 });

  // Verbatim from the build log of run 31553106403 — the render behind the
  // card. Every one of these was verbatim in the captions, so the verbatim
  // guard passed all six.
  const shipped = [
    ["it sits just inside 410 and the taxes change", "410"],
    ["against 1604 the lots get bigger", "1604"],
    ["the third one is the one that matters", "third one"],
    ["that is the big one for a veteran buyer", "big one"],
    ["the district feeds one middle school", "feeds one"],
    ["they hold three separate exemptions", "hold three"],
  ];

  for (const [text, wasPunched] of shipped) {
    test(`"${wasPunched}" is no longer punchable`, () => {
      const got = punchCandidatesFor(seg(text)).map((c) => c.text);
      assert.ok(!got.includes(wasPunched),
        `"${wasPunched}" came back as a punch: ${JSON.stringify(got)}`);
    });
  }

  test("the symbol-anchored beats still punch — this is not a blanket ban", () => {
    const c = punchCandidatesFor(seg("you pay $0 up front and 100% of the fee comes back"));
    const byText = Object.fromEntries(c.map((x) => [x.text, x.klass]));
    assert.equal(byText["$0"], PUNCH_CLASS.CURRENCY);
    assert.equal(byText["100%"], PUNCH_CLASS.PERCENT);
  });

  test("the disabled classes are switched off, not deleted", () => {
    // The scanner still finds them; the class gate is what keeps them out. So
    // turning them back on is a workflow change and nothing else.
    const wide = punchCandidatesFor(seg("against 1604 the lots get bigger"), {
      allowedClasses: ["currency", "percent", "counted", "figure"],
    });
    assert.ok(wide.some((c) => c.text === "1604"), "the finder is intact behind the gate");
  });

  test("selectPunches inherits the gate", () => {
    const plan = { segments: [seg("it sits just inside 410 and the third one is the big one for buyers")] };
    const { punches } = selectPunches(plan, { max: 6, minGap: 1, protectedSeconds: 0, enabled: true });
    assert.deepEqual(punches.map((p) => p.text), [], `nothing here is an emphasis beat: ${JSON.stringify(punches)}`);
  });
});
