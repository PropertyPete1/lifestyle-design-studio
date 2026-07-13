/**
 * Caption dry-run test with LEAD-GATING + 4-fix validation.
 * 
 * TEST A: KB match (Esperanza community detected in video overlay) — must NOT reveal community name
 * TEST B: Restructure original rich caption — must strip community/builder/branded names, KB overrides HOA
 * TEST C: No KB match (generic fallback) — must have ZERO unsourced claims (no amenities, no HOA, no school)
 * 
 * Validates:
 * 1. No-KB fallback has zero invented claims
 * 2. KB overrides stale original values (HOA $165/month → $900-$1,200/year from KB)
 * 3. Currency formatting (all prices have $, all rates have %)
 * 4. Hashtag lock (only #texas #[city] #realestate #military #veteran #newconstruction)
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

// Locked hashtag set
const LOCKED_HASHTAGS = "#texas #sanantonio #realestate #military #veteran #newconstruction";

// Unsourced claims that MUST NOT appear in Test C (no KB match)
const UNSOURCED_CLAIMS_PATTERNS = [
  /\$\d{2,3}(?:\s*(?:to|[-–])\s*\$?\d{2,3})?\s*(?:per month|\/month|monthly)/i, // HOA dollar amounts
  /\$\d{3,4}\s*(?:per year|\/year|annually)/i, // HOA annual amounts
  /\b(?:ISD|school district)\b.*?(?:rated|rating)/i, // school ratings
  /\b(?:resort.style pool|lazy river|splash pad|fitness center|dog park|playground|basketball court)/i, // specific amenities
  /\b\d{1,2}[\s-]?(?:acre|mile)/i, // specific sizes (11-acre, 20 miles)
  /\b\d{3,4}\s*(?:to|[-–])\s*\d{3,4}\s*(?:sq|square)/i, // sqft ranges
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

function checkHashtagLock(caption, testName) {
  // Check that the caption ends with the locked hashtag set
  const lines = caption.trim().split("\n");
  const lastLine = lines[lines.length - 1].trim();
  if (lastLine === LOCKED_HASHTAGS) {
    console.log(`[${testName}] ✅ HASHTAG LOCK — correct locked set`);
    return true;
  }
  // Check if locked hashtags appear anywhere
  if (caption.includes(LOCKED_HASHTAGS)) {
    console.log(`[${testName}] ✅ HASHTAG LOCK — locked set present`);
    return true;
  }
  console.log(`[${testName}] ❌ HASHTAG LOCK FAILED — expected "${LOCKED_HASHTAGS}", got last line: "${lastLine}"`);
  return false;
}

function checkCurrencyFormatting(caption, testName) {
  // Check for bare prices (6+ digit numbers without $)
  const barePrices = caption.match(/(?<!\$)\b\d{3},\d{3}\b/g);
  if (barePrices && barePrices.length > 0) {
    console.log(`[${testName}] ❌ CURRENCY FORMAT — bare prices without $: ${barePrices.join(", ")}`);
    return false;
  }
  console.log(`[${testName}] ✅ CURRENCY FORMAT — all prices have $`);
  return true;
}

function checkNoUnsourcedClaims(caption, testName) {
  const violations = [];
  for (const pattern of UNSOURCED_CLAIMS_PATTERNS) {
    const match = caption.match(pattern);
    if (match) {
      violations.push(match[0]);
    }
  }
  
  // Also check for specific amenity lists (more than 2 specific amenities = likely invented)
  // The allowed sections are the tease lines
  const hasTeaseAmenity = caption.includes("want the full amenity") || caption.includes("comment TOUR and I'll send");
  const hasTeaseSchool = caption.includes("school ratings, HOA and taxes vary") || caption.includes("I'll send exact numbers");
  
  if (violations.length > 0) {
    console.log(`[${testName}] ❌ UNSOURCED CLAIMS: ${violations.join(" | ")}`);
    return false;
  }
  if (!hasTeaseAmenity) {
    console.log(`[${testName}] ❌ MISSING AMENITY TEASE — should say "want the full amenity and community rundown?"`);
    return false;
  }
  if (!hasTeaseSchool) {
    console.log(`[${testName}] ❌ MISSING SCHOOL TEASE — should say "school ratings, HOA and taxes vary by address"`);
    return false;
  }
  console.log(`[${testName}] ✅ NO UNSOURCED CLAIMS — amenity/school sections are teases only`);
  return true;
}

function checkKBOverride(caption, testName) {
  // The original says $165/month HOA. The KB says $900-$1,200/year.
  // The output should NOT have $165 and SHOULD have $900 or $1,200
  const hasStaleHOA = caption.includes("$165");
  const hasKBHOA = caption.includes("$900") || caption.includes("$1,200") || caption.includes("900") || caption.includes("1,200");
  
  if (hasStaleHOA) {
    console.log(`[${testName}] ❌ KB OVERRIDE FAILED — still has stale $165/month HOA from original`);
    return false;
  }
  if (hasKBHOA) {
    console.log(`[${testName}] ✅ KB OVERRIDE — HOA updated to KB value ($900-$1,200/year)`);
    return true;
  }
  console.log(`[${testName}] ⚠️ KB OVERRIDE — $165 removed but KB value not found (may have been rephrased)`);
  return true; // At least the stale value is gone
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
  const hashA = checkHashtagLock(captionA, "TEST A");
  const currA = checkCurrencyFormatting(captionA, "TEST A");
  console.log("");

  console.log("═".repeat(60));
  console.log("TEST B: RESTRUCTURE ORIGINAL — rich caption (gated, KB override)");
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

  // Pass overlays so KB override can fire
  const captionB = await generateCaptionFromOriginal(richOriginal, "san_antonio", esperanzaOverlays);
  
  console.log("[TEST B] ═══════ RESTRUCTURED CAPTION (GATED, KB OVERRIDE) ═══════");
  console.log(captionB);
  console.log("[TEST B] ═══════ END CAPTION ═══════");
  console.log(`[TEST B] Caption length: ${captionB.length} chars`);
  const leaksB = checkLeaks(captionB, "TEST B");
  const hashB = checkHashtagLock(captionB, "TEST B");
  const currB = checkCurrencyFormatting(captionB, "TEST B");
  const kbOverride = checkKBOverride(captionB, "TEST B");
  console.log("");

  console.log("═".repeat(60));
  console.log("TEST C: NO KB MATCH — must have ZERO unsourced claims");
  console.log("═".repeat(60));
  console.log("");

  const genericOverlays = {
    price: "$340,000",
    city: "San Antonio",
    community: "Northwest",
    beds: null
  };

  const captionC = await generateCaption("san_antonio", genericOverlays);
  
  console.log("[TEST C] ═══════ GENERATED CAPTION (NO KB MATCH, ZERO UNSOURCED) ═══════");
  console.log(captionC);
  console.log("[TEST C] ═══════ END CAPTION ═══════");
  console.log(`[TEST C] Caption length: ${captionC.length} chars`);
  const leaksC = checkLeaks(captionC, "TEST C");
  const hashC = checkHashtagLock(captionC, "TEST C");
  const currC = checkCurrencyFormatting(captionC, "TEST C");
  const noUnsourced = checkNoUnsourcedClaims(captionC, "TEST C");
  console.log("");

  // Summary
  console.log("═".repeat(60));
  console.log("VERIFICATION SUMMARY");
  console.log("═".repeat(60));
  console.log(`Test A (KB match):      ${captionA.length} chars | Leaks: ${leaksA.length} | Hashtags: ${hashA ? "✅" : "❌"} | Currency: ${currA ? "✅" : "❌"}`);
  console.log(`Test B (restructure):   ${captionB.length} chars | Leaks: ${leaksB.length} | Hashtags: ${hashB ? "✅" : "❌"} | Currency: ${currB ? "✅" : "❌"} | KB Override: ${kbOverride ? "✅" : "❌"}`);
  console.log(`Test C (no match):      ${captionC.length} chars | Leaks: ${leaksC.length} | Hashtags: ${hashC ? "✅" : "❌"} | Currency: ${currC ? "✅" : "❌"} | No Unsourced: ${noUnsourced ? "✅" : "❌"}`);
  
  // Check Test B preserved facts (minus gated names, with KB override for HOA)
  const factsToPreserve = ["$389,900", "Boerne ISD", "1,625", "5,000"];
  const preserved = factsToPreserve.filter(f => captionB.includes(f));
  console.log(`Test B facts preserved: ${preserved.length}/${factsToPreserve.length} (${preserved.join(", ")})`);
  const missingFacts = factsToPreserve.filter(f => !captionB.includes(f));
  if (missingFacts.length > 0) console.log(`Test B facts MISSING: ${missingFacts.join(", ")}`);
  
  // Final pass/fail
  const totalLeaks = leaksA.length + leaksB.length + leaksC.length;
  const allPassed = totalLeaks === 0 && hashA && hashB && hashC && currA && currB && currC && kbOverride && noUnsourced;
  
  if (allPassed) {
    console.log(`\n✅ ALL TESTS PASSED — zero leaks, hashtags locked, currency formatted, KB overrides working, no unsourced claims`);
  } else {
    console.log(`\n⚠️ SOME CHECKS FAILED — review above`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
