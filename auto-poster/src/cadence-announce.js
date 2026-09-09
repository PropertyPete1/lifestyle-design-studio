/**
 * cadence-announce.js — tell Peter, through PRIMARY, that cadence moved.
 *
 * TWO SEAMS, BECAUSE ONE DOES NOT EXIST AND THE OTHER ALREADY WORKS.
 *
 * PRIMARY is the assistant in PropertyPete1/lifestyle-brain. Crossing repos to
 * reach it splits cleanly into two different problems:
 *
 * 1. ANSWERING QUESTIONS ("why did we drop to three a day?") is ALREADY SOLVED
 *    and needs no code in either repo. lifestyle-design-studio is in the brain's
 *    ALLOWED_REPOS, and the brain's system prompt already instructs the model to
 *    read that repo for anything about posting, content or reels. So a durable
 *    record committed to this repo's default branch is answerable the moment it
 *    lands — PRIMARY fetches it with github_get_file on demand. That is what
 *    status/posting_cadence.json below is for.
 *
 *    It has to be its own file. status/social_log.json re-validates on-disk rows
 *    against a closed three-value type enum and DELETES anything else on the next
 *    posting run; status/social_stats.json is read for exactly five scalars and
 *    everything else is dropped. Either would swallow this silently.
 *
 * 2. ANNOUNCING proactively is NOT solved. The brain's only inbound push door is
 *    POST /api/notify, and its notification text is hardcoded to build-pipeline
 *    language — firing it as-is would tell Peter a build finished and link him to
 *    a PR that does not exist. So this module writes the durable record
 *    unconditionally, and posts to the webhook only when one is explicitly
 *    configured. With no webhook set it is a no-op that still leaves PRIMARY able
 *    to answer, which is the safe default.
 *
 * Nothing here can fail a posting run. The publish has already happened by the
 * time cadence is announced, and an unreachable brain is not a reason to go red.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RECORD_PATH = join(__dirname, "..", "..", "status", "posting_cadence.json");

export const CADENCE_RECORD_VERSION = 1;

/**
 * The sentence Peter should hear.
 *
 * Written to read as a person would say it — "dropped to three a day, views per
 * post were up 40% at four" — because it is spoken by PRIMARY, not rendered in a
 * dashboard. The effect clause is included ONLY when the decision file supplied
 * a rationale; inventing a number to make the sentence sound complete is how a
 * summary becomes a lie.
 */
export function announcementText({ from, to, proposed = null, rationale = null }) {
  const dir = to < from ? "Dropped" : "Raised";
  const head = `${dir} posting to ${to} a day, from ${from}.`;
  const why = rationale && String(rationale).trim().length >= 20
    ? ` ${String(rationale).trim()}`
    : " No rationale was given for the change, so this moved one step on the decision file's number alone.";
  const cap = proposed != null && proposed !== to
    ? ` The decision file asked for ${proposed} a day; this is one step toward it — cadence never jumps.`
    : "";
  return head + why + cap;
}

/** Load the durable record, tolerating a missing or corrupt file. */
export function loadCadenceRecord(path = RECORD_PATH) {
  const fresh = () => ({ schema_version: CADENCE_RECORD_VERSION, changes: [] });
  if (!existsSync(path)) return fresh();
  try {
    const p = JSON.parse(readFileSync(path, "utf-8"));
    return p && Array.isArray(p.changes) ? p : fresh();
  } catch {
    return fresh();
  }
}

/**
 * Append the change to the durable record PRIMARY can read.
 *
 * This is the half that always runs. It is a plain append to a repo file, so it
 * survives the brain being down, the webhook being unset, and Peter reading it
 * three weeks later.
 */
export function recordForPrimary(entry, { path = RECORD_PATH } = {}) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const rec = loadCadenceRecord(path);
    rec.schema_version = CADENCE_RECORD_VERSION;
    rec.changes.push(entry);
    rec.changes = rec.changes.slice(-200);
    writeFileSync(path, JSON.stringify(rec, null, 2));
    return true;
  } catch (err) {
    console.warn(`[Cadence] Could not write the PRIMARY record: ${err.message}`);
    return false;
  }
}

/**
 * Announce a cadence change. Never throws.
 *
 * Configuration to activate the push half: BRAIN_NOTIFY_URL and
 * BRAIN_NOTIFY_SECRET. Unset means record-only, which is a working state — not a
 * degraded one.
 */
export async function announceCadenceChange({
  from, to, proposed = null, rationale = null, state = null,
  now = new Date(), fetchImpl = fetch, env = process.env,
} = {}) {
  const text = announcementText({ from, to, proposed, rationale });
  const entry = {
    at: now.toISOString(),
    from,
    to,
    proposed,
    rationale: rationale ?? null,
    announcement: text,
    unit: "realty pipeline publishes per Chicago day",
    // Spelling the fan-out out here means PRIMARY can answer "how many posts is
    // that really?" without inferring it.
    fan_out_note: "one publish reaches 3 satellite Instagram accounts plus TikTok and YouTube on the main brand; the main brand's Instagram is posted natively by Peter",
    floor: state?.floor ?? null,
    ceiling: state?.ceiling ?? null,
    run_id: env.GITHUB_RUN_ID || null,
  };

  recordForPrimary(entry);
  console.log(`[Cadence] ${text}`);

  const url = env.BRAIN_NOTIFY_URL;
  const secret = env.BRAIN_NOTIFY_SECRET;
  if (!url || !secret) {
    console.log("[Cadence] BRAIN_NOTIFY_URL/SECRET not set — recorded for PRIMARY to read, no push sent");
    return { recorded: true, pushed: false, reason: "webhook not configured" };
  }

  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Notify-Secret": secret },
      body: JSON.stringify({ kind: "cadence_change", title: "Posting cadence changed", body: text, detail: entry }),
    });
    if (!res.ok) {
      console.warn(`[Cadence] Brain notify returned ${res.status} — the record is still committed`);
      return { recorded: true, pushed: false, reason: `HTTP ${res.status}` };
    }
    console.log("[Cadence] PRIMARY notified");
    return { recorded: true, pushed: true };
  } catch (err) {
    console.warn(`[Cadence] Brain notify failed (${err.message}) — the record is still committed`);
    return { recorded: true, pushed: false, reason: err.message };
  }
}

export { RECORD_PATH };
