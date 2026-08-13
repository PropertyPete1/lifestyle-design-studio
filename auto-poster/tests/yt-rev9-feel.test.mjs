/**
 * yt-rev9-feel.test.mjs — the three feel-level defects, and the failure sweep
 * of every path added to fix them.
 *
 * All three reached Peter's screen through checks that were passing: circles
 * over the passages naming neighbourhoods, motion that stepped, and a noise on
 * every removed breath. What they have in common is that nothing asserted on
 * the EXPERIENCE — the plans were right and the metrics were green. So these
 * tests assert the properties that would have caught them, and the artifact-level
 * companions live in longform/probe/probe-rev9-artifact.mjs.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  keywordsForWindow, documentFrequencies, properLexicon, classifyTokens,
  widenToSegment, PLACE_ESTABLISHING_CONCEPT,
} from "../src/yt-scene-keywords.js";
import { bridgeBeats } from "../src/yt-visual-build.js";
import { buildStates } from "../src/yt-visual-animate.js";
import { punchSfxTimeline } from "../src/yt-sfx.js";
import { buildEditList, pieceArgs, PIECE_DECLICK_SECONDS } from "../src/yt-oncamera-edit.js";
import { MapSession, mapSpecForIntent } from "../src/yt-map-render.js";
import { punchCandidatesFor } from "../src/yt-punch.js";
import { GRAPHIC_TWEEN_FPS, BEAT_BRIDGE_MAX_SECONDS } from "../src/yt-config.js";

const seg = (text, seconds = 8, extra = {}) => ({ kind: "voiceover", takeId: "t1", text, seconds, ...extra });
const ctx = (s) => ({ frequencies: documentFrequencies([s]), lexicon: properLexicon([s]) });

// ─── 1. never abstract circles over the video's own subject ─────────────────

describe("1. a window about a place never falls to the beat", () => {
  test("a window that is mostly a name is recognised as one", () => {
    const s = seg("Timberwood Park is further north, past Stone Oak, and it's a little more spread out.");
    const w = keywordsForWindow(s, { startAt: 0, seconds: 8 }, ctx(s));
    assert.equal(w.placeDominated, true, `got ${JSON.stringify(w)}`);
    assert.deepEqual(w.properPhrases, ["Timberwood Park", "Stone Oak"], "and the names are whole, not tokens");
  });

  test("a window that describes the place is NOT place-dominated — it has something to show", () => {
    // Peter's own example: this one should search for the homes, not draw a map.
    const s = seg("Stone Oak has newer two-story homes on smaller lots near the schools.");
    const w = keywordsForWindow(s, { startAt: 0, seconds: 8 }, ctx(s));
    assert.equal(w.placeDominated, false);
    assert.match(w.keywords.join(" "), /two-story|homes|schools/);
  });

  test("a window of pure place talk still gets a concept, never nothing", () => {
    const s = seg("Stone Oak and Shavano Park.", 6);
    const w = keywordsForWindow(s, { startAt: 0, seconds: 6 }, ctx(s));
    assert.equal(w.keywords[0], PLACE_ESTABLISHING_CONCEPT);
    assert.equal(w.source, "place-establishing");
  });

  test("the ladder widens to the sentence before it gives up", () => {
    // The name lands in the first window and what describes it in the second;
    // the first window used to be declared conceptless with the words twenty
    // tokens away.
    const s = seg("Shavano Park. Shavano Park. Big lots and mature oak trees line every street.", 16);
    const widened = widenToSegment(s, { ...documentFrequencies([s]), lexicon: properLexicon([s]), exclude: new Set() });
    assert.ok(widened.length > 0, "the take has plenty to show");
    assert.ok(/lots|trees|street/.test(widened.join(" ")), `got ${JSON.stringify(widened)}`);
  });

  test("a place a map already covered is not mapped again", () => {
    const spec = mapSpecForIntent({ places: ["Stone Oak"], lines: [] }, { market: "san_antonio" });
    assert.ok(spec, "the fixture needs geometry to be meaningful");
    const session = new MapSession();
    assert.equal(session.coversPlaces(spec), false);
    session.record(spec);
    assert.equal(session.coversPlaces(spec), true, "the same neighbourhood must not be introduced twice");
  });

  test("the beat is capped at a bridge and the neighbour takes the rest", () => {
    const broll = [{ kind: "stock", seconds: 6 }, { kind: "beat", seconds: 7 }, { kind: "graphic", seconds: 5 }];
    bridgeBeats(broll, { max: BEAT_BRIDGE_MAX_SECONDS });
    assert.equal(broll[1].seconds, BEAT_BRIDGE_MAX_SECONDS);
    assert.equal(broll[0].seconds, 6 + (7 - BEAT_BRIDGE_MAX_SECONDS), "the previous scene absorbs the overflow");
    // The take is still exactly as long as it was: the picture may change, the
    // clock may not.
    assert.equal(broll.reduce((n, b) => n + b.seconds, 0), 18);
  });

  test("a take with NOTHING else keeps its beat, and says so", () => {
    // The one case where a long beat is correct: there is no other visual to
    // extend, and a hole would be worse than geometry.
    const broll = [{ kind: "beat", seconds: 9 }];
    const bridges = [];
    bridgeBeats(broll, { max: 2, takeId: "t9", beatBridges: bridges });
    assert.equal(broll[0].seconds, 9, "nothing to hand it to");
    assert.equal(bridges[0].capped, false);
    assert.match(bridges[0].reason, /no other visual/);
  });

  test("the verification subject is a thing to film, never a claim about a place", () => {
    // THIS TEST USED TO REQUIRE THE SUBJECT TO BE THE SENTENCE — "the check gets
    // the sentence, not the query" — and that requirement was measured and found
    // to be the reason stock never produced a single clip.
    //
    // A probe of all sixteen windows of the current script (2026-08-13, real
    // Pexels, real vision) returned 48 vision rejections and ZERO search misses.
    // Pexels had footage every time. The check was rejecting it because it was
    // being asked things like "just south and west of that hospital cluster" and
    // answering, correctly, that frames cannot establish a spatial relationship
    // to a landmark. That is the one claim stock must never be taken to support,
    // which is why proper nouns are stripped in the first place — so the check
    // was right and the question was wrong.
    //
    // The subject is now the noun phrase around the head word: a thing a camera
    // can be pointed at. The concern the old test carried — a baseball field
    // passing for "closest base" — is still covered, by the assertions below and
    // by the vision check's own criteria, not by asking an unanswerable question.
    const s = seg("Oak Hills sits just south and west of that hospital cluster.");
    const w = keywordsForWindow(s, { startAt: 0, seconds: 8 }, ctx(s));

    assert.equal(w.verifySubject, "hospital cluster", "the check is asked for a thing, not a relation");

    // THE SAFETY PROPERTY, UNCHANGED AND STILL THE POINT. A clip may never be
    // accepted as being a specific named place.
    for (const name of ["oak", "hills"]) {
      assert.ok(!w.verifySubject.toLowerCase().includes(name), `the check may never learn "${name}"`);
    }

    // And no relation word survives into it, so the subject cannot express a
    // position relative to anything.
    for (const rel of [" of ", " south", " west", " north", " east", "just "]) {
      assert.ok(!w.verifySubject.toLowerCase().includes(rel.trim() === "of" ? " of " : rel),
        `"${rel.trim()}" would make the subject a claim rather than a picture`);
    }
  });

  test("a named place still never reaches the check, whatever rung answers", () => {
    for (const text of [
      "Universal City is the closest thing to Randolph's front gate.",
      "The Audie Murphy VA hospital anchors the whole south side.",
      "Timberwood Park is further north, past Stone Oak.",
    ]) {
      const s = seg(text);
      const w = keywordsForWindow(s, { startAt: 0, seconds: 8 }, ctx(s));
      const subject = String(w.verifySubject || "").toLowerCase();
      for (const name of (w.dropped || [])) {
        assert.ok(!subject.includes(String(name).toLowerCase()),
          `"${name}" reached the vision check via ${w.source}: ${JSON.stringify(w.verifySubject)}`);
      }
    }
  });
});

// ─── 2. motion, not a slideshow ────────────────────────────────────────────

describe("2. everything that moves, tweens", () => {
  test("a road draws at the delivery frame rate, not in five jumps", () => {
    const reveals = [{ at: 1, label: "Loop 1604", index: 0, synced: true }];
    const states = buildStates({ type: "MAP", labels: ["Loop 1604"], reveals, beats: [], seconds: 10, roadIds: ["loop1604"] });
    const drawing = states.filter((s) => s.roadProgress && s.roadProgress.loop1604 > 0 && s.roadProgress.loop1604 < 1);
    // 0.7s of draw at 30fps is ~20 intermediate frames. Five was the old value
    // and is what read as stepping.
    assert.ok(drawing.length >= 12, `only ${drawing.length} intermediate frames — motion will step`);
  });

  test("the intermediate frames are marked as tweens, or the dead-state check rejects smoothness", () => {
    const reveals = [{ at: 1, label: "Loop 1604", index: 0, synced: true }];
    const states = buildStates({ type: "MAP", labels: ["Loop 1604"], reveals, beats: [], seconds: 10, roadIds: ["loop1604"] });
    const mid = states.filter((s) => s.roadProgress?.loop1604 > 0 && s.roadProgress.loop1604 < 1);
    assert.ok(mid.every((s) => s.tween === true), "every frame of a draw except the last is a tween");
    const done = states.filter((s) => s.roadProgress?.loop1604 === 1);
    assert.ok(done.some((s) => !s.tween), "and the finished road is a key state that must show a change");
  });

  test("the draw eases rather than stepping linearly", () => {
    const reveals = [{ at: 1, label: "Loop 1604", index: 0, synced: true }];
    const states = buildStates({ type: "MAP", labels: ["Loop 1604"], reveals, beats: [], seconds: 10, roadIds: ["loop1604"] });
    const p = states.filter((s) => s.roadProgress?.loop1604 !== undefined).map((s) => s.roadProgress.loop1604);
    const drawing = p.filter((v) => v > 0 && v < 1);
    assert.ok(drawing.length > 3);
    // Ease-out: the first half of the time covers well over half the distance.
    assert.ok(drawing[Math.floor(drawing.length / 2)] > 0.6, `midpoint at ${drawing[Math.floor(drawing.length / 2)]} — that is linear`);
  });

  test("state times are frame-accurate, so the collapse does not eat half the tweens", () => {
    // FOUND BY THE ARTIFACT PROBE, not by reasoning. State times rounded to
    // 0.01s while finish() discarded anything closer together than a frame
    // (0.0333s at 30fps) — so successive tween frames landed 0.03 and 0.04 apart
    // and every 0.03 one was collapsed as "coincident". A draw asking for 30
    // drawings a second delivered 18.
    const reveals = [{ at: 1, label: "Loop 1604", index: 0, synced: true }];
    const states = buildStates({ type: "MAP", labels: ["Loop 1604"], reveals, beats: [], seconds: 10, roadIds: ["loop1604"] });
    const drawing = states.filter((s) => s.roadProgress?.loop1604 > 0 && s.roadProgress.loop1604 < 1);
    // 0.7s at 30fps asks for 21 steps; 20 of them are partial.
    assert.ok(drawing.length >= 18, `only ${drawing.length} of ~20 draw states survived the collapse`);
    // And no two states may share a timestamp, or the concat list holds a frame
    // for zero seconds.
    const times = states.map((s) => s.at);
    assert.equal(new Set(times).size, times.length, "collapsed states must not leave duplicates");
  });

  test("the tween rate is tied to the delivery rate", () => {
    assert.equal(GRAPHIC_TWEEN_FPS, 30, "a graphic that moves slower than the video is what 'laggy' meant");
  });
});

// ─── 3. no noise on a cut that was meant to be invisible ───────────────────

describe("3. the joins", () => {
  test("dead-space joins and punch-ins are told apart on the edit list", () => {
    // A take with one long pause in the middle and enough length to be split.
    const plan = buildEditList(30, [{ start: 12, end: 14 }], { isOpening: false, seed: 0 });
    const kinds = plan.pieces.map((p) => p.joinKind);
    assert.equal(kinds[0], null, "the first piece opens nothing");
    assert.ok(kinds.includes("dead-space"), `no dead-space join found in ${JSON.stringify(kinds)}`);
    assert.ok(kinds.slice(1).every((k) => k === "dead-space" || k === "punch-in"));
  });

  test("every piece is declicked at both edges", () => {
    const args = pieceArgs("in.mp4", "out.mp4", { srcStart: 0, srcEnd: 6, scale: 1, pulses: [] }, { w: 1920, h: 1080 });
    const af = args[args.indexOf("-af") + 1];
    assert.match(af, /afade=t=in:st=0:d=0\.015/);
    assert.match(af, /afade=t=out:st=5\.985:d=0\.015/);
  });

  test("a piece too short to hold two fades gets none rather than being all fade", () => {
    const args = pieceArgs("in.mp4", "out.mp4", { srcStart: 0, srcEnd: 0.03, scale: 1, pulses: [] }, { w: 1920, h: 1080 });
    assert.ok(!args.includes("-af"), "a 30ms piece must not be faded to nothing");
  });

  test("the declick is short enough to be inaudible on speech", () => {
    assert.ok(PIECE_DECLICK_SECONDS <= 0.02, "longer than 20ms starts to soften consonants");
  });
});

// ─── 4. the failure sweep of every new path ────────────────────────────────

describe("4. the new paths, pushed until they break", () => {
  test("a place window whose geometry does not resolve still gets a concept", () => {
    const s = seg("Nowhereville Heights and Fictional Downs.", 6);
    const w = keywordsForWindow(s, { startAt: 0, seconds: 6 }, ctx(s));
    // No geometry will exist for these, so the map path declines and the stock
    // ladder has to answer. It must not come back empty.
    assert.ok(w.keywords.length > 0, "a window about places can never be left with nothing");
    assert.equal(mapSpecForIntent({ places: w.properPhrases, lines: [] }, { market: "san_antonio" }), null);
  });

  test("a window that is only function words returns nothing, and says so", () => {
    const s = seg("and it is that of the", 4);
    const w = keywordsForWindow(s, { startAt: 0, seconds: 4 }, ctx(s));
    assert.equal(w.keywords.length, 0);
    assert.equal(w.source, "none");
    assert.equal(w.placeDominated, false, "no names means it is not a place window");
  });

  test("an empty take does not throw anywhere in the chain", () => {
    const s = seg("", 0);
    const w = keywordsForWindow(s, { startAt: 0, seconds: 0 }, ctx(s));
    assert.equal(w.keywords.length, 0);
    assert.deepEqual(classifyTokens([]).proper, []);
    assert.deepEqual(bridgeBeats([], { max: 2 }), []);
  });

  test("a graphic with a single state produces no tween and still renders", () => {
    const states = buildStates({ type: "LIST", labels: ["only"], reveals: [{ at: 0, label: "only", index: 0 }], beats: [], seconds: 3 });
    assert.ok(states.length >= 1);
    assert.ok(states.every((s) => s.until > s.at), "no zero-length state may reach the concat list");
  });

  test("SFX knobs in every combination", () => {
    const plan = { segments: [{ kind: "on_camera", takeId: "oc", seconds: 30, editPlan: { pieces: [
      { seconds: 10, joinKind: null }, { seconds: 10, joinKind: "punch-in" },
    ] } }] };
    const punches = [{ at: 5 }];
    assert.deepEqual(punchSfxTimeline(plan, punches, { enabled: false, whoosh: false }), []);
    assert.deepEqual(punchSfxTimeline(plan, punches, { enabled: false, whoosh: true }), [], "the master knob wins");
    assert.equal(punchSfxTimeline(plan, punches, { enabled: true, whoosh: false }).length, 1);
    assert.equal(punchSfxTimeline(plan, punches, { enabled: true, whoosh: true }).length, 2);
  });

  test("a punch landing exactly on a dead-space join gets its impact anyway", () => {
    // The impact belongs to the WORD, not to the seam, so a coincidence with a
    // removed pause must not silence it.
    const plan = { segments: [{ kind: "on_camera", takeId: "oc", seconds: 20, editPlan: { pieces: [
      { seconds: 10, joinKind: null }, { seconds: 10, joinKind: "dead-space" },
    ] } }] };
    const events = punchSfxTimeline(plan, [{ at: 10 }], { enabled: true, whoosh: true });
    assert.equal(events.filter((e) => e.kind === "impact").length, 1);
    assert.equal(events.filter((e) => e.kind === "whoosh").length, 0, "and the join itself is still silent");
  });

  test("a bridge cap of zero does not eat a take", () => {
    const broll = [{ kind: "stock", seconds: 4 }, { kind: "beat", seconds: 3 }];
    bridgeBeats(broll, { max: 0 });
    assert.equal(broll.reduce((n, b) => n + b.seconds, 0), 7, "the runtime is preserved whatever the cap");
  });

  test("consecutive beats with no real neighbour anywhere are all left alone", () => {
    const broll = [{ kind: "beat", seconds: 5 }, { kind: "beat", seconds: 5 }];
    const bridges = [];
    bridgeBeats(broll, { max: 2, beatBridges: bridges });
    assert.equal(broll.reduce((n, b) => n + b.seconds, 0), 10);
    assert.equal(bridges.filter((b) => !b.capped).length, 2);
  });

  test("a counted-noun punch cannot be built from a function word", () => {
    // Revision 8 shipped "other two", "the three", "and eleven" and "against
    // 1604" — every one a function word or preposition in front of a number.
    for (const text of ["the other two are cheaper", "and eleven of them sold", "just against 1604 the lots widen", "mostly one story homes"]) {
      // The gate is opened deliberately: with the counted class off by default
      // this loop would pass without testing anything at all, which is the
      // vacuous-green shape these suites exist to avoid.
      const c = punchCandidatesFor({ text, seconds: 10 }, { allowedClasses: ["currency", "percent", "counted", "figure"] });
      const counted = c.filter((x) => x.klass === "counted");
      assert.deepEqual(counted, [], `"${text}" produced ${JSON.stringify(counted.map((x) => x.text))}`);
    }
  });

  test("a real counted noun still punches, with the class gate opened", () => {
    // The counted class defaults OFF now. The scanner it tests is unchanged, so
    // the test opens the gate rather than being deleted — the day Peter wants
    // counted nouns back, this is the cover that says they still work.
    const c = punchCandidatesFor(
      { text: "the credit survives to month nine of the build", seconds: 10 },
      { allowedClasses: ["currency", "percent", "counted", "figure"] }
    );
    assert.ok(c.some((x) => x.text === "month nine"), JSON.stringify(c));
  });
});
