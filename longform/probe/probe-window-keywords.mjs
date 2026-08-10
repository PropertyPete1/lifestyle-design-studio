/**
 * probe-window-keywords.mjs — proof that the stock layer is universal.
 *
 * The per-window keyword extractor contains no place names, no market, no topic
 * vocabulary and no mapping table, and the only way to SHOW that rather than
 * assert it is to run it over scripts it was never looked at while being
 * written. So this probe drives it with two topics unrelated to video 1 —
 * property tax protests and school attendance zones — and prints the whole
 * chain: the window, the phrase spoken inside it, the concept derived from that
 * phrase, and every proper noun dropped on the way.
 *
 * Run:  node longform/probe/probe-window-keywords.mjs
 *
 * With PEXELS_API_KEY set it also performs the real searches and prints the
 * clip each window would bind to. Without one it stops at the query, which is
 * the part that proves universality; the clip is Pexels' answer to the query,
 * not ours.
 */

import { planSegmentCoverage } from "../../auto-poster/src/yt-visual-plan.js";
import {
  documentFrequencies, properLexicon, keywordsForWindow,
} from "../../auto-poster/src/yt-scene-keywords.js";
import { searchPexels, rankCandidates } from "../../auto-poster/src/yt-stock.js";

/**
 * Two scripts about things this pipeline has never rendered.
 *
 * Written in the register the real writer produces: prose with proper nouns
 * embedded in it, because the proper nouns are the whole difficulty. A script
 * that named nothing would prove nothing.
 */
const SCRIPTS = {
  "property tax protests": [
    {
      takeId: "tax-1", kind: "voiceover", seconds: 24, visual: "FOOTAGE", visualSpec: { keywords: [] },
      text: "Every January the Bexar Appraisal District mails a notice with a number on it, and most people file it away. " +
            "That number is a guess made by a computer that has never been inside your kitchen. " +
            "The protest deadline sits in May and the paperwork is two pages long.",
    },
    {
      takeId: "tax-2", kind: "voiceover", seconds: 22, visual: "FOOTAGE", visualSpec: { keywords: [] },
      text: "You are not arguing about what your house is worth. You are arguing that the roof is older than the comparable sales say. " +
            "Bring photographs of the damage, bring the repair estimates, and bring the closing statement.",
    },
  ],
  "school attendance zones": [
    {
      takeId: "school-1", kind: "voiceover", seconds: 24, visual: "FOOTAGE", visualSpec: { keywords: [] },
      text: "The Northside district boundary runs down the middle of a street, and the houses on the east side feed a different elementary school. " +
            "Two identical homes, one block apart, and the bus takes the children to opposite ends of the city.",
    },
    {
      takeId: "school-2", kind: "voiceover", seconds: 20, visual: "FOOTAGE", visualSpec: { keywords: [] },
      text: "Rezoning happens when a campus runs out of classrooms. The portable buildings go up in the parking lot first, " +
            "and by the time the district redraws the map your commute has already changed.",
    },
  ],
};

const key = process.env.PEXELS_API_KEY;

for (const [topic, segments] of Object.entries(SCRIPTS)) {
  console.log(`\n${"═".repeat(78)}\nTOPIC: ${topic}\n${"═".repeat(78)}`);

  // Plan coverage exactly as the build does, so the windows are the real ones.
  const planned = segments.map((seg) => {
    const coverage = planSegmentCoverage(seg, { stockSeconds: seg.seconds });
    return { ...seg, visualBlocks: coverage.blocks };
  });

  const frequencies = documentFrequencies(planned);
  const lexicon = properLexicon(planned);
  console.log(`proper nouns the script itself taught us: ${[...lexicon].join(", ") || "(none)"}\n`);

  for (const seg of planned) {
    for (const block of seg.visualBlocks) {
      if (block.kind !== "stock") continue;
      const w = keywordsForWindow(seg, block, {
        frequencies, lexicon, fallbackKeywords: seg.visualSpec?.keywords || [],
      });

      console.log(`${seg.takeId} window ${block.phase}  ${block.startAt}s → ${round(block.startAt + block.seconds)}s`);
      console.log(`  spoken   "${w.phrase}"`);
      console.log(`  query    [${w.keywords.join(" | ") || "— nothing searchable —"}]   (${w.source})`);
      console.log(`  dropped  ${w.dropped.length ? w.dropped.join(", ") : "(no proper nouns in this window)"}`);

      // The safety property, checked rather than claimed.
      const leaked = w.dropped.filter((d) => w.keywords.join(" ").toLowerCase().includes(String(d).toLowerCase()));
      if (leaked.length) console.log(`  ✗ LEAK   ${leaked.join(", ")} reached the query`);

      if (key && w.keywords.length) {
        const results = await searchPexels(w.keywords[0]);
        const top = rankCandidates(results)[0];
        console.log(`  clip     ${top ? `${top.pageUrl} (${top.width}x${top.height}, ${top.durationSeconds}s, ${top.photographer})` : "no candidate cleared the size and length floors"}`);
      }
      console.log();
    }
  }
}

if (!key) {
  console.log("\nPEXELS_API_KEY is not set — stopped at the query.");
  console.log("The query is the part this probe exists to demonstrate; the clip is Pexels' answer to it.");
}

function round(n) {
  return Math.round(n * 100) / 100;
}
