/**
 * yt-rev10-feel.test.mjs — the card-11 sweep: every gap the artifact showed,
 * as a scenario that must stay closed.
 *
 * Card 11 was mechanically clean — duration on plan, zero clicks, honest
 * speed — and unwatchable: 84 seconds of frozen frames with dead captions,
 * a rooster over the Timberwood Park narration, 55% of the voiceover carried
 * by wordless geometry, cards sitting empty for twelve seconds. Each scenario
 * here is one of those defects reduced to the smallest input that produces it,
 * plus the negative controls that keep the checks themselves honest.
 *
 * The ffmpeg-dependent scenarios skip where ffmpeg is missing, exactly like
 * the artifact-QC suite. The pure ones run everywhere.
 */

import { test, describe } from "node:test";
import assert from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildVisuals, bridgeBeats } from "../src/yt-visual-build.js";
import { planSegmentCoverage } from "../src/yt-visual-plan.js";
import { keywordsForWindow, documentFrequencies, properLexicon } from "../src/yt-scene-keywords.js";
import { deriveConcept, sanitiseConcept } from "../src/yt-concept-fallback.js";
import { buildStates, assertClipCovers } from "../src/yt-visual-animate.js";
import { planReveals } from "../src/yt-reveal-timing.js";
import {
  conformArgs, assertPictureCoversAudio, buildCaptionChunks,
  muxNarrationArgs, concatArgs, ffmpeg as runFfmpeg, canvasFor,
} from "../src/yt-assemble.js";
import { checkMotion } from "../src/yt-artifact-qc.js";
import { EMPTY_CARD_MAX_HOLD, GRAPHIC_GRAIN_STRENGTH, BEAT_BRIDGE_MAX_SECONDS } from "../src/yt-config.js";

const have = (bin) => {
  const res = spawnSync(bin, ["-version"], { encoding: "utf-8" });
  return !res.error && res.status === 0;
};
const HAVE_FFMPEG = have("ffmpeg");

/** A vision/concept client whose answers the scenario scripts. */
function fakeClient(conceptAnswer) {
  return {
    messages: {
      create: async ({ messages }) => {
        const text = String(messages?.[0]?.content || "");
        // The concept prompt is plain text; the vision prompt is multimodal
        // (an array) — this fake only ever sees the concept path because the
        // vision check lives inside the injected stock fetcher.
        if (typeof conceptAnswer === "function") return conceptAnswer(text);
        return { content: [{ type: "text", text: JSON.stringify(conceptAnswer) }] };
      },
    },
  };
}

/** A stock fetcher whose per-query behaviour the scenario scripts. */
function fakeFetcher(decide) {
  const calls = [];
  const fn = async (opts) => {
    calls.push({ keywords: opts.keywords, subject: opts.subject, seconds: opts.seconds });
    return decide(opts, calls.length);
  };
  fn.calls = calls;
  return fn;
}

const vo = (id, text, seconds, intent = "FOOTAGE") => ({
  kind: "voiceover", takeId: id, section: "Sweep section", text, seconds, visualIntent: intent,
});

const noWords = async () => null;

describe("card-11 sweep: the fallback ladder", () => {
  test("a window where stock and concept both fail bridges into its neighbour, never a full-window beat", async (t) => {
    if (!HAVE_FFMPEG) return t.skip("ffmpeg not installed");
    const dir = mkdtempSync(join(tmpdir(), "sweep-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));

    process.env.PEXELS_API_KEY = "sweep-test-key";
    t.after(() => { delete process.env.PEXELS_API_KEY; });

    // Window 1 gets a clip; window 2 dies at vision AND the concept rung dies
    // too. The beat that results must be a bridge, with the difference played
    // by the neighbour's spare footage.
    const clipPath = join(dir, "clip.mp4");
    runFfmpeg(["-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=30:duration=16", "-pix_fmt", "yuv420p", clipPath]);
    const fetcher = fakeFetcher((opts, n) =>
      n === 1
        ? { clip: { path: clipPath, seconds: opts.seconds, gradedSeconds: 16, contentHash: `h${n}`, credit: { line: "test" }, query: opts.keywords[0] }, attempts: [] }
        : { clip: null, attempts: [{ stage: "vision", reason: "sweep: rejected" }] }
    );
    const client = fakeClient({ filmable: false });

    const plan = { segments: [vo("t1", "The kitchen has a big island and the yard has oak trees over the patio out back there.", 16)] };
    const { report, plan: built } = await buildVisuals(plan, {
      workDir: dir, ffmpeg: runFfmpeg, getWordTimestamps: noWords,
      visionClient: client, stockFetcher: fetcher,
    });

    const broll = built.segments[0].broll;
    const beats = broll.filter((b) => b.kind === "beat");
    for (const b of beats) {
      assert.ok(b.seconds <= BEAT_BRIDGE_MAX_SECONDS + 0.05, `a beat held ${b.seconds}s — the bridge did not fire`);
    }
    const total = broll.reduce((n, b) => n + b.seconds, 0);
    assert.ok(Math.abs(total - 16) < 0.06, `the clock moved: ${total}s of picture for 16s of narration`);
    assert.ok(report.beatBridges.some((b) => b.capped), "the bridge reported its work");
  });

  test("a take that is all abstract talk resolves via the concept rung, and the report says so", async (t) => {
    if (!HAVE_FFMPEG) return t.skip("ffmpeg not installed");
    const dir = mkdtempSync(join(tmpdir(), "sweep-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    process.env.PEXELS_API_KEY = "sweep-test-key";
    t.after(() => { delete process.env.PEXELS_API_KEY; });

    const clipPath = join(dir, "clip.mp4");
    runFfmpeg(["-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=30:duration=16", "-pix_fmt", "yuv420p", clipPath]);
    // The window's own words die; the concept query succeeds.
    const fetcher = fakeFetcher((opts) =>
      opts.keywords?.[0] === "family front yard"
        ? { clip: { path: clipPath, seconds: opts.seconds, gradedSeconds: 16, contentHash: "c1", credit: { line: "t" }, query: opts.keywords[0] }, attempts: [] }
        : { clip: null, attempts: [{ stage: "vision", reason: "sweep: no" }] }
    );
    const client = fakeClient({ filmable: true, query: "family front yard", subject: "a family in a front yard" });

    const plan = { segments: [vo("t1", "This matters even if it never seems like it would matter to anybody at all honestly.", 8)] };
    const { report } = await buildVisuals(plan, {
      workDir: dir, ffmpeg: runFfmpeg, getWordTimestamps: noWords,
      visionClient: client, stockFetcher: fetcher,
    });

    const conceptRows = report.stockWindows.filter((w) => w.source === "concept" && w.matched);
    assert.ok(conceptRows.length >= 1, `no window resolved via concept: ${JSON.stringify(report.stockWindows)}`);
    assert.ok(report.conceptCalls.asked >= 1 && report.conceptCalls.matched >= 1, JSON.stringify(report.conceptCalls));
  });

  test("when every rung fails for a whole take with stock live, the build fails loudly instead of shipping geometry", async (t) => {
    if (!HAVE_FFMPEG) return t.skip("ffmpeg not installed");
    const dir = mkdtempSync(join(tmpdir(), "sweep-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    process.env.PEXELS_API_KEY = "sweep-test-key";
    t.after(() => { delete process.env.PEXELS_API_KEY; });

    const fetcher = fakeFetcher(() => ({ clip: null, attempts: [{ stage: "vision", reason: "sweep: rejected" }] }));
    // The vision model ERRORING is this same scenario: deriveConcept fails
    // closed, the ladder runs out, and the honest outcome is a named failure —
    // not twelve minutes of gold circles over the take that names the subject.
    const client = fakeClient(() => { throw new Error("sweep: model down"); });

    const plan = { segments: [vo("t1", "Nothing here can be filmed and nothing will be found for it either way.", 10)] };
    await assert.rejects(
      () => buildVisuals(plan, { workDir: dir, ffmpeg: runFfmpeg, getWordTimestamps: noWords, visionClient: client, stockFetcher: fetcher }),
      /full-window beats survived with stock live.*t1/s
    );
  });

  test("the dry run — no stock configured — keeps its beats and does NOT fail", async (t) => {
    if (!HAVE_FFMPEG) return t.skip("ffmpeg not installed");
    const dir = mkdtempSync(join(tmpdir(), "sweep-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    delete process.env.PEXELS_API_KEY;

    const plan = { segments: [vo("t1", "A dry run take with no stock behind it at all.", 6)] };
    const { plan: built } = await buildVisuals(plan, {
      workDir: dir, ffmpeg: runFfmpeg, getWordTimestamps: noWords, visionClient: null,
    });
    const beats = built.segments[0].broll.filter((b) => b.kind === "beat");
    assert.ok(beats.length >= 1, "the dry run's floor is still the beat");
  });
});

describe("card-11 sweep: queries and concepts", () => {
  test("spatial words never lead a query — the [northeast anybody] regression", () => {
    // WHAT THIS PINS AND WHAT IT DOES NOT. Direction words are out of the
    // query — that much is mechanical and stays. What the mechanical ladder
    // still cannot know is that "homes yard" beats "anybody expects": rarity
    // has no notion of filmability, which is measured fact (this very
    // sentence yields "anybody expects" once "northeast" is gone). THAT gap
    // belongs to the concept rung, tested below — a query this weak dies at
    // search or vision and the model names the yard instead.
    const seg = {
      takeId: "s4t4", kind: "voiceover", seconds: 8,
      text: "on the northeast side. Bigger homes, more yard, and a much easier drive than anybody expects.",
    };
    const w = keywordsForWindow(seg, { startAt: 0, seconds: 8 }, {
      frequencies: documentFrequencies([seg]), lexicon: properLexicon([seg]),
    });
    const queryWords = (w.keywords[0] || "").split(/\s+/);
    for (const q of queryWords) {
      assert.ok(!["northeast", "north", "south", "closest", "further"].includes(q), `a direction word leads the query: ${w.keywords[0]}`);
    }
  });

  test("the concept sanitiser strips place names, directions and figures a model sneaks in", () => {
    const banned = new Set(["timberwood", "park"]);
    assert.equal(sanitiseConcept("Timberwood Park front yard", { banned }), "front yard");
    assert.equal(sanitiseConcept("homes northeast of downtown", { banned: new Set(["downtown"]) }), "homes");
    assert.equal(sanitiseConcept("$400 closing costs", {}), "closing costs");
    assert.equal(sanitiseConcept("Timberwood Park", { banned }), null, "an answer that is ONLY a name yields nothing");
  });

  test("a misbehaving model cannot reach a search: deriveConcept passes its output through the sanitiser", async () => {
    const client = fakeClient({ filmable: true, query: "Stone Oak entrance", subject: "the Stone Oak neighbourhood entrance" });
    const banned = new Set(["stone", "oak"]);
    const concept = await deriveConcept({ phrase: "x", takeText: "x", sectionTitle: "s", banned, client });
    assert.ok(concept, "the concept survives with the name removed");
    assert.ok(!/stone|oak/i.test(concept.query), concept.query);
    assert.ok(!/stone|oak/i.test(concept.subject), concept.subject);
  });

  test("a model error fails closed to null — the ladder moves on", async () => {
    const client = fakeClient(() => { throw new Error("boom"); });
    assert.equal(await deriveConcept({ phrase: "anything", client }), null);
    const junk = fakeClient(() => ({ content: [{ type: "text", text: "not json at all" }] }));
    assert.equal(await deriveConcept({ phrase: "anything", client: junk }), null);
    const declined = fakeClient({ filmable: false });
    assert.equal(await deriveConcept({ phrase: "anything", client: declined }), null);
  });
});

describe("card-11 sweep: the bridge under pressure", () => {
  test("caps fighting on a 9s window: the split beat bridges back into the stock it split from", () => {
    // A 9s FOOTAGE take splits 4.5+4.5 to honour the cap (stock cannot repeat,
    // so the second half is born a beat). The bridge must then retire that
    // beat into the clip's graded slack without breaching the cap again.
    const coverage = planSegmentCoverage(
      { takeId: "t9", seconds: 9, visual: "FOOTAGE", visualSpec: { keywords: [] } },
      { stockSeconds: 9 }
    );
    const blocks = coverage.blocks.map((b) => (b.kind === "stock" ? { ...b, sourceSeconds: 17 } : { ...b }));
    const bridges = [];
    bridgeBeats(blocks, { max: 2, sceneMax: 8, beatBridges: bridges });
    const total = blocks.reduce((n, b) => n + b.seconds, 0);
    assert.ok(Math.abs(total - 9) < 0.02, `the clock moved: ${total}`);
    for (const b of blocks) {
      if (b.kind === "beat") assert.ok(b.seconds <= 2.01, `beat ${b.seconds}s`);
      assert.ok(b.seconds <= 8 + 1.6 + 0.01, `a scene grew past the cap: ${b.seconds}s`);
    }
  });

  test("a beat landing exactly on the segment seam bridges backwards and the clock holds", () => {
    const blocks = [
      { kind: "stock", seconds: 8, sourceSeconds: 20 },
      { kind: "beat", seconds: 6 },
    ];
    const bridges = [];
    bridgeBeats(blocks, { max: 2, sceneMax: 8, beatBridges: bridges });
    assert.equal(blocks[blocks.length - 1].kind, "beat", "the bridge stays at the seam");
    assert.ok(blocks[blocks.length - 1].seconds <= 2.01);
    assert.ok(Math.abs(blocks.reduce((n, b) => n + b.seconds, 0) - 14) < 0.02);
    // The continuation the overflow became is real content, not a replay.
    assert.ok(blocks.some((b) => b.continuation), "overflow became a continuation scene");
  });

  test("graphic capacity is the render, and slices stay contiguous through a bridge", async (t) => {
    if (!HAVE_FFMPEG) return t.skip("ffmpeg not installed");
    // Pure arithmetic version: a graphic take whose beats hand seconds back to
    // the graphic. The graphic's spare is its render minus what is displayed,
    // which for a full-take render is exactly the beats' own seconds.
    const blocks = [
      { kind: "graphic", seconds: 8 },
      { kind: "beat", seconds: 8 },
      { kind: "graphic", seconds: 4 },
    ];
    bridgeBeats(blocks, { max: 2, sceneMax: 8, graphicSeconds: 20, beatBridges: [] });
    const beat = blocks.find((b) => b.kind === "beat");
    assert.ok(beat.seconds <= 2.01, `the beat still holds ${beat.seconds}s`);
    const graphicTotal = blocks.filter((b) => b.kind === "graphic").reduce((n, b) => n + b.seconds, 0);
    assert.ok(Math.abs(graphicTotal + beat.seconds - 20) < 0.02, "the graphic side absorbed exactly the beat's surrender");
    assert.ok(graphicTotal <= 20 + 0.01, "the graphic never displays more than its render holds");
  });
});

describe("card-11 sweep: frozen-frame class", () => {
  test("a clip shorter than its slot is named before it can freeze", async (t) => {
    if (!HAVE_FFMPEG) return t.skip("ffmpeg not installed");
    const dir = mkdtempSync(join(tmpdir(), "sweep-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const short = join(dir, "short.mp4");
    runFfmpeg(["-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=30:duration=1", "-pix_fmt", "yuv420p", short]);
    const verdict = await assertClipCovers(short, { seconds: 3, dir, ffmpeg: runFfmpeg });
    assert.equal(verdict.ok, false);
    assert.match(verdict.failures.join(" "), /run out|freeze|loop/);
  });

  test("a clip that is one frame in a trench coat is named too", async (t) => {
    if (!HAVE_FFMPEG) return t.skip("ffmpeg not installed");
    const dir = mkdtempSync(join(tmpdir(), "sweep-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const png = join(dir, "still.png");
    runFfmpeg(["-y", "-f", "lavfi", "-i", "color=c=0x223344:s=320x180:d=1", "-frames:v", "1", png]);
    const still = join(dir, "still.mp4");
    runFfmpeg(["-y", "-loop", "1", "-t", "3", "-i", png, "-pix_fmt", "yuv420p", still]);
    const verdict = await assertClipCovers(still, { seconds: 3, dir, ffmpeg: runFfmpeg });
    assert.equal(verdict.ok, false);
    assert.match(verdict.failures.join(" "), /still/);
  });

  test("a segment whose picture ends before its narration throws with the take's name on it", (t) => {
    if (!HAVE_FFMPEG) return t.skip("ffmpeg not installed");
    const dir = mkdtempSync(join(tmpdir(), "sweep-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const bad = join(dir, "bad.mp4");
    // 2s of picture, 6s of audio — the exact shape of card 11's frozen tails.
    runFfmpeg([
      "-y",
      "-f", "lavfi", "-i", "testsrc=size=320x180:rate=30:duration=2",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=6:sample_rate=48000",
      "-map", "0:v", "-map", "1:a",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", bad,
    ]);
    assert.throws(() => assertPictureCoversAudio(bad, "s5t5"), /s5t5.*picture ends.*before the narration/s);
  });

  test("the motion gate refuses an ungrained hold and passes the same hold through the real conform grain", async (t) => {
    if (!HAVE_FFMPEG) return t.skip("ffmpeg not installed");
    const dir = mkdtempSync(join(tmpdir(), "sweep-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const png = join(dir, "card.png");
    runFfmpeg(["-y", "-f", "lavfi", "-i", "color=c=0x111111:s=640x360:d=1", "-frames:v", "1", png]);
    const still = join(dir, "hold.mp4");
    runFfmpeg(["-y", "-loop", "1", "-t", "12", "-i", png, "-r", "30", "-pix_fmt", "yuv420p", still]);

    const bare = checkMotion({ path: still, duration: 12 });
    assert.equal(bare.ok, false, "an ungrained 12s hold must fail the gate");

    const dim = { w: 640, h: 360 };
    const grained = join(dir, "grained.mp4");
    runFfmpeg(conformArgs(still, grained, dim, { seconds: 12, grain: GRAPHIC_GRAIN_STRENGTH }));
    const textured = checkMotion({ path: grained, duration: 12 });
    assert.equal(textured.ok, true, `the grained hold still fails: ${JSON.stringify(textured.failures?.slice(0, 2))}`);
  });

  test("stock is conformed without grain — a sensor already did it", () => {
    const dim = canvasFor("1080p");
    const withGrain = conformArgs("in.mp4", "out.mp4", dim, { seconds: 5, grain: GRAPHIC_GRAIN_STRENGTH }).join(" ");
    const without = conformArgs("in.mp4", "out.mp4", dim, { seconds: 5, grain: 0 }).join(" ");
    assert.match(withGrain, /noise=c0s=/);
    assert.doesNotMatch(without, /noise=/);
  });
});

describe("card-11 sweep: cards that arrive and clocks that agree", () => {
  test("a clock time arrives whole — no 'Tuesday, 0:15 AM' ever renders", () => {
    const states = buildStates({
      type: "CALLOUT",
      labels: ["Tuesday, 7:15 AM"],
      reveals: [{ at: 2, label: "Tuesday, 7:15 AM", index: 0 }],
      beats: [],
      seconds: 10,
      spec: { value: "Tuesday, 7:15 AM", label: "drive it before you sign" },
    });
    // The counting path emits many intermediate progress states; the arrival
    // path emits none. An intermediate progress on a clock value is the bug.
    assert.ok(!states.some((s) => s.progress > 0 && s.progress < 1), "a clock time must not ease through false times");
  });

  test("the first reveal lands inside the empty-card bound wherever its word fell", () => {
    const words = [{ word: "framing", start: 0.5, end: 1 }, { word: "item", start: 12, end: 12.4 }];
    const plan = planReveals({ labels: ["item one", "item two"], words, seconds: 20 });
    assert.ok(plan.reveals[0].at <= EMPTY_CARD_MAX_HOLD + 0.01, `first reveal at ${plan.reveals[0].at}`);
    const narration = planReveals({ labels: ["item one", "item two"], words, seconds: 20, order: "narration" });
    assert.ok(narration.reveals[0].at <= EMPTY_CARD_MAX_HOLD + 0.01, `narration-order first reveal at ${narration.reveals[0].at}`);
    // The pulled reveal may not claim its word anymore.
    assert.equal(plan.reveals[0].synced, false);
  });

  test("renderTimeline refuses a broll entry whose file is gone — the silent-skip class", async (t) => {
    if (!HAVE_FFMPEG) return t.skip("ffmpeg not installed");
    const { renderTimeline } = await import("../src/yt-assemble.js");
    const dir = mkdtempSync(join(tmpdir(), "sweep-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const narration = join(dir, "narr.m4a");
    runFfmpeg(["-y", "-f", "lavfi", "-i", "sine=frequency=300:duration=4:sample_rate=48000", "-c:a", "aac", narration]);
    const plan = {
      segments: [{
        kind: "voiceover", takeId: "sab1", seconds: 4, text: "four seconds of words",
        narrationSource: narration,
        broll: [{ generated: true, preRendered: true, kind: "beat", sourcePath: join(dir, "never-written.mp4"), seconds: 4 }],
      }],
    };
    await assert.rejects(
      () => renderTimeline(plan, { workDir: join(dir, "work"), resolveBrollPath: () => null }),
      /sab1.*source missing/s,
      "a vanished piece must stop the build with the take's name, not shorten the picture"
    );
  });

  test("scene boundaries and caption chunks share one clock — the card-7 drift stays dead", () => {
    const plan = {
      segments: [
        { kind: "voiceover", takeId: "a", seconds: 18.37, text: Array(40).fill("word").join(" ") },
        { kind: "on_camera", takeId: "b", seconds: 12.02, text: "spoken on camera here" },
        { kind: "voiceover", takeId: "c", seconds: 21.6, text: Array(52).fill("word").join(" ") },
      ],
    };
    const chunks = buildCaptionChunks(plan);
    // The last chunk of each narrated segment must END exactly on the segment
    // boundary the scene grid uses — same clock, no accumulation.
    let elapsed = 0;
    for (const seg of plan.segments) {
      elapsed += seg.seconds;
      if (!seg.text) continue;
      const inSeg = chunks.filter((c) => c.end <= elapsed + 0.001);
      const last = inSeg[inSeg.length - 1];
      assert.ok(Math.abs(last.end - elapsed) < 0.02, `caption clock drifted ${Math.abs(last.end - elapsed)}s by ${seg.takeId}`);
    }
  });
});
