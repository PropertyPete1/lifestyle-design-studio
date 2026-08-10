/**
 * yt-map-animation.test.mjs — the animated map, and the ways it must decline.
 *
 * MAP was a fallback for two revisions because its reveal unit is geometry
 * rather than a row of text. These tests exist because the ways an animated map
 * can be silently wrong are all invisible in a passing render: a road that
 * "draws" by jumping from nothing to complete, a projection that rescales under
 * the reveals so the whole map crawls, a badge labelling a road that is not
 * there yet, and a script naming a suburb the vendored extract has never heard
 * of.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  partialPathFor,
  mapRevealLabels,
  highlightedRoadIds,
  renderMapSvg,
  renderMapPng,
  mapSpecForIntent,
  loadMarket,
  boundsOf,
  buildProjection,
} from "../src/yt-map-render.js";

import { buildStates } from "../src/yt-visual-animate.js";
import { planReveals } from "../src/yt-reveal-timing.js";

const SPEC = {
  market: "san_antonio",
  highlight: ["loop1604", "us281"],
  labels: ["stone_oak", "hollywood_park"],
  title: "Inside or outside 1604",
};

function projectionFor(id) {
  const { roads } = loadMarket("san_antonio");
  const f = roads.features.find((x) => x.properties.id === id);
  return { f, project: buildProjection(boundsOf([f])) };
}

// ─── the reveal unit: a road drawing itself ─────────────────────────────────

test("partialPathFor grows monotonically and ends exactly where the full path does", () => {
  const { f, project } = projectionFor("loop1604");
  const lengths = [0, 0.1, 0.25, 0.5, 0.75, 0.9].map((p) => partialPathFor(f, project, p).length);
  for (let i = 1; i < lengths.length; i++) {
    assert.ok(lengths[i] > lengths[i - 1], `progress must add geometry: ${lengths[i - 1]} -> ${lengths[i]}`);
  }
  // p=1 must be byte-identical to the unanimated path, or the settle state
  // would differ from the still render for no reason a viewer could see.
  assert.equal(partialPathFor(f, project, 1), partialPathFor(f, project, 1.4));
});

test("partialPathFor draws nothing at zero and never throws on nonsense progress", () => {
  const { f, project } = projectionFor("us281");
  assert.equal(partialPathFor(f, project, 0), "");
  assert.equal(partialPathFor(f, project, -3), "");
  // A NaN progress must draw the WHOLE road, not nothing. `?? 1` does not catch
  // NaN, so this used to blank the road for that state with no error at all.
  assert.equal(partialPathFor(f, project, NaN), partialPathFor(f, project, 1));
  assert.equal(partialPathFor(f, project, undefined), partialPathFor(f, project, 1));
});

test("a partial road lands mid-segment rather than snapping vertex to vertex", () => {
  const { f, project } = projectionFor("loop1604");
  // Two nearby progress values must differ, which they cannot if the tip only
  // ever stops on a vertex — the 1604 ring has 351 of them over ~9s.
  assert.notEqual(partialPathFor(f, project, 0.500), partialPathFor(f, project, 0.505));
});

// ─── layout stability: the map must not crawl ──────────────────────────────

test("the projection is computed from the spec, so early states do not rescale the map", async () => {
  // The full render and a one-road-in render must place the SAME road
  // identically. If bounds were derived from what is currently visible, 1604
  // would be drawn at a different scale before 281 arrived.
  const early = renderMapSvg(SPEC, { roadProgress: { loop1604: 1, us281: 0 }, places: 0 });
  const full = renderMapSvg(SPEC, { roadProgress: { loop1604: 1, us281: 1 }, places: 2 });
  const firstPath = (svg) => /<path d="(M[^"]{80,})"/.exec(svg)?.[1]?.slice(0, 80);
  assert.equal(firstPath(early), firstPath(full), "context geometry must be identical across states");
});

test("no state renders identical bytes to its neighbour while a road is drawing", async () => {
  const seen = new Set();
  for (const p of [0.2, 0.4, 0.6, 0.8, 1]) {
    const png = await renderMapPng(SPEC, { roadProgress: { loop1604: p, us281: 0 }, places: 0 });
    const key = png.length;
    assert.ok(!seen.has(key), `two draw states produced the same byte length (${key}) — the reveal is not drawing`);
    seen.add(key);
  }
});

test("a road badge waits until its road has essentially finished drawing", () => {
  const quarter = renderMapSvg(SPEC, { roadProgress: { loop1604: 0.25, us281: 0 }, places: 0 });
  const done = renderMapSvg(SPEC, { roadProgress: { loop1604: 1, us281: 0 }, places: 0 });
  assert.ok(!quarter.includes(">1604<"), "a quarter-drawn road must not carry its name plate");
  assert.ok(done.includes(">1604<"), "a finished road must carry its name plate");
});

test("places appear only up to the revealed count", () => {
  const none = renderMapSvg(SPEC, { roadProgress: { loop1604: 1, us281: 1 }, places: 0 });
  const one = renderMapSvg(SPEC, { roadProgress: { loop1604: 1, us281: 1 }, places: 1 });
  const labels = mapRevealLabels(SPEC).slice(2);
  assert.ok(!none.includes(labels[0]), "no place label before its reveal");
  assert.ok(one.includes(labels[0]), "the first place lands on its reveal");
  assert.ok(!one.includes(labels[1]), "the second place waits for its own reveal");
});

test("the finished map with no state is identical to the fully-revealed state", async () => {
  const a = renderMapSvg(SPEC, null);
  const b = renderMapSvg(SPEC, { roadProgress: { loop1604: 1, us281: 1 }, places: 2 });
  // The halo is the one difference: it marks the MOST RECENTLY landed place, and
  // a finished map has no "most recent". Strip it and the rest must match.
  const strip = (s) =>
    s.replace(/<circle[^>]*fill-opacity="0\.(07|10)"[^>]*\/>/g, "").replace(/\s+/g, " ").trim();
  assert.equal(strip(a), strip(b));
});

// ─── state sequencing ──────────────────────────────────────────────────────

test("roads draw before places land, and finished roads stay finished", () => {
  const roadIds = ["loop1604", "us281"];
  const states = buildStates({
    type: "MAP",
    labels: ["1604", "281", "Stone Oak"],
    roadIds,
    reveals: [{ at: 1 }, { at: 3 }, { at: 5 }],
    beats: [],
    seconds: 9,
  });

  // Once a road reaches 1 it never goes back — an earlier road vanishing as the
  // next one draws was the first thing this state model got wrong.
  let high = 0;
  for (const s of states) {
    const v = s.roadProgress.loop1604;
    assert.ok(v >= high - 1e-9, `loop1604 went backwards: ${high} -> ${v}`);
    high = Math.max(high, v);
  }
  // No place may land before the first road has started.
  const firstPlace = states.find((s) => s.places > 0);
  assert.ok(firstPlace.roadProgress.loop1604 === 1, "places land after the roads they hang off");
});

test("a MAP with no transcript still reveals, on even pacing", () => {
  const labels = mapRevealLabels(SPEC);
  const timing = planReveals({ labels, words: null, seconds: 9 });
  assert.equal(timing.source, "even-pacing");
  assert.equal(timing.syncedCount, 0);

  const states = buildStates({
    type: "MAP",
    labels,
    roadIds: highlightedRoadIds(SPEC),
    reveals: timing.reveals,
    beats: timing.beats,
    seconds: 9,
  });
  assert.ok(states.length > labels.length, "every reveal still produces states without word timing");
  assert.ok(states.at(-1).roadProgress.loop1604 === 1, "the map still finishes drawing");
});

test("motion beats re-emphasise without inventing content", () => {
  const roadIds = ["loop1604"];
  const states = buildStates({
    type: "MAP",
    labels: ["1604", "Stone Oak"],
    roadIds,
    reveals: [{ at: 0.5 }, { at: 2 }],
    beats: [{ at: 6 }],
    seconds: 12,
  });
  const beat = states.find((s) => s.beat);
  assert.ok(beat, "a 12s map with a 6s dwell gets a beat");
  assert.equal(beat.places, 1, "a beat must not reveal a place that has not been named");
  assert.equal(beat.roadProgress.loop1604, 1, "a beat must not un-draw a road");
});

// ─── declining, loudly ─────────────────────────────────────────────────────

test("a MAP naming nothing the gazetteer holds resolves to null so the caller can fall back", () => {
  assert.equal(mapSpecForIntent({ places: ["Atlantis"], lines: ["The Ring Road"] }, { market: "san_antonio" }), null);
  assert.equal(mapSpecForIntent({ places: [], lines: [] }, { market: "san_antonio" }), null);
  assert.equal(mapSpecForIntent(null, { market: "san_antonio" }), null);
});

test("a MAP naming one real place still renders, framed on the rings", () => {
  const spec = mapSpecForIntent({ places: ["Stone Oak", "Atlantis"] }, { market: "san_antonio" });
  assert.ok(spec, "one resolvable place is enough to draw");
  assert.deepEqual(spec.highlight, ["loop410", "loop1604"], "with no road named the rings orient the frame");
  assert.deepEqual(spec.labels, ["stone_oak"], "the unresolvable name is dropped, not guessed at");
});

test("highlightedRoadIds and mapRevealLabels agree on order and count", () => {
  const ids = highlightedRoadIds(SPEC);
  const labels = mapRevealLabels(SPEC);
  assert.equal(ids.length, 2);
  // The first N labels are the roads, in the same order as the ids — the
  // animator keys progress by id and matches narration by label, and a
  // disagreement here would animate the wrong road for the spoken name.
  const { roads } = loadMarket("san_antonio");
  ids.forEach((id, i) => {
    const f = roads.features.find((x) => x.properties.id === id);
    assert.equal(labels[i], f.properties.label);
  });
});
