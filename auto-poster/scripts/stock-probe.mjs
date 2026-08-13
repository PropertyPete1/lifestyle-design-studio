#!/usr/bin/env node
/**
 * stock-probe.mjs — ask the stock ladder why it came up empty, without rendering.
 *
 * WHY THIS EXISTS.
 *
 * On 2026-08-13 a build reported `stock windows: 0/13 matched a clip` and the
 * question that decided the fix — did Pexels return nothing, or did it return
 * clips the vision check rejected — could only be answered by another
 * fifty-five minute render. Those two have opposite fixes: unsearchable queries
 * mean the keyword ladder needs work, rejected clips mean the ladder is fine and
 * the check is the problem. Guessing wrong costs a build.
 *
 * Nothing about that question needs a render. The stock layer runs off the
 * script's own words: the windows come from the transcript, the queries from the
 * windows, and the searches and vision checks are network calls. This runs
 * exactly that much and stops — no takes, no encoding, no upload, no state
 * written anywhere.
 *
 * IT USES THE REAL LADDER, NOT A COPY. `planWindowKeywords` and `fetchStockClip`
 * are imported from the modules the pipeline uses. A probe with its own idea of
 * how queries are built would answer a question about itself.
 *
 * WHERE THE SCRIPT COMES FROM. The same place a rework gets it: the recording
 * kit's `actedResult.script` on the approvals record. That is what makes this a
 * probe of the CURRENT video rather than of a fixture.
 *
 *   node scripts/stock-probe.mjs                       # the current script's windows
 *   STOCK_PROBE_QUERIES="hospital cluster; big hill" node scripts/stock-probe.mjs
 *
 * THE SECOND FORM IS THE ONE THAT SETTLES AN ARGUMENT: hand it the exact queries
 * a past build used, read off which stage each one dies at.
 */

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import Anthropic from "@anthropic-ai/sdk";

import { loadApprovals } from "../src/yt-approvals.js";
import { orderedTakes, estimateSpeechSeconds } from "../src/yt-timeline.js";
import { VOICEOVER } from "../src/yt-script.js";
import { planWindowKeywords } from "../src/yt-scene-keywords.js";
import { planVisuals } from "../src/yt-visual-plan.js";
import { fetchStockClip, stockEnabled } from "../src/yt-stock.js";
import { ffmpeg } from "../src/yt-assemble.js";

/**
 * The script's voiceover takes, as segments the planner understands.
 *
 * `orderedTakes` and `estimateSpeechSeconds` are the pipeline's own — a probe
 * that flattened the script itself would be testing its own idea of the script.
 * The script nests takes inside sections and marks them with `mode`, which is
 * exactly the sort of shape a hand-rolled reader gets wrong: the first version
 * of this looked for a top-level `takes` array and reported zero windows on a
 * 34-take script.
 *
 * THE DURATIONS ARE ESTIMATED AND THAT IS SOUND. A real build sets each
 * segment's length from the narration audio, which does not exist here, so this
 * uses the same estimator the timeline uses before recordings arrive. It moves a
 * window boundary by a word or two against the real build — which changes the
 * odd query at the margin and changes nothing about the question being asked.
 * "Do queries of this shape return clips, and do those clips survive the vision
 * check" is not a question about window edges.
 */
function segmentsFromScript(script) {
  return orderedTakes(script)
    .filter((t) => t.mode === VOICEOVER)
    .map((t) => ({
      takeId: t.id,
      kind: "voiceover",
      text: String(t.text || ""),
      seconds: Math.max(6, estimateSpeechSeconds(String(t.text || ""))),
      visualIntent: t.visualIntent || null,
      visualSpec: t.visualIntent || null,
    }));
}

function currentScript() {
  const approvals = loadApprovals();
  // Newest first: the kit record carries the script a rework rebuilds from.
  for (const r of [...(approvals.requests || [])].reverse()) {
    const s = r?.actedResult?.script;
    if (s) return { script: s, requestId: r.requestId };
  }
  return { script: null, requestId: null };
}

/**
 * THE NEGATIVE CONTROL: proof the loosened criterion 3 did not loosen anything else.
 *
 * Relaxing "is this plausibly <the whole sentence>" to "does this depict <a
 * thing>" moved the probe from 0/16 to 9/16. The obvious worry is that it moved
 * because the check stopped checking. So two clips that MUST still be rejected,
 * run against the same model with the same prompt:
 *
 *   1. BURNED-IN TEXT — a frame with large on-screen writing. Criteria 1 and 2.
 *      Generated here rather than fetched, so the control cannot silently stop
 *      testing anything the day Pexels changes what it returns.
 *
 *   2. WRONG SUBJECT — a real Pexels clip fetched for one query and then asked
 *      to be something else entirely. Criterion 3, from the other side: the
 *      question is now answerable, and the answer still has to be no.
 *
 * A control that cannot fail is not a control, so both assert on the verdict and
 * the script exits non-zero if either is accepted.
 */
async function negativeControl(client, dir) {
  const { visionCheckClip, searchPexels, rankCandidates } = await import("../src/yt-stock.js");
  let failures = 0;

  // ── 1. burned-in text ────────────────────────────────────────────────────
  const textFrame = join(dir, "control-text.jpg");
  ffmpeg([
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "gradients=s=1280x720:c0=0x3a5f8a:c1=0x8fbfd4:d=1",
    "-vf", "drawtext=text='STOCKFOOTAGE-DEMO':fontcolor=white@0.85:fontsize=96:x=(w-tw)/2:y=(h-th)/2",
    "-frames:v", "1", textFrame,
  ]);
  const textVerdict = await visionCheckClip([textFrame], { subject: "a hospital campus", client });
  console.log(`[StockProbe] control 1 (burned-in text): ${textVerdict.ok ? "ACCEPTED" : "rejected"} — ${textVerdict.reason}`);
  if (textVerdict.ok) { console.log("::error::the burned-in-text control was ACCEPTED — criteria 1/2 have stopped working"); failures++; }

  // ── 2. wrong subject ─────────────────────────────────────────────────────
  const results = await searchPexels("commercial kitchen interior", { orientation: "landscape" });
  const pick = rankCandidates(results)[0];
  if (!pick) {
    console.log("::error::the wrong-subject control could not fetch a clip — the control did not run");
    failures++;
  } else {
    const clipPath = join(dir, "control-wrong.mp4");
    const res = await fetch(pick.url);
    const { writeFileSync } = await import("fs");
    writeFileSync(clipPath, Buffer.from(await res.arrayBuffer()));
    const frame = join(dir, "control-wrong.jpg");
    ffmpeg(["-y", "-v", "error", "-ss", "1", "-i", clipPath, "-frames:v", "1", "-q:v", "3", frame]);
    // A kitchen asked to be a hospital campus. Answerable, and the answer is no.
    const wrongVerdict = await visionCheckClip([frame], { subject: "a hospital campus", client });
    console.log(`[StockProbe] control 2 (wrong subject): ${wrongVerdict.ok ? "ACCEPTED" : "rejected"} — ${wrongVerdict.reason}`);
    if (wrongVerdict.ok) { console.log("::error::the wrong-subject control was ACCEPTED — criterion 3 is now too loose"); failures++; }
  }

  console.log(`[StockProbe] negative control: ${failures === 0 ? "both clips correctly REJECTED" : `${failures} control(s) wrongly accepted`}`);
  return failures;
}

async function main() {
  // SEMICOLON-SEPARATED, NOT SPACE. Every real query is two words — "hospital
  // cluster", "aerial suburban neighborhood" — so splitting a list on spaces
  // turns thirteen phrases into twenty-six single-word searches and answers a
  // question nobody asked. The env var carries the list so a shell cannot word-
  // split it either.
  const explicit = (process.env.STOCK_PROBE_QUERIES || process.argv.slice(2).join(";"))
    .split(";")
    .map((q) => q.trim())
    .filter(Boolean);

  if (!stockEnabled()) {
    console.log("::error::PEXELS_API_KEY is not set — the probe cannot ask Pexels anything");
    process.exit(1);
  }
  const client = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;
  if (!client) {
    // Worth stopping for. Without the vision client every clip fails closed, so
    // the probe would report "vision" for everything and prove nothing.
    console.log("::error::ANTHROPIC_API_KEY is not set — every clip would fail the vision check and the answer would be meaningless");
    process.exit(1);
  }

  const dirForControl = mkdtempSync(join(tmpdir(), "stock-control-"));
  let controlFailures = 0;
  if (process.env.STOCK_PROBE_CONTROL === "true") {
    try {
      controlFailures = await negativeControl(client, dirForControl);
    } finally {
      rmSync(dirForControl, { recursive: true, force: true });
    }
  } else {
    rmSync(dirForControl, { recursive: true, force: true });
  }

  let windows;
  if (explicit.length > 0) {
    windows = explicit.map((q, i) => ({ takeId: "arg", phase: i, seconds: 8, keywords: [q], subject: q, verifySubject: q, source: "argument" }));
    console.log(`[StockProbe] ${windows.length} query(ies) supplied on the command line`);
  } else {
    const { script, requestId } = currentScript();
    if (!script) {
      console.log("::error::no script on any approvals record — pass queries as arguments instead");
      process.exit(1);
    }
    const segments = segmentsFromScript(script);
    // The real planner, with the graphic layer declined and stock offered the
    // whole take. Declining graphics is not a distortion of the question: a take
    // whose graphic renders never reaches stock in a real build either, so the
    // windows this produces are exactly the ones stock is ever asked to fill.
    const planned = await planVisuals(segments, {
      renderGraphic: async () => ({ ok: false, reason: "the probe does not render graphics" }),
      stockAvailable: (seg) => seg.seconds,
      ownedFor: () => 0,
    });
    const withBlocks = (planned.segments || planned || []).filter((s) => s.kind === "voiceover");
    windows = planWindowKeywords(withBlocks);
    console.log(
      `[StockProbe] ${windows.length} window(s) derived from ${requestId}'s script ` +
        `(${segments.length} voiceover take(s), ${withBlocks.filter((s) => (s.visualBlocks || []).some((b) => b.kind === "stock")).length} carrying stock)`
    );
  }

  const dir = mkdtempSync(join(tmpdir(), "stock-probe-"));
  const byStage = {};
  const rows = [];
  try {
    for (const [i, w] of windows.entries()) {
      const query = (w.keywords || []).join(" | ") || "(none)";
      if ((w.keywords || []).length === 0) {
        byStage.keywords = (byStage.keywords || 0) + 1;
        rows.push({ window: `${w.takeId}#${w.phase}`, query, stage: "keywords", reason: "no searchable concept in this window", source: w.source });
        continue;
      }
      const { clip, attempts } = await fetchStockClip({
        keywords: w.keywords,
        seconds: w.seconds || 8,
        subject: w.verifySubject || w.subject || null,
        dir,
        index: i,
        client,
        ffmpeg,
      });
      for (const a of attempts) byStage[a.stage] = (byStage[a.stage] || 0) + 1;
      const last = attempts[attempts.length - 1];
      rows.push({
        window: `${w.takeId}#${w.phase}`,
        query,
        source: w.source,
        stage: clip ? "MATCHED" : last?.stage || "none",
        reason: clip ? `${clip.query}` : last?.reason || "no attempts recorded",
        attempts: attempts.length,
      });
      // The clip file is not wanted — only the verdict.
      if (clip?.path) rmSync(clip.path, { force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log("");
  for (const r of rows) {
    console.log(
      `[StockProbe] ${String(r.window).padEnd(10)} ${String(r.source || "").padEnd(19)} ` +
        `${JSON.stringify(r.query).padEnd(34)} -> ${String(r.stage).padEnd(9)} ${r.reason}`
    );
  }
  console.log("");
  console.log(`[StockProbe] stages: ${JSON.stringify(byStage)}`);
  const matched = rows.filter((r) => r.stage === "MATCHED").length;
  console.log(`[StockProbe] ${matched}/${rows.length} window(s) would have got a clip`);

  // THE ANSWER, STATED RATHER THAN LEFT AS A TABLE. This probe exists to settle
  // one question and it should say which way it came out.
  const search = byStage.search || 0;
  const vision = byStage.vision || 0;
  if (search === 0 && vision === 0) {
    console.log("[StockProbe] verdict: neither search nor vision is the blocker — read the stages above");
  } else if (search > vision * 2) {
    console.log(`[StockProbe] verdict: SEARCH-HEAVY (${search} search misses vs ${vision} vision rejections) — the queries are not findable, the keyword ladder is the fix`);
  } else if (vision > search * 2) {
    console.log(`[StockProbe] verdict: VISION-HEAVY (${vision} vision rejections vs ${search} search misses) — Pexels returns clips and the check refuses them, the vision step is the fix`);
  } else {
    console.log(`[StockProbe] verdict: MIXED (${search} search misses, ${vision} vision rejections) — both need work`);
  }

  // A control that cannot fail the run is a control nobody reads.
  if (controlFailures > 0) process.exit(1);
}

main().catch((err) => {
  console.log(`::error::stock probe failed: ${err.message}`);
  process.exit(1);
});
