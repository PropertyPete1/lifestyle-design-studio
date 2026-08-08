import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  normaliseIntent, attachIntents, REJECTED,
  MAP, COMPARISON, NUMBER_BREAKDOWN, LIST, TIMELINE, CALLOUT, VISUAL_TYPES,
} from "../src/yt-visual-intent.js";
import { loadMarket, renderMapSvg, renderMapPng, mapSpecForIntent, buildProjection, MAP_ATTRIBUTION } from "../src/yt-map-render.js";
import { renderCardSvg, renderCardPng, CARD_TYPES } from "../src/yt-card-render.js";
import { inspectRender, findOverflowingText } from "../src/yt-visual-qc.js";
import { selectGeneratedVisuals, spliceGenerated, kenBurnsArgs, GENERATED_SHARE_CAP } from "../src/yt-visual-broll.js";
import { buildDescription, MAP_CREDITS } from "../src/yt-packaging.js";
import { allScriptText, visualIntentText, applyGuards } from "../src/yt-script.js";
import { gatedDevelopmentNames } from "../src/yt-brief.js";
import { planTimeline } from "../src/yt-timeline.js";

const intent = (type, spec) => ({ type, spec });

describe("normaliseIntent — the writer's contract", () => {
  test("accepts each of the six types", () => {
    const good = {
      [MAP]: { places: ["Stone Oak"], lines: ["1604"] },
      [COMPARISON]: { columns: [{ name: "A", points: ["x"] }, { name: "B", points: ["y"] }] },
      [NUMBER_BREAKDOWN]: { rows: [{ label: "School", value: "1.2%" }, { label: "County", value: "0.3%" }] },
      [LIST]: { items: ["W2s", "Bank statements"] },
      [TIMELINE]: { steps: [{ label: "Offer", when: "day 0" }, { label: "Close", when: "day 30" }] },
      [CALLOUT]: { value: "41 days", label: "median" },
    };
    for (const type of VISUAL_TYPES) {
      const r = normaliseIntent(intent(type, good[type]));
      assert.equal(r.ok, true, `${type} was rejected: ${r.reason}`);
      assert.equal(r.type, type);
    }
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

describe("the 30% cap", () => {
  const seg = (i, seconds, type = CALLOUT) => ({
    kind: "voiceover", takeId: `t${i}`, seconds, visual: type,
    visualSpec: { value: "x" }, broll: [{ driveFileId: `c${i}`, seconds }],
  });

  test("never spends more than the cap", () => {
    const segments = Array.from({ length: 20 }, (_, i) => seg(i, 12));
    const { report } = selectGeneratedVisuals(segments);
    assert.ok(report.share <= GENERATED_SHARE_CAP + 1e-9, `share was ${report.share}`);
    assert.ok(report.skippedForCap > 0);
  });

  test("spreads across the script instead of front-loading one section", () => {
    // Nine requests, a budget for about three. Taking the first three would
    // make the opening a slideshow and leave the rest of the video bare.
    const segments = Array.from({ length: 9 }, (_, i) => seg(i, 20));
    const { segments: out } = selectGeneratedVisuals(segments);
    const chosen = out.map((s, i) => (s.generatedSeconds > 0 ? i : -1)).filter((i) => i >= 0);
    assert.ok(chosen.length >= 2, `expected several, got ${chosen.length}`);
    assert.ok(Math.max(...chosen) - Math.min(...chosen) > 3, `all clustered: ${chosen.join(",")}`);
  });

  test("segments with no validated visual are never chosen", () => {
    const segments = [{ kind: "voiceover", takeId: "a", seconds: 30, visual: null, broll: [] }];
    const { report } = selectGeneratedVisuals(segments);
    assert.equal(report.chosenCount, 0);
  });

  test("a short script still gets a visual — the budget shrinks it, not skips it", () => {
    // One 22s take gives a 6.6s budget against a 9s ideal. Comparing the two
    // and skipping meant short videos rendered NOTHING, silently.
    const { report, segments } = selectGeneratedVisuals([seg(1, 22)]);
    assert.equal(report.chosenCount, 1, "a 4s visual fits in 6.6s and should have been chosen");
    assert.ok(segments[0].generatedSeconds >= 4);
    assert.ok(report.share <= GENERATED_SHARE_CAP + 1e-9);
  });

  test("a segment the allocator could not fill is left alone", () => {
    // renderTimeline throws loudly on a voiceover take with no B-roll. Splicing
    // a visual in makes the concat succeed with a picture shorter than the
    // narration, and -shortest then cuts the narration — a lost sentence
    // instead of a failed build.
    const starved = { kind: "voiceover", takeId: "a", seconds: 30, visual: CALLOUT, visualSpec: { value: "x" }, broll: [] };
    const { report } = selectGeneratedVisuals([starved]);
    assert.equal(report.chosenCount, 0);
  });

  test("on-camera runtime is excluded from the budget", () => {
    const { report } = selectGeneratedVisuals([{ kind: "on_camera", seconds: 600 }, seg(1, 40)]);
    assert.equal(report.brollSeconds, 40);
    assert.ok(report.budgetSeconds <= 12 + 1e-9);
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
