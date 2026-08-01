#!/usr/bin/env node
/**
 * scan-drive-duplicates.mjs — find content-duplicate videos in a folder.
 *
 * Report only. Deletes nothing, posts nothing, modifies nothing.
 *
 *   node scripts/scan-drive-duplicates.mjs <folder> [<folder>...]
 *
 * Fingerprints every .mp4 and reports pairs within CONTENT_DUP_THRESHOLD —
 * i.e. the pairs that could produce a repeat of the 2026-07-31 incident.
 */
import { readdirSync, statSync, existsSync, writeFileSync, readFileSync } from "fs";
import { join, basename } from "path";
import { execSync } from "child_process";
import { computeContentHash, contentHashDistance, CONTENT_DUP_THRESHOLD } from "../src/content-hash.js";

const folders = process.argv.slice(2).filter((f) => existsSync(f));
if (!folders.length) {
  console.error("usage: node scripts/scan-drive-duplicates.mjs <folder> [...]");
  process.exit(1);
}

const CACHE = "/tmp/drive-dupe-hash-cache.json";
let cache = {};
try { cache = JSON.parse(readFileSync(CACHE, "utf-8")); } catch {}

const dur = (p) => {
  try {
    return parseFloat(execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${p}"`, { encoding: "utf-8", timeout: 30000 }).trim());
  } catch { return 0; }
};

const items = [];
for (const folder of folders) {
  const files = readdirSync(folder).filter((f) => /\.mp4$/i.test(f)).sort();
  console.error(`[scan] ${basename(folder)}: ${files.length} videos`);
  for (const f of files) {
    const full = join(folder, f);
    let size;
    try { size = statSync(full).size; } catch { continue; }
    const key = `${full}:${size}`;
    let hash = cache[key];
    if (hash === undefined) {
      const d = dur(full);
      hash = d > 0 ? await computeContentHash(full, d) : null;
      cache[key] = hash;
      try { writeFileSync(CACHE, JSON.stringify(cache)); } catch {}
    }
    items.push({ folder: basename(folder), name: f, path: full, size, hash });
    if (items.length % 25 === 0) console.error(`[scan]   ...${items.length} hashed`);
  }
}

const usable = items.filter((i) => i.hash);
console.error(`[scan] fingerprinted ${usable.length}/${items.length}\n`);

const pairs = [];
for (let i = 0; i < usable.length; i++) {
  for (let j = i + 1; j < usable.length; j++) {
    const d = contentHashDistance(usable[i].hash, usable[j].hash);
    if (d <= CONTENT_DUP_THRESHOLD) pairs.push({ a: usable[i], b: usable[j], d });
  }
}
pairs.sort((x, y) => x.d - y.d);

console.log(`CONTENT-DUPLICATE PAIRS (distance <= ${CONTENT_DUP_THRESHOLD})`);
console.log(`scanned ${usable.length} videos across ${folders.length} folder(s) — found ${pairs.length} pair(s)\n`);
for (const p of pairs) {
  console.log(`  distance ${p.d.toFixed(2)}`);
  console.log(`    ${p.a.folder}/${p.a.name}  (${(p.a.size / 1048576).toFixed(0)}MB)`);
  console.log(`    ${p.b.folder}/${p.b.name}  (${(p.b.size / 1048576).toFixed(0)}MB)`);
}
if (items.length !== usable.length) {
  console.log(`\n  note: ${items.length - usable.length} file(s) could not be fingerprinted (unreadable/too short)`);
}
