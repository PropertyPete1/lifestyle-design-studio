/**
 * Targeted caption dry-run test.
 * Calls the REAL generateCaption and generateCaptionFromOriginal functions
 * with controlled inputs to validate both code paths:
 * 
 * TEST A: KB match (Esperanza community detected in video overlay)
 * TEST B: KB match via generateCaptionFromOriginal (restructure a rich original)
 * 
 * The SA dispatch already proved the no-match fallback path (community=Northwest, not in KB).
 * 
 * Usage: node scripts/test-caption-dry-run.mjs
 * Requires: ANTHROPIC_API_KEY env var
 */

import { generateCaption, generateCaptionFromOriginal } from "../src/caption.js";

async function main() {
  console.log("═".repeat(60));
  console.log("TEST A: KB MATCH — Esperanza community (San Antonio/Boerne)");
  console.log("═".repeat(60));
  console.log("");

  // Simulate video overlays that would trigger Esperanza KB match
  const esperanzaOverlays = {
    price: "Starting at $389,900",
    city: "Boerne",
    community: "Esperanza",
    beds: "3-5 bedrooms"
  };

  const captionA = await generateCaption("san_antonio", esperanzaOverlays);
  
  console.log("[TEST A] ═══════ GENERATED CAPTION (KB MATCH) ═══════");
  console.log(captionA);
  console.log("[TEST A] ═══════ END CAPTION ═══════");
  console.log(`[TEST A] Caption length: ${captionA.length} chars`);
  console.log(`[TEST A] Community overlay: ${esperanzaOverlays.community}`);
  console.log("");

  console.log("═".repeat(60));
  console.log("TEST B: RESTRUCTURE ORIGINAL — rich caption preservation");
  console.log("═".repeat(60));
  console.log("");

  // A real rich original caption (from past posts) to test restructuring
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
  
  console.log("[TEST B] ═══════ RESTRUCTURED CAPTION ═══════");
  console.log(captionB);
  console.log("[TEST B] ═══════ END CAPTION ═══════");
  console.log(`[TEST B] Caption length: ${captionB.length} chars`);
  console.log("");

  // Verification
  console.log("═".repeat(60));
  console.log("VERIFICATION");
  console.log("═".repeat(60));
  console.log(`Test A length: ${captionA.length} chars (target: 1500-2000)`);
  console.log(`Test B length: ${captionB.length} chars (target: ~${richOriginal.length} chars, preserve richness)`);
  console.log(`Test A has em-dash: ${captionA.includes("—") || captionA.includes("–")}`);
  console.log(`Test B has em-dash: ${captionB.includes("—") || captionB.includes("–")}`);
  
  // Check Test A uses KB facts
  const kbFacts = ["Boerne ISD", "Esperanza", "$165", "Roca Loca", "The Club"];
  const foundFacts = kbFacts.filter(f => captionA.toLowerCase().includes(f.toLowerCase()));
  console.log(`Test A KB facts used: ${foundFacts.length}/${kbFacts.length} (${foundFacts.join(", ")})`);
  
  // Check Test B preserves original facts
  const origFacts = ["$389,900", "Boerne ISD", "1,625", "5,000", "$165", "Roca Loca", "6 different builders"];
  const preservedFacts = origFacts.filter(f => captionB.includes(f));
  console.log(`Test B facts preserved: ${preservedFacts.length}/${origFacts.length} (${preservedFacts.join(", ")})`);
}

main().catch(err => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
