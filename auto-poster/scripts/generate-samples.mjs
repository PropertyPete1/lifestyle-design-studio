#!/usr/bin/env node
/**
 * generate-samples.mjs — three complete sample carousels for PR review.
 *
 * Runs the real content engine and the real renderer, including the critic
 * gate, so what lands in the PR is exactly what the daily job would produce.
 * Distribution is never reached: runCarousel in SAMPLE_OUT mode writes to disk
 * and returns before any Metricool or Drive call.
 *
 * Dates are picked to hit three different pillars AND all three close types,
 * so the DM, engagement-question and share closes can each be judged.
 */

import sharp from "sharp";
import { runCarousel } from "../src/carousel-main.js";
import { pillarFor } from "../src/carousel-content.js";
import { WIDTH } from "../src/carousel-render.js";
import { writeFileSync, mkdirSync, existsSync, rmSync, readdirSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "samples");

// Mon education -> DM close, Tue lifestyle -> question close,
// Wed motivation -> share close.
const DATES = ["2026-08-03", "2026-08-04", "2026-08-05"];

async function main() {
  if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const index = [];
  for (const date of DATES) {
    const pillar = pillarFor(date);
    const dir = join(OUT, `${date}-${pillar.key}`);
    console.log(`\n=== Sample: ${date} (${pillar.label}) ===`);
    const { result } = await runCarousel({ dateStr: date, sampleOut: dir });
    index.push({
      date,
      pillar: pillar.label,
      closeType: result.closeType,
      topic: result.topic,
      hook: result.hook,
      keyword: result.keyword,
      scores: result.scores,
      attemptsUsed: result.attemptsUsed,
      belowBar: result.belowBar,
      slides: result.deck.points.length + 3,
      dir: `${date}-${pillar.key}`,
    });
  }

  writeFileSync(join(OUT, "index.json"), JSON.stringify(index, null, 2) + "\n");

  // End-to-end overflow guard. The unit tests can only catch this on a machine
  // whose fonts match the renderer's; here we are on the runner, checking the
  // slides that were actually produced. Text clipped at the canvas edge is the
  // one render fault that looks fine to every dimension check.
  const MAX_INK_X = WIDTH - 96 + 8;
  const overflows = [];
  for (const entry of index) {
    for (const file of readdirSync(join(OUT, entry.dir)).filter((f) => f.endsWith(".png"))) {
      const path = join(OUT, entry.dir, file);
      const { data, info } = await sharp(path).greyscale().raw().toBuffer({ resolveWithObject: true });
      let right = 0;
      for (let y = 0; y < info.height; y++) {
        for (let x = info.width - 1; x > right; x--) {
          if (data[y * info.width + x] > 90) { right = x; break; }
        }
      }
      if (right > MAX_INK_X) overflows.push(`${entry.dir}/${file}: ink to x=${right}`);
    }
  }
  if (overflows.length) {
    console.error(`\nTEXT OVERFLOW on ${overflows.length} slide(s):`);
    for (const o of overflows) console.error(`  ${o}`);
    console.error("Re-run scripts/calibrate-text-metrics.mjs and raise the factors in carousel-render.js.");
    process.exit(1);
  }
  console.log(`\nOverflow check: all slides inside the ${MAX_INK_X}px content edge.`);

  console.log("\n=== SAMPLE SUMMARY ===");
  for (const s of index) {
    console.log(`${s.date}  ${s.pillar.padEnd(24)} ${String(s.closeType).padEnd(9)} hook=${s.scores.hook} loops=${s.scores.loops} cta=${s.scores.cta}  attempts=${s.attemptsUsed}${s.belowBar ? "  BELOW BAR" : ""}`);
    console.log(`  ${s.keyword ? `keyword=${s.keyword}  ` : ""}slides=${s.slides}  "${s.hook}"`);
  }
}

main().catch((err) => {
  console.error(`Sample generation failed: ${err.stack || err.message}`);
  process.exit(1);
});
