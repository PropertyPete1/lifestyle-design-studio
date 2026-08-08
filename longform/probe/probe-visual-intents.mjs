#!/usr/bin/env node
/**
 * probe-visual-intents.mjs — does the visual system work for any topic, or
 * only for the one it was built against?
 *
 * The first version of this feature scanned narration for highway numbers. It
 * scored well on a video about Loop 410 and would have returned FOOTAGE for
 * every take of a video about property taxes — working perfectly and doing
 * nothing, which is this project's most expensive recurring bug.
 *
 * So the acceptance test is not "does it draw the two rings". It is: take
 * three pillar topics that share almost no vocabulary, run them through the
 * REAL writer, and report what came back. A topic that produces zero visuals is
 * a FINDING to be reported, not a failure to be hidden and not a pass.
 *
 * Needs ANTHROPIC_API_KEY, so it runs on the runner rather than a laptop.
 * Renders nothing to any platform and publishes nothing.
 *
 *   node longform/probe/probe-visual-intents.mjs
 *   PROBE_TOPICS=taxes,schools node longform/probe/probe-visual-intents.mjs
 */

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { generateScript, allTakes, VOICEOVER } from "../../auto-poster/src/yt-script.js";
import { planTimeline } from "../../auto-poster/src/yt-timeline.js";
import { attachIntents, VISUAL_TYPES, MAP } from "../../auto-poster/src/yt-visual-intent.js";
import { applyGeneratedVisuals } from "../../auto-poster/src/yt-visual-broll.js";
import { mapSpecForIntent, renderMapPng, renderMapSvg } from "../../auto-poster/src/yt-map-render.js";
import { renderCardPng, renderCardSvg } from "../../auto-poster/src/yt-card-render.js";
import { inspectRender, findOverflowingText } from "../../auto-poster/src/yt-visual-qc.js";

const OUT = process.env.PROBE_OUT_DIR || "/tmp/visual-intent-probe";

/**
 * Three pillar topics chosen to SHARE NO VOCABULARY.
 *
 * One is geographic, one is numeric, one is a comparison. If the system only
 * fires on the first, that is the keyword classifier's failure reproduced, and
 * this probe exists to make that visible rather than plausible.
 */
const TOPICS = {
  taxes: {
    title: "Property taxes in San Antonio, explained for people moving here",
    hook: "There is no state income tax. That is the trade, and nobody explains the other half of it.",
    outline: [
      "What actually makes up your tax bill, line by line",
      "How the homestead exemption changes the number",
      "MUD and PID assessments, and why they are not a tax",
      "What to check before you sign",
    ].join("\n"),
    market: "san_antonio",
  },
  schools: {
    title: "Comparing San Antonio school districts before you buy",
    hook: "The district line moves the price of the exact same house, and it does not follow the subdivision.",
    outline: [
      "How districts and city limits fail to line up",
      "The three districts most relocating families ask about",
      "How to verify a school by address, not by listing",
      "What it does to resale",
    ].join("\n"),
    market: "san_antonio",
  },
  budget: {
    title: "What $400,000 actually buys in San Antonio in 2026",
    hook: "The number people quote you is the price. The number that decides it is what comes after.",
    outline: [
      "What $400K buys inside the loop versus outside",
      "New build versus resale at the same number",
      "The costs that arrive after closing",
      "Where the money goes furthest right now",
    ].join("\n"),
    market: "san_antonio",
  },
};

/** A B-roll pool big enough that allocation is never the reason a take fails. */
function fakeBrollPool(n = 80) {
  return Array.from({ length: n }, (_, i) => ({
    id: `clip${i}`,
    name: `clip${i}.mp4`,
    durationSeconds: 20,
    contentHash: `h${i}`,
  }));
}

/** Recordings for every take, so planTimeline never reports a missing one. */
function fakeRecordings(script) {
  const out = {};
  for (const t of allTakes(script)) out[t.id] = { path: `/tmp/${t.id}.mp4`, durationSeconds: 22 };
  return out;
}

async function runTopic(name, topic) {
  console.log(`\n${"=".repeat(70)}\n${name.toUpperCase()}: ${topic.title}\n${"=".repeat(70)}`);

  const t0 = Date.now();
  const { script, scores } = await generateScript({ topic });
  console.log(`  written in ${((Date.now() - t0) / 1000).toFixed(0)}s, scores ${JSON.stringify(scores)}`);

  const takes = allTakes(script);
  const voiceover = takes.filter((t) => t.mode === VOICEOVER);
  const plan = planTimeline(script, fakeRecordings(script), fakeBrollPool());
  const { segments, report } = attachIntents(plan.segments);

  console.log(`  ${takes.length} takes, ${voiceover.length} voiceover`);
  console.log(`  writer requested ${report.requested} visual(s): ${JSON.stringify(report.byType)}`);
  if (report.rejected > 0) {
    console.log(`  ${report.rejected} rejected:`);
    for (const r of report.rejections) console.log(`    - ${r.takeId}: ${r.type} — ${r.reason}`);
  }

  // What the writer asked for, in its own words.
  const requests = segments
    .filter((s) => s.visual)
    .map((s) => ({ takeId: s.takeId, section: s.section, type: s.visual, spec: s.visualSpec, text: s.text }));
  for (const r of requests) {
    console.log(`    ${r.takeId.padEnd(6)} ${r.type.padEnd(17)} ${JSON.stringify(r.spec).slice(0, 110)}`);
  }

  // Render one of each type this topic produced, and QC it.
  const rendered = [];
  const seen = new Set();
  for (const r of requests) {
    if (seen.has(r.type)) continue;
    seen.add(r.type);
    try {
      let png, svg;
      if (r.type === MAP) {
        const spec = mapSpecForIntent(r.spec, { market: topic.market });
        if (!spec) { rendered.push({ type: r.type, ok: false, why: "no named place resolved" }); continue; }
        svg = renderMapSvg(spec);
        png = await renderMapPng(spec);
      } else {
        svg = renderCardSvg(r.type, r.spec);
        png = await renderCardPng(r.type, r.spec);
      }
      const verdict = await inspectRender(png, { label: r.type, edgeCheck: r.type !== MAP });
      const overflow = findOverflowingText(svg);
      const file = join(OUT, `${name}-${r.type.toLowerCase()}.png`);
      writeFileSync(file, png);
      rendered.push({
        type: r.type,
        ok: verdict.ok && overflow.length === 0,
        why: [...verdict.failures, ...overflow.map((o) => `off-canvas: ${o.text}`)].join("; ") || null,
        file,
        ink: verdict.metrics.inkRatio,
      });
    } catch (err) {
      rendered.push({ type: r.type, ok: false, why: err.message });
    }
  }
  for (const r of rendered) {
    console.log(`  render ${r.type.padEnd(17)} ${r.ok ? "OK" : "FAIL"} ${r.why || `ink ${(r.ink * 100).toFixed(2)}%`}`);
  }

  // And the full integration, including the cap.
  const withVisuals = await applyGeneratedVisuals({ ...plan, segments: plan.segments }, { workDir: join(OUT, name), market: topic.market });
  const gen = withVisuals.generated;
  console.log(
    `  after the cap: ${gen.renderedCount} on the timeline, ` +
      `${gen.usedSeconds}s of ${gen.budgetSeconds}s budget (${Math.round(gen.share * 100)}% of B-roll)`
  );
  for (const f of gen.failures) console.log(`    fell back to footage: ${f.takeId} — ${f.reason}`);

  writeFileSync(join(OUT, `${name}-script.json`), JSON.stringify(script, null, 1));

  return {
    topic: name,
    title: topic.title,
    takes: takes.length,
    voiceover: voiceover.length,
    requested: report.requested,
    byType: report.byType,
    rejected: report.rejected,
    rejections: report.rejections,
    requests,
    rendered,
    onTimeline: gen.renderedCount,
    sharePct: Math.round(gen.share * 100),
  };
}

// ─── main ───────────────────────────────────────────────────────────────────

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set. This probe calls the real writer on purpose —");
  console.error("a hand-written script would prove the renderers work and prove nothing about");
  console.error("whether the WRITER emits visualIntent, which is the whole question.");
  process.exit(2);
}

mkdirSync(OUT, { recursive: true });
const wanted = (process.env.PROBE_TOPICS || Object.keys(TOPICS).join(",")).split(",").map((s) => s.trim());
const results = [];

for (const name of wanted) {
  const topic = TOPICS[name];
  if (!topic) { console.error(`unknown topic "${name}"`); continue; }
  try {
    results.push(await runTopic(name, topic));
  } catch (err) {
    console.error(`\n${name} FAILED: ${err.message}`);
    results.push({ topic: name, error: err.message });
  }
}

console.log(`\n${"=".repeat(70)}\nSUMMARY\n${"=".repeat(70)}`);
console.log("topic      takes  vo  requested  types                          on timeline");
for (const r of results) {
  if (r.error) { console.log(`${r.topic.padEnd(10)} ERROR: ${r.error}`); continue; }
  console.log(
    `${r.topic.padEnd(10)} ${String(r.takes).padStart(5)} ${String(r.voiceover).padStart(3)} ` +
      `${String(r.requested).padStart(10)}  ${JSON.stringify(r.byType).padEnd(30)} ${r.onTimeline}`
  );
}

const silent = results.filter((r) => !r.error && r.requested === 0);
const failedRenders = results.flatMap((r) => (r.rendered || []).filter((x) => !x.ok));
const typesSeen = new Set(results.flatMap((r) => Object.keys(r.byType || {})));

console.log(`\ntypes exercised: ${[...typesSeen].sort().join(", ") || "NONE"}`);
console.log(`types never requested: ${VISUAL_TYPES.filter((t) => !typesSeen.has(t)).join(", ") || "none"}`);

if (silent.length) {
  console.log(`\nFINDING: ${silent.map((r) => r.topic).join(", ")} produced ZERO visuals.`);
  console.log("That is a reportable result, not a pass — either the prompt is not reaching the");
  console.log("writer for this shape of topic, or the topic genuinely has nothing to draw.");
}
if (failedRenders.length) {
  console.log(`\nFINDING: ${failedRenders.length} render(s) failed QC:`);
  for (const f of failedRenders) console.log(`  ${f.type}: ${f.why}`);
}

writeFileSync(join(OUT, "summary.json"), JSON.stringify(results, null, 1));
console.log(`\nartifacts in ${OUT}\n`);

/**
 * Exit conditions, and why the first one had to be added.
 *
 * The first live run of this probe reported SUCCESS while proving nothing: all
 * three scripts failed to generate, so there were no renders, so the only exit
 * check — "did any render fail?" — found nothing wrong and returned 0. A probe
 * whose entire job is to answer a question exited green having answered it not
 * at all. That is the same silent-success failure it was written to hunt.
 *
 * A topic producing ZERO VISUALS is still a finding rather than a failure. A
 * topic that never produced a SCRIPT is a failure, because nothing downstream
 * was exercised at all.
 */
const errored = results.filter((r) => r.error);
if (errored.length) {
  console.log(`FAILURE: ${errored.length} of ${results.length} topic(s) never produced a script:`);
  for (const r of errored) console.log(`  ${r.topic}: ${r.error}`);
  console.log("Nothing downstream was exercised for those topics — this run proves nothing about them.");
}
if (results.length === 0) console.log("FAILURE: no topics ran at all.");

process.exit(failedRenders.length > 0 || errored.length > 0 || results.length === 0 ? 1 : 0);
