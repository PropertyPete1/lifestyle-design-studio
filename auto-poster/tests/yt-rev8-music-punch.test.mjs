/**
 * yt-rev8-music-punch.test.mjs — the bed, the punches, the per-window stock,
 * and the synthesised hits.
 *
 * The load-bearing assertions here are the ones about AGREEMENT: a punch must
 * say what the captions say, and a stock search must never name a place. Both
 * are properties card 7 got wrong in a way that looked fine until somebody
 * watched the video, so both are checked structurally rather than by eye.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  TRACKS, LICENCE, pickTrack, trackUrl, creditLine, musicCreditsBlock,
  bedEnvelope, dbToGain, fetchMusicBed, cacheKey, musicReport,
} from "../src/yt-music.js";
import {
  punchCandidatesFor, selectPunches, captionTextFor, chunkStartFor,
  punchDisplay, punchSvg, PUNCH_CLASS,
} from "../src/yt-punch.js";
import {
  classifyTokens, keywordsForWindow, windowTokens, documentFrequencies, planWindowKeywords, properLexicon,
} from "../src/yt-scene-keywords.js";
import { punchSfxTimeline, mixSfxArgs, impactArgs, whooshArgs } from "../src/yt-sfx.js";
import { buildCaptionChunks, burnArgs, duckArgs, plannedSeconds } from "../src/yt-assemble.js";

const DIR = mkdtempSync(join(tmpdir(), "rev8-mp-"));

// ─── 1. the bed ─────────────────────────────────────────────────────────────

describe("1. the music bed", () => {
  test("every vendored track is longer than any video this pipeline makes", () => {
    // The modification disclosure rests on this. A bed that had to LOOP would be
    // "lengthening" the work under incompetech's terms and would owe a more
    // careful statement than "trimmed to length".
    for (const t of TRACKS) {
      assert.ok(t.seconds > 15 * 60, `${t.title} is ${t.seconds}s — a 15 minute video would loop it`);
    }
  });

  test("every track carries the licence evidence a dispute would need", () => {
    for (const t of TRACKS) {
      assert.ok(t.isrc && /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(t.isrc), `${t.title} needs a well-formed ISRC`);
      assert.ok(trackUrl(t).startsWith("https://incompetech.com/"), "and a source URL");
    }
    assert.equal(LICENCE.attributionRequired, true);
  });

  test("the credit names the licensor, the licence, and what we changed", () => {
    const line = creditLine(TRACKS[0]);
    assert.ok(line.includes(TRACKS[0].title));
    assert.ok(line.includes("Kevin MacLeod"));
    assert.ok(line.includes("creativecommons.org/licenses/by/4.0/"), "the licence URL is part of the required form");
    // The modification clause: the credit must make clear which parts are ours.
    assert.ok(/trimmed/i.test(line) && /mix/i.test(line), "the edit must be disclosed, not implied");
  });

  test("no bed means no music block in the description", () => {
    assert.equal(musicCreditsBlock(null), "");
    assert.ok(musicCreditsBlock(TRACKS[0]).startsWith("Music"));
  });

  test("track choice is stable for one script and spread across scripts", () => {
    assert.equal(pickTrack("Where to live in North San Antonio").id, pickTrack("Where to live in North San Antonio").id);
    const picks = new Set(
      ["schools", "property taxes", "flood plains", "closing costs", "commute times", "HOA fees"].map((s) => pickTrack(s).id)
    );
    assert.ok(picks.size > 1, "different scripts must not all land on one track");
  });

  test("the envelope lifts at the hook and the close and ramps between", () => {
    const env = bedEnvelope({ seconds: 720, hookSeconds: 15, closeSeconds: 20, ramp: 2, db: -14, liftDb: 5 });
    assert.equal(env.shaped, true);
    assert.ok(env.lift > env.body, "the lift must actually be louder");
    assert.equal(env.body, dbToGain(-14));
    assert.equal(env.lift, dbToGain(-9));
    // The close begins where the expression says it does.
    assert.ok(env.expr.includes("700"), "the close starts 20s from the end");
    // Every branch is a number or a ramp; an unbalanced expression would make
    // ffmpeg fail at filter-init, twelve minutes into a render.
    assert.equal((env.expr.match(/\(/g) || []).length, (env.expr.match(/\)/g) || []).length);
  });

  test("a video too short to shape gets one flat level, not a folded envelope", () => {
    const env = bedEnvelope({ seconds: 30, hookSeconds: 15, closeSeconds: 20 });
    assert.equal(env.shaped, false);
    assert.equal(env.expr, String(env.body));
  });

  test("the duck applies the envelope per frame, before the compressor", () => {
    const env = bedEnvelope({ seconds: 720 });
    const args = duckArgs("in.mp4", "bed.mp3", "out.mp4", { envelope: env });
    const graph = args[args.indexOf("-filter_complex") + 1];
    assert.ok(graph.includes("eval=frame"), "without eval=frame the whole video plays at t=0's level");
    // The bed is levelled first, then sidechained. Raising it afterwards would
    // hand back exactly the headroom the duck removed.
    assert.ok(graph.indexOf("volume=eval=frame") < graph.indexOf("sidechaincompress"));
  });

  test("the bed is OFF unless a build asks for it", async () => {
    // The baseline strip made every added layer opt-in: a workflow that forgets
    // to mention the knob gets a video with no bed, rather than a video with a
    // bed nobody reviewed. `enabled` is how the rest of this suite still reaches
    // the acquisition logic behind it.
    const r = await fetchMusicBed({
      track: TRACKS[0], dir: DIR,
      fetchImpl: async () => { throw new Error("must not reach the network"); },
    });
    assert.equal(r.path, null);
    assert.match(r.reason, /YT_MUSIC is off/);
  });

  test("a download that returns an error page is not accepted as a track", async () => {
    const r = await fetchMusicBed({
      track: TRACKS[0], dir: DIR, enabled: true,
      fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(512) }),
    });
    assert.equal(r.path, null);
    assert.match(r.reason, /too small/);
  });

  test("a failed fetch is reported, never thrown — the video ships without music", async () => {
    const r = await fetchMusicBed({
      track: TRACKS[1], dir: DIR, enabled: true,
      fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
    });
    assert.equal(r.path, null);
    assert.match(r.reason, /ECONNREFUSED/);
    assert.equal(musicReport(r).used, false);
  });

  test("the Drive cache is preferred over the network", async () => {
    let fetched = false;
    const r = await fetchMusicBed({
      track: TRACKS[2], dir: DIR, enabled: true,
      driveGet: async (name) => { assert.equal(name, cacheKey(TRACKS[2])); return Buffer.alloc(600 * 1024, 1); },
      fetchImpl: async () => { fetched = true; throw new Error("should not reach the network"); },
    });
    assert.equal(r.source, "drive-cache");
    assert.equal(fetched, false);
  });
});

// ─── 2. the micro-punches ───────────────────────────────────────────────────

describe("2. micro-punches say what the captions say", () => {
  const seg = (takeId, text, seconds) => ({ takeId, kind: "voiceover", text, seconds });

  test("figures are found by shape, with no vocabulary anywhere", () => {
    const c = punchCandidatesFor(seg("t", "you pay $0 up front and 100% of the fee comes back by month nine.", 20));
    const byText = Object.fromEntries(c.map((x) => [x.text, x.klass]));
    assert.equal(byText["$0"], PUNCH_CLASS.CURRENCY);
    assert.equal(byText["100%"], PUNCH_CLASS.PERCENT);
    // "month nine" is NOT here by default any more. The counted class is
    // switched off — see PUNCH_CLASS in yt-punch.js for the list of what it
    // actually put on screen across two revisions — and the scanner behind the
    // gate is checked in the next test.
    assert.equal(byText["month nine"], undefined);
  });

  test("the disabled classes are gated, not deleted", () => {
    // The finder is intact. Only what reaches the plan is narrowed, so widening
    // it again is a workflow change and nothing else.
    const c = punchCandidatesFor(
      seg("t", "you pay $0 up front and 100% of the fee comes back by month nine.", 20),
      { allowedClasses: ["currency", "percent", "counted", "figure"] }
    );
    const byText = Object.fromEntries(c.map((x) => [x.text, x.klass]));
    assert.equal(byText["month nine"], PUNCH_CLASS.COUNTED);
  });

  test("a proper noun followed by a number is a label, not an emphasis beat", () => {
    // "Loop 1604" is the exact shape of a counted noun and must not be punched —
    // it is a road, and putting it mid-screen in gold would be the stock layer's
    // mistake made in text.
    const c = punchCandidatesFor(seg("t", "just past Loop 1604 the lots get bigger.", 10));
    assert.ok(!c.some((x) => /Loop/i.test(x.text)), `Loop 1604 must not be punchable: ${JSON.stringify(c)}`);
  });

  test("EVERY punch appears verbatim in its take's caption text", () => {
    // The card 7 guarantee. Checked against the string the captions actually
    // render — whitespace-normalised — not against the raw script.
    const plan = { segments: [
      seg("t1", "The first ninety seconds are all setup.", 30),
      seg("t2", "You put down $0 at closing, and 100% of that credit survives to month nine of the build.", 60),
      seg("t3", "That is the trade nobody explains up front.", 40),
    ] };
    const { punches } = selectPunches(plan, { enabled: true, max: 6, minGap: 5, protectedSeconds: 15 });
    assert.ok(punches.length > 0, "this script has punchable figures in it");
    for (const p of punches) {
      const take = plan.segments.find((s) => s.takeId === p.takeId);
      assert.ok(
        captionTextFor(take).includes(p.text),
        `"${p.text}" is not verbatim in take ${p.takeId}: "${captionTextFor(take)}"`
      );
      // Uppercase is the only transform, and it cannot change which word is there.
      assert.equal(p.display, punchDisplay(p.text));
      assert.equal(p.display.toLowerCase(), p.text.toLowerCase());
    }
  });

  test("a script written with ragged whitespace still yields verbatim punches", () => {
    // buildCaptionChunks splits on /\s+/ and joins with one space, so a punch
    // compared against the RAW script would pass here and fail on screen.
    const plan = { segments: [seg("t1", "hold\n\nthe   line at   100%   even  then", 40)] };
    const { punches } = selectPunches(plan, { enabled: true, minGap: 1, protectedSeconds: 0 });
    for (const p of punches) {
      assert.ok(captionTextFor(plan.segments[0]).includes(p.text));
    }
  });

  // ─── the 2026-08-11 card 9 failure ────────────────────────────────────────
  //
  // Two 30-plus-minute builds died at the pipeline's verbatim guard on
  // `micro-punch "highway ten" does not appear verbatim in take s4t5's
  // captions`. Whisper had transcribed the take as "…along highway, ten minutes
  // from the loop": "highway" + "ten" is exactly the shape of a counted noun,
  // and the counted-noun branch joined the two PUNCTUATION-STRIPPED tokens with
  // a space, producing a string the captions never contain.
  //
  // The module claimed verbatim-by-construction from the day it was written.
  // One branch did not honour it and the fixtures had no punctuation mid-phrase,
  // so nothing caught it until a real transcript did.

  test("a comma between the noun and the number is not a counted noun", () => {
    const s = seg("s4t5", "it runs right along highway, ten minutes from the loop", 40);
    const c = punchCandidatesFor(s);
    assert.deepEqual(c, [], `nothing here is an emphasis beat: ${JSON.stringify(c)}`);
  });

  test("a sentence boundary between them is not a counted noun either", () => {
    const s = seg("s4t5", "it runs right along highway. Ten minutes from the loop", 40);
    assert.deepEqual(punchCandidatesFor(s), []);
  });

  test("the counted scanner still works behind its gate", () => {
    // THIS TEST USED TO REQUIRE "highway ten" TO PUNCH, which is the road-name
    // defect written down as a requirement. It is kept, with the gate opened
    // explicitly, because the boundary rule it was guarding is still real and
    // still needs cover — but wanting the class ON is no longer the default,
    // and "highway ten" is now an example of what the gate is for rather than
    // an example of what the feature is for.
    const wide = { allowedClasses: ["currency", "percent", "counted", "figure"] };
    assert.ok(punchCandidatesFor(seg("t", "you are on highway ten minutes from the loop", 20), wide)
      .some((c) => c.text === "highway ten"));
    assert.ok(punchCandidatesFor(seg("t", "the credit survives to month nine of the build", 20), wide)
      .some((c) => c.text === "month nine"));
  });

  test("NO candidate is ever non-verbatim, whatever the punctuation", () => {
    // The structural claim, checked as a property rather than on one example.
    // Every one of these is a shape a transcript really can produce.
    const transcripts = [
      "it runs right along highway, ten minutes from the loop",
      "it runs right along highway. Ten minutes from the loop",
      "you put down $0 at closing, and 100% of it survives to month nine.",
      "they call it the \"month\" nine problem, and it is real",
      "just past Loop 1604 the lots get bigger.",
      "hold\n\nthe   line at   100%   even  then",
      "the fee is 100%. Nine times out of ten nobody reads it",
      "(month nine) is when the credit lands",
      "grade 5, year two, and month nine all matter here",
      "$450,000. That is the number nobody says out loud.",
      "it is ten; the second one is twelve",
      "day one — month nine — year two",
    ];
    for (const text of transcripts) {
      const s = seg("t", text, 40);
      const caption = captionTextFor(s);
      for (const c of punchCandidatesFor(s)) {
        assert.ok(
          caption.includes(c.text),
          `"${c.text}" is not in the captions "${caption}"`
        );
      }
    }
  });

  test("selectPunches inherits it — nothing non-verbatim survives to the plan", () => {
    const plan = { segments: [
      seg("t1", "it runs right along highway, ten minutes from the loop and it is slow", 40),
      seg("t2", "you put down $0 at closing, and 100% of that credit survives to month nine.", 60),
      seg("t3", "the fee is 100%. Nine times out of ten nobody reads it at all", 40),
    ] };
    const { punches } = selectPunches(plan, { enabled: true, max: 6, minGap: 5, protectedSeconds: 15 });
    for (const p of punches) {
      const take = plan.segments.find((s) => s.takeId === p.takeId);
      assert.ok(
        captionTextFor(take).includes(p.text),
        `"${p.text}" is not verbatim in ${p.takeId}: "${captionTextFor(take)}"`
      );
    }
    assert.ok(!punches.some((p) => p.text === "highway ten"), "the s4t5 punch must not come back");
  });

  test("a punch is on screen while its own words are in the captions", () => {
    const plan = { segments: [seg("t1", "one two three four five six seven eight $0 ten eleven twelve", 12)] };
    const { punches } = selectPunches(plan, { enabled: true, minGap: 1, protectedSeconds: 0 });
    const p = punches.find((x) => x.text === "$0");
    assert.ok(p, "the figure is punched");
    const chunk = buildCaptionChunks(plan).find((c) => c.text.includes("$0"));
    assert.ok(chunk, "and it is in a caption chunk");
    // The punch opens exactly when its chunk does. Not "close to" — the two are
    // computed from the same arithmetic and must agree exactly.
    assert.ok(Math.abs(p.at - chunk.start) < 0.02, `punch at ${p.at}, caption chunk at ${chunk.start}`);
  });

  test("nothing draws in the protected opening", () => {
    const plan = { segments: [seg("t1", "$0 down and 100% back", 60)] };
    const { punches, rejected } = selectPunches(plan, { enabled: true, protectedSeconds: 15, minGap: 1 });
    assert.ok(punches.every((p) => p.at >= 15));
    assert.ok(rejected.some((r) => /protected opening/.test(r.reason)) || punches.length > 0);
  });

  test("the ceiling and the spacing both hold", () => {
    const text = Array.from({ length: 40 }, (_, i) => `item ${i + 10} costs $${i + 10}00`).join(" ");
    const plan = { segments: [seg("t1", text, 600)] };
    const { punches } = selectPunches(plan, { enabled: true, max: 4, minGap: 20, protectedSeconds: 15 });
    assert.ok(punches.length <= 4, `${punches.length} punches exceeds the ceiling`);
    for (let i = 1; i < punches.length; i++) {
      assert.ok(punches[i].at - punches[i - 1].at >= 20, "two punches landed inside the gap");
    }
  });

  test("on-camera takes are never punched", () => {
    const plan = { segments: [
      { takeId: "oc", kind: "on_camera", text: "you pay $0 up front", seconds: 60 },
      seg("vo", "and 100% comes back", 60),
    ] };
    const { punches } = selectPunches(plan, { enabled: true, minGap: 1, protectedSeconds: 0 });
    assert.ok(punches.every((p) => p.takeId !== "oc"), "an edited take's word positions move");
  });

  test("the plate is gold, centred, and carries a scrim", () => {
    const svg = punchSvg("$0", { w: 1920, h: 1080 });
    assert.ok(svg.includes("#C8AA6A"), "brand gold");
    assert.ok(svg.includes("url(#scrim)"), "legible over a bright clip");
    assert.ok(svg.includes(">$0<"), "the figure itself");
  });

  test("the burn shifts each plate onto the video's clock", () => {
    const args = burnArgs("in.mp4", "c.ass", "out.mp4", {
      punches: [{ at: 61.5, seconds: 1.2, pngPath: "/p0.png", text: "$0" }],
    });
    const graph = args[args.indexOf("-filter_complex") + 1];
    // Without the setpts shift the fade runs on the PNG's own timeline and the
    // plate is already invisible when its enable window opens.
    assert.ok(graph.includes("setpts=PTS-STARTPTS+61.500/TB"), graph);
    assert.ok(graph.includes("enable='between(t,61.500,62.700)'"));
    // Captions first, so a punch sits over them rather than under them.
    assert.ok(graph.indexOf("ass=") < graph.indexOf("overlay"));
  });

  test("no punches means the cheap single-filter burn, unchanged", () => {
    const args = burnArgs("in.mp4", "c.ass", "out.mp4", { punches: [] });
    assert.ok(args.includes("-vf"), "a video with no punches must not pay for a filter_complex");
    assert.ok(!args.includes("-filter_complex"));
  });
});

// ─── 3. per-window stock keywords ───────────────────────────────────────────

describe("3. stock keywords come from the window, and never name a place", () => {
  test("a proper noun is dropped and its common noun kept", () => {
    const { proper, common } = classifyTokens("the Audie Murphy VA hospital campus".split(" "));
    assert.deepEqual(proper, ["Audie", "Murphy", "VA"]);
    assert.ok(common.includes("hospital") && common.includes("campus"));
  });

  test("a decade survives as an era, and bare figures do not", () => {
    const { common } = classifyTokens("houses from the 80s and 90s cost 340000".split(" "));
    assert.ok(common.includes("80s") && common.includes("90s"), "an era is a visual property");
    assert.ok(!common.includes("340000"), "a price is not a picture");
  });

  test("the window's own sentence chooses the window's footage", () => {
    const seg = {
      kind: "voiceover", takeId: "t1", seconds: 16,
      text: "The Audie Murphy VA hospital anchors the whole south side. Further north the houses are from the 80s and 90s.",
    };
    const frequencies = documentFrequencies([seg]);
    const first = keywordsForWindow(seg, { startAt: 0, seconds: 8 }, { frequencies });
    const second = keywordsForWindow(seg, { startAt: 8, seconds: 8 }, { frequencies });

    assert.ok(/hospital/.test(first.subject), `first window: ${JSON.stringify(first)}`);
    assert.ok(/houses|80s|90s/.test(second.subject), `second window: ${JSON.stringify(second)}`);
    assert.notEqual(first.subject, second.subject, "two windows of one take must not search for the same thing");
  });

  test("NO proper noun can reach a search query, on any window", () => {
    // The structural guarantee: proper nouns are removed before the query is
    // built, so the vision check's subject cannot name a real place and a clip
    // can never be presented as one.
    const seg = {
      kind: "voiceover", takeId: "t1", seconds: 24,
      text: "Stone Oak sits inside Loop 1604 while Timberwood Park is outside it, and the Comal ISD line runs between them near the Audie Murphy VA hospital.",
    };
    const frequencies = documentFrequencies([seg]);
    for (const startAt of [0, 8, 16]) {
      const w = keywordsForWindow(seg, { startAt, seconds: 8 }, { frequencies });
      const query = [w.subject || "", ...w.keywords].join(" ").toLowerCase();
      for (const banned of ["stone", "oak", "timberwood", "comal", "isd", "audie", "murphy", "va", "loop"]) {
        assert.ok(!query.includes(banned), `"${banned}" reached a stock search: "${query}"`);
      }
    }
  });

  test("a window of nothing but a place name falls back to the take's intent", () => {
    const seg = {
      kind: "voiceover", takeId: "t1", seconds: 6,
      text: "Stone Oak and Timberwood Park.",
      visualSpec: { keywords: ["suburban street"] },
    };
    const w = keywordsForWindow(seg, { startAt: 0, seconds: 6 }, {
      frequencies: documentFrequencies([seg]),
      fallbackKeywords: ["suburban street"],
    });
    assert.equal(w.source, "take-intent");
    assert.deepEqual(w.keywords, ["suburban street"]);
  });

  test("a word running through the whole script loses to one specific to the window", () => {
    // Otherwise every window searches for the video's topic and returns the same
    // footage, which is the per-take behaviour wearing a new name.
    const segs = [
      { kind: "voiceover", takeId: "a", seconds: 8, text: "The neighborhood question is really a neighborhood budget question." },
      { kind: "voiceover", takeId: "b", seconds: 8, text: "In this neighborhood the drainage easement floods every spring." },
    ];
    const frequencies = documentFrequencies(segs);
    const w = keywordsForWindow(segs[1], { startAt: 0, seconds: 8 }, { frequencies });
    assert.ok(/drainage|easement|floods|spring/.test(w.subject), `got "${w.subject}"`);
  });

  test("windows are enumerated per stock block across the plan", () => {
    const segments = [{
      kind: "voiceover", takeId: "t1", seconds: 16, text: "The hospital campus anchors it. The houses further out are newer builds.",
      visualBlocks: [
        { kind: "stock", startAt: 0, seconds: 8, phase: 0 },
        { kind: "stock", startAt: 8, seconds: 8, phase: 1 },
      ],
    }];
    const windows = planWindowKeywords(segments);
    assert.equal(windows.length, 2);
    assert.notEqual(windows[0].subject, windows[1].subject);
  });

  test("a window OPENING on a place name still drops it", () => {
    // THE BUG THIS CAUGHT. Proper nouns were detected by "capitalised and not
    // the first token", which is right for a sentence and wrong for a window —
    // and a window begins wherever six seconds of narration begins. Every window
    // whose first word was a place name leaked it into the search.
    const seg = {
      kind: "voiceover", takeId: "t1", seconds: 16,
      text: "The line runs east of here. Timberwood Park sits north of it, past the older subdivisions.",
    };
    const lexicon = properLexicon([seg]);
    // The 16 tokens map one per second, so this window opens exactly on the name.
    const w = keywordsForWindow(seg, { startAt: 6, seconds: 8 }, {
      frequencies: documentFrequencies([seg]), lexicon,
    });
    assert.ok(w.phrase.startsWith("Timberwood"), `the fixture must open on the name: "${w.phrase}"`);
    assert.ok(!/timberwood|park/i.test([w.subject, ...w.keywords].join(" ")), `leaked: ${JSON.stringify(w)}`);
  });

  test("a decade in a window does not crash the ranking", () => {
    // Kept tokens became objects when the noun cue was added, and the decade
    // branch went on pushing a bare string — so any window containing "80s"
    // reached the ranker with an undefined word and threw.
    const seg = { kind: "voiceover", takeId: "t1", seconds: 8, text: "the houses here are from the 80s and 90s mostly" };
    const w = keywordsForWindow(seg, { startAt: 0, seconds: 8 }, { frequencies: documentFrequencies([seg]) });
    assert.ok(/80s|90s|houses/.test(w.subject), `got "${w.subject}"`);
  });

  test("a capitalised function word is never reported as a dropped name", () => {
    // "Every January" and "The Northside" both start with one, and reporting
    // "Every" and "The" as proper nouns made the build's evidence line — the
    // thing a person reads to confirm no place name escaped — read like noise.
    const { proper } = classifyTokens("Every January the notice arrives".split(" "), {
      lexicon: new Set(["january"]),
      startsSentence: (i) => i === 0,
    });
    assert.ok(!proper.some((p) => /^(Every|The)$/i.test(p)), `got ${JSON.stringify(proper)}`);
    assert.ok(proper.some((p) => /January/i.test(p)));
  });

  test("window tokens track the window, not the take", () => {
    const seg = { text: "one two three four five six seven eight", seconds: 8 };
    assert.deepEqual(windowTokens(seg, { startAt: 0, seconds: 4 }), ["one", "two", "three", "four"]);
    assert.deepEqual(windowTokens(seg, { startAt: 4, seconds: 4 }), ["five", "six", "seven", "eight"]);
  });
});

// ─── 4. the synthesised hits ────────────────────────────────────────────────

describe("4. SFX are generated, not licensed", () => {
  test("both sounds guard the NaN timestamp that would silence them", () => {
    // ffmpeg hands the volume filter a NaN `t` on frames whose time it does not
    // know, the expression evaluates to NaN, and the filter substitutes zero —
    // it warns and produces audio anyway, which is how this hides.
    assert.ok(impactArgs("i.wav").join(" ").includes("isnan(t)"));
    assert.ok(whooshArgs("w.wav").join(" ").includes("isnan(t)"));
  });

  test("makeup gain is applied so the dB knob means something", () => {
    // ffmpeg's sine source is not full-scale and mono-to-stereo costs another
    // 3 dB; unmade-up, a hit sat 41 dB down and the knob read as broken.
    assert.match(impactArgs("i.wav").join(" "), /volume=8,/);
    assert.match(whooshArgs("w.wav").join(" "), /volume=4\.5,/);
  });

  test("a DEAD-SPACE join is silent; only a deliberate punch-in may sound", () => {
    // THE "WEIRD NOISE ON CUTS" NOTE. Every piece boundary used to get a whoosh,
    // including the joins where a breath was removed — so an edit whose entire
    // purpose is to be unnoticeable announced itself at every seam. A removed
    // pause is not an event; a framing change is.
    const plan = { segments: [
      { kind: "on_camera", takeId: "oc", seconds: 30, editPlan: { pieces: [
        { seconds: 10, joinKind: null },
        { seconds: 10, joinKind: "dead-space" },
        { seconds: 10, joinKind: "punch-in" },
      ] } },
      { kind: "voiceover", takeId: "vo", seconds: 30 },
    ] };
    const events = punchSfxTimeline(plan, [{ at: 40 }], { enabled: true, whoosh: true });
    assert.equal(events.filter((e) => e.kind === "impact").length, 1);
    const whooshes = events.filter((e) => e.kind === "whoosh");
    assert.equal(whooshes.length, 1, "the dead-space join must stay silent");
    assert.equal(whooshes[0].at, 20, "and the sound belongs to the punch-in at 20s");
    assert.deepEqual(events.map((e) => e.at), [...events].sort((a, b) => a.at - b.at).map((e) => e.at));
  });

  test("whooshes are OFF by default — impacts are not", () => {
    const plan = { segments: [{ kind: "on_camera", takeId: "oc", seconds: 30, editPlan: { pieces: [
      { seconds: 10, joinKind: null }, { seconds: 10, joinKind: "punch-in" },
    ] } }] };
    // The default path: no `whoosh` argument at all.
    const events = punchSfxTimeline(plan, [{ at: 5 }], { enabled: true });
    assert.equal(events.filter((e) => e.kind === "whoosh").length, 0);
    assert.equal(events.filter((e) => e.kind === "impact").length, 1, "the punch impacts stay");
  });

  test("a heavily cut video thins its whooshes instead of front-loading them", () => {
    const pieces = Array.from({ length: 200 }, (_, i) => ({ seconds: 3, joinKind: i === 0 ? null : "punch-in" }));
    const plan = { segments: [{ kind: "on_camera", takeId: "oc", seconds: 600, editPlan: { pieces } }] };
    const events = punchSfxTimeline(plan, [], { max: 20, enabled: true, whoosh: true });
    assert.ok(events.length <= 20);
    // Taking the first twenty would put every whoosh in the first minute and
    // none afterwards, which sounds like the effect broke halfway through.
    assert.ok(events[events.length - 1].at > 400, `last hit at ${events[events.length - 1].at}s`);
  });

  test("the mix does not attenuate the narration by the number of hits", () => {
    const args = mixSfxArgs("in.mp4", [{ at: 1, kind: "impact" }, { at: 2, kind: "whoosh" }], { impact: "i.wav", whoosh: "w.wav" }, "out.mp4");
    const graph = args[args.indexOf("-filter_complex") + 1];
    // amix divides by input count by default: forty hits would drop the voice
    // forty-fold.
    assert.ok(graph.includes("normalize=0"), graph);
    assert.ok(graph.includes("adelay=1000|1000"));
    assert.ok(graph.includes("adelay=2000|2000"));
  });

  test("the knob turns it all off", () => {
    assert.deepEqual(punchSfxTimeline({ segments: [] }, [{ at: 5 }], { enabled: false }), []);
  });
});

// ─── 5. the plan's own arithmetic ───────────────────────────────────────────

test("plannedSeconds agrees with the caption timeline", () => {
  const plan = { segments: [
    { kind: "voiceover", takeId: "a", text: "one two three four", seconds: 10 },
    { kind: "voiceover", takeId: "b", text: "five six seven eight", seconds: 12 },
  ] };
  assert.equal(plannedSeconds(plan), 22);
  const chunks = buildCaptionChunks(plan);
  assert.ok(Math.abs(chunks[chunks.length - 1].end - 22) < 0.05);
  // And the punch arithmetic is the caption arithmetic.
  assert.equal(chunkStartFor(0, 4, 10), 0);
  assert.equal(chunkStartFor(3, 4, 10), 0);
});
