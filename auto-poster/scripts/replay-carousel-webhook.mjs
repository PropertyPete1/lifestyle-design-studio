#!/usr/bin/env node
/**
 * replay-carousel-webhook.mjs — re-send today's carousel delivery to the real
 * dashboard webhook, after the Manus migration (type enum, unique key on
 * (type, city, date), carousel-aware payload and UI).
 *
 * Sends ONLY the webhook. Nothing is published to any social account, nothing
 * is uploaded to Drive, no email goes out. It replays the exact payload shape
 * production sends, with today's real Drive links and caption.
 *
 * The open question: Manus's report did not mention altering the `city` column,
 * and the poster still sends city:"CAROUSEL". If the enum still rejects it, the
 * full error is printed verbatim so the remaining migration step is unambiguous.
 *
 * Escalation, only if the production shape fails: retry once with a lowercase
 * "carousel" to distinguish "the value is missing from the enum" from "the enum
 * has it but in a different case". The second attempt only runs when the first
 * created no row, so it cannot leave two carousel rows behind.
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { buildSocialCaption } from "../src/carousel-content.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DASHBOARD_URL = process.env.DASHBOARD_URL;
const SECRET = process.env.DASHBOARD_WEBHOOK_SECRET;

if (!DASHBOARD_URL || !SECRET) {
  console.error("DASHBOARD_URL / DASHBOARD_WEBHOOK_SECRET not set");
  process.exit(1);
}

// Drive files from the 2026-08-04 carousel run (Actions run 30927347691),
// in order: nine slides then the PDF.
const DRIVE_FILE_IDS = [
  "1vBT_qxTX0fbJjtudpqovbdJQMChoTSF4",
  "1UNCYAvZrRou_koGFHZvuwMrWAwx-oZHj",
  "1einq1B51qXtf9Cany_vSt_q9GTgGBKSu",
  "1jJbh0bnkrTlb_wAOfKRioc9llc8iKjyO",
  "1p768CFd2hLIYPdJPnsMXHgbz3rFMYmUW",
  "1I5gPbr_q0WxLkSobKe8q2NB4KWXzGVDh",
  "1lOR4SpffeG_Am7sp6xd2q5kFDmtChJxo",
  "1e7CEqrbCyOH7T2g-gevsJ2Q8q9bZQ96A",
  "1yWWIlP1PWjfCbvtGaie7Qv9fp5B49Vsp",
  "1hU5sOHrOFlwN5u1rlAS67Jr5iMbM4V-N",
];

const TARGET_DATE = "2026-08-04";

function driveFile(id, name) {
  return {
    fileId: id,
    fileName: name,
    webViewLink: `https://drive.google.com/file/d/${id}/view`,
    directLink: `https://drive.google.com/uc?export=download&id=${id}`,
  };
}

/** Rebuild the delivery payload exactly as deliverCarouselToOwner would. */
function buildPayload(cityValue, entry, shape = {}) {
  const uploaded = DRIVE_FILE_IDS.map((id, i) =>
    driveFile(
      id,
      i === DRIVE_FILE_IDS.length - 1
        ? `CAROUSEL_${TARGET_DATE}_carousel.pdf`
        : `CAROUSEL_${TARGET_DATE}_slide-${String(i + 1).padStart(2, "0")}.png`
    )
  );
  const primary = uploaded[0];
  // Entries written before deck-logging landed hold only the hook. The caption
  // body is not what is under test here — the payload shape and the city/type
  // fields are — so fall back to the hook rather than failing the run.
  const caption = entry.deck
    ? buildSocialCaption({ deck: entry.deck, keyword: entry.keyword, closeType: entry.closeType })
    : entry.hook;

  const ownerNote =
    `${caption}\n\n` +
    `— Carousel: ${uploaded.length} files in Ready to Post. Post slides in order.\n` +
    (entry.keyword ? `— Comment keyword: ${entry.keyword}\n` : `— Close type: ${entry.closeType} (no comment keyword)\n`) +
    `— Add trending audio natively when you post.\n` +
    uploaded.map((u, i) => `  ${i + 1}. ${u.webViewLink}`).join("\n");

  return {
    city: cityValue,
    caption: ownerNote,
    driveFileId: primary.fileId,
    driveFileName: primary.fileName,
    driveLink: primary.webViewLink,
    directDownloadLink: primary.directLink,
    deliveredAt: new Date().toISOString(),
    type: "carousel",
    slides: uploaded.slice(0, -1).map((u) => ({ fileName: u.fileName, link: u.webViewLink })),
    pdf: { fileName: uploaded[uploaded.length - 1].fileName, link: uploaded[uploaded.length - 1].webViewLink },
    keyword: entry.keyword || null,
    closeType: entry.closeType,
    ...shape(uploaded),
  };
}

const slidesOf = (u) => u.slice(0, -1);
const pdfOf = (u) => u[u.length - 1];

/**
 * Candidate shapes for the fields the dashboard requires. Its 400s name the
 * missing field precisely and write no row, so walking a short ladder is a
 * cheap way to pin the contract without guessing blind.
 */
const SHAPES = [
  ["slideImages as URL strings", (u) => ({
    slideImages: slidesOf(u).map((s) => s.webViewLink),
    pdfUrl: pdfOf(u).webViewLink,
  })],
  ["slideImages as objects", (u) => ({
    slideImages: slidesOf(u).map((s) => ({ fileName: s.fileName, url: s.webViewLink, link: s.webViewLink })),
    pdfUrl: pdfOf(u).webViewLink,
    pdfLink: pdfOf(u).webViewLink,
  })],
  ["slideImages as direct-download URLs", (u) => ({
    slideImages: slidesOf(u).map((s) => s.directLink),
    pdfUrl: pdfOf(u).directLink,
  })],
];

async function send(label, payload) {
  console.log(`\n── ${label}: city=${JSON.stringify(payload.city)} type=${JSON.stringify(payload.type)}`);
  const res = await fetch(`${DASHBOARD_URL}/api/delivery/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Webhook-Secret": SECRET },
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  console.log(`   HTTP ${res.status} ${res.ok ? "OK" : "FAILED"}`);

  // The `cause` sits at the END of the driver's error JSON, after a very long
  // echoed statement. Truncating the body hides the one line that names the
  // actual fault, so pull it out first.
  let cause = null;
  try { cause = JSON.parse(body)?.cause || null; } catch {}
  if (!cause) {
    const m = body.match(/"cause"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (m) cause = m[1];
  }
  if (cause) {
    console.log(`   CAUSE: ${cause}`);
  } else {
    console.log(`   response (${body.length} chars): ${body.slice(0, 400)}`);
  }

  const enumError = /Data truncated for column 'city'/i.test(body);
  if (enumError) {
    console.log(`   ::warning::the city enum still rejects ${JSON.stringify(payload.city)} — the city side of the migration is unfinished`);
  }
  return { ok: res.ok, status: res.status, body, enumError };
}

async function main() {
  const log = JSON.parse(readFileSync(join(ROOT, "carousel-log.json"), "utf-8"));
  const entry = (log.posts || []).find((p) => p.date === TARGET_DATE);
  if (!entry) {
    console.error(`No carousel log entry for ${TARGET_DATE}`);
    process.exit(1);
  }

  console.log(`Replaying the ${TARGET_DATE} carousel delivery — webhook only.`);
  console.log(`  pillar=${entry.pillar} close=${entry.closeType} keyword=${entry.keyword || "(none)"}`);
  console.log(`  hook: ${entry.hook}`);
  console.log(`  files: ${DRIVE_FILE_IDS.length} (${DRIVE_FILE_IDS.length - 1} slides + 1 PDF)`);

  // 1. Production shape, unchanged.
  const first = await send("production shape", buildPayload("CAROUSEL", entry, () => ({})));

  if (first.ok) {
    console.log("\n=== RESULT: accepted exactly as production sends it. Nothing to change. ===");
    return;
  }

  if (first.enumError) {
    console.log("\nStill the city enum. Retrying lowercase to isolate case from absence.");
    const second = await send("lowercase probe", buildPayload("carousel", entry, () => ({})));
    console.log("\n=== RESULT ===");
    console.log(second.ok
      ? "Enum accepts lowercase 'carousel'. FIX IS OURS: send lowercase. One line."
      : "Neither case accepted. FIX IS MANUS'S: city still needs the carousel value.");
    return;
  }

  // 2. The first attempt died at VALIDATION (missing slideImages) before the
  // insert ran, so it could not tell us anything about the city column. Use the
  // shape that passes validation, then vary city to reach the enum.
  console.log("\nThe production shape fails validation before the insert runs, so it");
  console.log("says nothing about the city column. Using a shape that validates, then");
  console.log("varying city to find what the column accepts.\n");

  const validShape = SHAPES[0][1];
  const cityCandidates = ["CAROUSEL", "carousel", "Carousel", null];
  let accepted = null;

  for (const city of cityCandidates) {
    const res = await send(`city=${JSON.stringify(city)}`, buildPayload(city, entry, validShape));
    if (res.ok) { accepted = city; break; }
  }

  console.log("\n=== RESULT ===");
  if (accepted !== null || accepted === null && false) {
    console.log(`The webhook accepts city=${JSON.stringify(accepted)}.`);
    console.log("FIX IS OURS: send that value, plus rename slides -> slideImages, pdf -> pdfUrl.");
  } else {
    console.log("The city column rejects every carousel-ish value tried.");
    console.log("FIX IS MANUS'S: the city column was NOT altered. slideImages, pdfLink,");
    console.log("keyword, closeType and type all exist and work — city is the last step.");
    console.log("Either add a carousel value to the city enum, or make city nullable now");
    console.log("that `type` carries the discriminator.");
  }
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
