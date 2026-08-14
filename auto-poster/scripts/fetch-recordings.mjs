#!/usr/bin/env node
/**
 * fetch-recordings.mjs — pull one request's recordings out of Drive.
 *
 * Only used by the dry-run gate, so the gate can work from the same clips the
 * real build would: same folder, same files, same Drive listing code. Reading
 * them from anywhere else would test a path production does not take.
 *
 * Also pulls a slice of the B-roll library, because the render needs real
 * footage to be a real test — synthetic clips encode nothing like 4K portrait
 * drone video, which is 71% of the render time.
 */

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { findRecordingsFolder, listRecordings } from "../src/yt-ingest.js";
import { getAccessToken, listCityVideos, downloadVideo } from "../src/drive.js";
import { routeWarnChannel } from "../src/yt-evidence.js";
// The Actions log drops the warn channel entirely (proven on two preserved
// runs) — route it to stdout at every entrypoint. See yt-evidence.js.
routeWarnChannel();

const requestId = process.argv[2];
const dest = process.argv[3] || "/tmp/dryrun-recordings";
const brollDest = process.argv[4] || "/tmp/dryrun-broll";
const brollCount = Number(process.env.DRYRUN_BROLL_COUNT || 6);
const market = process.env.DRYRUN_MARKET || "san_antonio";

if (!requestId) {
  console.error('Usage: fetch-recordings.mjs <requestId> [recordingsDir] [brollDir]');
  process.exit(1);
}

async function main() {
  const token = await getAccessToken();

  mkdirSync(dest, { recursive: true });
  const folderId = await findRecordingsFolder(requestId, token);
  if (!folderId) {
    console.error(`No recordings folder for ${requestId}. Peter has not uploaded anything yet.`);
    process.exit(2);
  }

  const files = await listRecordings(folderId, token);
  if (files.length === 0) {
    console.error(`The folder for ${requestId} is empty. Nothing to dry-run against.`);
    process.exit(2);
  }

  for (const f of files) {
    const path = join(dest, f.name.replace(/[^\w.-]/g, "_"));
    writeFileSync(path, await downloadVideo(f.id, f.name));
    console.log(`  ${f.name}`);
  }
  console.log(`${files.length} recording(s) -> ${dest}`);

  mkdirSync(brollDest, { recursive: true });
  const videos = (await listCityVideos(market)).slice(0, brollCount);
  for (const v of videos) {
    writeFileSync(join(brollDest, v.name.replace(/[^\w.-]/g, "_")), await downloadVideo(v.id, v.name));
  }
  console.log(`${videos.length} B-roll clip(s) -> ${brollDest}`);
}

main().catch((err) => {
  console.error(`fetch-recordings failed: ${err?.stack || err}`);
  process.exit(1);
});
