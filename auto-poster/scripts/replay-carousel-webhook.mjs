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
 * Sends exactly what production sends — one request, no variants. Earlier runs
 * needed a ladder to find the contract; that is settled now, so anything other
 * than the production payload would be testing something we do not ship.
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { buildSocialCaption } from "../src/carousel-content.js";
import { requireLiveAck } from "./live-guard.mjs";
import { routeWarnChannel } from "../src/yt-evidence.js";
// The Actions log drops the warn channel entirely (proven on two preserved
// runs) — route it to stdout at every entrypoint. See yt-evidence.js.
routeWarnChannel();

// TOUCHES LIVE: sends a real delivery webhook to the live dashboard, which
// creates a delivery record and notifies the owner. Publishes nothing to any
// social account and uploads nothing to Drive.
requireLiveAck(
  "Sends a real carousel delivery webhook to the live dashboard, creating a delivery record " +
    "and notifying the owner. Publishes nothing to social."
);

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
function buildPayload(cityValue, entry) {
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

  const postingInstructions = [
    `Carousel: ${uploaded.length} files in Ready to Post. Post the slides in order.`,
    entry.keyword ? `Comment keyword: ${entry.keyword}` : `Close type: ${entry.closeType} (no comment keyword)`,
    `Add trending audio natively when you post.`,
  ].join("\n");

  return {
    city: cityValue,
    caption,
    instructions: postingInstructions,
    driveFileId: primary.fileId,
    driveFileName: primary.fileName,
    driveLink: primary.webViewLink,
    directDownloadLink: primary.directLink,
    deliveredAt: new Date().toISOString(),
    type: "carousel",
    slideImages: uploaded.slice(0, -1).map((u) => u.webViewLink),
    slideThumbnails: uploaded.slice(0, -1).map((u) => `https://drive.google.com/thumbnail?id=${u.fileId}&sz=w800`),
    slideFileIds: uploaded.slice(0, -1).map((u) => u.fileId),
    pdfLink: uploaded[uploaded.length - 1].webViewLink,
    keyword: entry.keyword || null,
    closeType: entry.closeType,
  };
}



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

  const payload = buildPayload("carousel", entry);
  console.log(`  slideImages: ${payload.slideImages.length} urls`);
  console.log(`  pdfLink: ${payload.pdfLink.slice(0, 60)}...`);
  console.log(`\n  CAPTION SENT (must be paste-ready, no URLs or instructions):`);
  console.log(payload.caption.split("\n").map((l) => `    | ${l}`).join("\n"));
  const dirty = /https?:\/\/|Ready to Post|trending audio|^\s*\d+\.\s/m.test(payload.caption);
  console.log(`  caption clean: ${dirty ? "NO — still polluted" : "YES"}`);

  const first = await send("production payload", payload);

  if (!first.ok) {
    console.log("\n=== RESULT ===\nStill rejected. See CAUSE above.");
    process.exitCode = 1;
    return;
  }

  // Send it again. The unique key is (type, city, date), so a second identical
  // delivery must UPDATE the same row, not insert a second one. If the ids
  // differ the key is not doing its job and every re-run would duplicate.
  const second = await send("same delivery again (idempotency)", payload);

  const idOf = (r) => { try { return JSON.parse(r.body)?.deliveryId ?? null; } catch { return null; } };
  const id1 = idOf(first);
  const id2 = idOf(second);

  console.log("\n=== RESULT ===");
  console.log(`first  deliveryId: ${id1}`);
  console.log(`second deliveryId: ${id2}`);

  if (!second.ok) {
    console.log("The repeat was rejected — the row exists but re-runs will fail.");
    process.exitCode = 1;
  } else if (id1 !== null && id1 === id2) {
    console.log("UPSERT CONFIRMED — same row updated. The (type, city, date) key works.");
  } else {
    console.log("::warning::the repeat created a DIFFERENT row — the unique key is not");
    console.log("catching carousels, so every re-run will duplicate the delivery.");
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
