/**
 * The hook-plate burn on the daily reels path.
 *
 * Two classes of test, deliberately:
 *
 *   - Pure rules (text fitness, gate order, argument construction) with
 *     injected dependencies, because a wrong reason string or a silently
 *     re-timed source is cheap to assert and expensive to notice live.
 *   - ONE real ffmpeg render, because the class of bug this repo pays for
 *     most is the one a mock cannot catch — and this module's own doc says
 *     it: an overlay that never enables renders perfectly and produces a
 *     video identical to the master. The render test proves the plate is ON
 *     the early frames and GONE from the late ones.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  plateTextFromCaption,
  plateBurnArgs,
  burnHookPlate,
  probeVideo,
  MAX_PLATE_WORDS,
  DURATION_TOLERANCE_SECONDS,
} from "../src/reel-hook-burn.js";
import { HOOK_HOLD_SECONDS } from "../src/reel-hooks.js";

describe("plate text from the caption", () => {
  test("takes the first line and strips emoji, keeping the words verbatim", () => {
    const { text, reason } = plateTextFromCaption("Wait until you see the kitchen in this one 😮‍💨\n\nbody line");
    assert.equal(text, "Wait until you see the kitchen in this one");
    assert.equal(reason, null);
  });

  test("a leading blank line does not blind it", () => {
    assert.equal(plateTextFromCaption("\n  \nthis might be the best one\nrest").text, "this might be the best one");
  });

  test("an emoji-only first line is refused with a reason", () => {
    const { text, reason } = plateTextFromCaption("😮‍💨🔥\nreal text below");
    assert.equal(text, null);
    assert.match(reason, /only emoji/);
  });

  test(`a line past ${MAX_PLATE_WORDS} words is refused — a plate is not a poster`, () => {
    const long = Array.from({ length: MAX_PLATE_WORDS + 1 }, (_, i) => `word${i}`).join(" ");
    const { text, reason } = plateTextFromCaption(long);
    assert.equal(text, null);
    assert.match(reason, /too long/);
  });

  test("an empty caption is refused, never thrown on", () => {
    assert.equal(plateTextFromCaption("").text, null);
    assert.equal(plateTextFromCaption(null).text, null);
  });
});

describe("the burn arguments", () => {
  const args = plateBurnArgs("in.mp4", "plate.png", "out.mp4", { hold: 3 });

  test("the overlay enables for exactly the hold window", () => {
    const filter = args[args.indexOf("-filter_complex") + 1];
    assert.match(filter, /between\(t,0,3\)/);
    assert.match(filter, /fade=t=out:st=2\.75:d=0\.25/);
  });

  test("no -r flag — the source keeps its own frame rate", () => {
    assert.ok(!args.includes("-r"), "found a -r flag; the daily path must not resample fps");
  });

  test("audio is copied, video at the caption burn's CRF 18", () => {
    assert.equal(args[args.indexOf("-c:a") + 1], "copy");
    assert.equal(args[args.indexOf("-crf") + 1], "18");
  });
});

describe("the gates, with injected dependencies", () => {
  const CAPTION = "would you believe this is brand new construction?\nbody";
  const okProbe = () => ({ width: 540, height: 960, duration: 6 });

  test("an unverifiable caption scan refuses the plate", async () => {
    const r = await burnHookPlate("v.mp4", CAPTION, { captionScan: { ocrUnavailable: true }, probe: okProbe });
    assert.equal(r.burned, false);
    assert.match(r.reason, /cannot verify/);
  });

  test("a source with burned-in text refuses the plate", async () => {
    const r = await burnHookPlate("v.mp4", CAPTION, { captionScan: { detected: true }, probe: okProbe });
    assert.equal(r.burned, false);
    assert.match(r.reason, /caption-over-captions/);
  });

  test("an unprobeable video refuses the plate rather than guessing dimensions", async () => {
    const r = await burnHookPlate("v.mp4", CAPTION, { captionScan: { detected: false }, probe: () => null });
    assert.equal(r.burned, false);
    assert.match(r.reason, /dimensions/);
  });

  test("a throwing ffmpeg degrades to a reasoned skip, never an exception", async () => {
    const r = await burnHookPlate("v.mp4", CAPTION, {
      captionScan: { detected: false },
      probe: okProbe,
      renderPlate: async () => Buffer.from("png"),
      runFfmpeg: () => { throw new Error("boom"); },
    });
    assert.equal(r.burned, false);
    assert.match(r.reason, /render failed: boom/);
  });

  test("an ffmpeg that writes nothing fails the self-check, not the caller", async () => {
    const r = await burnHookPlate("v.mp4", CAPTION, {
      captionScan: { detected: false },
      probe: okProbe,
      renderPlate: async () => Buffer.from("png"),
      runFfmpeg: () => {}, // exits 0, produces no file — the lying success case
    });
    assert.equal(r.burned, false);
    assert.match(r.reason, /no usable output/);
  });
});

// ─── The real render ─────────────────────────────────────────────────────────

describe("a real burn, verified frame by frame", () => {
  let dir;
  let sourcePath;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "hookburn-test-"));
    sourcePath = join(dir, "source.mp4");
    // A 6s solid-colour vertical clip with a sine tone: solid colour so a
    // plate-bearing frame is unmistakably different from a clean one, real
    // audio so the -c:a copy path is exercised.
    execSync(
      `ffmpeg -y -f lavfi -i "color=c=0x336699:size=540x960:rate=30:duration=6" ` +
      `-f lavfi -i "sine=frequency=440:duration=6" ` +
      `-c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -c:a aac -shortest "${sourcePath}"`,
      { stdio: "pipe", timeout: 120000 }
    );
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A small grayscale raw frame at time t, for pixel comparison. */
  function grabFrame(videoPath, t) {
    const out = join(dir, `frame-${String(t).replace(".", "_")}-${Math.random().toString(36).slice(2, 8)}.raw`);
    execSync(
      `ffmpeg -y -ss ${t} -i "${videoPath}" -frames:v 1 -f rawvideo -pix_fmt gray -s 128x228 "${out}"`,
      { stdio: "pipe", timeout: 60000 }
    );
    return out;
  }

  function diffRatio(rawA, rawB) {
    const a = readFileSync(rawA);
    const b = readFileSync(rawB);
    const n = Math.min(a.length, b.length);
    let differing = 0;
    for (let i = 0; i < n; i++) {
      if (Math.abs(a[i] - b[i]) > 12) differing++; // tolerate codec noise
    }
    return differing / n;
  }

  test("burns, keeps duration and audio, shows the plate early and not late", async () => {
    const caption = "would you believe this is brand new construction?\n\nrest of caption";
    const result = await burnHookPlate(sourcePath, caption, {
      captionScan: { detected: false, ocrUnavailable: false },
      outputDir: dir,
    });

    assert.equal(result.burned, true, `burn failed: ${result.reason}`);
    assert.ok(existsSync(result.videoPath));
    assert.equal(result.text, "would you believe this is brand new construction?");
    assert.equal(result.hold_seconds, HOOK_HOLD_SECONDS);

    // Structure: duration preserved within tolerance, audio stream survived the copy.
    const dims = probeVideo(result.videoPath);
    assert.ok(dims, "output unprobeable");
    assert.ok(Math.abs(dims.duration - 6) <= DURATION_TOLERANCE_SECONDS, `duration drifted to ${dims.duration}`);
    const streams = JSON.parse(execSync(
      `ffprobe -v quiet -print_format json -show_streams "${result.videoPath}"`,
      { encoding: "utf-8", timeout: 30000 }
    )).streams.map((s) => s.codec_type);
    assert.ok(streams.includes("audio"), "audio stream was lost");

    // The overlay actually enabled — and expired. A frame inside the hold
    // window must differ hard from a frame after it; two clean late frames
    // must not (that pair calibrates codec noise on this exact encode).
    const early = grabFrame(result.videoPath, 1.0);
    const late = grabFrame(result.videoPath, 4.5);
    const late2 = grabFrame(result.videoPath, 5.2);
    const plateDiff = diffRatio(early, late);
    const noiseDiff = diffRatio(late, late2);
    assert.ok(plateDiff > 0.02, `plate frame barely differs from clean frame (${(plateDiff * 100).toFixed(2)}%) — did the overlay enable?`);
    assert.ok(noiseDiff < 0.005, `two clean frames differ by ${(noiseDiff * 100).toFixed(2)}% — the comparison is not calibrated`);
    assert.ok(plateDiff > noiseDiff * 4, "plate signal is not clearly above codec noise");
  });
});
