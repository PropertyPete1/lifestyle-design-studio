/**
 * The teaser.
 *
 * The one property that makes a teaser a teaser: IT OPENS THE LOOP AND DOES
 * NOT RESOLVE IT. The payoff lives on YouTube; a teaser that answers its own
 * question is a substitute, not a trailer. That guard is structural — the cut
 * can only ever reach the hook take and section 2's opener — and the tests
 * here try to break it before a viewer can.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  pickTeaserTakes,
  teaserCaptions,
  chunksFromWords,
  trimPointFor,
  endPlateSvg,
  cutTeaser,
  TEASER_MIN_SECONDS,
  TEASER_MAX_SECONDS,
  PLATE_SECONDS,
} from "../src/yt-teaser.js";
import { ON_CAMERA, VOICEOVER } from "../src/yt-script.js";
import { mediaDuration } from "../src/yt-assemble.js";

const SCRIPT = {
  title: "What Stone Oak Actually Costs",
  hook: "Everyone quotes the price. Nobody quotes the fee.",
  sections: [
    { title: "The fee", takes: [
      { id: "s1t1", mode: ON_CAMERA, text: "Everyone quotes the price. Nobody quotes the fee that decides whether you can afford it." },
      { id: "s1t2", mode: VOICEOVER, text: "voiceover body" },
    ]},
    { title: "The map", takes: [
      { id: "s2t1", mode: ON_CAMERA, text: "And here is where that fee actually lives on the map." },
      { id: "s2t2", mode: VOICEOVER, text: "more body" },
    ]},
    { title: "The payoff", takes: [
      { id: "s3t1", mode: ON_CAMERA, text: "So the answer is: the MUD fee is 1200 a year and here is exactly how to avoid it." },
    ]},
  ],
  softCta: { mode: ON_CAMERA, text: "Comment MATH and I'll run your numbers.", id: "cta" },
  close: { mode: ON_CAMERA, text: "The full answer, resolved and wrapped up.", id: "close" },
};

describe("pickTeaserTakes — THE LOOP GUARD", () => {
  const rec = (ids) => Object.fromEntries(ids.map((id) => [id, { path: `/takes/${id}.mov`, durationSeconds: 20 }]));

  test("hook leads, section 2's opener may follow — nothing else, ever", () => {
    // Every take recorded, including the payoff, the CTA and the close: the
    // guard must leave all of them unreachable even though they are RIGHT THERE.
    const all = rec(["s1t1", "s1t2", "s2t1", "s2t2", "s3t1", "cta", "close"]);
    const picked = pickTeaserTakes(SCRIPT, all);
    assert.deepEqual(picked.takes.map((t) => t.takeId), ["s1t1", "s2t1"]);
  });

  test("the payoff section is unreachable even when section 2 was not recorded", () => {
    const picked = pickTeaserTakes(SCRIPT, rec(["s1t1", "s3t1", "cta", "close"]));
    assert.deepEqual(picked.takes.map((t) => t.takeId), ["s1t1"], "short beats spoiled");
  });

  test("no hook recording means no teaser — never a substitute from later takes", () => {
    const picked = pickTeaserTakes(SCRIPT, rec(["s2t1", "s3t1", "close"]));
    assert.equal(picked.takes.length, 0);
    assert.match(picked.reason, /hook/);
  });

  test("a voiceover take can never be the hook, even as section 1's first take", () => {
    const voFirst = { ...SCRIPT, sections: [{ title: "x", takes: [{ id: "s1t1", mode: VOICEOVER, text: "vo" }, { id: "s1t2", mode: ON_CAMERA, text: "face" }] }] };
    const picked = pickTeaserTakes(voFirst, rec(["s1t1", "s1t2"]));
    assert.deepEqual(picked.takes.map((t) => t.takeId), ["s1t2"], "the teaser needs a face");
  });
});

describe("teaserCaptions — three platforms, one rule: the payoff stays on YouTube", () => {
  const caps = teaserCaptions({ title: "What Stone Oak Actually Costs", hookLine: "Everyone quotes the price. Nobody quotes the fee." });

  test("every platform points at YouTube", () => {
    for (const [platform, text] of Object.entries(caps)) {
      assert.match(text, /YouTube/i, platform);
    }
    assert.match(caps.instagram, /link in bio/i);
    assert.match(caps.tiktok, /link in bio/i);
  });

  test("LinkedIn gets its own register — no hashtags, link in comments", () => {
    assert.ok(!caps.linkedin.includes("#"), "hashtags read as spam on LinkedIn");
    assert.match(caps.linkedin, /comments/i);
  });

  test("the hook's FIRST sentence opens every caption — tease, not summary", () => {
    for (const text of Object.values(caps)) {
      assert.ok(text.startsWith("Everyone quotes the price."), "the opener is the hook's first sentence");
      assert.ok(!text.includes("Nobody quotes the fee."), "the second sentence stays in the video");
    }
  });

  test("deterministic — same inputs, same captions, nothing to hallucinate a payoff", () => {
    assert.deepEqual(caps, teaserCaptions({ title: "What Stone Oak Actually Costs", hookLine: "Everyone quotes the price. Nobody quotes the fee." }));
  });
});

describe("chunksFromWords / trimPointFor / endPlateSvg", () => {
  test("words group into chunks with real clock positions", () => {
    const words = [
      { word: "Everyone", start: 0.1, end: 0.4 }, { word: "quotes", start: 0.4, end: 0.7 },
      { word: "the", start: 0.7, end: 0.8 }, { word: "price", start: 0.8, end: 1.2 },
      { word: "nobody", start: 1.5, end: 1.9 },
    ];
    const chunks = chunksFromWords(words, { wordsPerChunk: 4 });
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].text, "Everyone quotes the price");
    assert.equal(chunks[0].start, 0.1);
    assert.equal(chunks[0].end, 1.2);
    assert.ok(chunks[1].end >= chunks[1].start + 0.3, "a one-word chunk still gets readable screen time");
  });

  test("trim lands on a cut, never mid-syllable", () => {
    const pieces = [{ seconds: 6 }, { seconds: 7 }, { seconds: 9 }];
    assert.equal(trimPointFor(pieces, 20), 13, "6+7 fits, +9 does not");
    assert.equal(trimPointFor(pieces, 5), null, "not even one piece fits — refuse");
  });

  test("the end plate says exactly where the payoff is", () => {
    const svg = endPlateSvg();
    assert.match(svg, /THE FULL VIDEO/);
    assert.match(svg, /IS ON YOUTUBE/);
    assert.match(svg, /LINK IN BIO/);
  });
});

describe("cutTeaser — the whole cut, real ffmpeg, offline transcription", () => {
  let workDir;
  let hookTake;
  before(() => {
    workDir = mkdtempSync(join(tmpdir(), "teaser-test-"));
    // A synthetic vertical "hook take": tone bursts with silences for the
    // retention edit to find and remove, ~24s so the trim path exercises too.
    hookTake = join(workDir, "hook.mp4");
    execFileSync("ffmpeg", [
      "-y",
      "-f", "lavfi", "-i", "testsrc2=size=1080x1920:rate=30:duration=24",
      "-f", "lavfi", "-i",
      "sine=frequency=440:duration=24,volume='if(lt(mod(t,6),4),1,0)':eval=frame",
      "-map", "0:v", "-map", "1:a",
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-ar", "48000", "-ac", "2",
      hookTake,
    ], { stdio: "pipe", timeout: 120_000 });
  });
  after(() => rmSync(workDir, { recursive: true, force: true }));

  const script = { ...SCRIPT };
  const fakeTranscribe = () => ({ ok: true, transcript: "", duration: 0, words: [] });

  test("cuts a bounded, audible, honest teaser ending on the plate", { timeout: 240_000 }, async () => {
    const recordings = { s1t1: { path: hookTake, durationSeconds: 24 } };
    const teaser = await cutTeaser({ script, recordings, workDir, transcribe: fakeTranscribe });

    assert.ok(teaser.seconds <= TEASER_MAX_SECONDS + PLATE_SECONDS + 1.0, `runs ${teaser.seconds}s`);
    assert.ok(teaser.seconds >= 5, "produced something substantive");
    const measured = mediaDuration(teaser.path);
    assert.ok(Math.abs(measured - teaser.seconds) < 0.2, "reports the measured duration");
    // The plate is real pixels at the tail, not a promise: the last frame is
    // near-black with bright text, radically darker than testsrc2 noise.
    const stats = execSync(
      `ffmpeg -sseof -1 -i "${teaser.path}" -frames:v 1 -vf "signalstats,metadata=print:key=lavfi.signalstats.YAVG" -f null - 2>&1 | grep -o "YAVG=[0-9.]*" | tail -1`,
      { encoding: "utf-8", timeout: 60_000 }
    ).trim();
    const yavg = Number(stats.split("=")[1]);
    assert.ok(Number.isFinite(yavg) && yavg < 60, `the tail should be the dark plate, measured YAVG ${yavg}`);
  });

  test("refuses when there is nothing to cut", async () => {
    await assert.rejects(
      () => cutTeaser({ script, recordings: {}, workDir, transcribe: fakeTranscribe }),
      /no material|hook/
    );
  });
});
