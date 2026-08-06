#!/usr/bin/env node
/**
 * backfill-content-hashes.mjs — populate content_hash on historical posted-log entries.
 *
 * WHY: the content-dedupe guard (PR #6) only compares against entries that
 * already carry a content_hash. Every entry written before that PR has none, so
 * on the day it shipped the guard started with zero history and could not catch
 * a repost of anything posted earlier. That gap is what let a San Antonio video
 * from 2026-07-28/29 be reposted on 2026-07-31.
 *
 * Backfilling closes the window immediately — it is a data fix, not a code fix.
 *
 *   # production: resolve videos through the Drive API
 *   node scripts/backfill-content-hashes.mjs
 *
 *   # offline: resolve videos from a locally synced Drive folder (matched by fileName)
 *   node scripts/backfill-content-hashes.mjs --local-root "/path/to/My Drive"
 *
 *   --days N     how far back to backfill (default 35)
 *   --dry-run    compute and report, write nothing
 *
 * Entries whose video no longer exists are marked `content_hash_status:"missing"`
 * so they are skipped permanently instead of retried on every run.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, unlinkSync } from "fs";
import { join, extname } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";
import { computeContentHash } from "../../src/content-hash.js";
import { requireLiveAck } from "../live-guard.mjs";

// TOUCHES LIVE: rewrites posted-log.json in place — the committed record the
// duplicate guards read on every run. Pass --dry-run to compute and report
// without writing.
requireLiveAck(
  "Rewrites posted-log.json in place — the committed post history the dedupe guards depend on. " +
    "Use --dry-run to compute without writing."
);

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d; };
const DRY = args.includes("--dry-run");
const DAYS = Number(flag("days", "35"));
const LOCAL_ROOT = flag("local-root", null);
const LOG_PATH = new URL("../../posted-log.json", import.meta.url).pathname;

// ─── Video resolution ────────────────────────────────────────────────────────

/** Recursively index fileName -> path under a synced Drive root. */
function buildLocalIndex(root) {
  const idx = new Map();
  const walk = (dir, depth = 0) => {
    if (depth > 6) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (/\.(mp4|mov|m4v)$/i.test(e.name) && !idx.has(e.name)) idx.set(e.name, full);
    }
  };
  walk(root);
  return idx;
}

const localIndex = LOCAL_ROOT ? buildLocalIndex(LOCAL_ROOT) : null;
if (localIndex) console.log(`[Backfill] Local index: ${localIndex.size} video files under ${LOCAL_ROOT}`);

const durationOf = (p) => {
  try {
    return parseFloat(execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${p}"`, { encoding: "utf-8", timeout: 60000 }).trim()) || 0;
  } catch { return 0; }
};

/**
 * Make the entry's video available on local disk.
 * Returns { path, temp }, or `null` when the video is genuinely gone, or
 * `"unsupported"` when THIS resolver cannot address the entry at all.
 *
 * The distinction matters: local mode matches on fileName, so entries without
 * one (e.g. instagram_main_native manual-confirm receipts) are unaddressable
 * here even though the Drive API could fetch them by driveFileId. Marking those
 * permanently "missing" would exclude them from a later credentialed run.
 */
async function resolveVideo(entry) {
  if (localIndex) {
    if (!entry.fileName) return "unsupported";
    const hit = localIndex.get(entry.fileName);
    return hit && existsSync(hit) ? { path: hit, temp: false } : null;
  }
  // Production path — pull it through the Drive API.
  const { downloadVideo } = await import("../../src/drive.js");
  const tmp = join(tmpdir(), `backfill_${entry.driveFileId}${extname(entry.fileName || ".mp4")}`);
  try {
    const buf = await downloadVideo(entry.driveFileId, entry.fileName);
    writeFileSync(tmp, buf);
    return { path: tmp, temp: true };
  } catch {
    return null;
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

const log = JSON.parse(readFileSync(LOG_PATH, "utf-8"));
const cutoff = Date.now() - DAYS * 86400_000;

const todo = log.posts.filter((p) => {
  if (!p || p.content_hash || p.content_hash_status === "missing") return false;
  if (!p.driveFileId) return false;
  const ts = new Date(p.timestamp).getTime();
  return Number.isFinite(ts) && ts > cutoff;
});

console.log(`[Backfill] ${todo.length} entries in the last ${DAYS} days need a content_hash (of ${log.posts.length} total)\n`);

let hashed = 0, missing = 0, unsupported = 0;
for (const entry of todo) {
  const label = `${entry.timestamp?.slice(0, 10)} ${String(entry.city || "?").padEnd(12)} ${entry.fileName || "(no fileName)"}`;
  const res = await resolveVideo(entry);
  if (res === "unsupported") {
    // Not marked — a credentialed run can still pick this up by driveFileId.
    console.log(`  skip     ${label} — no fileName, needs Drive API mode`);
    unsupported++;
    continue;
  }
  if (!res) {
    console.log(`  MISSING  ${label}`);
    entry.content_hash_status = "missing";
    missing++;
    continue;
  }
  const dur = durationOf(res.path);
  const hash = dur > 0 ? await computeContentHash(res.path, dur) : null;
  if (res.temp) { try { unlinkSync(res.path); } catch {} }

  if (!hash) {
    console.log(`  FAILED   ${label} (unreadable)`);
    entry.content_hash_status = "missing";
    missing++;
    continue;
  }
  entry.content_hash = hash;
  entry.content_hash_backfilled = true;
  hashed++;
  console.log(`  ok       ${label}`);
}

console.log(`\n[Backfill] hashed ${hashed}, missing ${missing}, skipped-unsupported ${unsupported}`);

if (DRY) {
  console.log("[Backfill] --dry-run: posted-log.json NOT written");
} else if (hashed || missing) {
  writeFileSync(LOG_PATH, JSON.stringify(log, null, 2) + "\n");
  console.log("[Backfill] posted-log.json updated");
}
