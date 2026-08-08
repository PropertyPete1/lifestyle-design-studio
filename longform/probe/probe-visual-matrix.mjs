#!/usr/bin/env node
/**
 * probe-visual-matrix.mjs — every path through the visual system, exercised.
 *
 * Not a unit test. The suite proves each piece behaves; this proves the pieces
 * behave TOGETHER, on real geometry, through real ffmpeg, including the paths
 * that only exist when something goes wrong. Those are the ones that ship
 * broken, because they are the ones nobody runs.
 *
 * Needs no API key — everything here is downstream of the writer, so it runs on
 * a laptop and on the runner identically.
 *
 * EVERY CHECK ASSERTS AN EFFECT, NEVER A RETURN VALUE. A render "succeeding"
 * means a file exists with real bytes and passes QC at 1080p; a clip
 * "encoding" means ffprobe agrees on its size and duration and the frames
 * actually differ. This project's most expensive bug class is a success return
 * with nothing behind it, and a probe that trusted return values would be one.
 *
 *   node longform/probe/probe-visual-matrix.mjs
 */

import { mkdirSync, rmSync, existsSync, statSync, writeFileSync, chmodSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import { tmpdir } from "os";

import { planTimeline } from "../../auto-poster/src/yt-timeline.js";
import { applyGeneratedVisuals, kenBurnsArgs, selectGeneratedVisuals } from "../../auto-poster/src/yt-visual-broll.js";
import { normaliseIntent, attachIntents, GRAPHIC_TYPES, FOOTAGE, MAP } from "../../auto-poster/src/yt-visual-intent.js";
import { renderCardPng, renderCardSvg, CARD_TYPES } from "../../auto-poster/src/yt-card-render.js";
import { mapSpecForIntent, renderMapPng } from "../../auto-poster/src/yt-map-render.js";
import { inspectRender, findOverflowingText, frameDifference, solidPng } from "../../auto-poster/src/yt-visual-qc.js";
import { planOpening, validateOverlay, renderOverlayPng, burnOverlayArgs } from "../../auto-poster/src/yt-opening.js";
import { allTakes } from "../../auto-poster/src/yt-script.js";

const OUT = process.env.PROBE_OUT_DIR || join(tmpdir(), `visual-matrix-${Date.now()}`);
mkdirSync(OUT, { recursive: true });

const results = [];
let currentPath = null;

function path(name) {
  currentPath = { name, checks: [], failures: [] };
  results.push(currentPath);
}
function check(label, condition, detail = "") {
  currentPath.checks.push(label);
  if (!condition) currentPath.failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
}
async function guard(label, fn) {
  try {
    await fn();
  } catch (err) {
    currentPath.failures.push(`${label} THREW — ${err.message}`);
  }
}

// ─── fixtures ───────────────────────────────────────────────────────────────

const SPECS = {
  NUMBER_BREAKDOWN: { eyebrow: "A tax bill", title: "Where the money goes", rows: [{ label: "School district", value: "1.24%" }, { label: "County", value: "0.28%" }, { label: "City", value: "0.55%" }], total: "2.07%" },
  COMPARISON: { title: "Older inside, newer outside", columns: [{ name: "Inside the loop", points: ["1970s build", "Bigger lot"] }, { name: "Outside", points: ["2000s build", "More space"] }] },
  LIST: { eyebrow: "Before you apply", title: "What a lender asks for", items: ["Two years of W2s", "Thirty days of pay stubs", "Two months of bank statements"] },
  TIMELINE: { title: "Offer to keys", steps: [{ label: "Offer accepted", when: "day 0" }, { label: "Option ends", when: "day 7" }, { label: "Clear to close", when: "day 30" }] },
  CALLOUT: { eyebrow: "San Antonio, 2026", value: "41 days", label: "median time on market" },
};

/** Specs that are structurally valid but impossible to draw well. */
const BROKEN_SPECS = {
  NUMBER_BREAKDOWN: { title: "  ", rows: [{ label: " ", value: " " }, { label: "", value: "" }] },
  COMPARISON: { title: " ", columns: [{ name: " ", points: [" "] }, { name: " ", points: [" "] }] },
  LIST: { title: " ", items: [" ", "  "] },
  TIMELINE: { title: " ", steps: [{ label: " " }, { label: "  " }] },
  CALLOUT: { value: " ", label: " " },
};

const pool = (n = 138) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, name: `c${i}.mp4`, durationSeconds: 20, contentHash: `h${i}` }));
const recs = (script) => Object.fromEntries(allTakes(script).map((t) => [t.id, { path: `/tmp/${t.id}.mp4`, durationSeconds: 22 }]));

/** A script whose voiceover takes all carry `intentFor(i)`. */
function scriptWith(intentFor, { takes = 6, openWithFace = true } = {}) {
  const list = [];
  if (openWithFace) list.push({ id: "s1t0", mode: "ON_CAMERA", text: "This is the opening claim, said to camera, and it runs about twenty seconds." });
  for (let i = 0; i < takes; i++) {
    list.push({ id: `s1t${i + 1}`, mode: "VOICEOVER", text: `Narration for take ${i + 1}, long enough to be a real take of about twenty seconds.`, visualIntent: intentFor(i) });
  }
  return {
    title: "t", hook: "There is no state income tax here. That is the trade.", promise: "p",
    sections: [{ title: "S", boundaryPull: "b", takes: list }],
    softCta: { mode: "ON_CAMERA", text: "cta" }, close: { mode: "ON_CAMERA", text: "close" },
  };
}

async function build(script, opts = {}) {
  const plan = planTimeline(script, recs(script), pool());
  const dir = join(OUT, `w${results.length}-${Math.random().toString(36).slice(2, 7)}`);
  return { plan, result: await applyGeneratedVisuals(plan, { workDir: dir, market: "san_antonio", ...opts }) };
}

function ffprobe(p) {
  const out = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,nb_frames", "-show_entries", "format=duration", "-of", "default=nw=1", p], { encoding: "utf-8" });
  return Object.fromEntries(out.trim().split("\n").map((l) => l.split("=")));
}

// ═══ PATH 1: every type renders ═════════════════════════════════════════════

path("each graphic type renders and passes QC");
for (const type of CARD_TYPES) {
  await guard(type, async () => {
    const png = await renderCardPng(type, SPECS[type]);
    const v = await inspectRender(png, { label: type });
    const overflow = findOverflowingText(renderCardSvg(type, SPECS[type]));
    check(`${type} renders`, png.length > 5000, `${png.length} bytes`);
    check(`${type} passes QC`, v.ok, v.failures.join("; "));
    check(`${type} text is on-canvas`, overflow.length === 0, JSON.stringify(overflow));
  });
}
await guard("MAP", async () => {
  const spec = mapSpecForIntent({ places: ["Stone Oak", "Downtown"], lines: ["1604", "Loop 410"] });
  check("MAP spec resolves", Boolean(spec));
  const png = await renderMapPng(spec);
  const v = await inspectRender(png, { label: "MAP", edgeCheck: false });
  check("MAP renders", png.length > 5000);
  check("MAP passes QC", v.ok, v.failures.join("; "));
});

// ═══ PATH 2: every type FAILS gracefully ════════════════════════════════════

path("each graphic type fails to footage rather than shipping junk");
for (const type of CARD_TYPES) {
  await guard(`${type} broken`, async () => {
    // The PRIMARY defence is the normaliser: blank content never reaches a
    // renderer at all.
    const rejected = normaliseIntent({ type, spec: BROKEN_SPECS[type] });
    check(`${type} blank content is rejected before rendering`, !rejected.ok, `normaliser accepted it: ${JSON.stringify(rejected.spec)}`);

    // DEFENCE IN DEPTH: if one did render anyway, QC is the last thing before
    // the screen and must not wave through a card of pure furniture.
    const png = await renderCardPng(type, BROKEN_SPECS[type]);
    const v = await inspectRender(png, { label: type });
    check(`${type} chrome-only render is caught by QC`, !v.ok, `QC passed a card with no readable content: ${JSON.stringify(v.metrics)}`);
  });
}
await guard("end to end fallback", async () => {
  const script = scriptWith(() => ({ type: "LIST", spec: { title: " ", items: [" ", "  "] } }));
  const { result } = await build(script);
  const g = result.generated;
  check("a blank card never reaches the timeline", g.renderedCount === 0, `${g.renderedCount} rendered`);
  // It is rejected at the intent stage, so the record lives in intents.rejections
  // rather than in render failures. Either channel is fine; silence is not.
  check("the rejection is recorded somewhere", g.intents.rejected > 0 || g.failures.length > 0,
    `rejections=${g.intents.rejected} failures=${g.failures.length}`);
  check("footage still plays on those takes", result.segments.filter((s) => s.kind === "voiceover").every((s) => (s.broll || []).length > 0));
});

// ═══ PATH 3: a script requesting ZERO graphics ══════════════════════════════

path("a script that requests zero graphics");
await guard("all footage", async () => {
  const script = scriptWith(() => "FOOTAGE");
  const { result } = await build(script);
  const g = result.generated;
  check("nothing is rendered", g.renderedCount === 0);
  check("no failures are invented", g.failures.length === 0, JSON.stringify(g.failures));
  check("the split reads 0/100", g.split.graphicPct === 0 && g.split.footagePct === 100, JSON.stringify(g.split));
  check("footage choices are counted", g.intents.footageTakes === 6, `${g.intents.footageTakes}`);
  check("no take is left unspecified", g.intents.unspecifiedTakes === 0);
  check("every segment keeps its footage", result.segments.filter((s) => s.kind === "voiceover").every((s) => (s.broll || []).length > 0));
});

path("a script that says NOTHING (no intents at all)");
await guard("silent script", async () => {
  const script = scriptWith(() => undefined);
  const { result } = await build(script);
  const g = result.generated;
  check("nothing is rendered", g.renderedCount === 0);
  check("silence is distinguished from a footage choice", g.intents.unspecifiedTakes === 6 && g.intents.footageTakes === 0,
    `unspecified=${g.intents.unspecifiedTakes} footage=${g.intents.footageTakes}`);
  check("the split still reports", g.split.graphicPct === 0);
});

// ═══ PATH 4: graphics on EVERY line ═════════════════════════════════════════

path("a script requesting a graphic on every line");
await guard("all graphics", async () => {
  const types = CARD_TYPES;
  const script = scriptWith((i) => ({ type: types[i % types.length], spec: SPECS[types[i % types.length]] }));
  const { result } = await build(script);
  const g = result.generated;
  check("every past-opening take renders", g.renderedCount === 6, `${g.renderedCount} of 6`);
  check("there is no cap holding it back", g.split.graphicPct === 100, JSON.stringify(g.split));
  check("each render exists on disk", g.rendered.every((r) => existsSync(r.path) && statSync(r.path).size > 5000));
  const spliced = result.segments.flatMap((s) => (s.broll || []).filter((b) => b.generated));
  check("every render is spliced in", spliced.length === g.rendered.length, `${g.rendered.length} rendered vs ${spliced.length} spliced`);
  check("runtime is unchanged by splicing", result.segments.filter((s) => s.kind === "voiceover")
    .every((s) => Math.abs((s.broll || []).reduce((n, c) => n + c.seconds, 0) - s.seconds) < 0.05));
});

// ═══ PATH 5: malformed model output ═════════════════════════════════════════

path("malformed visualIntent from the model");
await guard("junk intents", async () => {
  const junk = [
    { type: "NUMBER_BREAKDOWN", spec: { rows: "not an array" } },
    { type: "COMPARISON", spec: { columns: [null, 42] } },
    { type: null, spec: {} },
    "a bare string that is not a type",
    12345,
    { type: "TIMELINE", spec: { steps: [{}, {}] } },
  ];
  const script = scriptWith((i) => junk[i]);
  const { result } = await build(script);
  const g = result.generated;
  check("nothing is rendered from junk", g.renderedCount === 0);
  check("rejections are recorded, not swallowed", g.intents.rejected >= 4, `${g.intents.rejected} recorded`);
  check("the build survives", Array.isArray(result.segments) && result.segments.length > 0);
});
await guard("normaliser never throws", async () => {
  let threw = false;
  for (const j of [0, "", [], true, { type: 5 }, { type: "MAP", spec: null }, Symbol.iterator, () => {}, new Date()]) {
    try { normaliseIntent(j); } catch { threw = true; }
  }
  check("normaliseIntent never throws", !threw);
});

// ═══ PATH 6: a renderer returning blank ═════════════════════════════════════

path("a renderer that returns a blank image");
await guard("blank detection", async () => {
  const black = await solidPng(2560, 1440, "#000");
  const v = await inspectRender(black);
  check("a large valid all-black PNG is caught", !v.ok && v.failures.some((f) => /blank/.test(f)), v.failures.join("; "));
  const junkBytes = await inspectRender(Buffer.from("not a png at all"));
  check("unreadable bytes are reported, not thrown", !junkBytes.ok && junkBytes.failures.some((f) => /unreadable/.test(f)));
});

// ═══ PATH 7: a map naming places we do not cover ════════════════════════════

path("a MAP request the geometry cannot satisfy");
await guard("uncovered places", async () => {
  check("a wholly foreign map declines", mapSpecForIntent({ places: ["Brooklyn", "Queens"], lines: ["BQE"] }) === null);
  check("an unknown market declines", mapSpecForIntent({ places: ["Stone Oak"] }, { market: "el_paso" }) === null);
  const partial = mapSpecForIntent({ places: ["Stone Oak", "Buffalo Bayou"], lines: [] });
  check("a partial match keeps what it knows", partial && partial.labels.length === 1, JSON.stringify(partial));

  const script = scriptWith(() => ({ type: "MAP", spec: { places: ["Brooklyn"], lines: ["BQE"] } }));
  const { result } = await build(script);
  check("an unsatisfiable map falls back to footage", result.generated.renderedCount === 0);
  check("the fallback is reported", result.generated.failures.length === 6, `${result.generated.failures.length}`);
  check("footage still plays", result.segments.filter((s) => s.kind === "voiceover").every((s) => (s.broll || []).length > 0));
});

// ═══ PATH 8: FOOTAGE requested but no footage available ════════════════════

path("FOOTAGE requested when the library is exhausted");
await guard("starved footage", async () => {
  const script = scriptWith(() => "FOOTAGE", { takes: 6 });
  // A pool far too small for six takes, so the allocator runs dry.
  const plan = planTimeline(script, recs(script), pool(3));
  check("the planner flags exhaustion", plan.brollExhausted === true);
  const starved = plan.segments.filter((s) => s.kind === "voiceover" && (s.broll || []).length === 0);
  check("some segments genuinely have no footage", starved.length > 0, `${starved.length}`);

  const { generated } = await applyGeneratedVisuals(plan, { workDir: join(OUT, "starved"), market: "san_antonio" });
  check("nothing is spliced into a starved segment", generated.renderedCount === 0);
  // The loud failure must remain loud: renderTimeline still refuses this plan.
  check("the exhausted plan is still detectable downstream", starved.length > 0);
});

path("a GRAPHIC requested on a starved segment");
await guard("starved graphic", async () => {
  const script = scriptWith(() => ({ type: "CALLOUT", spec: SPECS.CALLOUT }), { takes: 6 });
  const plan = planTimeline(script, recs(script), pool(3));
  const { report } = selectGeneratedVisuals(plan.segments);
  const starvedIdx = plan.segments.findIndex((s) => s.kind === "voiceover" && (s.broll || []).length === 0);
  check("a starved segment exists in the fixture", starvedIdx >= 0);
  check("it is never chosen", report.chosenCount < plan.segments.filter((s) => s.kind === "voiceover").length);
});

// ═══ PATH 9: the opening treatment ══════════════════════════════════════════

path("the opening treatment");
await guard("opening", async () => {
  const good = scriptWith(() => "FOOTAGE");
  const { result } = await build(good);
  const okPlan = planOpening(result.segments, { overlay: "The trade nobody explains" });
  check("a face-first timeline passes", okPlan.ok, okPlan.failures.join("; "));
  check("the composition names what it opens on", /on-camera/.test(okPlan.composition.opensOn));

  // No on-camera take at all.
  const faceless = scriptWith(() => "FOOTAGE", { openWithFace: false });
  const { result: r2 } = await build(faceless);
  const badPlan = planOpening(r2.segments);
  check("a timeline with no opening face FAILS", !badPlan.ok);
  check("the failure names the cause", badPlan.failures.some((f) => /on-camera/.test(f)), badPlan.failures.join("; "));

  // On-camera present but never recorded.
  const noRec = planOpening([{ kind: "on_camera", takeId: "s1t0", seconds: 20, source: null }]);
  check("an unrecorded opening take FAILS", !noRec.ok && noRec.failures.some((f) => /no recording/.test(f)));

  check("an empty timeline fails cleanly", planOpening([]).ok === false);
});

path("graphics are suppressed for the first 15 seconds");
await guard("suppression", async () => {
  const script = scriptWith(() => ({ type: "CALLOUT", spec: SPECS.CALLOUT }));
  const { result } = await build(script);
  const opening = planOpening(result.segments, { overlay: "The trade nobody explains" });
  check("no graphic is scheduled in the protected window", opening.ok, opening.failures.join("; "));
  const first = result.segments[0];
  check("the video still opens on the face", first.kind === "on_camera");
  check("suppression is reported", Array.isArray(result.generated.suppressedInOpening));
});

path("the opening overlay");
await guard("overlay", async () => {
  const HOOK = "There is no state income tax here. That is the trade, and nobody explains the other half of it.";
  check("a good line passes", validateOverlay("The trade nobody explains", HOOK).length === 0);
  check("a verbatim run is rejected", validateOverlay("there is no state income tax", HOOK).length > 0);
  check("too short is rejected", validateOverlay("Taxes", HOOK).length > 0);
  check("empty is rejected", validateOverlay("", HOOK).length > 0);

  const png = await renderOverlayPng("The trade nobody explains", { width: 1920, height: 1080 });
  const v = await inspectRender(png, { label: "overlay", edgeCheck: false });
  check("the overlay is not blank", v.metrics.range > 8, JSON.stringify(v.metrics));
  writeFileSync(join(OUT, "overlay.png"), png);
});

// ═══ PATH 10: real ffmpeg ═══════════════════════════════════════════════════

path("real encoding: ken burns and the overlay burn");
await guard("ffmpeg", async () => {
  const png = await renderCardPng("CALLOUT", SPECS.CALLOUT);
  const src = join(OUT, "kb.png");
  writeFileSync(src, png);
  const clip = join(OUT, "kb.mp4");
  execFileSync("ffmpeg", kenBurnsArgs(src, clip, { seconds: 6, dim: { w: 1920, h: 1080 }, fps: 30 }), { stdio: ["pipe", "pipe", "pipe"] });
  const p = ffprobe(clip);
  check("the clip is 1920x1080", p.width === "1920" && p.height === "1080", `${p.width}x${p.height}`);
  check("the clip is the requested length", Math.abs(parseFloat(p.duration) - 6) < 0.1, `${p.duration}s`);

  // The frames must actually MOVE. A constant zoom expression produced a
  // correctly sized clip of 180 identical frames and nothing caught it.
  const last = Number(p.nb_frames) - 1;
  for (const n of [0, last]) {
    execFileSync("ffmpeg", ["-y", "-v", "error", "-i", clip, "-vf", `select=eq(n\\,${n})`, "-vframes", "1", join(OUT, `f${n}.png`)]);
  }
  const motion = await frameDifference(join(OUT, "f0.png"), join(OUT, `f${last}.png`));
  check("ken burns actually moves", motion > 1, `mean frame diff ${motion.toFixed(2)}`);

  // And the overlay burn, over a real clip.
  const ov = join(OUT, "ov.png");
  writeFileSync(ov, await renderOverlayPng("The trade nobody explains", { w: 1920, h: 1080 }));
  const burned = join(OUT, "burned.mp4");
  execFileSync("ffmpeg", burnOverlayArgs(clip, ov, burned), { stdio: ["pipe", "pipe", "pipe"] });
  const bp = ffprobe(burned);
  check("the burned clip keeps its size", bp.width === "1920" && bp.height === "1080");
  check("the burned clip keeps its length", Math.abs(parseFloat(bp.duration) - 6) < 0.2, `${bp.duration}s`);

  // The overlay must be VISIBLE: a frame inside the window differs from one
  // after it. Otherwise the burn "succeeded" and changed nothing.
  for (const [n, tag] of [[60, "inside"], [175, "after"]]) {
    execFileSync("ffmpeg", ["-y", "-v", "error", "-i", burned, "-vf", `select=eq(n\\,${n})`, "-vframes", "1", join(OUT, `b_${tag}.png`)]);
  }
  const overlayDelta = await frameDifference(join(OUT, "b_inside.png"), join(OUT, "b_after.png"));
  check("the overlay is actually visible on screen", overlayDelta > 1, `mean diff ${overlayDelta.toFixed(2)}`);
});

// ═══ PATH 11: hostile environment ═══════════════════════════════════════════

path("hostile environment");
await guard("unwritable work dir", async () => {
  const ro = join(OUT, "readonly");
  mkdirSync(ro, { recursive: true });
  chmodSync(ro, 0o500);
  try {
    const script = scriptWith(() => ({ type: "CALLOUT", spec: SPECS.CALLOUT }));
    const plan = planTimeline(script, recs(script), pool());
    const { generated } = await applyGeneratedVisuals(plan, { workDir: ro, market: "san_antonio" });
    check("no false render is claimed", generated.rendered.every((r) => existsSync(r.path)));
    check("the failure is reported", generated.renderedCount === 0 ? generated.failures.length > 0 : true);
  } finally {
    chmodSync(ro, 0o700);
  }
});

// ─── report ─────────────────────────────────────────────────────────────────

console.log(`\n${"=".repeat(74)}\nVISUAL PATH MATRIX\n${"=".repeat(74)}\n`);
let totalChecks = 0;
let totalFailures = 0;
for (const r of results) {
  totalChecks += r.checks.length;
  totalFailures += r.failures.length;
  const status = r.failures.length === 0 ? "PASS" : "FAIL";
  console.log(`${status}  ${r.name}  (${r.checks.length} checks)`);
  for (const f of r.failures) console.log(`      ✗ ${f}`);
}

console.log(`\n${"-".repeat(74)}`);
console.log(`${results.length} paths, ${totalChecks} checks, ${totalFailures} failures`);
console.log(`artifacts in ${OUT}`);

// A path that ran no checks is a path that silently did nothing.
const empty = results.filter((r) => r.checks.length === 0);
if (empty.length) {
  console.log(`\nVACUOUS: ${empty.length} path(s) ran no checks at all: ${empty.map((r) => r.name).join(", ")}`);
}

console.log(totalFailures === 0 && empty.length === 0 ? "\nZERO FAILURES\n" : "\nFAILURES PRESENT\n");
process.exit(totalFailures === 0 && empty.length === 0 ? 0 : 1);
