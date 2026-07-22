#!/usr/bin/env node
/**
 * merge-log-push.mjs — JSON-aware merge for posted-log, video-matches, performance-weights.
 *
 * Called by the GitHub Actions commit step AFTER the run completes.
 * Eliminates git merge conflicts by operating in JSON-space:
 *
 * 1. Copies this run's modified files to /tmp (the "local" state)
 * 2. Resets to origin/main (the "remote" state)
 * 3. Merges local data INTO remote data using type-specific logic
 * 4. Commits and pushes. On push rejection, loops back to step 2.
 * 5. Hard exit 1 after MAX_ATTEMPTS — a lost log entry must page the owner.
 *
 * Merge strategies:
 * - posted-log.json: append entries whose timestamp doesn't already exist
 * - video-matches.json: merge keys (local wins on conflict)
 * - performance-weights.json: take whichever has newer lastUpdated per key
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const MAX_ATTEMPTS = 5;
const CITY = process.argv[2] || "unknown";
const POST_SUCCESS = process.argv[3] === "true";
const REPO_DIR = process.cwd(); // Should be auto-poster/

// Files to merge
const FILES = ["posted-log.json", "video-matches.json", "performance-weights.json", "qc-blocklist.json", "linkedin-history.json"];
const TMP_DIR = "/tmp/merge-push-local";

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { cwd: REPO_DIR, encoding: "utf-8", stdio: "pipe", ...opts });
  } catch (e) {
    if (opts.allowFail) return e.stdout || "";
    throw e;
  }
}

function readJSON(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function writeJSON(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

// ─── Merge strategies ────────────────────────────────────────────────────────

function mergePostedLog(local, remote) {
  // Both have a "posts" array. Append local entries not already in remote.
  const remotePosts = remote?.posts || [];
  const localPosts = local?.posts || [];

  // Build a set of existing timestamps for dedup
  const existingTimestamps = new Set(
    remotePosts.map((p) => p.timestamp).filter(Boolean)
  );

  let added = 0;
  for (const entry of localPosts) {
    if (entry.timestamp && !existingTimestamps.has(entry.timestamp)) {
      remotePosts.push(entry);
      existingTimestamps.add(entry.timestamp);
      added++;
    }
  }

  // Also merge any other top-level keys (like "version")
  const merged = { ...remote, ...local, posts: remotePosts };
  console.log(`[Merge] posted-log: ${added} new entries appended (total: ${remotePosts.length})`);
  return merged;
}

function mergeVideoMatches(local, remote) {
  // Object with keys → local wins on conflict (has fresher match data)
  const merged = { ...remote, ...local };
  const localKeys = Object.keys(local || {}).length;
  const remoteKeys = Object.keys(remote || {}).length;
  const mergedKeys = Object.keys(merged).length;
  console.log(`[Merge] video-matches: local=${localKeys}, remote=${remoteKeys}, merged=${mergedKeys}`);
  return merged;
}

function mergePerformanceWeights(local, remote) {
  // Object with keys, each having a lastUpdated field. Take newer per key.
  const merged = { ...(remote || {}) };
  for (const [key, localVal] of Object.entries(local || {})) {
    if (!merged[key]) {
      merged[key] = localVal;
    } else if (localVal && typeof localVal === "object" && localVal.lastUpdated) {
      const remoteUpdated = merged[key]?.lastUpdated || "";
      if (localVal.lastUpdated > remoteUpdated) {
        merged[key] = localVal;
      }
    } else {
      // No lastUpdated — local wins
      merged[key] = localVal;
    }
  }
  console.log(`[Merge] performance-weights: ${Object.keys(merged).length} keys`);
  return merged;
}

function mergeBlocklist(local, remote) {
  // Union of all blocked IDs — once blocked, always blocked
  const merged = { blockedDriveIds: { ...(remote?.blockedDriveIds || {}), ...(local?.blockedDriveIds || {}) } };
  console.log(`[Merge] qc-blocklist: ${Object.keys(merged.blockedDriveIds).length} blocked videos`);
  return merged;
}

function mergeLinkedinHistory(local, remote) {
  // Union of posts by date, keep last 7
  const allPosts = [...(remote?.posts || []), ...(local?.posts || [])];
  // Dedupe by date (keep latest entry per date)
  const byDate = new Map();
  for (const p of allPosts) {
    byDate.set(p.date || p.body?.slice(0, 30), p);
  }
  const merged = { posts: [...byDate.values()].slice(-7) };
  console.log(`[Merge] linkedin-history: ${merged.posts.length} entries`);
  return merged;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[MergePush] Starting for city=${CITY}, post_success=${POST_SUCCESS}`);

  // Step 0: Check if there are any changes to commit
  const status = run("git status --porcelain", { allowFail: true }).trim();
  if (!status) {
    console.log("[MergePush] No changes to commit — nothing to push.");
    process.exit(0);
  }

  // Step 1: Save this run's file state to /tmp
  run(`mkdir -p ${TMP_DIR}`);
  for (const file of FILES) {
    const fullPath = join(REPO_DIR, file);
    if (existsSync(fullPath)) {
      copyFileSync(fullPath, join(TMP_DIR, file));
      console.log(`[MergePush] Saved local ${file} to /tmp`);
    }
  }

  // Step 2-5: Retry loop
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`\n[MergePush] === Attempt ${attempt}/${MAX_ATTEMPTS} ===`);

    try {
      // Reset to origin/main (throw away all local git state)
      run("git fetch origin main", { allowFail: true });
      run("git reset --hard origin/main");
      console.log("[MergePush] Reset to origin/main");

      // Merge each file
      for (const file of FILES) {
        const localPath = join(TMP_DIR, file);
        const remotePath = join(REPO_DIR, file);

        if (!existsSync(localPath)) continue;

        const localData = readJSON(localPath);
        const remoteData = readJSON(remotePath);

        if (!localData) continue;

        let merged;
        if (file === "posted-log.json") {
          merged = mergePostedLog(localData, remoteData || { posts: [] });
        } else if (file === "video-matches.json") {
          merged = mergeVideoMatches(localData, remoteData);
        } else if (file === "performance-weights.json") {
          merged = mergePerformanceWeights(localData, remoteData);
        } else if (file === "qc-blocklist.json") {
          merged = mergeBlocklist(localData, remoteData);
        } else if (file === "linkedin-history.json") {
          merged = mergeLinkedinHistory(localData, remoteData || { posts: [] });
        } else {
          merged = localData; // Fallback: local wins
        }

        writeJSON(remotePath, merged);
      }

      // Stage and commit
      run("git add posted-log.json video-matches.json performance-weights.json qc-blocklist.json linkedin-history.json 2>/dev/null || true", { allowFail: true });

      const diffResult = run("git diff --cached --quiet || echo changed", { allowFail: true }).trim();
      if (!diffResult.includes("changed")) {
        console.log("[MergePush] No diff after merge — files already in sync.");
        process.exit(0);
      }

      const commitMsg = POST_SUCCESS
        ? `📸 ${CITY.toUpperCase()} post ${new Date().toISOString().slice(0, 10)}`
        : `🔍 ${CITY.toUpperCase()} run ${new Date().toISOString().slice(0, 10)} — no post (see logs)`;

      run(`git commit -m "${commitMsg}"`);
      console.log(`[MergePush] Committed: ${commitMsg}`);

      // Push
      const pushResult = run("git push origin main 2>&1", { allowFail: true });
      if (pushResult.includes("rejected") || pushResult.includes("error:") || pushResult.includes("failed")) {
        console.log(`[MergePush] Push rejected on attempt ${attempt} — will retry with fresh merge`);
        if (attempt < MAX_ATTEMPTS) {
          const backoff = attempt * 3;
          console.log(`[MergePush] Waiting ${backoff}s before retry...`);
          await new Promise((r) => setTimeout(r, backoff * 1000));
          continue;
        }
      } else {
        console.log(`[MergePush] ✓ Push succeeded on attempt ${attempt}`);
        process.exit(0);
      }
    } catch (err) {
      console.error(`[MergePush] Error on attempt ${attempt}: ${err.message}`);
      if (attempt < MAX_ATTEMPTS) {
        const backoff = attempt * 3;
        console.log(`[MergePush] Waiting ${backoff}s before retry...`);
        await new Promise((r) => setTimeout(r, backoff * 1000));
        continue;
      }
    }
  }

  // All attempts failed
  console.error("::error::🚨 CRITICAL: All push attempts failed. Log entry is LOST. Double-post risk!");
  process.exit(1);
}

main();
