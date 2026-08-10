/**
 * yt-rev8.test.mjs — no words but the captions', a beat that holds the frame,
 * stock that never repeats, and a map whose labels are honestly classified.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { normaliseIntent, VISUAL_TYPES, REJECTED } from "../src/yt-visual-intent.js";
import { planSegmentCoverage } from "../src/yt-visual-plan.js";
import { beatSvg, renderBeatPng } from "../src/yt-card-render.js";
import { inspectRender, frameDifference } from "../src/yt-visual-qc.js";
import { mapRevealTargets, roadAliases, mapSpecForIntent } from "../src/yt-map-render.js";
import { planMapReveals } from "../src/yt-reveal-timing.js";
import { inventedSpecifics } from "../src/yt-packaging.js";

// ─── no layer sets the narration as prose ──────────────────────────────────

test("TYPOGRAPHY is not a type any script can ask for", () => {
  assert.ok(!VISUAL_TYPES.includes("TYPOGRAPHY"));
  const r = normaliseIntent({ type: "TYPOGRAPHY", spec: { phrases: ["anything"] } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, REJECTED.UNKNOWN_TYPE);
});

test("the beat carries no text at all", () => {
  const svg = beatSvg({ phase: 200 });
  // The one thing that must never appear: a <text> element. The whole reason
  // typography was removed is that on-screen prose disagreed with the captions,
  // and a floor that quietly drew a word would reintroduce it.
  assert.ok(!/<text/.test(svg), "the beat must contain no text element");
  assert.ok(/stroke/.test(svg), "and must still draw something");
});

test("the beat is a legible picture and its phases differ", async () => {
  const a = await renderBeatPng(0);
  const b = await renderBeatPng(313);
  const va = await inspectRender(a, { label: "beat", edgeCheck: false });
  assert.ok(va.ok, `the beat must pass the same QC as a card: ${va.failures.join("; ")}`);
  // Consecutive beats must not be the same still, or a long stretch of them is a
  // freeze the frame-diff check would rightly reject.
  assert.ok(await frameDifference(a, b) > 0.05);
});

test("a segment with nothing available is covered by beats, under the cap", () => {
  const { blocks, primary } = planSegmentCoverage({ kind: "voiceover", visual: null, seconds: 26 }, {});
  assert.equal(primary, "beat");
  assert.ok(blocks.every((b) => b.kind === "beat"));
  assert.ok(blocks.every((b) => b.seconds <= 8.001), "the floor obeys the cap");
  assert.ok(Math.abs(blocks.reduce((n, b) => n + b.seconds, 0) - 26) < 0.06, "and still covers the take");
});

// ─── stock never repeats a window ──────────────────────────────────────────

test("stock blocks in one take are given distinct windows", () => {
  const seg = { kind: "voiceover", visual: "FOOTAGE", seconds: 30, visualSpec: { keywords: ["x"] } };
  const { blocks } = planSegmentCoverage(seg, { stockSeconds: 30 });
  const stock = blocks.filter((b) => b.kind === "stock");
  assert.ok(stock.length > 1, "a 30s take chains more than one stock scene");
  // Distinct phase indices are what the builder turns into distinct -ss offsets.
  // Card 7 gave both blocks phase 0 and played the same eight seconds twice.
  assert.deepEqual(stock.map((b) => b.phase), stock.map((_, i) => i));
});

// ─── the map's two populations ─────────────────────────────────────────────

test("road aliases cover the ways a script actually says a number", () => {
  const i35 = roadAliases("i35", "I-35");
  assert.ok(i35.includes("interstate 35"), "the spec writes I-35 and the narration says Interstate 35");
  assert.ok(i35.includes("35"));
  // Longest first, so "interstate 35" is preferred over a bare "35" when both are
  // present — the bare number collides with every other figure in the script.
  assert.equal(i35[0].length >= i35[i35.length - 1].length, true);
});

test("spoken labels sync and orientation labels arrive with the base", () => {
  const spec = mapSpecForIntent({ lines: ["Loop 410", "1604"], places: ["Shavano Park", "Castle Hills", "Downtown"] }, { market: "san_antonio" });
  const text = "Shavano Park is a couple miles further out sitting right up against 1604 also its own small city";
  const words = text.split(" ").map((w, i) => ({ word: w, start: 0.3 + i * 0.4, end: 0.3 + i * 0.4 + 0.35 }));

  const r = planMapReveals({ targets: mapRevealTargets(spec), words, seconds: 14 });

  const shavano = r.reveals.find((x) => x.label === "Shavano Park");
  assert.equal(shavano.synced, true, "the subject of the sentence lands on its word");
  assert.ok(shavano.at < 1.0);

  // Castle Hills and Downtown are never said — they are there so the viewer knows
  // WHERE Shavano Park is. Card 7 even-paced them through the take, so the frame
  // kept sprouting neighbourhoods nobody had mentioned.
  for (const label of ["Castle Hills", "Downtown"]) {
    const c = r.reveals.find((x) => x.label === label);
    assert.equal(c.context, true, `${label} is orientation, not a reveal`);
    assert.equal(c.at, 0, "and arrives with the base");
  }
  // Three, not two: this take never says "Loop 410" either, so the ring is
  // orientation here as well. The count is a property of what the take SAYS, not
  // of what the spec lists — which is the whole distinction being drawn.
  assert.equal(r.contextCount, 3);
  assert.equal(r.syncedCount, r.spokenCount, "every label that could sync, did");
});

test("a map with no transcript still places every label", () => {
  const spec = mapSpecForIntent({ lines: ["1604"], places: ["Stone Oak"] }, { market: "san_antonio" });
  const targets = mapRevealTargets(spec);
  const r = planMapReveals({ targets, words: null, seconds: 10 });
  assert.equal(r.reveals.length, targets.length, "nothing is dropped without word timing");
  assert.equal(r.contextCount, targets.length, "and all of it is treated as orientation");
});

// ─── the description cannot open on a broken promise ───────────────────────

test("an opener naming places the chapters never cover is rejected", () => {
  const chapters = [{ title: "Stone Oak vs Timberwood Park" }, { title: "The Northside/Comal ISD line" }, { title: "MUD and PID fees vs the VA exemption" }];
  // Card 7's actual opener, which its own critic scored promise_match 5.
  const invented = inventedSpecifics(
    "Comparing Alamo Heights, Hollywood Park and Shavano Park prices.\nWhat each neighborhood costs.",
    { chapters, title: "Where to live in North San Antonio" }
  );
  assert.ok(invented.some((x) => /Hollywood Park/.test(x)));
  assert.ok(invented.some((x) => /Shavano Park/.test(x)));
});

test("an opener that matches the chapters passes", () => {
  const chapters = [{ title: "Stone Oak vs Timberwood Park" }, { title: "The Northside/Comal ISD line" }, { title: "MUD and PID fees vs the VA exemption" }];
  assert.deepEqual(
    inventedSpecifics(
      "Where to live in North San Antonio, inside or outside Loop 1604.\nStone Oak vs Timberwood Park, the ISD line, and the MUD fee your VA exemption misses.",
      { chapters, title: "Where to live in North San Antonio" }
    ),
    []
  );
});
