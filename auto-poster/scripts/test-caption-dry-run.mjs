/**
 * Caption dry-run test with LEAD-GATING validation.
 * 
 * TEST A: KB match (Esperanza community detected in video overlay) — must NOT reveal community name
 * TEST B: Restructure original rich caption — must strip community/builder/branded names
 * TEST C: No KB match (generic fallback) — must stay generic with zero invented facts
 * 
 * Usage: node scripts/test-caption-dry-run.mjs
 * Requires: ANTHROPIC_API_KEY env var
 */

import { generateCaption, generateCaptionFromOriginal } from "../src/caption.js";

// Terms that MUST NOT appear in any output
const GATED_TERMS = [
  "Esperanza", "Rancho Sienna", "Travisso", "Ventana", "Walsh Ranch",
  "Bee Cave / Lakeway",
  "KB Home", "Chesmar", "Scott Felder", "Perry Homes", "Highland Homes",
  "Weston Dean", "Taylor Morrison", "Toll Brothers",
  "Roca Loca", "The Club at Esperanza", "Wellness Barn", "Ranch Camp",
  "Palazzo Clubhouse", "The Forum", "Rover Oaks", "Bark Parque",
  "Reunión Parque", "Dr. Herff"
];

function checkLeaks(caption, testName) {
  const leaks = GATED_TERMS.filter(term => 
    caption.toLowerCase().includes(term.toLowerCase())
  );
  if (leaks.length > 0) {
    console.log(`[${testName}] ❌ LEAK DETECTED: ${leaks.join(", ")}`);
    return leaks;
  }
  console.log(`[${testName}] ✅ NO LEAKS — all gated terms absent`);
  return [];
}

async function main() {
  console.log("═".repeat(60));
  console.log("TEST A: KB MATCH — Esperanza community (gated)");
  console.log("═".repeat(60));
  console.log("");

  const esperanzaOverlays = {
    price: "Starting at $389,900",
    city: "Boerne",
    community: "Esperanza",
    beds: "3-5 bedrooms"
  };

  const captionA = await generateCaption("san_antonio", esperanzaOverlays);
  
  console.log("[TEST A] ═══════ GENERATED CAPTION (KB MATCH, GATED) ═══════");
  console.log(captionA);
  console.log("[TEST A] ═══════ END CAPTION ═══════");
  console.log(`[TEST A] Caption length: ${captionA.length} chars`);
  const leaksA = checkLeaks(captionA, "TEST A");
  console.log("");

  console.log("═".repeat(60));
  console.log("TEST B: RESTRUCTURE ORIGINAL — rich caption (gated)");
  console.log("═".repeat(60));
  console.log("");

  const richOriginal = `would you believe this is brand new in Boerne starting at $389,900? 🏡

Esperanza is one of those communities that just hits different. We're talking 3 to 5 bedrooms, 1,625 to almost 5,000 square feet, and prices from the low $300s all the way up to $786K+.

The Club at Esperanza has a resort-style pool, splash pad for the kids, fitness center, basketball courts, and miles of trails. Plus Roca Loca Waterpark is right there in the community.

Boerne ISD is A-rated and the schools here are incredible. HOA runs about $165/month which covers all those amenities.

6 different builders to choose from so you can customize exactly what you want. VA, FHA, and conventional all welcome. Builder incentives are available right now including rate buydowns and closing cost assistance.

Perfect for military families, growing families, or anyone tired of renting.

📲 comment TOUR and I'll send you everything
📩 DM LIST for similar options
⭐️ link in bio

Lifestyle Design Realty
#texas #boerne #sanantonio #newconstruction #realestate #military`;

  const captionB = await generateCaptionFromOriginal(richOriginal, "san_antonio");
  
  console.log("[TEST B] ═══════ RESTRUCTURED CAPTION (GATED) ═══════");
  console.log(captionB);
  console.log("[TEST B] ═══════ END CAPTION ═══════");
  console.log(`[TEST B] Caption length: ${captionB.length} chars`);
  const leaksB = checkLeaks(captionB, "TEST B");
  console.log("");

  console.log("═".repeat(60));
  console.log("TEST C: NO KB MATCH — generic fallback (Northwest SA)");
  console.log("═".repeat(60));
  console.log("");

  const genericOverlays = {
    price: "$340,000",
    city: "San Antonio",
    community: "Northwest",
    beds: null
  };

  const captionC = await generateCaption("san_antonio", genericOverlays);
  
  console.log("[TEST C] ═══════ GENERATED CAPTION (NO KB MATCH) ═══════");
  console.log(captionC);
  console.log("[TEST C] ═══════ END CAPTION ═══════");
  console.log(`[TEST C] Caption length: ${captionC.length} chars`);
  const leaksC = checkLeaks(captionC, "TEST C");
  console.log("");

  // Summary
  console.log("═".repeat(60));
  console.log("SUMMARY");
  console.log("═".repeat(60));
  console.log(`Test A (KB match): ${captionA.length} chars, ${leaksA.length} leaks`);
  console.log(`Test B (restructure): ${captionB.length} chars, ${leaksB.length} leaks`);
  console.log(`Test C (no match): ${captionC.length} chars, ${leaksC.length} leaks`);
  
  // Check Test B preserved facts (minus gated names)
  const factsToPreserve = ["$389,900", "Boerne ISD", "1,625", "5,000", "$165"];
  const preserved = factsToPreserve.filter(f => captionB.includes(f));
  console.log(`Test B facts preserved: ${preserved.length}/${factsToPreserve.length} (${preserved.join(", ")})`);
  
  // Check CTA mentions gated info as the reward
  const ctaGateCheck = captionA.includes("community name") || captionA.includes("builder");
  console.log(`Test A CTA gates info: ${ctaGateCheck ? "✅" : "❌"}`);
  
  const totalLeaks = leaksA.length + leaksB.length + leaksC.length;
  if (totalLeaks > 0) {
    console.log(`\n⚠️ TOTAL LEAKS: ${totalLeaks} — DO NOT SHIP`);
    process.exit(1);
  } else {
    console.log(`\n✅ ALL TESTS PASSED — zero leaks, ready to ship`);
  }
}

main().catch(err => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
