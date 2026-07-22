/**
 * Test script: Generate a full week of LinkedIn posts (Mon-Sun) for approval.
 * Uses real Claude API. Run with: node test-linkedin-week.mjs
 * 
 * Picks a week starting from next Monday to ensure we get a full Mon-Sun cycle.
 */

import { generateLinkedinPost, saveToHistory } from "./src/linkedin.js";

// Find the next Monday from today (or a specific test week)
// We'll use 2026-07-28 (Monday) through 2026-08-03 (Sunday) as our test week
const TEST_DATES = [
  "2026-07-28", // Monday
  "2026-07-29", // Tuesday (lead_overflow)
  "2026-07-30", // Wednesday
  "2026-07-31", // Thursday
  "2026-08-01", // Friday (lead_overflow)
  "2026-08-02", // Saturday
  "2026-08-03", // Sunday
];

const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  LINKEDIN DRY-RUN WEEK — 7 Posts for Approval");
  console.log("═══════════════════════════════════════════════════════════════\n");

  const results = [];

  for (let i = 0; i < TEST_DATES.length; i++) {
    const date = TEST_DATES[i];
    const dayName = DAY_NAMES[i];

    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`  ${dayName} (${date})`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

    try {
      const result = await generateLinkedinPost(date);
      results.push({ ...result, dayName });

      console.log(`\nTopic: ${result.topic}`);
      console.log(`Format: ${result.format}`);
      console.log(`Ending: ${result.ending}`);
      console.log(`Words: ${result.body.split(/\s+/).filter(Boolean).length}`);
      console.log(`\n--- POST TEXT ---`);
      console.log(result.body);
      console.log(`--- END ---\n`);

      // Save to history so subsequent posts see it for anti-repetition
      saveToHistory({ topic: result.topic, body: result.body, format: result.format, ending: result.ending, date });

    } catch (err) {
      console.error(`  ERROR: ${err.message}`);
      results.push({ dayName, date, error: err.message });
    }

    // Small delay between API calls
    await new Promise(r => setTimeout(r, 1000));
  }

  // Summary
  console.log("\n\n═══════════════════════════════════════════════════════════════");
  console.log("  SUMMARY");
  console.log("═══════════════════════════════════════════════════════════════\n");

  for (const r of results) {
    if (r.error) {
      console.log(`${r.dayName}: ERROR - ${r.error}`);
    } else {
      const wc = r.body.split(/\s+/).filter(Boolean).length;
      console.log(`${r.dayName}: ${r.topic} | ${r.format} | ${r.ending} | ${wc}w`);
    }
  }
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
