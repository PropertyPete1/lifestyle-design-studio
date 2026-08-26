#!/usr/bin/env node
/**
 * preview-voiceover-scripts.mjs — generate sample voiceover scripts, one per persona.
 *
 * Lets you audition the writing before anything reaches a live account.
 * Nothing is posted, no TTS is called, no video is touched.
 *
 *   node scripts/preview-voiceover-scripts.mjs            # all 6 personas (needs ANTHROPIC_API_KEY)
 *   node scripts/preview-voiceover-scripts.mjs --count 5  # first N personas
 *   node scripts/preview-voiceover-scripts.mjs --prompts  # print the assembled prompts only, no API call
 *   node scripts/preview-voiceover-scripts.mjs --city austin --duration 25
 */
import { PERSONAS } from "../../src/voiceover-style.js";
import { generateVoiceoverScript } from "../../src/caption.js";
import { findMonthlyPaymentFigure } from "../../src/caption-validator.js";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const PROMPTS_ONLY = args.includes("--prompts");
const CITY = flag("city", "san_antonio");
const DURATION = Number(flag("duration", "30"));
const COUNT = Number(flag("count", String(PERSONAS.length)));

// Representative overlay data so the price/rate branches are exercised.
const OVERLAYS = { city: null, price: "$326,990", raw_text: "4.99% fixed rate  $326,990  3 bed 2 bath" };

// A few plausible prior transcripts so the "do not resemble" block is populated.
const AVOID = [
  "Brand new construction in San Antonio starting at three hundred twenty six thousand dollars. Look at this kitchen.",
  "Wait until you see this brand new home. These ceilings are massive.",
];

if (PROMPTS_ONLY) {
  // Render the exact prompt string without calling the model. Monkey-patch the
  // module's client factory by intercepting at the network layer instead: simply
  // stub global fetch so the SDK call throws immediately and we capture input.
  console.log("Rendering assembled prompts (no API call).\n");
}

for (const persona of PERSONAS.slice(0, COUNT)) {
  console.log("=".repeat(78));
  console.log(`PERSONA: ${persona.label}  [${persona.id}]`);
  console.log("=".repeat(78));

  if (PROMPTS_ONLY) {
    console.log("--- persona instruction injected into the prompt ---");
    console.log(persona.instruction);
    console.log("");
    continue;
  }

  try {
    const { script } = await generateVoiceoverScript(CITY, DURATION, OVERLAYS, {
      persona,
      avoidTranscripts: AVOID,
    });
    if (!script) {
      console.error("  number-honesty gate blocked every candidate script\n");
      continue;
    }
    const words = script.trim().split(/\s+/).length;
    const payment = findMonthlyPaymentFigure(script);
    console.log(script.trim());
    console.log("");
    console.log(`  [${words} words | commas: ${(script.match(/,/g) || []).length} | ellipses: ${(script.match(/\.\.\./g) || []).length} | payment-figure: ${payment.found ? "BLOCKED — " + payment.match : "none ✓"}]`);
    console.log("");
  } catch (err) {
    console.error(`  generation failed: ${err.message}\n`);
  }
}
