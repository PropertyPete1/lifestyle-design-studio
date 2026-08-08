import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import { classifyTake, FOOTAGE, MAP, INFOGRAPHIC } from "../src/yt-visual-classify.js";
import { loadMarket, renderMapSvg, renderMapPng, buildProjection, MAP_ATTRIBUTION } from "../src/yt-map-render.js";
import { infographicSpecForSegment, renderInfographicPng } from "../src/yt-infographic-render.js";
import { selectGeneratedVisuals, spliceGenerated, kenBurnsArgs, GENERATED_SHARE_CAP } from "../src/yt-visual-broll.js";
import { buildDescription, MAP_CREDITS } from "../src/yt-packaging.js";
import { isNonBlank } from "../src/carousel-render.js";
import { planTimeline } from "../src/yt-timeline.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLACES = JSON.parse(readFileSync(join(HERE, "..", "assets", "geo", "san-antonio-places.json"), "utf-8")).places;

/** The real hook of video 1, and the takes around it. */
const RINGS = "North San Antonio is not one place. It's three, and they sit in rings. Loop 410 is the inner highway loop, that's basically the old edge of the city. 1604 is the outer loop, another eight or nine miles out.";
const RELATIONAL = "Churchill Estates is a little further north, still inside 1604, off Northwest Military Highway, which is the road that runs up toward Castle Hills.";
const MUD_PID = "The exemption applies to property taxes. It does not apply to a MUD or a PID. A MUD is a municipal utility district. A PID is a public improvement district.";
const EXEMPTION = "That charge shows up on the same statement. It isn't one. It's an assessment. Your exemption wipes out the school line and the county line, and that MUD assessment just sits there.";

describe("classifyTake — the bias is toward footage, on purpose", () => {
  test("a route named while talking about houses is NOT a map", () => {
    // Anchor present, justification absent. This is the single most common
    // false positive and the reason the classifier needs two signals.
    const r = classifyTake("Stone Oak has two story homes, mostly two thousands and newer, gated pockets, and 1604 nearby.", { places: PLACES });
    assert.equal(r.kind, FOOTAGE);
  });

  test("advice with no geography and no numbers is footage", () => {
    const r = classifyTake("Verify by address. Not by subdivision name, not by what the listing says.", { places: PLACES });
    assert.equal(r.kind, FOOTAGE);
    assert.equal(r.spec, null);
  });

  test("a neighbourhood placed against a road IS a map", () => {
    const r = classifyTake(RELATIONAL, { places: PLACES });
    assert.equal(r.kind, MAP);
    assert.ok(r.spec.routes.includes("loop1604"), "should have found 1604");
  });

  test("the MUD/PID definitions are an infographic — the brief's own example", () => {
    assert.equal(classifyTake(MUD_PID, { places: PLACES }).kind, INFOGRAPHIC);
  });

  test("when map and infographic signals both fire hard, it declines", () => {
    // "A newer house north of 1604 with an assessment can cost you more every
    // year than an older house inside the loop" is genuinely both. Not knowing
    // is a real answer, and footage is the safe one.
    const both = "For a hundred percent rated veteran the math flips. A newer house north of 1604 with an assessment on it can cost you more every year than an older house inside the loop with a higher tax rate.";
    const r = classifyTake(both, { places: PLACES });
    assert.ok(r.kind === FOOTAGE || r.kind === INFOGRAPHIC, `got ${r.kind}`);
    if (r.kind === FOOTAGE) {
      assert.ok(r.signals.some((s) => /ambiguous/.test(s)), "should say why it declined");
    }
  });

  test("empty text never classifies", () => {
    assert.equal(classifyTake("", { places: PLACES }).kind, FOOTAGE);
    assert.equal(classifyTake(null, { places: PLACES }).kind, FOOTAGE);
  });

  test("on-camera takes are never reclassified by the planner", () => {
    const script = {
      sections: [{ title: "S", takes: [{ id: "t1", mode: "ON_CAMERA", text: RINGS }] }],
    };
    const plan = planTimeline(script, { t1: { path: "/tmp/a.mp4", durationSeconds: 20 } }, [], { places: PLACES });
    // The hook is the most map-shaped sentence in the whole script, and it
    // still must not become a map: it is Peter on screen saying it.
    assert.equal(plan.segments[0].kind, "on_camera");
    assert.equal(plan.segments[0].visual, undefined);
  });
});

describe("vendored geometry", () => {
  const { roads, places } = loadMarket("san_antonio");
  const byId = Object.fromEntries(roads.features.map((f) => [f.properties.id, f]));

  test("both rings the video-1 hook names are present", () => {
    assert.ok(byId.loop410, "Loop 410 missing");
    assert.ok(byId.loop1604, "Loop 1604 missing");
  });

  test("Loop 410 is ONE closed ring, not two carriageways", () => {
    // It shipped doubled once, because the dedupe compared endpoints and two
    // carriageways of a closed loop start at different points on the circle.
    const lines = byId.loop410.geometry.coordinates;
    assert.equal(lines.length, 1, `expected one line, got ${lines.length}`);
    const [first] = lines[0];
    const last = lines[0][lines[0].length - 1];
    assert.ok(Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-6, "410 should close");
  });

  test("1604 spans the full ring, not just the northern arc", () => {
    // The primary layer alone yields 0.137 degrees of latitude — a C, not a
    // ring, in a video whose hook is the word "rings".
    const lats = byId.loop1604.geometry.coordinates.flat().map((p) => p[1]);
    assert.ok(Math.max(...lats) - Math.min(...lats) > 0.3, "1604 looks like the north arc only");
  });

  test("the file stays small enough to commit without ceremony", () => {
    const bytes = Buffer.byteLength(JSON.stringify(roads));
    assert.ok(bytes < 120_000, `geometry is ${bytes} bytes`);
  });

  /**
   * The assertion promised in san-antonio-places.json.
   *
   * Hand-placed coordinates are the one thing here nobody can eyeball in
   * review, so they are checked against the geometry instead: a place the
   * script describes as inside Loop 410 must actually fall inside Loop 410.
   */
  describe("hand-placed labels land where the script says they do", () => {
    const ring = byId.loop410.geometry.coordinates[0];
    const inside = (lon, lat) => {
      let hit = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) hit = !hit;
      }
      return hit;
    };
    const at = (id) => places.find((p) => p.id === id);

    test("downtown is inside Loop 410", () => {
      const p = at("downtown");
      assert.ok(inside(p.lon, p.lat), `downtown (${p.lon},${p.lat}) fell outside the ring`);
    });

    /**
     * Castle Hills and the Medical Center STRADDLE the loop — this is the
     * finding recorded in the places file, not a tolerance invented to make a
     * red test go green.
     *
     * Castle Hills is a small city that Loop 410 runs through, so its centroid
     * lands a couple of hundred metres outside. The Medical Center, geocoded
     * from 7703 Floyd Curl Drive, is about 1.9km NORTH of the loop. Asserting
     * either is strictly "inside" would encode the script's phrasing rather
     * than the ground truth. What genuinely matters for a label is that it
     * lands ON the loop's shoulder rather than across town, so that is what is
     * checked.
     */
    for (const id of ["castle_hills", "medical_center"]) {
      test(`${id} sits on the shoulder of Loop 410`, () => {
        const p = at(id);
        assert.ok(p, `${id} missing from the gazetteer`);
        const nearest = Math.min(...ring.map(([lon, lat]) => Math.hypot((lon - p.lon) * 0.87, lat - p.lat)));
        // ~0.02 degrees of latitude is about 2.2km.
        assert.ok(nearest < 0.025, `${id} is ${(nearest * 111).toFixed(1)}km from the loop`);
      });
    }

    for (const id of ["stone_oak", "timberwood", "randolph", "schertz"]) {
      test(`${id} is outside Loop 410`, () => {
        const p = at(id);
        assert.ok(p, `${id} missing from the gazetteer`);
        assert.ok(!inside(p.lon, p.lat), `${id} (${p.lon},${p.lat}) fell inside the ring`);
      });
    }

    test("Stone Oak sits north of the 1604 north arc, as the script says", () => {
      const northArc = byId.loop1604.geometry.coordinates
        .flat()
        .filter(([lon]) => lon > -98.55 && lon < -98.40)
        .map((p) => p[1]);
      assert.ok(at("stone_oak").lat > Math.max(...northArc) - 0.05, "Stone Oak is not north of 1604");
    });
  });
});

describe("projection", () => {
  test("does not distort — one scale on both axes", () => {
    const project = buildProjection({ minLon: -98.7, maxLon: -98.2, minLat: 29.2, maxLat: 29.7 });
    const [x1, y1] = project(-98.7, 29.7);
    const [x2] = project(-98.2, 29.7);
    const [, y2] = project(-98.7, 29.2);
    const lonScale = Math.cos((29.45 * Math.PI) / 180);
    // Equal degree spans, so the drawn width should be the height times the
    // cosine correction. Without it San Antonio comes out an egg.
    assert.ok(Math.abs((x2 - x1) / (y2 - y1) - lonScale) < 0.02);
  });

  test("rejects degenerate bounds rather than dividing by zero", () => {
    assert.throws(() => buildProjection({ minLon: -98, maxLon: -98, minLat: 29, maxLat: 29 }));
  });
});

describe("the map render", () => {
  test("the two-rings map draws both rings and credits the source", () => {
    const svg = renderMapSvg({
      market: "san_antonio",
      highlight: ["loop410", "loop1604"],
      labels: ["downtown", "stone_oak", "medical_center"],
      title: "It sits in rings",
    });
    assert.match(svg, /Loop 410/);
    assert.match(svg, /1604/);
    assert.ok(svg.includes(MAP_ATTRIBUTION), "attribution must be on the frame itself");
  });

  test("renders non-blank at full size", async () => {
    const png = await renderMapPng({ market: "san_antonio", highlight: ["loop410", "loop1604"], labels: ["stone_oak"] });
    assert.ok(await isNonBlank(png), "map rendered blank");
    assert.ok(png.length > 20_000, "suspiciously small PNG");
  });

  test("an unknown market throws rather than drawing an empty frame", () => {
    assert.throws(() => loadMarket("el_paso"), /no vendored geometry/);
  });
});

describe("infographic content", () => {
  test("pulls MUD and PID out of the narration correctly", () => {
    const spec = infographicSpecForSegment({ text: MUD_PID });
    assert.equal(spec.layout, "definition");
    assert.deepEqual(spec.terms.map((t) => t.term), ["MUD", "PID"]);
    assert.match(spec.terms[0].definition, /municipal utility district/);
  });

  test("the exemption breakdown keeps the assessment row live", () => {
    const spec = infographicSpecForSegment({ text: EXEMPTION });
    assert.equal(spec.layout, "breakdown");
    const live = spec.rows.filter((r) => !r.struck);
    assert.equal(live.length, 1);
    assert.match(live[0].label, /MUD/);
  });

  test("DECLINES on prose it cannot decompose — the common, correct path", () => {
    assert.equal(infographicSpecForSegment({ text: "It's quiet in a way that surprises people. Deer in the front yard quiet." }), null);
    assert.equal(infographicSpecForSegment({ text: "" }), null);
  });

  test("a district card never borrows an unrelated section heading", () => {
    const spec = infographicSpecForSegment(
      { text: "Northside ISD covers the northwest. North East ISD covers the north." },
      { section: "Northeast for Randolph, Fort Sam Houston and BAMC" }
    );
    assert.ok(!/Randolph/.test(spec.title), "section title leaked onto a school-district card");
  });

  test("renders non-blank", async () => {
    const png = await renderInfographicPng(infographicSpecForSegment({ text: MUD_PID }));
    assert.ok(await isNonBlank(png));
  });
});

describe("the 30% cap", () => {
  const seg = (i, seconds, visual, score) => ({
    kind: "voiceover", takeId: `t${i}`, seconds, visual, visualScore: score,
    broll: [{ driveFileId: `c${i}`, seconds }],
  });

  test("never spends more than the cap on generated visuals", () => {
    // Every take is short, so each visual costs the 4s floor while adding only
    // 12s to the budget — the budget runs out well before the candidates do.
    const segments = Array.from({ length: 20 }, (_, i) => seg(i, 12, MAP, 10));
    const { report } = selectGeneratedVisuals(segments);
    assert.ok(report.share <= GENERATED_SHARE_CAP + 1e-9, `share was ${report.share}`);
    assert.ok(report.skippedForCap > 0, "this fixture should overflow the budget");
  });

  test("when the cap bites it keeps the HIGHEST-scoring candidates", () => {
    // 3 x 12s of B-roll is a 10.8s budget, and each visual wants 6s — so
    // exactly one fits and it must be the strongest.
    const segments = [seg(1, 12, MAP, 3), seg(2, 12, MAP, 20), seg(3, 12, MAP, 12)];
    const { segments: out, report } = selectGeneratedVisuals(segments);
    const chosen = out.filter((s) => s.generatedSeconds > 0).map((s) => s.takeId);
    assert.equal(report.chosenCount, 1, `budget should fit exactly one, chose ${chosen.join(",")}`);
    assert.deepEqual(chosen, ["t2"], "the strongest candidate must be the one that survives");
  });

  test("footage segments are never touched", () => {
    const segments = [seg(1, 30, FOOTAGE, 0), seg(2, 30, FOOTAGE, 0)];
    const { segments: out, report } = selectGeneratedVisuals(segments);
    assert.equal(report.chosenCount, 0);
    assert.ok(out.every((s) => s.generatedSeconds === 0));
  });

  test("on-camera runtime is excluded from the budget", () => {
    // The cap is a share of B-ROLL, not of the whole video. Counting Peter's
    // own footage would buy graphics with runtime they can never occupy.
    const segments = [{ kind: "on_camera", seconds: 600 }, seg(1, 40, MAP, 10)];
    const { report } = selectGeneratedVisuals(segments);
    assert.equal(report.brollSeconds, 40);
    assert.ok(report.budgetSeconds <= 12 + 1e-9);
  });
});

describe("splicing a visual into a segment", () => {
  test("the take's total runtime is unchanged", () => {
    const broll = [{ driveFileId: "a", seconds: 6 }, { driveFileId: "b", seconds: 6 }, { driveFileId: "c", seconds: 6 }];
    const out = spliceGenerated(broll, { path: "/tmp/m.png", seconds: 6, kind: "map" });
    const total = out.reduce((n, c) => n + c.seconds, 0);
    assert.equal(total, 18, "splicing must not change how long the take runs");
  });

  test("the generated clip comes first", () => {
    const out = spliceGenerated([{ driveFileId: "a", seconds: 10 }], { path: "/tmp/m.png", seconds: 4, kind: "map" });
    assert.equal(out[0].generated, true);
    assert.equal(out[0].seconds, 4);
  });

  test("trims from the end so surviving clips stay readable", () => {
    // Shaving proportionally would leave three stubs too short to register.
    const broll = [{ driveFileId: "a", seconds: 6 }, { driveFileId: "b", seconds: 6 }];
    const out = spliceGenerated(broll, { path: "/tmp/m.png", seconds: 6, kind: "map" });
    assert.equal(out.length, 2);
    assert.equal(out[1].driveFileId, "a");
    assert.equal(out[1].seconds, 6, "the first clip should survive at full length");
  });
});

describe("ken burns", () => {
  test("outputs the CANVAS size, not the source size", () => {
    // zoompan's `s` is the output. Getting it wrong yields a correct-length
    // clip at the wrong size, which concat reinterprets rather than rejects.
    const args = kenBurnsArgs("/tmp/a.png", "/tmp/o.mp4", { seconds: 6, dim: { w: 1920, h: 1080 } });
    assert.match(args.join(" "), /s=1920x1080/);
  });

  test("duration is expressed in frames, and matches the seconds asked for", () => {
    const args = kenBurnsArgs("/tmp/a.png", "/tmp/o.mp4", { seconds: 6, dim: { w: 1920, h: 1080 }, fps: 30 });
    assert.match(args.join(" "), /d=180/);
    assert.equal(args[args.indexOf("-t") + 1], "6");
  });

  test("the zoom RAMPS — it is a function of the frame counter, not a constant", () => {
    // This shipped as z='1.0+0.12/180' once: a constant, accepted by ffmpeg,
    // producing a correctly sized clip of 180 identical frames. Nothing threw.
    const args = kenBurnsArgs("/tmp/a.png", "/tmp/o.mp4", { seconds: 6, dim: { w: 1920, h: 1080 }, fps: 30 });
    const z = /z='([^']+)'/.exec(args.join(" "))?.[1];
    assert.ok(z, "no zoom expression at all");
    assert.match(z, /\bon\b/, `zoom expression "${z}" does not vary with the frame counter`);
  });

  test("zooming out starts wide and ends at 1", () => {
    const out = /z='([^']+)'/.exec(kenBurnsArgs("/tmp/a.png", "/tmp/o.mp4", { seconds: 6, dim: { w: 1920, h: 1080 }, direction: "out" }).join(" "))[1];
    assert.match(out, /^1\.12-/);
  });

  test("keeps the pixel format concat requires", () => {
    const args = kenBurnsArgs("/tmp/a.png", "/tmp/o.mp4", { seconds: 4, dim: { w: 1920, h: 1080 } });
    assert.match(args.join(" "), /format=yuv420p/);
    assert.match(args.join(" "), /setsar=1/);
  });
});

describe("attribution in the description", () => {
  test("is present when a map was used", () => {
    const { text } = buildDescription({ hook: "h", promise: "p", mapsUsed: true });
    assert.ok(text.includes(MAP_CREDITS.tiger));
    assert.match(text, /public domain/);
  });

  test("is ABSENT when no map was drawn", () => {
    // A standing credit line that is sometimes false is worse than none.
    const { text } = buildDescription({ hook: "h", promise: "p", mapsUsed: false });
    assert.ok(!text.includes("TIGER"));
  });

  test("the OSM fallback carries the copyright URL its licence requires", () => {
    const { text } = buildDescription({ hook: "h", promise: "p", mapsUsed: true, mapSource: "osm" });
    assert.match(text, /OpenStreetMap contributors/);
    assert.match(text, /openstreetmap\.org\/copyright/);
    assert.match(text, /Open Database License/);
  });

  test("an unknown source is reported rather than silently uncredited", () => {
    const { missing } = buildDescription({ hook: "h", promise: "p", mapsUsed: true, mapSource: "bing" });
    assert.ok(missing.some((m) => /map attribution/.test(m)));
  });
});
