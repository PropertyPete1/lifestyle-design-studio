#!/usr/bin/env node
/**
 * market-today.mjs — which market gets today's one slot. post.yml runs this
 * before main.js so the workflow knows which CITY to run as.
 *
 * WHY THE WORKFLOW HAS TO ASK. main.js runs as ONE city — CITY picks the Drive
 * folder, the captions, the city keywords — and a GitHub cron can neither do
 * date arithmetic nor read a Drive file. So the daily cron runs this first and
 * hands main.js the answer. main.js then re-derives today's market from the
 * same two rules (drive-decision.js readTodayBlock, cadence.js resolveMarket)
 * and its gate REFUSES a mismatch — a wrong answer here costs a stand-down and
 * an alert, never a wrong post. The gate is the law; this is the usher.
 *
 * TWO RULES, IN ORDER:
 *   1. the decision file's `today` block, when it names a market FOR TODAY
 *      (Chicago date) — readTodayBlock holds the contract and the day-scoping;
 *   2. otherwise the calendar rotation — San Antonio → Austin → Dallas,
 *      anchored 2026-09-24 = San Antonio (cadence.js MARKET_ROTATION_ANCHOR).
 *
 * NEVER FAILS THE STEP. No credentials, a Drive error, a missing or stale file,
 * an unrecognised market — each falls back to rule 2 and says so on stderr.
 * Rule 2 needs nothing but the clock.
 *
 * READ-ONLY. It reads one Drive file and writes nothing anywhere, which is why
 * it carries no live-guard latch (read-only probes do not — see live-guard.mjs).
 *
 * USAGE
 *   node scripts/market-today.mjs                      resolve today's market
 *   node scripts/market-today.mjs --city dallas [--slot am]
 *                                  echo a workflow_dispatch choice in the same
 *                                  output shape; the gate decides if it may post
 *
 * OUTPUT — GITHUB_OUTPUT lines on stdout, and nothing else on stdout:
 *   city=austin
 *   label=ATX
 *   slot=am
 *   market_source=decision_file | rotation | dispatch
 */
import { loadDecision } from "../src/drive-decision.js";
import {
  resolveMarket, chicagoDay, rotationPreview, normalizeMarket,
  MARKET_LABELS, DAILY_SLOT, MARKETS,
} from "../src/cadence.js";

function stepOutputs({ city, slot = DAILY_SLOT, source }) {
  return [
    `city=${city}`,
    `label=${MARKET_LABELS[city] ?? String(city).toUpperCase()}`,
    `slot=${slot}`,
    `market_source=${source}`,
  ].join("\n") + "\n";
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

async function main() {
  const cityArg = argValue("--city");
  if (cityArg !== null) {
    const city = normalizeMarket(cityArg);
    if (!city) {
      console.error(`[MarketToday] "${cityArg}" is not a market (${MARKETS.join(", ")})`);
      process.exit(1);
    }
    const slot = argValue("--slot") || DAILY_SLOT;
    console.error(`[MarketToday] dispatch: ${city} ${slot} — the gate in main.js decides whether it may publish`);
    process.stdout.write(stepOutputs({ city, slot, source: "dispatch" }));
    return;
  }

  const now = new Date();
  const day = chicagoDay(now);
  const decision = await loadDecision({ now: now.getTime() });
  const today = decision.plan?.today ?? null;
  if (!decision.usable) console.error(`[MarketToday] decision file not usable — ${decision.reason}`);
  else if (today?.present) console.error(`[MarketToday] today block: ${today.reason}`);
  else console.error("[MarketToday] decision file carries no today block");

  const { market, source } = resolveMarket({ day, namedMarket: today?.market ?? null });
  const next = rotationPreview(day, 3).map((r) => `${r.day} ${MARKET_LABELS[r.market]}`).join(", ");
  console.error(`[MarketToday] ${day} (CT) → ${market} (${source}); rotation from today: ${next}`);
  process.stdout.write(stepOutputs({ city: market, slot: DAILY_SLOT, source }));
}

main().catch((err) => {
  // Rule 2 needs only the clock. A crash above must not cost the day its post.
  const { market } = resolveMarket({ day: chicagoDay(new Date()) });
  console.error(`[MarketToday] failed (${err.message}) — falling back to the rotation: ${market}`);
  process.stdout.write(stepOutputs({ city: market, slot: DAILY_SLOT, source: "rotation" }));
});
