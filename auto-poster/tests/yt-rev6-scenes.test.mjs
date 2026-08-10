/**
 * yt-rev6-scenes.test.mjs — the scene cap, subject-first maps, and map memory.
 *
 * All three come from watching card 5: a 30-second take sitting on one visual,
 * maps re-performing the rings every appearance, and the subject of the sentence
 * arriving ten seconds after it was named.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { planSegmentCoverage } from "../src/yt-visual-plan.js";
import { planReveals, findWordTime } from "../src/yt-reveal-timing.js";
import { buildStates } from "../src/yt-visual-animate.js";
import { MapSession, mapRevealLabels, mapSpecForIntent } from "../src/yt-map-render.js";
import { SCENE_MAX_SECONDS } from "../src/yt-config.js";

const wordsFor = (sentence, step = 0.34, from = 0.4) =>
  sentence.split(" ").map((w, i) => ({ word: w, start: from + i * step, end: from + i * step + 0.3 }));

// ─── the scene cap ─────────────────────────────────────────────────────────

test("no single visual owns the screen for much longer than the cap", () => {
  const cases = [
    [{ kind: "voiceover", visual: "COMPARISON", seconds: 30 }, { graphicOk: true, stockSeconds: 12 }],
    [{ kind: "voiceover", visual: "FOOTAGE", seconds: 30, visualSpec: { keywords: ["x"] } }, { stockSeconds: 30 }],
    [{ kind: "voiceover", visual: "LIST", seconds: 24 }, { graphicOk: true }],
  ];
  for (const [seg, opts] of cases) {
    const { blocks } = planSegmentCoverage(seg, opts);
    const longest = Math.max(...blocks.map((b) => b.seconds));
    // NO EXCEPTIONS. The stub merge used to push a 9s take to a single 9s scene;
    // over-cap blocks now split and share the time instead.
    assert.ok(longest <= SCENE_MAX_SECONDS + 0.001, `longest scene ${longest}s exceeds the cap`);
    assert.ok(blocks.length > 1, "a long take must be chained, not held");
  }
});

test("the cap does not chop a take that is already short enough", () => {
  const { blocks } = planSegmentCoverage({ kind: "voiceover", visual: "LIST", seconds: 7 }, { graphicOk: true });
  assert.equal(blocks.length, 1, "a 7s take is one scene");
});

test("a long take gets several graphic phases, each a distinct window", () => {
  // Revision 6 capped this at ONE scene because a second graphic block replayed
  // the animation from its first state. Phases exist now: the blocks are windows
  // into one continuous render, so more than one is correct — provided their
  // windows do not overlap, which is what makes phase 2 a continuation.
  const { blocks } = planSegmentCoverage({ kind: "voiceover", visual: "LIST", seconds: 40 }, { graphicOk: true, stockSeconds: 20 });
  const phases = blocks.filter((b) => b.kind === "graphic");
  assert.ok(phases.length > 1, "a 40s take is worth more than one graphic phase");

  phases.forEach((p, i) => {
    assert.equal(p.phase, i, "phases are numbered in play order");
    assert.equal(p.phaseOf, phases.length, "and each knows how many there are");
  });
  for (let i = 1; i < phases.length; i++) {
    const prevEnd = phases[i - 1].startAt + phases[i - 1].seconds;
    assert.ok(phases[i].startAt >= prevEnd, `phase ${i} must open at or after the previous one closed, not replay it`);
  }
});

test("a graphic phase never asks for time the render does not contain", () => {
  // startAt is measured in SEGMENT time and the render is capped, so on a long
  // take the last phase can sit past the end of the clip. The slice clamps; this
  // asserts the plan does not produce a window that starts beyond a 40s render.
  const { blocks } = planSegmentCoverage({ kind: "voiceover", visual: "LIST", seconds: 60 }, { graphicOk: true });
  for (const b of blocks.filter((x) => x.kind === "graphic")) {
    assert.ok(b.startAt < 40, `phase at ${b.startAt}s would start past the rendered clip`);
  }
});

test("every block knows where it sits inside the take", () => {
  const { blocks } = planSegmentCoverage({ kind: "voiceover", visual: "FOOTAGE", seconds: 30, visualSpec: { keywords: ["x"] } }, { stockSeconds: 30 });
  let at = 0;
  for (const b of blocks) {
    assert.equal(b.startAt, Math.round(at * 100) / 100, "startAt must be the running offset");
    at += b.seconds;
  }
  // Without this, every typography block sets the whole take and a chained
  // segment shows the same phrases two or three times over.
  assert.ok(blocks.some((b) => b.startAt > 0), "a chained take has blocks past zero");
});

test("variety holds across a take boundary", () => {
  const seg = { kind: "voiceover", visual: "FOOTAGE", seconds: 20, visualSpec: { keywords: ["x"] } };
  const { blocks } = planSegmentCoverage(seg, { stockSeconds: 20, startAfter: "stock" });
  assert.notEqual(blocks[0].kind, "stock", "a take must not open with the source that closed the last one");
});

// ─── subject first ─────────────────────────────────────────────────────────

test("the named subject animates first, however late the spec lists it", () => {
  // Card 5's real failure: "Castle Hills" is the first word and the last reveal.
  const words = wordsFor("Castle Hills sits just inside Loop 410 about fifteen minutes from downtown");
  const spec = mapSpecForIntent({ lines: ["Loop 410", "1604"], places: ["Castle Hills", "Downtown"] }, { market: "san_antonio" });
  const labels = mapRevealLabels(spec);

  assert.ok(labels.indexOf("Castle Hills") > 0, "the spec lists the subject after the roads");
  assert.equal(findWordTime(words, "Castle Hills", { after: 0 }), 0.4, "and it is spoken first");

  const given = planReveals({ labels, words, seconds: 14, order: "given" });
  const narration = planReveals({ labels, words, seconds: 14, order: "narration" });

  const castleGiven = given.reveals.find((r) => r.label === "Castle Hills");
  const castleNarr = narration.reveals.find((r) => r.label === "Castle Hills");

  assert.ok(castleGiven.at > 8, `given order strands the subject at ${castleGiven.at}s`);
  assert.equal(castleNarr.at, 0.4, "narration order lands it on the word");
  assert.equal(narration.reveals[0].label, "Castle Hills", "and it is the first thing to animate");
  assert.ok(narration.syncedCount > given.syncedCount, "narration order syncs strictly more");
});

test("narration order keeps a reveal for every label, spoken or not", () => {
  const words = wordsFor("Stone Oak is the big one up here");
  const labels = ["1604", "281", "Stone Oak", "Encino Park"];
  const { reveals } = planReveals({ labels, words, seconds: 12, order: "narration" });
  assert.equal(reveals.length, labels.length, "nothing is dropped for never being said");
  assert.deepEqual([...reveals].map((r) => r.index).sort(), [0, 1, 2, 3], "every label keeps its identity");
  for (let i = 1; i < reveals.length; i++) {
    assert.ok(reveals[i].at > reveals[i - 1].at, "reveals still increase in time");
  }
});

// ─── map memory ────────────────────────────────────────────────────────────

test("the first map draws the base and the second inherits it", () => {
  const session = new MapSession();
  const a = { market: "san_antonio", highlight: ["loop410", "loop1604"], labels: ["castle_hills"] };
  const b = { market: "san_antonio", highlight: ["loop410", "loop1604"], labels: ["shavano_park"] };

  assert.equal(session.establishedFor(a).size, 0, "nothing is established for the first map");
  session.record(a);
  const established = session.establishedFor(b);
  assert.equal(established.size, 2, "the second map opens from both rings");

  const reveals = [{ at: 0.4, index: 2 }, { at: 2.1, index: 0 }, { at: 4.0, index: 1 }];
  const labels = ["Loop 410", "1604", "Shavano Park"];
  const fresh = buildStates({ type: "MAP", labels, roadIds: ["loop410", "loop1604"], reveals, beats: [], seconds: 12 });
  const later = buildStates({ type: "MAP", labels, roadIds: ["loop410", "loop1604"], reveals, beats: [], seconds: 12, established });

  assert.ok(later.length < fresh.length, "an inherited base is fewer states, because it is not re-performed");
  // Every state of the later map already has the rings complete.
  for (const s of later) {
    assert.equal(s.roadProgress.loop410, 1, "an established road is never re-drawn");
    assert.equal(s.roadProgress.loop1604, 1);
  }
});

test("a road only counts as established when this map actually highlights it", () => {
  const session = new MapSession();
  session.record({ market: "san_antonio", highlight: ["loop410", "loop1604"], labels: ["castle_hills"] });
  const established = session.establishedFor({ market: "san_antonio", highlight: ["us281"], labels: ["stone_oak"] });
  assert.ok(!established.has("loop410"), "a road this map does not draw is not 'already drawn' for it");
});
