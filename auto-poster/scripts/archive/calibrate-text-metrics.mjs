#!/usr/bin/env node
/**
 * calibrate-text-metrics.mjs — measure the renderer's width estimate against
 * actual rasterised ink, on THIS machine's fonts.
 *
 * carousel-render.js wraps text using an estimate, because SVG has no text
 * wrapping. The estimate needs a per-style correction factor, and that factor
 * is font-dependent: a developer laptop resolves the stack to Helvetica and
 * Georgia, while the GitHub runner resolves it to DejaVu, which is noticeably
 * wider. Calibrating on the laptop and shipping to the runner is how a headline
 * ends up clipped at the canvas edge.
 *
 * Run this wherever the slides will actually be rendered — for the daily job
 * that is an ubuntu-latest GitHub runner, not a laptop — and set the factors in
 * carousel-render.js from the WORST ratio reported per style.
 */

import sharp from "sharp";
import { measure } from "../../src/carousel-render.js";

const SERIF = "Georgia, 'DejaVu Serif', 'Liberation Serif', 'Times New Roman', serif";
const SANS = "'Helvetica Neue', Helvetica, 'DejaVu Sans', 'Liberation Sans', Arial, sans-serif";

async function actualWidth(text, size, family, weight, style) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="400">` +
    `<rect width="4000" height="400" fill="#000"/>` +
    `<text x="10" y="280" font-family="${family}" font-size="${size}" font-weight="${weight}" ` +
    `font-style="${style}" fill="#fff">${text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</text></svg>`;
  const { info } = await sharp(Buffer.from(svg)).trim({ threshold: 10 }).toBuffer({ resolveWithObject: true });
  return info.width;
}

// Representative real copy from generated decks, per style.
const CASES = [
  ["bold-serif", SERIF, "bold", "normal", [
    ["Two Speeds, One Market", 76], ["Nobody Owes You Repairs", 76],
    ["It Isn't The Down Payment", 76], ["Bids Eat The Rest", 76],
    ["The 47 day stretch nobody warns", 92], ["Where Your 3 Days Go", 76],
    ["What 3% actually covers", 46], ["The part you can negotiate", 46],
  ]],
  ["sans-body", SANS, "normal", "normal", [
    ["Roofers and plumbers quote on their schedule,", 42],
    ["A foundation note means you now need a", 42],
    ["Priced right, homes here still go in under two", 42],
    ["the exact payment breakdown for your price range", 50],
    ["Closing costs sit on top of your down payment.", 42],
  ]],
  ["italic-serif", SERIF, "normal", "italic", [
    ["Then the hard part starts.", 40], ["but that's not the expensive part.", 40],
    ["Cooling is not the expensive part.", 40],
  ]],
];

const results = {};
for (const [style, family, weight, fontStyle, samples] of CASES) {
  let worst = 0, worstText = "";
  console.log(`\n=== ${style} ===`);
  for (const [text, size] of samples) {
    const est = measure(text, size);
    const act = await actualWidth(text, size, family, weight, fontStyle);
    const ratio = act / est;
    if (ratio > worst) { worst = ratio; worstText = text; }
    console.log(`  ${ratio.toFixed(3)}  est=${est.toFixed(0).padStart(5)} act=${String(act).padStart(5)}  "${text.slice(0, 44)}"`);
  }
  results[style] = { worst, worstText };
  console.log(`  WORST: ${worst.toFixed(3)}  ("${worstText.slice(0, 44)}")`);
}

console.log("\n=== RECOMMENDED FACTORS (worst ratio + 5% margin) ===");
for (const [style, r] of Object.entries(results)) {
  console.log(`  ${style.padEnd(14)} ${(r.worst * 1.05).toFixed(2)}`);
}
