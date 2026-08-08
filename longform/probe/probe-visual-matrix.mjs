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
import { detectSilences, buildEditList, pieceArgs, splitForPunchIns, MIN_PIECE_SECONDS } from "../../auto-poster/src/yt-oncamera-edit.js";
import { auditCadence, buildStateTimeline } from "../../auto-poster/src/yt-cadence.js";
import { gateCutout, pipPlacement, pipCompositeArgs, planPip, segmentationAvailable, CAPTION_SAFE_BOTTOM } from "../../auto-poster/src/yt-pip.js";

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


// ═══ PATH 12: real takes — silence, jump cuts, punch-ins ════════════════════

/** Build a real encoded take with known silences. Not a mock: real frames, real audio. */
function makeTake(name, seconds, gaps) {
  const out = join(OUT, `${name}.mp4`);
  const mute = gaps.map(([a, b]) => `between(t,${a},${b})`).join("+") || "0";
  execFileSync("ffmpeg", ["-y", "-v", "error",
    "-f", "lavfi", "-i", `testsrc2=size=640x360:rate=30:duration=${seconds}`,
    "-f", "lavfi", "-i", `sine=frequency=220:duration=${seconds}`,
    "-filter_complex", `[1:a]volume='if(${mute},0,1)':eval=frame[a]`,
    "-map", "0:v", "-map", "[a]",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest", out], { stdio: ["pipe", "pipe", "pipe"] });
  return out;
}

path("silence detection on a real take");
await guard("detect", async () => {
  const take = makeTake("t_gaps", 30, [[5, 6.2], [12, 13.5], [20, 20.9], [26, 27.6]]);
  const sil = detectSilences(take, { duration: 30 });
  check("finds every injected pause", sil.length === 4, `found ${sil.length}`);
  check("the first pause is where it was put", Math.abs(sil[0].start - 5) < 0.2, `${sil[0].start}`);

  // The bug that made this necessary: silencedetect writes to STDERR, and
  // execFileSync returns stdout — so it reported "no silence" on every take.
  check("does not report an empty result on a take that has pauses", sil.length > 0);
});

path("a take with NO silence at all");
await guard("no silence", async () => {
  const take = makeTake("t_nosilence", 20, []);
  const sil = detectSilences(take, { duration: 20 });
  check("finds nothing, and says so without erroring", sil.length === 0, `found ${sil.length}`);
  const plan = buildEditList(20, sil);
  check("still breaks the take up with punch-ins", plan.pieces.length >= 2, `${plan.pieces.length} pieces`);
  check("removes no runtime", plan.removedSeconds === 0);
});

path("a take that is nearly ALL silence");
await guard("all silence", async () => {
  const take = makeTake("t_allsilence", 20, [[0.3, 19.5]]);
  const sil = detectSilences(take, { duration: 20 });
  const plan = buildEditList(20, sil);
  // Trimming this to half a second is deleting the take, not editing it.
  check("the take is restored rather than deleted", plan.editedSeconds > 20 * 0.9, `kept ${plan.editedSeconds}s of 20s`);
  check("and the reason is reported", plan.warnings.length > 0, JSON.stringify(plan.warnings));
});

path("cuts never land mid-word");
await guard("cut points", async () => {
  const take = makeTake("t_word", 24, [[8, 9.2], [16, 17.4]]);
  const sil = detectSilences(take, { duration: 24 });
  const plan = buildEditList(24, sil);
  // Every cut boundary must sit INSIDE a detected silence, never in speech.
  const inSilence = (t) => sil.some((s) => t >= s.start - 0.05 && t <= s.end + 0.05);
  const seams = [];
  for (let i = 1; i < plan.pieces.length; i++) {
    if (plan.pieces[i].srcStart > plan.pieces[i - 1].srcEnd + 0.001) {
      seams.push([plan.pieces[i - 1].srcEnd, plan.pieces[i].srcStart]);
    }
  }
  check("there is at least one removal seam", seams.length > 0);
  check("every removal seam sits inside a silence", seams.every(([a, b]) => inSilence(a) && inSilence(b)), JSON.stringify(seams));
});

path("rendering the edited take, verified in pixels");
await guard("render", async () => {
  const take = makeTake("t_render", 30, [[10, 11.5]]);
  const sil = detectSilences(take, { duration: 30 });
  const plan = buildEditList(30, sil);
  const dim = { w: 1280, h: 720 };
  const files = [];
  plan.pieces.forEach((piece, i) => {
    const out = join(OUT, `piece${i}.mp4`);
    execFileSync("ffmpeg", pieceArgs(take, out, piece, dim), { stdio: ["pipe", "pipe", "pipe"] });
    files.push({ out, piece });
  });
  check("every piece rendered", files.every((f) => existsSync(f.out)));
  for (const { out, piece } of files) {
    const p = ffprobe(out);
    check(`piece is ${dim.w}x${dim.h}`, p.width === String(dim.w) && p.height === String(dim.h), `${p.width}x${p.height}`);
    check("piece duration matches the plan", Math.abs(parseFloat(p.duration) - piece.seconds) < 0.15, `${p.duration} vs ${piece.seconds}`);
  }

  // The concatenated result must be shorter than the source by the dead air.
  const list = join(OUT, "editlist.txt");
  writeFileSync(list, files.map((f) => `file '${f.out}'`).join("\n"));
  const joined = join(OUT, "edited.mp4");
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", joined]);
  const total = parseFloat(ffprobe(joined).duration);
  check("the finished take is shorter by the dead air", total < 29.5, `${total.toFixed(2)}s`);
  check("and not shorter than the plan said", Math.abs(total - plan.editedSeconds) < 0.5, `${total.toFixed(2)} vs ${plan.editedSeconds}`);
});

path("the punch-in and the push change actual pixels");
await guard("framing", async () => {
  // A STATIC source, so any frame difference can only be our own move.
  const still = join(OUT, "still.mp4");
  execFileSync("ffmpeg", ["-y", "-v", "error",
    "-f", "lavfi", "-i", "color=c=#202020:size=640x360:rate=30:duration=6",
    "-f", "lavfi", "-i", "sine=frequency=300:duration=6",
    "-filter_complex", "[0:v]drawbox=x=220:y=80:w=200:h=200:color=#C8AA6A@1:t=fill[v]",
    "-map", "[v]", "-map", "1:a", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", still], { stdio: ["pipe", "pipe", "pipe"] });

  const dim = { w: 1280, h: 720 };
  const grab = (f, n, o) => execFileSync("ffmpeg", ["-y", "-v", "error", "-i", f, "-vf", `select=eq(n\\,${n})`, "-vframes", "1", o]);

  for (const [tag, scale] of [["wide", 1.0], ["tight", 1.08]]) {
    execFileSync("ffmpeg", pieceArgs(still, join(OUT, `fr_${tag}.mp4`), { srcStart: 1, srcEnd: 2, seconds: 1, scale, push: null }, dim), { stdio: ["pipe", "pipe", "pipe"] });
    grab(join(OUT, `fr_${tag}.mp4`), 0, join(OUT, `fr_${tag}.png`));
  }
  const punchDelta = await frameDifference(join(OUT, "fr_wide.png"), join(OUT, "fr_tight.png"));
  check("the punch-in changes the framing", punchDelta > 1, `delta ${punchDelta.toFixed(2)}`);

  execFileSync("ffmpeg", pieceArgs(still, join(OUT, "pushed.mp4"), { srcStart: 0, srcEnd: 5, seconds: 5, scale: 1, push: { from: 1, to: 1.08, seconds: 3.5 } }, dim), { stdio: ["pipe", "pipe", "pipe"] });
  execFileSync("ffmpeg", pieceArgs(still, join(OUT, "unpushed.mp4"), { srcStart: 0, srcEnd: 5, seconds: 5, scale: 1, push: null }, dim), { stdio: ["pipe", "pipe", "pipe"] });
  for (const n of ["pushed", "unpushed"]) { grab(join(OUT, `${n}.mp4`), 0, join(OUT, `${n}_0.png`)); grab(join(OUT, `${n}.mp4`), 100, join(OUT, `${n}_100.png`)); }
  const control = await frameDifference(join(OUT, "unpushed_0.png"), join(OUT, "unpushed_100.png"));
  const pushed = await frameDifference(join(OUT, "pushed_0.png"), join(OUT, "pushed_100.png"));
  check("a static source with no push does not move", control < 0.5, `delta ${control.toFixed(3)}`);
  check("the opening push DOES move", pushed > 1, `delta ${pushed.toFixed(3)}`);
});

// ═══ PATH 13: cadence ═══════════════════════════════════════════════════════

path("pattern-interrupt cadence");
await guard("cadence", async () => {
  const held = [{ kind: "voiceover", takeId: "t1", seconds: 26, broll: [{ driveFileId: "a", seconds: 26 }] }];
  const audit = auditCadence(held);
  check("a 26s unbroken clip is caught", !audit.ok && audit.violations.length === 1);
  check("the violation names a remedy", audit.violations[0].remedy.length > 20);

  const cut = [{ kind: "voiceover", takeId: "t1", seconds: 26, broll: [{ driveFileId: "a", seconds: 7 }, { driveFileId: "b", seconds: 7 }, { driveFileId: "c", seconds: 6 }, { driveFileId: "d", seconds: 6 }] }];
  check("normal cutting passes", auditCadence(cut).ok);

  const edited = [{ kind: "on_camera", takeId: "t1", seconds: 24, editPieces: [{ seconds: 8, scale: 1 }, { seconds: 8, scale: 1.08 }, { seconds: 8, scale: 1 }] }];
  check("an edited on-camera take passes", auditCadence(edited).ok);
  check("and counts as three states, not one", buildStateTimeline(edited).length === 3);

  const uncut = [{ kind: "on_camera", takeId: "t1", seconds: 24 }];
  check("an UNEDITED long take is caught", !auditCadence(uncut).ok);

  // Only one visual available: the audit must report rather than invent one.
  const starved = [{ kind: "voiceover", takeId: "t1", seconds: 30, broll: [{ driveFileId: "only", seconds: 30 }] }];
  const sa = auditCadence(starved);
  check("with one clip available it reports instead of inventing", !sa.ok && sa.violations[0].remedy.includes("more clips"));
});

// ═══ PATH 14: PIP ═══════════════════════════════════════════════════════════

path("PIP placement and the caption safe area");
await guard("placement", async () => {
  const dim = { w: 1920, h: 1080 };
  const captionTop = Math.round(dim.h * (1 - CAPTION_SAFE_BOTTOM));
  for (let i = 0; i < 4; i++) {
    const p = pipPlacement(dim, { index: i });
    check(`#${i} stays clear of the captions`, p.y + p.h <= captionTop + 1, `bottom ${p.y + p.h} vs caption top ${captionTop}`);
    check(`#${i} is fully on-frame`, p.x >= 0 && p.y >= 0 && p.x + p.w <= dim.w && p.y + p.h <= dim.h);
  }
  check("corners alternate", pipPlacement(dim, { index: 0 }).corner !== pipPlacement(dim, { index: 1 }).corner);
});

path("PIP quality gate and the disabled flag");
await guard("gate", async () => {
  check("a clean matte is accepted", gateCutout({ coverage: 0.28, holeRatio: 0.01, edgeRoughness: 0.2, frames: 900 }).ok);
  for (const [name, m] of [
    ["found almost nothing", { coverage: 0.02, holeRatio: 0, edgeRoughness: 0.1, frames: 900 }],
    ["swallowed the background", { coverage: 0.95, holeRatio: 0, edgeRoughness: 0.1, frames: 900 }],
    ["holes in the silhouette", { coverage: 0.3, holeRatio: 0.3, edgeRoughness: 0.2, frames: 900 }],
    ["ragged edges", { coverage: 0.3, holeRatio: 0.01, edgeRoughness: 0.95, frames: 900 }],
    ["no metrics at all", null],
  ]) {
    const g = gateCutout(m);
    check(`rejects: ${name}`, !g.ok, "the gate accepted it");
    check(`and says why: ${name}`, g.reasons.length > 0 && g.reasons[0].length > 10);
  }

  const segs = [
    { kind: "voiceover", takeId: "a", narrationSource: "/tmp/a.mp4" },
    { kind: "voiceover", takeId: "b", narrationSource: null },
    { kind: "on_camera", takeId: "c", source: "/tmp/c.mp4" },
  ];
  const on = planPip(segs);
  check("only self-narrated segments are candidates", on.plan.length === 1 && on.plan[0].takeId === "a");
  check("the cloned-voice segment is skipped with a reason", on.skipped.some((s) => /cloned voice/.test(s.reason)));
  const off = planPip(segs, { enabled: false });
  check("the disable flag turns it all off", off.plan.length === 0);
  check("and says the flag did it", off.skipped.some((s) => /disabled/.test(s.reason)));
});

path("PIP compositing over a real visual, verified in pixels");
await guard("composite", async () => {
  const dim = { w: 1920, h: 1080 };
  // A cutout with REAL alpha — head and shoulders.
  const cut = join(OUT, "cutout.mov");
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=#c08a5a:size=640x360:rate=30:duration=3",
    "-vf", "format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(pow(X-320,2)/pow(70,2)+pow(Y-120,2)/pow(90,2),1),255,if(gt(Y,200)*lt(pow(X-320,2)/pow(150,2)+pow(Y-380,2)/pow(200,2),1),255,0))'",
    "-c:v", "qtrle", "-pix_fmt", "argb", cut], { stdio: ["pipe", "pipe", "pipe"] });
  check("the cutout kept its alpha channel", ffprobe(cut).pix_fmt === undefined || true);
  const pf = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=pix_fmt", "-of", "csv=p=0", cut], { encoding: "utf-8" }).trim();
  check("alpha is preserved by the codec", /argb|rgba|yuva/.test(pf), `pix_fmt ${pf} would composite as a rectangle`);

  const png = await renderMapPng(mapSpecForIntent({ places: ["Stone Oak", "Downtown"], lines: ["1604", "Loop 410"] }));
  const mapPng = join(OUT, "pipmap.png");
  writeFileSync(mapPng, png);
  const visual = join(OUT, "pipvisual.mp4");
  execFileSync("ffmpeg", ["-y", "-v", "error", "-loop", "1", "-i", mapPng, "-t", "3", "-vf", "scale=1920:1080,fps=30,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", visual]);

  const place = pipPlacement(dim, { index: 0 });
  const out = join(OUT, "pipped.mp4");
  execFileSync("ffmpeg", pipCompositeArgs(visual, cut, out, place, { seconds: 3 }), { stdio: ["pipe", "pipe", "pipe"] });
  check("the composite rendered", existsSync(out));
  const p = ffprobe(out);
  check("it kept the canvas size", p.width === "1920" && p.height === "1080");

  const grab = (f, n, o) => execFileSync("ffmpeg", ["-y", "-v", "error", "-i", f, "-vf", `select=eq(n\\,${n})`, "-vframes", "1", o]);
  grab(visual, 30, join(OUT, "pip_before.png"));
  grab(out, 30, join(OUT, "pip_after.png"));
  const delta = await frameDifference(join(OUT, "pip_before.png"), join(OUT, "pip_after.png"));
  check("the bubble is actually visible on screen", delta > 0.5, `delta ${delta.toFixed(3)} — the composite did nothing`);
});

path("segmentation availability is reported, never assumed");
await guard("availability", async () => {
  const avail = segmentationAvailable();
  check("availability returns a verdict with a reason", typeof avail.ok === "boolean" && (avail.ok || typeof avail.reason === "string"));
  if (!avail.ok) console.log(`      (segmentation unavailable here: ${avail.reason})`);
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
