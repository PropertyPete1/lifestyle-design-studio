import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  normaliseIntent, attachIntents, REJECTED,
  MAP, COMPARISON, NUMBER_BREAKDOWN, LIST, TIMELINE, CALLOUT, FOOTAGE,
  VISUAL_TYPES, GRAPHIC_TYPES,
} from "../src/yt-visual-intent.js";
import { loadMarket, renderMapSvg, renderMapPng, mapSpecForIntent, buildProjection, MAP_ATTRIBUTION } from "../src/yt-map-render.js";
import { renderCardSvg, renderCardPng, CARD_TYPES } from "../src/yt-card-render.js";
import { inspectRender, findOverflowingText } from "../src/yt-visual-qc.js";
import { selectGeneratedVisuals, spliceGenerated, kenBurnsArgs } from "../src/yt-visual-broll.js";
import {
  planOpening, validateOverlay, longestSharedRun, renderOverlayPng, burnOverlayArgs, scoresPass,
} from "../src/yt-opening.js";
import { buildDescription, MAP_CREDITS } from "../src/yt-packaging.js";
import { allScriptText, visualIntentText, applyGuards } from "../src/yt-script.js";
import { gatedDevelopmentNames } from "../src/yt-brief.js";
import { planTimeline } from "../src/yt-timeline.js";

const intent = (type, spec) => ({ type, spec });

describe("normaliseIntent — the writer's contract", () => {
  test("accepts each of the seven types", () => {
    const good = {
      [MAP]: { places: ["Stone Oak"], lines: ["1604"] },
      [COMPARISON]: { columns: [{ name: "A", points: ["x"] }, { name: "B", points: ["y"] }] },
      [NUMBER_BREAKDOWN]: { rows: [{ label: "School", value: "1.2%" }, { label: "County", value: "0.3%" }] },
      [LIST]: { items: ["W2s", "Bank statements"] },
      [TIMELINE]: { steps: [{ label: "Offer", when: "day 0" }, { label: "Close", when: "day 30" }] },
      [CALLOUT]: { value: "41 days", label: "median" },
      [FOOTAGE]: { note: "wide streets, grown trees" },
    };
    for (const type of VISUAL_TYPES) {
      const r = normaliseIntent(intent(type, good[type]));
      assert.equal(r.ok, true, `${type} was rejected: ${r.reason}`);
      assert.equal(r.type, type);
    }
  });

  describe("FOOTAGE is a choice, not an absence", () => {
    test("a bare {type:FOOTAGE} with no spec is valid", () => {
      const r = normaliseIntent({ type: FOOTAGE });
      assert.equal(r.ok, true);
      assert.equal(r.type, FOOTAGE);
    });

    test('the string shorthand "FOOTAGE" is valid', () => {
      // Every voiceover take now carries an intent, and a 38-take script would
      // otherwise gain 38 nested objects to a JSON payload the writer already
      // struggles to close. The first live run failed all three topics, twice
      // on malformed JSON.
      const r = normaliseIntent("FOOTAGE");
      assert.equal(r.ok, true);
      assert.equal(r.type, FOOTAGE);
    });

    test("the shorthand tolerates casing and whitespace", () => {
      for (const s of ["footage", " Footage ", "FOOTAGE"]) {
        assert.equal(normaliseIntent(s).ok, true, `"${s}" was rejected`);
      }
    });

    test("a shorthand string for a DRAWN type is rejected — there is nothing to draw", () => {
      const r = normaliseIntent("CALLOUT");
      assert.equal(r.ok, false);
      assert.equal(r.reason, REJECTED.EMPTY);
    });

    test("an unknown shorthand is rejected, not treated as footage", () => {
      const r = normaliseIntent("VIBES");
      assert.equal(r.ok, false);
      assert.equal(r.reason, REJECTED.UNKNOWN_TYPE);
    });

    test("FOOTAGE is not a graphic type", () => {
      assert.ok(!GRAPHIC_TYPES.includes(FOOTAGE));
      assert.equal(GRAPHIC_TYPES.length, 6);
    });
  });

  test("normalises the casings a model actually emits", () => {
    for (const written of ["number_breakdown", "Number Breakdown", "NUMBER-BREAKDOWN", "  number_breakdown  "]) {
      const r = normaliseIntent(intent(written, { rows: [{ label: "a", value: "1" }, { label: "b", value: "2" }] }));
      assert.equal(r.ok, true, `"${written}" was rejected`);
      assert.equal(r.type, NUMBER_BREAKDOWN);
    }
  });

  test("recovers rows the model wrote as strings", () => {
    const r = normaliseIntent(intent(NUMBER_BREAKDOWN, { rows: ["School district: 1.24%", "County — 0.28%"] }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.spec.rows.map((x) => x.label), ["School district", "County"]);
    assert.equal(r.spec.rows[0].value, "1.24%");
  });

  test("recovers a list of objects where strings were asked for", () => {
    const r = normaliseIntent(intent(LIST, { items: [{ label: "Two years of W2s" }, { text: "Certificate of Eligibility" }] }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.spec.items, ["Two years of W2s", "Certificate of Eligibility"]);
  });

  test("accepts {left,right} as well as {columns}", () => {
    const r = normaliseIntent(intent(COMPARISON, { left: { name: "Inside", points: ["older"] }, right: { name: "Outside", points: ["newer"] } }));
    assert.equal(r.ok, true);
    assert.equal(r.spec.columns.length, 2);
  });

  describe("rejects rather than draws something wrong", () => {
    const cases = [
      ["no intent at all", undefined, REJECTED.NONE],
      ["null", null, REJECTED.NONE],
      ["a type nobody implements", intent("PIE_CHART", { slices: [1, 2] }), REJECTED.UNKNOWN_TYPE],
      ["a spec that is a string", intent(LIST, "documents"), REJECTED.MALFORMED],
      ["a spec that is an array", intent(LIST, ["a", "b"]), REJECTED.MALFORMED],
      ["a comparison with one column", intent(COMPARISON, { columns: [{ name: "A" }] }), REJECTED.TOO_FEW],
      ["a breakdown with one row", intent(NUMBER_BREAKDOWN, { rows: [{ label: "a", value: "1" }] }), REJECTED.TOO_FEW],
      ["a timeline with one step", intent(TIMELINE, { steps: [{ label: "a" }] }), REJECTED.TOO_FEW],
      ["a callout with no value", intent(CALLOUT, { label: "median" }), REJECTED.EMPTY],
      ["a map naming nothing", intent(MAP, { places: [], lines: [] }), REJECTED.EMPTY],
      ["a list of empty strings", intent(LIST, { items: ["", "  ", null] }), REJECTED.TOO_FEW],
    ];
    for (const [name, value, reason] of cases) {
      test(name, () => {
        const r = normaliseIntent(value);
        assert.equal(r.ok, false);
        assert.equal(r.reason, reason);
      });
    }
  });

  test("never throws, whatever it is handed", () => {
    for (const junk of [0, "", [], true, { type: 5 }, { type: MAP, spec: null }, { spec: {} }, Symbol.iterator]) {
      assert.doesNotThrow(() => normaliseIntent(junk));
    }
  });
});

describe("attachIntents", () => {
  const vo = (id, visualIntent) => ({ kind: "voiceover", takeId: id, seconds: 20, visualIntent, broll: [] });

  test("distinguishes 'asked for nothing' from 'everything was rejected'", () => {
    // In the finished video these look identical. Only one is a bug.
    const silent = attachIntents([vo("a"), vo("b")]);
    assert.equal(silent.report.requested, 0);
    assert.equal(silent.report.rejected, 0);

    const broken = attachIntents([vo("a", intent("CHART", {})), vo("b", intent(LIST, { items: ["one"] }))]);
    assert.equal(broken.report.requested, 0);
    assert.equal(broken.report.rejected, 2);
    assert.equal(broken.report.rejections[0].takeId, "a");
  });

  test("never touches an on-camera take", () => {
    const segs = [{ kind: "on_camera", takeId: "x", visualIntent: intent(CALLOUT, { value: "9%" }) }];
    const { segments, report } = attachIntents(segs);
    assert.equal(segments[0].visual, undefined);
    assert.equal(report.requested, 0);
  });

  test("counts by type", () => {
    const { report } = attachIntents([
      vo("a", intent(CALLOUT, { value: "41 days" })),
      vo("b", intent(CALLOUT, { value: "6%" })),
      vo("c", intent(LIST, { items: ["x", "y"] })),
    ]);
    assert.deepEqual(report.byType, { LIST: 1, CALLOUT: 2 });
  });
});

describe("visualIntent goes through the content guards", () => {
  // The guards over allScriptText are the leak scanner and the monthly-payment
  // ban. A spec is not spoken but IS rendered in 84px gold, so a spec excluded
  // from that list is a hole straight through both.
  test("spec strings appear in allScriptText", () => {
    const script = {
      sections: [{
        title: "S",
        takes: [{ id: "t1", mode: "VOICEOVER", text: "spoken words", visualIntent: intent(NUMBER_BREAKDOWN, { rows: [{ label: "SECRET_DEVELOPMENT", value: "$2,400 a month" }] }) }],
      }],
    };
    const all = allScriptText(script).join(" ");
    assert.match(all, /SECRET_DEVELOPMENT/, "a banned name inside a spec would bypass the leak scanner");
    assert.match(all, /\$2,400 a month/, "a payment figure inside a spec would bypass the ban");
  });

  test("walks arbitrary nesting, not just known keys", () => {
    const found = visualIntentText({ type: "X", spec: { deep: { deeper: ["needle", { key: "second" }] }, n: 42 } });
    assert.ok(found.includes("needle"));
    assert.ok(found.includes("second"));
    assert.ok(found.includes("42"));
  });

  test("terminates on a self-referencing object", () => {
    const cyclic = { a: 1 };
    cyclic.self = cyclic;
    assert.doesNotThrow(() => visualIntentText(cyclic));
  });

  test("a banned name inside a spec is STRIPPED, not merely detected", () => {
    // Being visible to the guards is not the same as being removed. A gated
    // development name that appeared only in a spec was stripped from nothing,
    // recorded in no leak note, and rendered on screen in 84px gold.
    const banned = gatedDevelopmentNames()[0];
    const script = {
      sections: [{
        title: "S",
        takes: [{
          id: "t1", mode: "VOICEOVER", text: "narration with no problem in it",
          visualIntent: { type: "NUMBER_BREAKDOWN", spec: { rows: [{ label: banned, value: "1%" }, { label: "County", value: "2%" }], footnote: `also ${banned}` } },
        }],
      }],
    };
    const { script: guarded, leaksStripped } = applyGuards(script);
    const spec = guarded.sections[0].takes[0].visualIntent.spec;
    assert.ok(!spec.rows[0].label.includes(banned), `"${banned}" survived in a row label`);
    assert.ok(!spec.footnote.includes(banned), `"${banned}" survived in the footnote`);
    assert.ok(leaksStripped.length >= 2, "the strip should have been recorded");
  });

  test("scrubbing a spec keeps its structure and its type", () => {
    const script = {
      sections: [{ title: "S", takes: [{ id: "t1", mode: "VOICEOVER", text: "words",
        visualIntent: { type: "NUMBER_BREAKDOWN", spec: { rows: [{ label: "School", value: "1.2%" }, { label: "County", value: "0.3%" }] } } }] }],
    };
    const { script: guarded } = applyGuards(script);
    const vi = guarded.sections[0].takes[0].visualIntent;
    assert.equal(vi.type, "NUMBER_BREAKDOWN", "the type enum must not be run through a leak scanner");
    assert.ok(Array.isArray(vi.spec.rows));
    assert.equal(vi.spec.rows[1].value, "0.3%");
  });
});

describe("planTimeline carries intent without interpreting it", () => {
  test("an intent on a voiceover take survives to the segment", () => {
    const script = {
      sections: [{ title: "S", takes: [{ id: "t1", mode: "VOICEOVER", text: "words", visualIntent: intent(CALLOUT, { value: "41 days" }) }] }],
    };
    const plan = planTimeline(script, {}, [{ id: "c1", name: "a.mp4", durationSeconds: 30 }]);
    assert.equal(plan.segments[0].visualIntent.type, CALLOUT);
    assert.equal(plan.stats.visualIntentsRequested, 1);
  });

  test("a script with no intents plans exactly as before", () => {
    const script = { sections: [{ title: "S", takes: [{ id: "t1", mode: "VOICEOVER", text: "words" }] }] };
    const plan = planTimeline(script, {}, [{ id: "c1", name: "a.mp4", durationSeconds: 30 }]);
    assert.equal(plan.segments[0].visualIntent, null);
    assert.equal(plan.stats.visualIntentsRequested, 0);
  });
});

describe("map: resolving what the writer wrote", () => {
  test("matches prose names, not ids", () => {
    const spec = mapSpecForIntent({ places: ["Stone Oak", "Downtown"], lines: ["1604", "Loop 410"] });
    assert.ok(spec, "should have resolved");
    assert.ok(spec.labels.includes("stone_oak"));
    assert.ok(spec.highlight.includes("loop1604"));
    assert.ok(spec.highlight.includes("loop410"));
  });

  test("keeps the places it knows and drops the ones it does not", () => {
    const spec = mapSpecForIntent({ places: ["Stone Oak", "Buffalo Bayou"], lines: [] });
    assert.deepEqual(spec.labels, ["stone_oak"]);
  });

  test("declines when NOTHING resolves — a map of the wrong city is worse", () => {
    assert.equal(mapSpecForIntent({ places: ["Brooklyn", "Queens"], lines: ["BQE"] }), null);
  });

  test("declines for a market with no geometry instead of throwing", () => {
    assert.equal(mapSpecForIntent({ places: ["Stone Oak"] }, { market: "el_paso" }), null);
  });

  test("falls back to the rings when only places are named", () => {
    const spec = mapSpecForIntent({ places: ["Stone Oak"], lines: [] });
    assert.deepEqual(spec.highlight, ["loop410", "loop1604"]);
  });
});

describe("vendored geometry", () => {
  const { roads } = loadMarket("san_antonio");
  const byId = Object.fromEntries(roads.features.map((f) => [f.properties.id, f]));

  test("Loop 410 is ONE closed ring, not two carriageways", () => {
    const lines = byId.loop410.geometry.coordinates;
    assert.equal(lines.length, 1);
    const first = lines[0][0];
    const last = lines[0][lines[0].length - 1];
    assert.ok(Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-6);
  });

  test("1604 spans the full ring, not just the northern arc", () => {
    const lats = byId.loop1604.geometry.coordinates.flat().map((p) => p[1]);
    assert.ok(Math.max(...lats) - Math.min(...lats) > 0.3);
  });

  test("stays small enough to commit without ceremony", () => {
    assert.ok(Buffer.byteLength(JSON.stringify(roads)) < 120_000);
  });
});

describe("projection", () => {
  test("does not distort — one scale on both axes", () => {
    const project = buildProjection({ minLon: -98.7, maxLon: -98.2, minLat: 29.2, maxLat: 29.7 });
    const [x1, y1] = project(-98.7, 29.7);
    const [x2] = project(-98.2, 29.7);
    const [, y2] = project(-98.7, 29.2);
    assert.ok(Math.abs((x2 - x1) / (y2 - y1) - Math.cos((29.45 * Math.PI) / 180)) < 0.02);
  });

  test("rejects degenerate bounds rather than dividing by zero", () => {
    assert.throws(() => buildProjection({ minLon: -98, maxLon: -98, minLat: 29, maxLat: 29 }));
  });
});

// ─── the renderers, checked as pictures rather than as return values ────────

const SAMPLES = {
  [NUMBER_BREAKDOWN]: {
    eyebrow: "A Bexar County tax bill", title: "Where the money actually goes",
    rows: [{ label: "School district", value: "1.24%" }, { label: "County", value: "0.28%" }, { label: "City", value: "0.55%" }],
    total: "2.07%", footnote: "Rates vary by address.",
  },
  [COMPARISON]: {
    eyebrow: "Same budget", title: "Older inside, newer outside",
    columns: [
      { name: "Inside the loop", points: ["1970s build", "Bigger lot", "Shorter commute"] },
      { name: "Outside the loop", points: ["2000s build", "More square footage", "Newer schools"] },
    ],
    footnote: "Both are real trade-offs.",
  },
  [LIST]: {
    eyebrow: "Before you apply", title: "What a lender asks for",
    items: ["Two years of W2s", "Thirty days of pay stubs", "Two months of bank statements", "Certificate of Eligibility"],
  },
  [TIMELINE]: {
    eyebrow: "A normal closing", title: "Offer to keys",
    steps: [
      { label: "Offer accepted", when: "day 0" },
      { label: "Option period ends", when: "day 7" },
      { label: "Appraisal back", when: "day 21" },
      { label: "Clear to close", when: "day 30" },
    ],
  },
  [CALLOUT]: { eyebrow: "San Antonio, 2026", value: "41 days", label: "median time on market", footnote: "Up from 28 a year ago." },
};

describe("card renderers", () => {
  for (const type of CARD_TYPES) {
    test(`${type} renders a picture that passes QC at 1080p`, async () => {
      const png = await renderCardPng(type, SAMPLES[type]);
      const verdict = await inspectRender(png, { label: type });
      assert.equal(verdict.ok, true, verdict.failures.join("; "));
    });

    test(`${type} keeps all text inside the safe margin`, () => {
      const overflow = findOverflowingText(renderCardSvg(type, SAMPLES[type]));
      assert.deepEqual(overflow, [], `text off-canvas: ${JSON.stringify(overflow)}`);
    });
  }

  test("an unknown type throws rather than rendering an empty frame", () => {
    assert.throws(() => renderCardSvg("PIE_CHART", {}), /no card layout/);
  });
});

describe("card renderers survive model output that ignores the brief", () => {
  const LONG = "an extremely long label that the writer was explicitly told to keep under thirty characters and did not because models do that sometimes";

  test("a forty-word label does not push text off the canvas", () => {
    const svg = renderCardSvg(NUMBER_BREAKDOWN, {
      title: LONG, rows: [{ label: LONG, value: LONG }, { label: "ok", value: "1%" }],
    });
    assert.deepEqual(findOverflowingText(svg), []);
  });

  test("a callout with a long value shrinks instead of overflowing", async () => {
    const png = await renderCardPng(CALLOUT, { value: "$1,247,900 per acre", label: LONG });
    const verdict = await inspectRender(png, { label: "long callout" });
    assert.equal(verdict.ok, true, verdict.failures.join("; "));
  });

  test("more items than the layout holds are capped, not stacked off the bottom", () => {
    const svg = renderCardSvg(LIST, { title: "many", items: Array.from({ length: 20 }, (_, i) => `item number ${i + 1}`) });
    assert.deepEqual(findOverflowingText(svg), []);
  });

  test("empty strings inside otherwise valid content do not blank the card", async () => {
    const png = await renderCardPng(LIST, {
      title: "What a lender asks for",
      items: ["Two years of W2s", "", "Two months of bank statements", null],
    });
    const verdict = await inspectRender(png);
    assert.equal(verdict.ok, true, verdict.failures.join("; "));
  });
});

describe("QC catches what a return value cannot", () => {
  test("a solid black frame is caught, despite being a large valid PNG", async () => {
    const sharp = (await import("sharp")).default;
    const black = await sharp({ create: { width: 2560, height: 1440, channels: 3, background: "#000" } }).png().toBuffer();
    const verdict = await inspectRender(black);
    assert.equal(verdict.ok, false);
    assert.ok(verdict.failures.some((f) => /blank/.test(f)), verdict.failures.join("; "));
  });

  test("a nearly-empty frame is caught even though it is not blank", async () => {
    const sharp = (await import("sharp")).default;
    const almost = await sharp({ create: { width: 2560, height: 1440, channels: 3, background: "#000" } })
      .composite([{ input: { create: { width: 40, height: 8, channels: 3, background: "#fff" } }, left: 1200, top: 700 }])
      .png().toBuffer();
    const verdict = await inspectRender(almost);
    assert.equal(verdict.ok, false);
    assert.ok(verdict.failures.some((f) => /almost empty/.test(f)));
  });

  test("content clipped at the frame edge is caught", async () => {
    const sharp = (await import("sharp")).default;
    const bleeding = await sharp({ create: { width: 2560, height: 1440, channels: 3, background: "#000" } })
      .composite([
        { input: { create: { width: 900, height: 500, channels: 3, background: "#C8AA6A" } }, left: 800, top: 400 },
        { input: { create: { width: 300, height: 300, channels: 3, background: "#fff" } }, left: 0, top: 0 },
      ])
      .png().toBuffer();
    const verdict = await inspectRender(bleeding);
    assert.equal(verdict.ok, false);
    assert.ok(verdict.failures.some((f) => /safe margin/.test(f)), verdict.failures.join("; "));
  });

  test("a real card passes all three", async () => {
    const verdict = await inspectRender(await renderCardPng(CALLOUT, SAMPLES[CALLOUT]));
    assert.equal(verdict.ok, true, verdict.failures.join("; "));
  });

  test("garbage bytes are reported, not thrown", async () => {
    const verdict = await inspectRender(Buffer.from("not a png"));
    assert.equal(verdict.ok, false);
    assert.ok(verdict.failures.some((f) => /unreadable/.test(f)));
  });
});

describe("the map render", () => {
  test("draws both rings and credits the source on the frame", () => {
    const svg = renderMapSvg({ market: "san_antonio", highlight: ["loop410", "loop1604"], labels: ["downtown", "stone_oak"], title: "It sits in rings" });
    assert.match(svg, /Loop 410/);
    assert.match(svg, /1604/);
    assert.ok(svg.includes(MAP_ATTRIBUTION));
  });

  test("passes QC at 1080p", async () => {
    // edgeCheck off: roads are SUPPOSED to run off the frame. Text is still
    // checked for clipping separately, which is the part that matters.
    const png = await renderMapPng({ market: "san_antonio", highlight: ["loop410", "loop1604"], labels: ["stone_oak", "downtown"] });
    const verdict = await inspectRender(png, { label: "map", edgeCheck: false });
    assert.equal(verdict.ok, true, verdict.failures.join("; "));
  });

  test("its own attribution sits inside the safe margin", () => {
    // It shipped 34px from the corner, which overscan can crop — and a credit
    // line that gets cropped is the same as no credit line.
    const svg = renderMapSvg({ market: "san_antonio", highlight: ["loop410"], labels: [] });
    assert.deepEqual(findOverflowingText(svg), []);
  });

  test("an unknown market throws rather than drawing an empty frame", () => {
    assert.throws(() => loadMarket("el_paso"), /no vendored geometry/);
  });
});

describe("selection — no cap, graphics start after the opening", () => {
  const seg = (i, seconds, type = CALLOUT) => ({
    kind: "voiceover", takeId: `t${i}`, seconds, visual: type,
    visualSpec: { value: "x" }, broll: [{ driveFileId: `c${i}`, seconds }],
  });
  /** Pushes the rest of the script clear of the protected opening window. */
  const opener = { kind: "on_camera", takeId: "open", seconds: 20, source: "/tmp/a.mp4" };

  test("there is no ratio cap — every requested graphic past the opening is taken", () => {
    const segments = [opener, ...Array.from({ length: 20 }, (_, i) => seg(i, 12))];
    const { report } = selectGeneratedVisuals(segments);
    assert.equal(report.chosenCount, 20, "a cap would have trimmed this");
    assert.ok(report.graphicShare > 0.9, `graphics should dominate, got ${report.graphicShare}`);
  });

  test("graphics are suppressed inside the first 15 seconds", () => {
    // A map is not charming to somebody who is not invested yet.
    // t1 starts at 0s, t2 at 6s (both inside), t3 at 16s (clear of it).
    const segments = [seg(1, 6), seg(2, 10), seg(3, 30)];
    const { segments: out, report } = selectGeneratedVisuals(segments);
    assert.equal(out[0].generatedSeconds, 0);
    assert.equal(out[1].generatedSeconds, 0);
    assert.ok(out[2].generatedSeconds > 0, "the take starting at 16s should draw");
    assert.equal(report.suppressedInOpening.length, 2);
    assert.equal(report.suppressedInOpening[0].takeId, "t1");
  });

  test("a take is judged by where it STARTS, not where it ends", () => {
    // A 30s take beginning at 14s runs well past the window, and is still
    // suppressed — a graphic appearing one second before the hook lands is the
    // thing this rule exists to prevent.
    const straddling = selectGeneratedVisuals([seg(1, 14), seg(2, 30)]);
    assert.equal(straddling.segments[1].generatedSeconds, 0, "starts at 14s, inside the window");

    const clear = selectGeneratedVisuals([seg(1, 16), seg(2, 30)]);
    assert.equal(clear.segments[1].generatedSeconds, 30, "starts at 16s, past the window");
  });

  test("FOOTAGE is never rendered as a graphic", () => {
    const segments = [opener, { ...seg(1, 30), visual: FOOTAGE, visualSpec: { note: "wide streets" } }];
    const { report } = selectGeneratedVisuals(segments);
    assert.equal(report.chosenCount, 0);
  });

  test("segments with no validated visual are never chosen", () => {
    const { report } = selectGeneratedVisuals([opener, { kind: "voiceover", takeId: "a", seconds: 30, visual: null, broll: [] }]);
    assert.equal(report.chosenCount, 0);
  });

  test("a segment the allocator could not fill is left alone", () => {
    // renderTimeline throws loudly on a voiceover take with no B-roll. Splicing
    // a visual in makes the concat succeed with a picture shorter than the
    // narration, and -shortest then quietly cuts the narration — a lost
    // sentence instead of a failed build.
    const starved = { kind: "voiceover", takeId: "a", seconds: 30, visual: CALLOUT, visualSpec: { value: "x" }, broll: [] };
    const { report } = selectGeneratedVisuals([opener, starved]);
    assert.equal(report.chosenCount, 0);
  });

  test("on-camera runtime is excluded from the split", () => {
    const { report } = selectGeneratedVisuals([{ kind: "on_camera", seconds: 600, source: "/a.mp4" }, seg(1, 40)]);
    assert.equal(report.brollSeconds, 40);
  });

  test("the split is reported at both extremes", () => {
    const allGraphic = selectGeneratedVisuals([opener, seg(1, 30), seg(2, 30)]);
    assert.equal(allGraphic.report.graphicShare, 1);
    assert.equal(allGraphic.report.footageSeconds, 0);

    const allFootage = selectGeneratedVisuals([opener, { ...seg(1, 30), visual: FOOTAGE }, { ...seg(2, 30), visual: FOOTAGE }]);
    assert.equal(allFootage.report.graphicShare, 0);
    assert.equal(allFootage.report.footageSeconds, 60);
  });

  test("a script with no voiceover reports 0/0 rather than dividing by zero", () => {
    const { report } = selectGeneratedVisuals([opener]);
    assert.equal(report.brollSeconds, 0);
    assert.equal(report.graphicShare, 0);
  });
});

describe("splicing a visual into a segment", () => {
  test("the take's runtime is unchanged", () => {
    const broll = [{ driveFileId: "a", seconds: 6 }, { driveFileId: "b", seconds: 6 }, { driveFileId: "c", seconds: 6 }];
    const out = spliceGenerated(broll, { path: "/tmp/m.png", seconds: 6, kind: MAP });
    assert.equal(out.reduce((n, c) => n + c.seconds, 0), 18);
  });

  test("the generated clip comes first", () => {
    const out = spliceGenerated([{ driveFileId: "a", seconds: 10 }], { path: "/tmp/m.png", seconds: 4, kind: MAP });
    assert.equal(out[0].generated, true);
  });

  test("trims from the end so surviving clips stay readable", () => {
    const out = spliceGenerated([{ driveFileId: "a", seconds: 6 }, { driveFileId: "b", seconds: 6 }], { path: "/tmp/m.png", seconds: 6, kind: MAP });
    assert.equal(out.length, 2);
    assert.equal(out[1].seconds, 6);
  });

  test("a segment with no footage still gets its visual", () => {
    const out = spliceGenerated([], { path: "/tmp/m.png", seconds: 5, kind: CALLOUT });
    assert.equal(out.length, 1);
    assert.equal(out[0].seconds, 5);
  });
});

describe("ken burns", () => {
  test("outputs the CANVAS size, not the source size", () => {
    assert.match(kenBurnsArgs("/tmp/a.png", "/tmp/o.mp4", { seconds: 6, dim: { w: 1920, h: 1080 } }).join(" "), /s=1920x1080/);
  });

  test("the zoom RAMPS — it is a function of the frame counter, not a constant", () => {
    // This shipped as z='1.0+0.12/180': a constant, accepted by ffmpeg,
    // producing a correctly sized clip of 180 identical frames.
    const z = /z='([^']+)'/.exec(kenBurnsArgs("/tmp/a.png", "/tmp/o.mp4", { seconds: 6, dim: { w: 1920, h: 1080 } }).join(" "))[1];
    assert.match(z, /\bon\b/, `zoom "${z}" does not vary with the frame counter`);
  });

  test("duration is expressed in frames and matches the seconds asked for", () => {
    const args = kenBurnsArgs("/tmp/a.png", "/tmp/o.mp4", { seconds: 6, dim: { w: 1920, h: 1080 }, fps: 30 });
    assert.match(args.join(" "), /d=180/);
    assert.equal(args[args.indexOf("-t") + 1], "6");
  });

  test("keeps the pixel format and SAR concat requires", () => {
    const s = kenBurnsArgs("/tmp/a.png", "/tmp/o.mp4", { seconds: 4, dim: { w: 1920, h: 1080 } }).join(" ");
    assert.match(s, /format=yuv420p/);
    assert.match(s, /setsar=1/);
  });
});

describe("attribution in the description", () => {
  test("present when a map was used", () => {
    assert.ok(buildDescription({ hook: "h", promise: "p", mapsUsed: true }).text.includes(MAP_CREDITS.tiger));
  });

  test("ABSENT when no map was drawn", () => {
    assert.ok(!buildDescription({ hook: "h", promise: "p", mapsUsed: false }).text.includes("TIGER"));
  });

  test("the OSM fallback carries the copyright URL its licence requires", () => {
    const { text } = buildDescription({ hook: "h", promise: "p", mapsUsed: true, mapSource: "osm" });
    assert.match(text, /OpenStreetMap contributors/);
    assert.match(text, /openstreetmap\.org\/copyright/);
  });

  test("an unknown source is reported rather than silently uncredited", () => {
    const { missing } = buildDescription({ hook: "h", promise: "p", mapsUsed: true, mapSource: "bing" });
    assert.ok(missing.some((m) => /map attribution/.test(m)));
  });
});

describe("the opening treatment", () => {
  const onCam = (id, seconds = 20) => ({ kind: "on_camera", takeId: id, seconds, source: `/tmp/${id}.mp4` });
  const vo = (id, seconds = 20, extra = {}) => ({ kind: "voiceover", takeId: id, seconds, broll: [{ driveFileId: "c", seconds }], ...extra });

  test("a timeline opening on the face passes", () => {
    const r = planOpening([onCam("s1t1"), vo("s1t2", 30)], { overlay: "The trade nobody explains" });
    assert.equal(r.ok, true, r.failures.join("; "));
    assert.match(r.composition.opensOn, /on-camera take s1t1/);
  });

  test("a timeline opening on B-roll FAILS", () => {
    // Opening on somebody else's drone footage is a different product.
    const r = planOpening([vo("s1t1"), onCam("s1t2")]);
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => /must open on an on-camera take/.test(f)), r.failures.join("; "));
  });

  test("an opening take with no recording FAILS rather than rendering a hole", () => {
    const r = planOpening([{ kind: "on_camera", takeId: "s1t1", seconds: 20, source: null }]);
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => /no recording/.test(f)));
  });

  test("an empty timeline fails cleanly instead of throwing", () => {
    const r = planOpening([]);
    assert.equal(r.ok, false);
    assert.equal(r.composition, null);
  });

  test("a graphic scheduled inside the protected window FAILS", () => {
    const r = planOpening([onCam("s1t1", 5), vo("s1t2", 6, { generatedSeconds: 6, visual: "MAP" })]);
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => /protected opening/.test(f)));
  });

  test("the punctuation CALLOUT is allowed inside the window", () => {
    const r = planOpening([
      onCam("s1t1", 8),
      vo("s1t2", 4, { generatedSeconds: 1, visual: "CALLOUT", isOpeningPunctuation: true }),
    ]);
    assert.equal(r.ok, true, r.failures.join("; "));
    assert.match(r.composition.punctuation, /1s CALLOUT/);
  });

  test("the composition report says enough to judge without scrubbing", () => {
    const r = planOpening([onCam("s1t1", 12), vo("s1t2", 30)], { overlay: "The trade nobody explains" });
    const c = r.composition;
    assert.equal(c.overlay, "The trade nobody explains");
    assert.match(c.overlayWindow, /^0\.4s to 4s$/);
    assert.equal(c.protectedSeconds, 15);
    assert.equal(c.takesInWindow[0].takeId, "s1t1");
    assert.equal(c.punctuation, "none");
  });
});

describe("the opening overlay line", () => {
  const HOOK = "There is no state income tax here. That is the trade, and nobody explains the other half of it.";

  test("accepts a line that reuses the topic's nouns but not its phrasing", () => {
    // The first gate compared word SETS and rejected this — every content word
    // appears in the hook, and it is still the right line. Any overlay worth
    // burning reuses the topic's nouns.
    assert.deepEqual(validateOverlay("The trade nobody explains", HOOK), []);
  });

  test("rejects a verbatim run of the spoken hook", () => {
    const f = validateOverlay("there is no state income tax", HOOK);
    assert.ok(f.some((x) => /consecutive words/.test(x)), f.join("; "));
  });

  test("enforces the 4 to 8 word budget", () => {
    assert.ok(validateOverlay("Taxes bite", HOOK).some((f) => /at least 4/.test(f)));
    assert.ok(validateOverlay("this line has far too many words in it to ever work here", HOOK).some((f) => /ceiling is 8/.test(f)));
  });

  test("rejects trailing punctuation and quote marks", () => {
    assert.ok(validateOverlay("The trade nobody explains.", HOOK).some((f) => /ends with punctuation/.test(f)));
    assert.ok(validateOverlay('The "trade" nobody explains', HOOK).some((f) => /quote mark/.test(f)));
  });

  test("empty is rejected, not silently accepted", () => {
    assert.deepEqual(validateOverlay("", HOOK), ["overlay is empty"]);
    assert.deepEqual(validateOverlay(null, HOOK), ["overlay is empty"]);
  });

  test("longestSharedRun measures phrases, not word sets", () => {
    assert.equal(longestSharedRun("nobody explains", "and nobody explains the"), 2);
    assert.equal(longestSharedRun("completely unrelated wording", "and nobody explains the"), 0);
  });

  test("both critic axes must clear the bar", () => {
    assert.equal(scoresPass({ stopping_power: 9, complement: 9 }), true);
    assert.equal(scoresPass({ stopping_power: 9, complement: 6 }), false);
    assert.equal(scoresPass(null), false);
  });

  test("renders a legible overlay image", async () => {
    const png = await renderOverlayPng("The trade nobody explains", { width: 1920, height: 1080 });
    const v = await inspectRender(png, { label: "overlay", edgeCheck: false });
    // A transparent plate over video, so the card ink floor does not apply —
    // what matters is that it is not blank.
    assert.ok(v.metrics.range > 8, "overlay rendered blank");
    assert.ok(png.length > 3000);
  });

  test("the burn arguments fade the OVERLAY's alpha and leave the audio alone", () => {
    const args = burnOverlayArgs("in.mp4", "ov.png", "out.mp4").join(" ");
    assert.match(args, /alpha=1/);
    assert.match(args, /overlay=0:0:enable='between\(t,/);
    assert.match(args, /-c:a copy/);
  });
});
