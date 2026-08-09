/**
 * The revision-3 scenario matrix.
 *
 * Every entry is a way the three-layer visual system can be wrong in a way that
 * still produces a file. That is the class of failure this project keeps paying
 * for — a build that succeeds and has no effect — so each case here asserts on
 * an OUTCOME (a segment is covered, a clip is rejected, a folder is
 * unreachable) rather than on the absence of a thrown error.
 *
 * Nothing here needs the network, an API key, or ffmpeg. The layers that touch
 * those take them as injected functions, which is the reason they were written
 * that way.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";

import { planVisuals, planSegmentCoverage, coverageReport, REASON } from "../src/yt-visual-plan.js";
import { attachIntents, TYPOGRAPHY, FOOTAGE } from "../src/yt-visual-intent.js";
import { planReveals, findEmphasisWords, findWordTime } from "../src/yt-reveal-timing.js";
import { planTypography, splitPhrases, typographyPng } from "../src/yt-typography-render.js";
import { searchPexels, visionCheckClip, rankCandidates, creditsBlock, gradeArgs, stockContentHash } from "../src/yt-stock.js";
import { assertNoReelsReach, listLongformFootage, reelsFolderIds } from "../src/yt-footage-source.js";
import { buildEditList, assignPulses, splitForPunchIns, PUNCH_INTERVAL_MAX } from "../src/yt-oncamera-edit.js";
import { auditOpeningMotion, openingTeaserAt } from "../src/yt-opening.js";
import { assertAnimated, buildStates, verifyStateSequence } from "../src/yt-visual-animate.js";
import { renderCardPng, revealLabels } from "../src/yt-card-render.js";
import { frameDifference } from "../src/yt-visual-qc.js";
import { CITY_FOLDER_IDS } from "../src/drive.js";

const DIR = mkdtempSync(join(tmpdir(), "rev3-"));

function voiceover(id, text, seconds, visualIntent = null) {
  return { kind: "voiceover", takeId: id, section: "S", seconds, text, visualIntent, broll: [] };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("1. a script with zero visual intents", () => {
  const segments = [
    voiceover("t1", "Most people think the tax rate is the whole story. It is not.", 12),
    voiceover("t2", "Two houses at the same price can differ by four thousand dollars a year.", 14),
    voiceover("t3", "The line item nobody reads is the one that moves the payment.", 9),
  ];

  test("every segment is covered, none is blank", async () => {
    const { segments: planned, coverage } = await planVisuals(segments);
    for (const seg of planned) {
      const covered = seg.visualBlocks.reduce((n, b) => n + b.seconds, 0);
      assert.ok(seg.visualBlocks.length > 0, `${seg.takeId} has no visual blocks`);
      assert.ok(Math.abs(covered - seg.seconds) < 0.05, `${seg.takeId} covered ${covered}s of ${seg.seconds}s`);
    }
    assert.equal(coverage.uncoveredSeconds, 0, "some runtime has no picture");
  });

  test("all of it is typography, and the report says WHY rather than calling it a choice", async () => {
    const { coverage } = await planVisuals(segments);
    assert.equal(coverage.byPct.typography, 100);
    assert.equal(coverage.fallbackCount, 3);
    for (const f of coverage.fallbacks) assert.equal(f.reason, REASON.NO_INTENT);
  });

  test("a deliberate TYPOGRAPHY intent is NOT counted as a fallback", async () => {
    const asked = segments.map((s) => ({ ...s, visualIntent: "TYPOGRAPHY" }));
    const { coverage } = await planVisuals(asked);
    assert.equal(coverage.byPct.typography, 100);
    assert.equal(coverage.fallbackCount, 0, "an explicit choice must not read as a failure");
  });
});

describe("2. Pexels is down, or returns garbage", () => {
  const badPayloads = [
    { name: "500", impl: async () => ({ ok: false, status: 500, json: async () => ({}) }) },
    { name: "429 rate limit", impl: async () => ({ ok: false, status: 429, json: async () => ({}) }) },
    { name: "network throw", impl: async () => { throw new Error("ECONNREFUSED"); } },
    { name: "HTML where JSON was promised", impl: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); } }) },
    { name: "valid JSON, wrong shape", impl: async () => ({ ok: true, status: 200, json: async () => ({ nonsense: true }) }) },
    { name: "videos is not an array", impl: async () => ({ ok: true, status: 200, json: async () => ({ videos: "no" }) }) },
    { name: "a video with no files", impl: async () => ({ ok: true, status: 200, json: async () => ({ videos: [{ id: 1, video_files: [] }] }) }) },
    { name: "null in the videos array", impl: async () => ({ ok: true, status: 200, json: async () => ({ videos: [null, undefined] }) }) },
  ];

  for (const { name, impl } of badPayloads) {
    test(`${name} returns [] instead of throwing`, async () => {
      process.env.PEXELS_API_KEY = "test-key";
      const out = await searchPexels("aerial suburban neighborhood texas", { fetchImpl: impl });
      assert.deepEqual(out, [], `${name} should degrade to no results`);
    });
  }

  test("with no API key at all, search is empty and nothing throws", async () => {
    delete process.env.PEXELS_API_KEY;
    assert.deepEqual(await searchPexels("anything"), []);
  });

  test("a FOOTAGE take whose stock fails still gets a full picture", async () => {
    const seg = voiceover("t1", "Aerial over a new subdivision at golden hour, streets still empty.", 10, {
      type: "FOOTAGE", spec: { keywords: ["aerial suburban neighborhood texas"] },
    });
    const { segments: planned, coverage } = await planVisuals([seg], {
      fetchStock: async () => ({ clip: null, attempts: [{ stage: "search", reason: "no results" }] }),
    });
    const covered = planned[0].visualBlocks.reduce((n, b) => n + b.seconds, 0);
    assert.ok(Math.abs(covered - 10) < 0.05);
    assert.equal(planned[0].visualPrimary, "typography");
    assert.equal(coverage.fallbacks[0].reason, REASON.STOCK_NO_MATCH, "the fallback must name the cause");
  });

  test("a FOOTAGE intent with no keywords is reported differently from one that found nothing", async () => {
    const seg = voiceover("t1", "Show the place.", 8, "FOOTAGE");
    const { coverage } = await planVisuals([seg]);
    assert.equal(coverage.fallbacks[0].reason, REASON.NO_KEYWORDS);
  });
});

describe("3. a stock clip with a watermark", () => {
  const fakeClient = (reply) => ({ messages: { create: async () => ({ content: [{ type: "text", text: reply }] }) } });
  const frame = join(DIR, "frame.jpg");
  writeFileSync(frame, Buffer.from("not-a-real-jpeg-but-readable"));

  test("an explicit rejection is a rejection", async () => {
    const v = await visionCheckClip([frame], {
      subject: "aerial suburban neighborhood",
      client: fakeClient('{"ok": false, "reason": "a Shutterstock watermark is across the centre"}'),
    });
    assert.equal(v.ok, false);
    assert.match(v.reason, /watermark/i);
  });

  test("the check FAILS CLOSED on every ambiguous answer", async () => {
    const ambiguous = [
      "yes it looks fine",                      // no JSON at all
      '{"ok": "true"}',                          // a string, not a boolean
      '{"okay": true}',                          // the wrong key
      '{"ok": 1}',                               // truthy, not true
      "{ this is not json }",
      "",
    ];
    for (const reply of ambiguous) {
      const v = await visionCheckClip([frame], { subject: "x", client: fakeClient(reply) });
      assert.equal(v.ok, false, `"${reply}" must not pass`);
    }
  });

  test("a thrown request rejects rather than escaping", async () => {
    const client = { messages: { create: async () => { throw new Error("529 overloaded"); } } };
    const v = await visionCheckClip([frame], { subject: "x", client });
    assert.equal(v.ok, false);
    assert.match(v.reason, /529/);
  });

  test("no frames and no client both reject", async () => {
    assert.equal((await visionCheckClip([], { subject: "x", client: fakeClient('{"ok":true}') })).ok, false);
    assert.equal((await visionCheckClip([frame], { subject: "x", client: null })).ok, false);
  });

  test("only an explicit true passes", async () => {
    const v = await visionCheckClip([frame], { subject: "x", client: fakeClient('{"ok": true, "reason": "matches"}') });
    assert.equal(v.ok, true);
  });

  test("the prompt asks about watermarks, burned-in text and implied endorsement", async () => {
    let seen = null;
    const client = { messages: { create: async (req) => { seen = req; return { content: [{ type: "text", text: '{"ok":true}' }] }; } } };
    await visionCheckClip([frame], { subject: "family moving boxes into house", client });
    const prompt = seen.messages[0].content.at(-1).text;
    assert.match(prompt, /watermark/i);
    assert.match(prompt, /burned-in text|on-screen writing/i);
    assert.match(prompt, /endorsing/i, "the licence forbids implied endorsement — the check must ask");
    assert.match(prompt, /family moving boxes into house/, "the requested subject must reach the model");
    assert.match(prompt, /unsure, reject/i);
  });
});

describe("4. a take with no word timings", () => {
  const labels = ["School district", "County", "City"];

  test("reveals fall back to even pacing instead of crashing", () => {
    for (const words of [null, undefined, [], "not an array", [{}], [{ word: null, start: null }]]) {
      const p = planReveals({ labels, words, seconds: 9 });
      assert.equal(p.reveals.length, 3, `words=${JSON.stringify(words)} lost a reveal`);
      assert.ok(p.reveals.every((r) => Number.isFinite(r.at)));
    }
  });

  test("even pacing is monotonic and inside the runtime", () => {
    const p = planReveals({ labels, words: null, seconds: 9 });
    assert.equal(p.source, "even-pacing");
    assert.equal(p.synced, false);
    for (let i = 1; i < p.reveals.length; i++) assert.ok(p.reveals[i].at > p.reveals[i - 1].at);
    assert.ok(p.reveals.at(-1).at < 9);
  });

  test("a label that is never spoken still gets a reveal", () => {
    const words = [{ word: "County", start: 2, end: 2.4 }];
    const p = planReveals({ labels, words, seconds: 9 });
    assert.equal(p.reveals.length, 3);
    assert.equal(p.syncedCount, 1);
    assert.equal(p.source, "word-timing");
  });

  test("typography survives a missing transcript too", () => {
    const plan = planTypography({ text: "It is not the rate. It is the line item under it.", words: null, seconds: 10 });
    assert.ok(plan.cards.length > 0);
    assert.equal(plan.source, "even-pacing");
    assert.ok(Math.abs(plan.cards.at(-1).end - 10) < 0.001, "the last card must reach the end of the segment");
  });

  test("empty narration produces no cards rather than a broken one", () => {
    assert.deepEqual(splitPhrases(""), []);
    assert.deepEqual(splitPhrases("   "), []);
    assert.equal(planTypography({ text: "", words: null, seconds: 5 }).cards.length, 0);
  });
});

describe("5. the 3s cadence on a take shorter than 3s", () => {
  for (const duration of [0.4, 1.0, 2.4, 2.9]) {
    test(`a ${duration}s take produces one usable piece`, () => {
      const plan = buildEditList(duration, []);
      assert.equal(plan.pieces.length, 1, "a take under the interval must not be split");
      assert.ok(plan.pieces[0].seconds > 0);
      assert.ok(Math.abs(plan.pieces[0].srcEnd - duration) < 0.001);
    });
  }

  test("a zero-length take is handled, not divided by", () => {
    const plan = buildEditList(0, []);
    assert.deepEqual(plan.pieces, []);
    assert.ok(plan.warnings.length > 0);
  });

  test("a take just over the interval splits in two, not into slivers", () => {
    const plan = buildEditList(PUNCH_INTERVAL_MAX + 1.2, []);
    assert.ok(plan.pieces.length >= 2);
    assert.ok(plan.pieces.every((p) => p.seconds >= 0.45), JSON.stringify(plan.pieces.map((p) => p.seconds)));
  });
});

describe("6. zoom pulses colliding with cuts, trims and the opening push", () => {
  test("a pulse inside a trimmed silence is dropped and says so", () => {
    const pieces = [
      { srcStart: 0, srcEnd: 3, seconds: 3, pulses: [], push: null },
      { srcStart: 6, srcEnd: 9, seconds: 3, pulses: [], push: null },
    ];
    const r = assignPulses(pieces, [{ at: 4.5, word: "Boerne", kind: "proper" }]);
    assert.equal(r.assigned, 0);
    assert.match(r.dropped[0].why, /trimmed out/);
  });

  test("a pulse landing on a cut is dropped", () => {
    const pieces = [{ srcStart: 0, srcEnd: 3, seconds: 3, pulses: [], push: null }];
    for (const at of [0.05, 0.2, 2.95]) {
      const r = assignPulses([{ ...pieces[0], pulses: [] }], [{ at, word: "not", kind: "negation" }]);
      assert.equal(r.assigned, 0, `a pulse at ${at}s in a 3s piece should be dropped`);
      assert.match(r.dropped[0].why, /close to a cut/);
    }
  });

  test("a pulse during the opening push is dropped", () => {
    const pieces = [{ srcStart: 0, srcEnd: 8, seconds: 8, pulses: [], push: { from: 1, to: 1.08, seconds: 3.5 } }];
    const r = assignPulses(pieces, [{ at: 4, word: "twelve", kind: "number" }]);
    assert.equal(r.assigned, 0);
    assert.match(r.dropped[0].why, /opening push/);
  });

  test("two pulses on the same beat become one", () => {
    const pieces = [{ srcStart: 0, srcEnd: 6, seconds: 6, pulses: [], push: null }];
    const r = assignPulses(pieces, [
      { at: 3.0, word: "four", kind: "number" },
      { at: 3.1, word: "thousand", kind: "number" },
    ]);
    assert.equal(r.assigned, 1);
    assert.match(r.dropped[0].why, /already on this beat/);
  });

  test("a pulse with room lands, and carries its word for the report", () => {
    const pieces = [{ srcStart: 0, srcEnd: 6, seconds: 6, pulses: [], push: null }];
    const r = assignPulses(pieces, [{ at: 3.0, word: "1604", kind: "number" }]);
    assert.equal(r.assigned, 1);
    assert.equal(pieces[0].pulses[0].word, "1604");
    assert.equal(pieces[0].pulses[0].at, 3);
  });

  test("garbage emphasis entries are ignored rather than producing NaN pulses", () => {
    const pieces = [{ srcStart: 0, srcEnd: 6, seconds: 6, pulses: [], push: null }];
    const r = assignPulses(pieces, [null, undefined, {}, { at: "x" }, { at: NaN }]);
    assert.equal(r.assigned, 0);
    assert.equal(pieces[0].pulses.length, 0);
  });

  test("the opening take gets its beat even with no emphasis words in the hook", () => {
    const plan = buildEditList(14, [], { isOpening: true, emphasis: [] });
    const opening = plan.pieces[0].pulses.find((p) => p.kind === "opening");
    assert.ok(opening, "the opening beat must not depend on the hook containing a number");
    assert.ok(plan.pieces[0].push, "the push must survive alongside it");
  });

  test("a sentence-initial capital is not mistaken for a place name", () => {
    const words = [
      { word: "Your", start: 0, end: 0.2 }, { word: "bill", start: 0.3, end: 0.5 },
      { word: "is", start: 0.6, end: 0.7 }, { word: "not", start: 0.8, end: 1.0 },
      { word: "what", start: 1.1, end: 1.3 }, { word: "Boerne", start: 3.5, end: 4.0 },
    ];
    const hits = findEmphasisWords(words);
    assert.ok(!hits.some((h) => h.word === "Your"), "every take would open on a wasted pulse");
    assert.ok(hits.some((h) => h.word === "not"));
  });
});

describe("7. the long-form footage folder is empty — the default state", () => {
  test("no folder configured is quiet and returns nothing", async () => {
    const out = await listLongformFootage({ folderId: null });
    assert.deepEqual(out, []);
  });

  test("an empty folder returns nothing and is not an error", async () => {
    const out = await listLongformFootage({
      folderId: "longform-folder-id",
      tokenFn: async () => "tok",
      fetchImpl: async () => ({ ok: true, json: async () => ({ files: [] }) }),
    });
    assert.deepEqual(out, []);
  });

  test("a Drive failure degrades to no footage rather than stopping the build", async () => {
    const out = await listLongformFootage({
      folderId: "longform-folder-id",
      tokenFn: async () => "tok",
      fetchImpl: async () => { throw new Error("network down"); },
    });
    assert.deepEqual(out, []);
  });

  test("an auth failure degrades too", async () => {
    const out = await listLongformFootage({
      folderId: "longform-folder-id",
      tokenFn: async () => { throw new Error("no refresh token"); },
    });
    assert.deepEqual(out, []);
  });

  test("with an empty library the whole video still has a picture", async () => {
    const segments = [
      voiceover("t1", "Here is what the neighbourhood actually looks like on a Tuesday.", 11, { type: "FOOTAGE", spec: { keywords: ["suburban street"] } }),
      voiceover("t2", "The number that matters is the one under the rate.", 8, null),
    ];
    const { coverage } = await planVisuals(segments, { ownedFor: () => 0 });
    assert.equal(coverage.uncoveredSeconds, 0);
    assert.equal(coverage.bySource.owned, 0);
  });
});

describe("8. long-form cannot reach the reels library", () => {
  test("every reels city folder id is refused by name", () => {
    for (const [city, id] of Object.entries(CITY_FOLDER_IDS)) {
      assert.throws(() => assertNoReelsReach(id), /reels/i, `${city} was not refused`);
    }
  });

  test("the assertion THROWS rather than falling back", () => {
    // Everything else in the visual system degrades. This must not: the failure
    // mode is a burned-in mortgage rate on screen for years, and a dead build
    // is strictly cheaper.
    assert.throws(() => assertNoReelsReach(CITY_FOLDER_IDS.san_antonio), (err) => {
      assert.match(err.message, /san_antonio/);
      assert.match(err.message, /YT_LONGFORM_BROLL_FOLDER/);
      return true;
    });
  });

  test("listLongformFootage refuses a reels folder even if one is configured", async () => {
    await assert.rejects(
      () => listLongformFootage({ folderId: CITY_FOLDER_IDS.austin, tokenFn: async () => "tok" }),
      /reels/i
    );
  });

  test("a non-reels folder passes", () => {
    assert.doesNotThrow(() => assertNoReelsReach("some-other-folder-id"));
    assert.doesNotThrow(() => assertNoReelsReach(null));
  });

  test("the reels id list is not empty — a vacuous assertion would pass forever", () => {
    assert.ok(reelsFolderIds().length >= 3, "if this list empties, every test above passes for the wrong reason");
  });
});

describe("9. frame-diff catches a deliberately frozen render", () => {
  // A fake ffmpeg that serves pre-rendered frames by timestamp, so the static
  // detection can be driven without encoding anything.
  function fakeGrabber(frameFor) {
    return (args) => {
      const ss = Number(args[args.indexOf("-ss") + 1]);
      const out = args[args.length - 1];
      writeFileSync(out, frameFor(ss));
    };
  }

  const spec = {
    eyebrow: "PROPERTY TAX", title: "Where your bill goes",
    rows: [{ label: "School district", value: "$4,200" }, { label: "County", value: "$1,100" }, { label: "City", value: "$900" }],
    total: "$7,600",
  };

  test("a frozen clip fails, and the failure names the window", async () => {
    const frozen = await renderCardPng("NUMBER_BREAKDOWN", spec);
    const verdict = await assertAnimated("clip.mp4", {
      seconds: 9,
      reveals: [{ at: 3, label: "County" }],
      dir: DIR,
      index: 90,
      ffmpeg: fakeGrabber(() => frozen),
    });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.failures.some((f) => /frozen between/.test(f)), verdict.failures.join("|"));
  });

  /**
   * THE PUSH-ONLY CASE NEEDS A REAL ENCODE, and the first attempt at faking it
   * is worth recording because the fake passed.
   *
   * Simulating the push by cropping a still to integer pixel bounds produces
   * motion that arrives in whole-pixel JUMPS rather than smoothly. Those jumps
   * landed near the probe timestamps, so two of three reveal windows measured
   * 2.1 against an ambient of 0.35 — a ratio of 6, and a confident pass for a
   * clip with no reveals in it at all. The fixture was not a smaller version of
   * the phenomenon; it was a different phenomenon.
   *
   * A real zoompan interpolates sub-pixel, which is what makes ambient and
   * reveal windows comparable in the first place. So this one case pays for an
   * encode, and skips where ffmpeg is unavailable rather than asserting against
   * something that does not represent what ships.
   */
  const hasFfmpeg = (() => {
    try {
      execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  test("a clip that MOVES but never reveals is caught — the revision-2 failure", { skip: hasFfmpeg ? false : "ffmpeg not available" }, async () => {
    const ffmpeg = (a) => execFileSync("ffmpeg", a, { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 });
    const still = join(DIR, "finished-card.png");
    writeFileSync(still, await renderCardPng("NUMBER_BREAKDOWN", spec));

    // Exactly the push the animator applies, over a card that is already whole.
    const pushOnly = join(DIR, "push-only.mp4");
    ffmpeg(["-y", "-loop", "1", "-i", still, "-t", "9", "-vf",
      "fps=30,zoompan=z='1+0.045*on/270':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1920x1080:fps=30,format=yuv420p",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-an", pushOnly]);

    // Build the state renders a REAL graphic of this spec would have produced,
    // and ask whether the push-only clip steps through them. It cannot: every
    // moment of it looks like the finished card.
    const { buildStates: mkStates } = await import("../src/yt-visual-animate.js");
    const p = planReveals({ labels: revealLabels("NUMBER_BREAKDOWN", spec), words: null, seconds: 9 });
    const states = mkStates({ type: "NUMBER_BREAKDOWN", labels: revealLabels("NUMBER_BREAKDOWN", spec), reveals: p.reveals, beats: p.beats, seconds: 9 });
    const framePaths = [];
    for (let i = 0; i < states.length; i++) {
      const fp = join(DIR, `ref-${i}.png`);
      writeFileSync(fp, await renderCardPng("NUMBER_BREAKDOWN", spec, states[i]));
      framePaths.push(fp);
    }

    const seq = await verifyStateSequence(pushOnly, { states, framePaths, seconds: 9, dir: DIR, ffmpeg, index: 91 });
    assert.equal(seq.ok, false, `a push over a finished card must not pass: ${JSON.stringify(seq.matches)}`);
    assert.ok(
      seq.failures.some((f) => /same state|not stepping/.test(f)),
      `expected the state-sequence check to fire, got: ${seq.failures.join(" | ")}`
    );

    // And the frozen check must stay quiet — this clip genuinely is moving, so
    // it is NOT the thing that should have caught it.
    const verdict = await assertAnimated(pushOnly, { seconds: 9, reveals: p.reveals, dir: DIR, index: 91, ffmpeg });
    assert.ok(!verdict.failures.some((f) => /frozen between/.test(f)), "this clip is not frozen — the frozen check should not be what caught it");
  });

  test("a genuinely animated graphic passes the same check", { skip: hasFfmpeg ? false : "ffmpeg not available" }, async () => {
    const ffmpeg = (a) => execFileSync("ffmpeg", a, { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 });
    const { renderAnimatedGraphic } = await import("../src/yt-visual-animate.js");
    const words = [
      { word: "school", start: 1.8, end: 2.2 }, { word: "district", start: 2.3, end: 2.8 },
      { word: "County", start: 4.4, end: 4.9 }, { word: "city", start: 6.3, end: 6.7 },
    ];
    const r = await renderAnimatedGraphic({
      type: "NUMBER_BREAKDOWN", spec, seconds: 10, words, dir: DIR, index: 92, ffmpeg, writeFileSync,
    });
    assert.equal(r.deadStates.length, 0, `states that should differ rendered identically: ${JSON.stringify(r.deadStates)}`);

    const verdict = await assertAnimated(r.path, { seconds: 10, reveals: r.reveals, dir: DIR, index: 92, ffmpeg });
    assert.equal(verdict.ok, true, `a real animated graphic must pass: ${verdict.failures.join(" | ")}`);

    // The discriminating check, on the same clip that the push-only case fails.
    const seq = await verifyStateSequence(r.path, {
      states: r.states, framePaths: r.framePaths, seconds: 10, dir: DIR, ffmpeg, index: 92,
    });
    assert.equal(seq.ok, true, `a real graphic must step through its states: ${seq.failures.join(" | ")}`);
    assert.ok(new Set(seq.matches.map((m) => m.matched)).size >= 3, `expected several distinct states, got ${JSON.stringify(seq.matches)}`);
  });

  test("a real reveal sequence differs state to state", async () => {
    const labels = revealLabels("NUMBER_BREAKDOWN", spec);
    assert.deepEqual(labels, ["School district", "County", "City", "$7,600"]);
    let previous = null;
    for (let v = 0; v <= labels.length; v++) {
      const png = await renderCardPng("NUMBER_BREAKDOWN", spec, { visible: v, current: v - 1, pulse: 0 });
      if (previous) {
        const d = await frameDifference(previous, png);
        assert.ok(d > 0.02, `state ${v - 1}->${v} rendered identically (diff ${d})`);
      }
      previous = png;
    }
  });

  test("a card renders its reveal states without reflowing the layout", async () => {
    // The geometry must come from the full spec at every state. If it did not,
    // the rows would creep up the frame as the table filled.
    const partial = await renderCardPng("NUMBER_BREAKDOWN", spec, { visible: 1, current: 0, pulse: 0 });
    const full = await renderCardPng("NUMBER_BREAKDOWN", spec, { visible: 99, current: -1, pulse: 0 });
    const a = await sharp(partial).greyscale().raw().toBuffer({ resolveWithObject: true });
    const b = await sharp(full).greyscale().raw().toBuffer({ resolveWithObject: true });
    assert.equal(a.info.width, b.info.width);
    assert.equal(a.info.height, b.info.height);
  });

  test("the state sequence always ends settled, never mid-pulse", () => {
    const states = buildStates({
      type: "NUMBER_BREAKDOWN",
      labels: ["a", "b"],
      reveals: [{ at: 1, label: "a" }, { at: 4, label: "b" }],
      beats: [],
      seconds: 10,
    });
    const last = states.at(-1);
    assert.equal(last.pulse, 0, "a viewer pausing on the last frame must not see a half-emphasised row");
    assert.equal(last.visible, Infinity);
  });

  test("no planned state holds longer than the static rule allows", () => {
    const p = planReveals({ labels: ["a", "b"], words: null, seconds: 20 });
    const states = buildStates({ type: "LIST", labels: ["a", "b"], reveals: p.reveals, beats: p.beats, seconds: 20 });
    for (let i = 1; i < states.length; i++) {
      const gap = states[i].at - states[i - 1].at;
      assert.ok(gap <= 2.05, `a ${gap}s hold at ${states[i - 1].at}s breaks the ~2s rule`);
    }
  });
});

describe("10. the chain is deterministic across cold runs", () => {
  const segments = [
    voiceover("t1", "Most people think the tax rate is the whole story. It is not.", 12),
    voiceover("t2", "Two houses at the same price can differ by four thousand dollars.", 11, {
      type: "NUMBER_BREAKDOWN",
      spec: { title: "Where it goes", rows: [{ label: "School district", value: "$4,200" }, { label: "County", value: "$1,100" }] },
    }),
    voiceover("t3", "Here is the street on a Tuesday afternoon.", 9, { type: "FOOTAGE", spec: { keywords: ["suburban street texas"] } }),
  ];

  const stubs = {
    renderGraphic: async () => ({ ok: true, path: "/tmp/g.mp4", timing: { syncedCount: 2, source: "word-timing" } }),
    fetchStock: async () => ({
      clip: { path: "/tmp/s.mp4", seconds: 9, contentHash: "abc123", credit: { line: "Video by A. Photographer on Pexels", photographer: "A. Photographer" } },
      attempts: [],
    }),
    ownedFor: () => 0,
  };

  test("two cold runs produce identical plans", async () => {
    const a = await planVisuals(segments, stubs);
    const b = await planVisuals(segments, stubs);
    assert.deepEqual(
      a.segments.map((s) => ({ id: s.takeId, blocks: s.visualBlocks, primary: s.visualPrimary })),
      b.segments.map((s) => ({ id: s.takeId, blocks: s.visualBlocks, primary: s.visualPrimary }))
    );
    assert.deepEqual(a.coverage, b.coverage);
  });

  test("reveal planning is pure — same inputs, same output", () => {
    const words = [{ word: "school", start: 2, end: 2.4 }, { word: "county", start: 5, end: 5.4 }];
    const a = planReveals({ labels: ["School district", "County"], words, seconds: 10 });
    const b = planReveals({ labels: ["School district", "County"], words, seconds: 10 });
    assert.deepEqual(a, b);
  });

  test("typography planning is pure", () => {
    const text = "It is not the rate. It is the line item under it, and nobody reads it.";
    assert.deepEqual(planTypography({ text, words: null, seconds: 14 }), planTypography({ text, words: null, seconds: 14 }));
  });

  test("the grade is a pure function of its arguments", () => {
    assert.deepEqual(
      gradeArgs("in.mp4", "out.mp4", { seconds: 8 }),
      gradeArgs("in.mp4", "out.mp4", { seconds: 8 })
    );
  });

  test("the same bytes always hash the same, different bytes do not", () => {
    const a = Buffer.from("clip-one");
    assert.equal(stockContentHash(a), stockContentHash(Buffer.from("clip-one")));
    assert.notEqual(stockContentHash(a), stockContentHash(Buffer.from("clip-two")));
  });

  test("the coverage split adds up to the voiceover runtime", async () => {
    const { coverage } = await planVisuals(segments, stubs);
    const summed = Object.values(coverage.bySource).reduce((n, v) => n + v, 0);
    assert.ok(Math.abs(summed - coverage.voiceoverSeconds) < 0.05, `${summed} vs ${coverage.voiceoverSeconds}`);
    assert.equal(coverage.uncoveredSeconds, 0);
  });
});

describe("credits satisfy the Pexels API terms", () => {
  test("stock in the video means a Pexels link and a photographer credit", () => {
    const block = creditsBlock([
      { line: "Video by A. Photographer on Pexels — https://pexels.com/video/1" },
      { line: "Video by B. Shooter on Pexels — https://pexels.com/video/2" },
    ]);
    assert.match(block, /pexels\.com/i, "the API guidelines require a prominent link to Pexels");
    assert.match(block, /A\. Photographer/);
    assert.match(block, /B\. Shooter/);
  });

  test("duplicates collapse", () => {
    const one = { line: "Video by A on Pexels" };
    assert.equal(creditsBlock([one, one, one]).split("\n").length, 2);
  });

  test("no stock means no dangling header", () => {
    assert.equal(creditsBlock([]), "");
    assert.equal(creditsBlock([null, undefined]), "");
  });
});

describe("the opening is never a static talking face", () => {
  const hookStates = [{ at: 0.4 }, { at: 0.62 }, { at: 0.84 }, { at: 1.06 }, { at: 1.28 }];

  test("a complete opening passes", () => {
    const r = auditOpeningMotion({
      piece: { pulses: [{ at: 0.2 }], push: { from: 1, to: 1.08, seconds: 3.5 } },
      hookStates,
      teaserAt: openingTeaserAt(hookStates),
    });
    assert.equal(r.ok, true, r.failures.join(" | "));
  });

  test("the teaser follows the hook rather than sitting at a fixed second 3", () => {
    // A fast hook finishes early. Pinning the teaser to 2.6s would leave over a
    // second of static face in the middle of the opening — which the gap check
    // below catches, and which is why this timing is derived.
    const fast = [{ at: 0.4 }, { at: 0.62 }, { at: 0.84 }, { at: 1.06 }, { at: 1.28 }];
    assert.equal(openingTeaserAt(fast), 1.88);
    assert.equal(auditOpeningMotion({ piece: { pulses: [{ at: 0.2 }] }, hookStates: fast, teaserAt: 2.6 }).ok, false);
    assert.equal(auditOpeningMotion({ piece: { pulses: [{ at: 0.2 }] }, hookStates: fast, teaserAt: openingTeaserAt(fast) }).ok, true);
  });

  test("a long hook never pushes the teaser past second 3", () => {
    const long = Array.from({ length: 9 }, (_, i) => ({ at: 0.4 + i * 0.28 }));
    assert.ok(openingTeaserAt(long) <= 3.0);
  });

  test("pulses turned off is caught", () => {
    const r = auditOpeningMotion({ piece: { pulses: [], push: null }, hookStates, teaserAt: 2.6 });
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => /first beat/.test(f)));
  });

  test("a hook that finishes after second 3 is caught", () => {
    const late = [{ at: 0.4 }, { at: 3.9 }];
    const r = auditOpeningMotion({ piece: { pulses: [{ at: 0.2 }] }, hookStates: late, teaserAt: 2.6 });
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => /3s mark|not fully on screen/.test(f)));
  });

  test("no teaser element is caught", () => {
    const r = auditOpeningMotion({ piece: { pulses: [{ at: 0.2 }] }, hookStates, teaserAt: null });
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => /no graphic or typography element/.test(f)));
  });

  test("a dead second in the middle of the opening is caught", () => {
    const r = auditOpeningMotion({
      piece: { pulses: [{ at: 0.2 }] },
      hookStates: [{ at: 0.4 }, { at: 0.6 }],
      teaserAt: 2.9,
    });
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => /nothing happens between/.test(f)));
  });
});
