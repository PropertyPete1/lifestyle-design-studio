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
import { MERGE_STRATEGIES, MERGE_FILES } from "./merge-strategies.mjs";

const MAX_ATTEMPTS = 5;
const CITY = process.argv[2] || "unknown";
const POST_SUCCESS = process.argv[3] === "true";
const REPO_DIR = process.cwd(); // Should be auto-poster/

// Files to merge
const FILES = MERGE_FILES;
const TMP_DIR = "/tmp/merge-push-local";

/**
 * Run a command, returning BOTH the exit status and the combined output.
 *
 * Never infer success from stdout contents — `git push` reports most failures on
 * stderr with wording that varies by failure class (e.g. "Could not resolve host"
 * contains none of "rejected"/"error:"/"failed"). Exit status is the only
 * trustworthy signal.
 */
function runStatus(cmd, opts = {}) {
  try {
    const stdout = execSync(cmd, {
      cwd: REPO_DIR,
      encoding: "utf-8",
      stdio: "pipe",
      ...opts,
    });
    return { ok: true, code: 0, output: stdout || "" };
  } catch (e) {
    const output = `${e.stdout || ""}${e.stderr || ""}`;
    return { ok: false, code: e.status ?? 1, output };
  }
}

function run(cmd, opts = {}) {
  const r = runStatus(cmd, opts);
  if (!r.ok && !opts.allowFail) {
    const err = new Error(`Command failed (exit ${r.code}): ${cmd}\n${r.output}`);
    err.status = r.code;
    throw err;
  }
  return r.output;
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

        const strategy = MERGE_STRATEGIES[file];
        const merged = strategy ? strategy(localData, remoteData, console.log) : localData;

        writeJSON(remotePath, merged);
      }

      // Stage only the files that actually exist. `git add` with a pathspec that
      // matches nothing fails for the WHOLE invocation, which previously staged
      // nothing at all and made the run look like a clean no-op.
      const filesToAdd = FILES.filter((f) => existsSync(join(REPO_DIR, f)));
      if (filesToAdd.length === 0) {
        throw new Error("No merge-managed files exist on disk — refusing to continue");
      }
      run(`git add ${filesToAdd.map((f) => `"${f}"`).join(" ")}`);

      const staged = runStatus("git diff --cached --quiet");
      // exit 0 => no staged changes; exit 1 => staged changes present
      if (staged.ok) {
        console.log("[MergePush] No diff after merge — files already in sync.");
        process.exit(0);
      }

      const commitMsg = POST_SUCCESS
        ? `📸 ${CITY.toUpperCase()} post ${new Date().toISOString().slice(0, 10)}`
        : `🔍 ${CITY.toUpperCase()} run ${new Date().toISOString().slice(0, 10)} — no post (see logs)`;

      run(`git commit -m "${commitMsg}"`);
      console.log(`[MergePush] Committed: ${commitMsg}`);

      // Push — success is determined by EXIT STATUS, never by grepping output.
      //
      // `HEAD:main`, not `main`: a workflow_dispatch on a branch checks out only
      // that branch, so there is no local `main` ref and `git push origin main`
      // dies on "src refspec main does not match any" — five times, then
      // "log entry is LOST. Double-post risk!". A real trial variant was
      // generated, delivered and then forgotten exactly this way.
      //
      // Pushing HEAD is still safe from a branch: the reset above put this
      // commit directly on top of origin/main with only merge-managed JSON
      // changed, so no branch code can ride along.
      const push = runStatus("git push origin HEAD:main");
      if (push.ok) {
        // Verify the remote actually advanced to our commit before declaring victory.
        const localSha = run("git rev-parse HEAD").trim();
        const remoteSha = runStatus("git ls-remote origin refs/heads/main").output.split(/\s+/)[0] || "";
        if (remoteSha && remoteSha !== localSha) {
          console.log(`[MergePush] Push reported success but remote is at ${remoteSha.slice(0, 8)}, expected ${localSha.slice(0, 8)} — retrying`);
        } else {
          console.log(`[MergePush] ✓ Push succeeded on attempt ${attempt} (remote at ${localSha.slice(0, 8)})`);
          process.exit(0);
        }
      } else {
        console.log(`[MergePush] Push FAILED on attempt ${attempt} (exit ${push.code}): ${push.output.trim().slice(0, 300)}`);
      }
      if (attempt < MAX_ATTEMPTS) {
        const backoff = attempt * 3;
        console.log(`[MergePush] Waiting ${backoff}s before retry...`);
        await new Promise((r) => setTimeout(r, backoff * 1000));
        continue;
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
