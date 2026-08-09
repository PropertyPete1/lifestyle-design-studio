#!/usr/bin/env node
/**
 * retrofit-video1-intents.mjs — annotate video 1's stored script with the
 * visualIntents it predates. ANNOTATION ONLY.
 *
 * Video 1's script was written before visualIntent existed, so its build came
 * out 0% graphic — no rings map, no exemption breakdown. The recordings are
 * done and immutable; the visuals only change what plays OVER the narration,
 * so intents can be added without touching a word he recorded against.
 *
 * THE IMMUTABILITY GUARD IS THE POINT OF THIS SCRIPT. Take text is hashed
 * before and after; any difference at all aborts without writing. The intents
 * are keyed by distinctive fragments of the take text rather than by take id,
 * so a numbering assumption can never silently annotate the wrong take — an
 * ambiguous or unmatched fragment is a hard failure.
 *
 * Every added intent goes through the REAL validators before anything is
 * written: normaliseIntent must accept it, every MAP must resolve against the
 * gazetteer, and the whole annotated script must clear applyGuards with no
 * leak stripped and no payment figure found.
 *
 *   node scripts/retrofit-video1-intents.mjs            # dry report
 *   node scripts/retrofit-video1-intents.mjs --write    # write the file
 */

import { createHash } from "crypto";
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { normaliseIntent, GRAPHIC_TYPES, FOOTAGE } from "../src/yt-visual-intent.js";
import { mapSpecForIntent } from "../src/yt-map-render.js";
import { applyGuards, allTakes } from "../src/yt-script.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const APPROVALS = join(HERE, "..", "yt-approvals.json");
const WRITE = process.argv.includes("--write");

/**
 * The annotations, keyed by a fragment that appears in exactly one take.
 *
 * Hand-authored against the recorded narration, not generated: video 1 is the
 * template video, and the first pass of its graphic density is an editorial
 * choice Peter will tune through review rounds. Present rate: 13 graphics
 * across 24 voiceover takes, with the rest explicitly FOOTAGE so the split
 * report reads "chosen", not "unspecified".
 */
const ANNOTATIONS = [
  // ── S1: the rings. The video's founding visual. ──────────────────────────
  { match: "Castle Hills sits just inside Loop 410",
    intent: { type: "MAP", spec: { lines: ["Loop 410", "1604"], places: ["Castle Hills", "Downtown"], eyebrow: "North San Antonio", title: "Two rings, three neighborhoods" } } },
  { match: "Shavano Park is a couple miles further out",
    intent: { type: "MAP", spec: { lines: ["Loop 410", "1604"], places: ["Shavano Park", "Castle Hills", "Downtown"] } } },
  { match: "Stone Oak is the third one",
    intent: { type: "MAP", spec: { lines: ["1604", "281"], places: ["Stone Oak", "Shavano Park"] } } },

  // ── S2: inside the loop for the hospitals ────────────────────────────────
  { match: "Oak Hills sits just south and west", intent: "FOOTAGE" },
  { match: "Churchill Estates is a little further north",
    intent: { type: "MAP", spec: { lines: ["Loop 410", "1604"], places: ["Churchill Estates", "Castle Hills", "Medical Center"] } } },
  { match: "Deerfield is the newest of the three", intent: "FOOTAGE" },
  { match: "you're inspecting foundations",
    intent: { type: "LIST", spec: { eyebrow: "Older inside the loop", title: "What the inspection is really for", items: ["Foundation movement", "Cast iron drain lines", "Thirty-year-old ductwork"], footnote: "Budget for it going in, not after." } } },

  // ── S3: the 281 corridor ─────────────────────────────────────────────────
  { match: "Stone Oak is the big one", intent: "FOOTAGE" },
  { match: "Encino Park is smaller and quieter",
    intent: { type: "MAP", spec: { lines: ["281", "1604"], places: ["Encino Park", "Stone Oak"] } } },
  { match: "Timberwood Park is further north", intent: "FOOTAGE" },
  { match: "Drive 281 before you sign",
    intent: { type: "CALLOUT", spec: { eyebrow: "The only honest test", value: "Tuesday, 7:15 AM", label: "drive the 281 commute before you sign" } } },

  // ── S4: the northeast, Randolph, the districts that chase it ─────────────
  { match: "Live Oak and Selma sit right along Interstate 35",
    intent: { type: "MAP", spec: { lines: ["I-35", "1604"], places: ["Live Oak", "Selma", "Randolph"] } } },
  { match: "Universal City is the closest thing", intent: "FOOTAGE" },
  { match: "Schertz and Cibolo are the next two out", intent: "FOOTAGE" },
  { match: "people call it SCUC",
    intent: { type: "COMPARISON", spec: { eyebrow: "The district line", title: "Same house, different district", columns: [
      { name: "SCUC ISD", points: ["Schertz, Cibolo, Universal City", "The one relocating families chase"] },
      { name: "Judson ISD", points: ["Live Oak side and Converse", "Easier prices, tougher resale"] },
    ], footnote: "The line moves the price of the exact same house." } } },

  // ── S5: the school-boundary surprise ─────────────────────────────────────
  { match: "Northside ISD is the giant district",
    intent: { type: "COMPARISON", spec: { eyebrow: "Both own pieces of Stone Oak", title: "One subdivision, two districts", columns: [
      { name: "Northside ISD", points: ["West and northwest side", "Owns part of Stone Oak"] },
      { name: "North East ISD", points: ["North and northeast", "Owns the other part"] },
    ], footnote: "Same entrance sign. Different schools." } } },
  { match: "Comal ISD is the district that reaches down",
    intent: { type: "MAP", spec: { lines: ["I-35", "281"], places: ["Timberwood Park", "Bulverde", "New Braunfels"] } } },
  { match: "Verify by address",
    intent: { type: "LIST", spec: { eyebrow: "Before you write the offer", title: "Verify the school by address", items: ["Find the district's boundary lookup", "Type the exact street address", "Note all three campus assignments", "Never trust the subdivision name"] } } },
  { match: "This matters even if your kids are grown", intent: "FOOTAGE" },

  // ── S6: the exemption and the line it does not touch ─────────────────────
  { match: "It does not apply to a MUD or a PID",
    intent: { type: "COMPARISON", spec: { eyebrow: "Two things that are not taxes", title: "MUD and PID, plainly", columns: [
      { name: "MUD", points: ["Municipal utility district", "Pays for water and sewer"] },
      { name: "PID", points: ["Public improvement district", "Pays for roads and amenities"] },
    ], footnote: "Your exemption does not touch either one." } } },
  { match: "looking exactly like a tax", intent: "FOOTAGE" },
  { match: "the ones with the stone entrance",
    intent: { type: "MAP", spec: { lines: ["1604", "I-35"], places: ["Stone Oak", "Schertz", "Cibolo", "Timberwood Park"], eyebrow: "North and east of 1604", title: "Where the assessments live" } } },
  { match: "the math flips completely",
    intent: { type: "NUMBER_BREAKDOWN", spec: { eyebrow: "100% disabled veteran", title: "What the exemption does not touch", rows: [
      { label: "School district tax", value: "exempt", struck: true },
      { label: "County tax", value: "exempt", struck: true },
      { label: "MUD / PID assessment", value: "still due" },
    ], footnote: "It is an assessment, not a tax." } } },
  { match: "Where do veterans actually stay put",
    intent: { type: "MAP", spec: { lines: ["I-35"], places: ["Universal City", "Schertz", "Cibolo", "Live Oak", "Randolph"] } } },
];

// ─── locate the stored script ───────────────────────────────────────────────

const approvals = JSON.parse(readFileSync(APPROVALS, "utf-8"));
const record = (approvals.requests || []).find((r) => r.kind === "topic_pick" && r.actedResult?.script && !String(r.requestId).startsWith("TEST-"));
if (!record) {
  console.error("no acted topic_pick with a script found");
  process.exit(1);
}
const script = record.actedResult.script;
console.log(`script: "${script.title}" (${record.requestId})`);

const takeTextHash = (s) =>
  createHash("sha256").update(allTakes(s).map((t) => `${t.id} ${t.text}`).join("")).digest("hex");

const before = takeTextHash(script);

// ─── apply, with every failure fatal ────────────────────────────────────────

const failures = [];
const applied = [];
const voTakes = [];
for (const section of script.sections) {
  for (const take of section.takes) if (take.mode === "VOICEOVER") voTakes.push(take);
}

for (const { match, intent } of ANNOTATIONS) {
  const hits = voTakes.filter((t) => t.text.includes(match));
  if (hits.length !== 1) {
    failures.push(`fragment "${match}" matched ${hits.length} take(s) — must match exactly one`);
    continue;
  }
  const take = hits[0];
  if (take.visualIntent) {
    failures.push(`${take.id} already carries an intent — refusing to overwrite`);
    continue;
  }
  const check = normaliseIntent(intent);
  if (!check.ok) {
    failures.push(`${take.id}: intent rejected by the validator — ${check.reason}`);
    continue;
  }
  if (check.type !== FOOTAGE && check.type === "MAP") {
    const resolved = mapSpecForIntent(check.spec, { market: record.actedResult.market || "san_antonio" });
    if (!resolved) {
      failures.push(`${take.id}: MAP names nothing the gazetteer resolves`);
      continue;
    }
  }
  take.visualIntent = intent;
  applied.push({ id: take.id, type: check.type });
}

// Every voiceover take must now carry a decision — that is the point.
const undecided = voTakes.filter((t) => !t.visualIntent);
for (const t of undecided) {
  t.visualIntent = "FOOTAGE";
  applied.push({ id: t.id, type: "FOOTAGE (default fill)" });
}

// ─── the guards ─────────────────────────────────────────────────────────────

const after = takeTextHash(script);
if (after !== before) {
  console.error("FATAL: take text changed during annotation. Nothing written.");
  process.exit(1);
}

const guarded = applyGuards(structuredClone(script));
if (guarded.paymentFigure.found) failures.push(`a spec states a payment figure: "${guarded.paymentFigure.match}"`);
if (guarded.leaksStripped.length > 0) failures.push(`a spec tripped the leak scanner: ${guarded.leaksStripped.join("; ")}`);
if (guarded.impossibleCta.length > 0) failures.push(`a spec promises an impossible CTA`);

if (failures.length) {
  console.error(`\n${failures.length} failure(s):`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}

const graphics = applied.filter((a) => GRAPHIC_TYPES.includes(a.type)).length;
console.log(`\ntake-text hash unchanged: ${before.slice(0, 16)}…`);
console.log(`${applied.length} takes annotated — ${graphics} graphics, ${applied.length - graphics} explicit footage:`);
for (const a of applied) console.log(`  ${a.id.padEnd(6)} ${a.type}`);

if (WRITE) {
  writeFileSync(APPROVALS, JSON.stringify(approvals, null, 1) + "\n");
  console.log(`\nwritten to ${APPROVALS}`);
} else {
  console.log("\nDRY RUN — pass --write to persist");
}
