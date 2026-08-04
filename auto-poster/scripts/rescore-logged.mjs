#!/usr/bin/env node
/**
 * rescore-logged.mjs — run past decks back through the current critic.
 *
 * The point is to check the clarity axis against real output: 2026-08-04's hook
 * scored 8/7/8 on the old three axes and shipped, and Peter could not tell what
 * it was claiming. If clarity works, that entry now fails.
 *
 * LIMITATION: log entries written before this change stored only the hook, not
 * the deck, so those can only be scored on slide 1. Entries written from now on
 * carry the full deck and can be re-scored whole. Where a deck is missing this
 * says so rather than quietly scoring less than it claims to.
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { scoreDeck, scoresPass } from "../src/carousel-content.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOG = join(ROOT, "carousel-log.json");

/** A hook-only stand-in, so the critic scores slide 1 and nothing it cannot see. */
function hookOnlyDeck(entry) {
  return {
    topic: entry.topic,
    hook: entry.hook,
    map: ["(not retained in the log)"],
    points: [],
    cta: { payoff: "(not retained in the log)" },
  };
}

async function main() {
  const log = JSON.parse(readFileSync(LOG, "utf-8"));
  const entries = (log.posts || []).slice(-3);

  console.log(`Log holds ${log.posts.length} entries; re-scoring the last ${entries.length}.\n`);

  for (const entry of entries) {
    const whole = Boolean(entry.deck);
    const deck = whole ? entry.deck : hookOnlyDeck(entry);
    const closeType = entry.closeType || "dm";

    console.log(`── ${entry.date}  ${entry.pillar}  (${whole ? "full deck" : "HOOK ONLY — deck not retained"})`);
    console.log(`   hook: "${entry.hook}"`);
    const before = entry.scores || {};
    console.log(`   was:  hook=${before.hook} loops=${before.loops} cta=${before.cta}  (no clarity axis existed)`);

    try {
      const now = await scoreDeck(deck, entry.keyword, undefined, closeType);
      const verdict = scoresPass(now) ? "PASS" : "BELOW BAR";
      console.log(`   now:  clarity=${now.clarity} hook=${now.hook} loops=${now.loops} cta=${now.cta}  -> ${verdict}`);
      if (now.worst_problem) console.log(`   critic: ${now.worst_problem}`);
      if (!whole) console.log(`   note: loops and cta are meaningless here — those slides were not retained.`);
    } catch (err) {
      console.log(`   scoring failed: ${err.message}`);
    }
    console.log("");
  }
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
