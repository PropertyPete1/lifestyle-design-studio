#!/usr/bin/env node
/**
 * generate-samples.mjs — three complete sample carousels for PR review.
 *
 * Runs the real content engine and the real renderer, including the critic
 * gate, so what lands in the PR is exactly what the daily job would produce.
 * Distribution is never reached: runCarousel in SAMPLE_OUT mode writes to disk
 * and returns before any Metricool or Drive call.
 *
 * Dates are picked to hit three different pillars.
 */

import { runCarousel } from "../src/carousel-main.js";
import { pillarFor } from "../src/carousel-content.js";
import { writeFileSync, mkdirSync, existsSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "samples");

// Mon = real estate education, Tue = Texas lifestyle, Sun = market insight.
const DATES = ["2026-08-03", "2026-08-04", "2026-08-09"];

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

  console.log("\n=== SAMPLE SUMMARY ===");
  for (const s of index) {
    console.log(`${s.date}  ${s.pillar.padEnd(24)} hook=${s.scores.hook} loops=${s.scores.loops} cta=${s.scores.cta}  attempts=${s.attemptsUsed}${s.belowBar ? "  BELOW BAR" : ""}`);
    console.log(`  keyword=${s.keyword}  slides=${s.slides}  "${s.hook}"`);
  }
}

main().catch((err) => {
  console.error(`Sample generation failed: ${err.stack || err.message}`);
  process.exit(1);
});
