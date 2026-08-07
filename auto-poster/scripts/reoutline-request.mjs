#!/usr/bin/env node
/**
 * reoutline-request.mjs — rewrite one approved request's outline under the
 * current brief rules, without making Peter pick a topic again.
 *
 * WHY THIS EXISTS. A topic is approved, the writer works from the outline stored
 * on that request, and then the rules the outline was generated under change.
 * On 2026-08-07 the brief's prompt banned community and development names
 * outright, so the outline for "Best neighborhoods in North San Antonio" carried
 * no named places; the writer will not invent ones it was not given, and the
 * critic held every draft for exactly that. #34 fixed the rule going forward,
 * but a request already approved keeps the outline it was born with.
 *
 * Regenerating the whole brief would work and would also throw away a decision
 * Peter already made. This rewrites only the outline of the candidate he picked.
 *
 * WHAT IT PRESERVES, always: the requestId, the decision, the selection, the
 * notes, and every other candidate. The only field that changes is the selected
 * candidate's `outline` — and `payload.reoutlinedAt` is stamped so the change is
 * visible in the record rather than looking like the model's original work.
 *
 * The new outline goes through the same applyGuards the brief does, so a gated
 * development cannot enter this way.
 *
 *   I_UNDERSTAND_THIS_TOUCHES_LIVE=yes node scripts/reoutline-request.mjs <requestId>
 */

import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { requireLiveAck } from "./live-guard.mjs";
import { briefSystem, callModel, applyGuards, resolveTopicSelection } from "../src/yt-brief.js";

// TOUCHES LIVE: rewrites yt-approvals.json, the committed record the pipeline
// reads to decide what to write next, and bills the Anthropic API.
requireLiveAck(
  "Rewrites the stored outline on a live approval record in yt-approvals.json, and bills the " +
    "Anthropic API. Peter's decision, selection and notes are preserved."
);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PATH = join(ROOT, "yt-approvals.json");
const DRY_RUN = process.env.DRY_RUN === "true";

const requestId = (process.argv[2] || process.env.REQUEST_ID || "").trim();
if (!requestId) {
  console.error("usage: reoutline-request.mjs <requestId>");
  process.exit(1);
}

function loadRaw() {
  const parsed = JSON.parse(readFileSync(PATH, "utf-8"));
  // The dashboard commits a bare array; the poster commits { requests }.
  return Array.isArray(parsed) ? { requests: parsed, wasArray: true } : { ...parsed, wasArray: false };
}

async function main() {
  const log = loadRaw();
  const record = (log.requests || []).find((r) => r?.requestId === requestId);
  if (!record) {
    console.error(`[Reoutline] ${requestId} not found in yt-approvals.json`);
    process.exit(1);
  }

  const candidates = record?.payload?.candidates || [];
  const selection = resolveTopicSelection(record, candidates);
  if (!selection.ok) {
    console.error(`[Reoutline] cannot tell which candidate was picked: ${selection.reason}`);
    process.exit(1);
  }

  const picked = selection.candidate;
  console.log(`[Reoutline] ${requestId} -> option ${selection.index}: "${picked.title}"`);
  console.log(`[Reoutline] decision=${record.decision} notes=${JSON.stringify(record.notes || null)}`);
  console.log(`\n[Reoutline] CURRENT OUTLINE:\n${picked.outline}\n`);

  // Peter's notes steer the video, so they steer the outline too — otherwise the
  // rewrite drops guidance he already gave once.
  const noteBlock = record.notes
    ? `\n\nPETER ASKED FOR THIS WHEN HE PICKED IT. Honour it in every chapter:\n${record.notes}\n`
    : "";

  const prompt =
    `Rewrite ONLY the outline for this already-approved video. The title, angle and market are ` +
    `fixed — do not propose a different video.\n\n` +
    `TITLE: ${picked.title}\n` +
    `MARKET: ${picked.market}\n` +
    `INTENT: ${picked.intent}\n` +
    `ANGLE: ${picked.hook}\n` +
    `WHO IT IS FOR: ${picked.why}\n\n` +
    `THE OUTLINE IT HAS NOW, which failed because it names no places:\n${picked.outline}\n` +
    noteBlock +
    `\nWrite 4 to 6 chapter titles, one per line, following the NAME REAL PLACES rule in your ` +
    `instructions. Most chapters must carry at least one real, named, publicly-known place, and ` +
    `the specific claim must attach to that named place.\n\n` +
    `Return ONLY valid JSON, no preamble and no code fences:\n{"outline": "chapter\\nchapter\\n..."}`;

  const raw = await callModel(briefSystem(), prompt);
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) {
    console.error(`[Reoutline] no JSON object in model output:\n${raw.slice(0, 500)}`);
    process.exit(1);
  }
  const outline = String(JSON.parse(raw.slice(start, end + 1)).outline || "").trim();

  const chapters = outline.split("\n").map((l) => l.trim()).filter(Boolean);
  if (chapters.length < 4) {
    console.error(`[Reoutline] model returned ${chapters.length} chapters, need at least 4`);
    process.exit(1);
  }

  // Same gate the brief runs. A gated development must not enter this way either.
  const guarded = applyGuards([{ ...picked, outline: chapters.join("\n") }]);
  if (guarded.leaksStripped.length) {
    console.log(`[Reoutline] guard stripped: ${guarded.leaksStripped.join(", ")}`);
  }
  const finalOutline = guarded.candidates[0].outline;

  console.log(`[Reoutline] NEW OUTLINE:\n${finalOutline}\n`);

  if (DRY_RUN) {
    console.log("[Reoutline] DRY RUN — nothing written.");
    return;
  }

  picked.outline = finalOutline;
  record.payload.reoutlinedAt = new Date().toISOString();
  record.payload.reoutlineReason =
    "Outline regenerated under the named-places rule (#34). Peter's pick and notes preserved.";

  const { wasArray, ...rest } = log;
  writeFileSync(PATH, JSON.stringify(wasArray ? rest.requests : rest, null, 2) + "\n");
  console.log(`[Reoutline] ✓ written — decision, selection and notes untouched`);
}

main().catch((err) => {
  console.error(`[Reoutline] FAILED: ${err?.stack || err}`);
  process.exit(1);
});
