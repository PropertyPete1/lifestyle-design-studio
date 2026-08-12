#!/usr/bin/env node
/**
 * collect-social-analytics.mjs — the daily pull of real performance data.
 *
 * Fetches per-post and per-platform analytics from Metricool, writes
 * status/social_analytics.json at the repo root, and commits it to main.
 *
 * READ-ONLY AGAINST METRICOOL. Every call is a GET against analytics endpoints.
 *
 * The commit half is deliberately the same shape as merge-log-push.mjs, for the
 * same reasons, and the ordering inside the retry loop is load-bearing in the
 * same way:
 *
 *   1. reset --hard origin/main   throw away local state
 *   2. WRITE the file             so the merge reads the file that is actually
 *                                 on main right now, not one a losing attempt
 *                                 left behind — the reset would have reverted
 *                                 anything written before this point anyway
 *   3. commit, push HEAD:main     exit status is the only success signal
 *   4. on rejection, loop         a sibling job won the race; re-merge onto it
 *
 * Pushing HEAD:main rather than main is not a style choice: a scheduled or
 * dispatched run checks out one branch and has no local `main` ref, so
 * `git push origin main` dies on "src refspec main does not match any". The
 * reset above puts this commit directly on top of origin/main with only
 * status/social_analytics.json changed, so nothing else can ride along.
 *
 * EXIT CODES
 *   0  file written and pushed, or nothing changed, or the API was down
 *   1  we had data and could not get it onto main after MAX_ATTEMPTS
 *
 * An API that is down is NOT a failed run. The collector leaves the previous
 * reading in place and says so; the dashboard then shows a stale generated_at,
 * which is true, rather than an empty file, which is not.
 *
 * DRY_RUN=true collects against the live API and prints what it would write,
 * touching neither git nor the working tree. That is how this was verified
 * against real accounts before it was ever allowed to commit — fixtures prove
 * the mapping, only the live API proves the mapping is of the right thing.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSocialAnalytics, ANALYTICS_FILENAME } from "../src/social-analytics.js";
import { STATUS_DIRNAME } from "../src/social-telemetry.js";

const MAX_ATTEMPTS = 5;
const REPO_DIR = process.cwd(); // auto-poster/
const DRY_RUN = process.env.DRY_RUN === "true";

function runStatus(cmd, opts = {}) {
  try {
    const stdout = execSync(cmd, { cwd: REPO_DIR, encoding: "utf-8", stdio: "pipe", ...opts });
    return { ok: true, code: 0, output: stdout || "" };
  } catch (e) {
    return { ok: false, code: e.status ?? 1, output: `${e.stdout || ""}${e.stderr || ""}` };
  }
}

function run(cmd, opts = {}) {
  const r = runStatus(cmd, opts);
  if (!r.ok && !opts.allowFail) {
    throw new Error(`Command failed (exit ${r.code}): ${cmd}\n${r.output}`);
  }
  return r.output;
}

function summarise(doc) {
  const lines = [];
  for (const [platform, block] of Object.entries(doc.platforms || {})) {
    if (block.unavailable) {
      lines.push(`${platform}: unavailable (${block.unavailable})`);
      continue;
    }
    const latest = block.daily?.[0];
    lines.push(
      `${platform}: ${block.posts_recorded} post(s) on file across ${block.accounts.length} account(s)` +
      (latest ? `, latest day ${latest.date} — ${latest.posts} post(s)${latest.views !== undefined ? `, ${latest.views} views` : ""}` : "") +
      (block.partial ? " [PARTIAL]" : "")
    );
  }
  return lines;
}

async function main() {
  console.log("[Analytics] Starting daily social analytics collection");

  const repoRoot = run("git rev-parse --show-toplevel").trim();
  const relPath = join(STATUS_DIRNAME, ANALYTICS_FILENAME);

  // Collect against the live API and report, touching nothing. No reset, no
  // write to the tracked path, no commit — so this is safe to run from any
  // branch at any time, including while a real posting job is mid-flight.
  if (DRY_RUN) {
    console.log("[Analytics] DRY RUN — collecting from the live API, writing nothing\n");
    const scratch = mkdtempSync(join(tmpdir(), "analytics-dry-"));
    mkdirSync(join(scratch, STATUS_DIRNAME), { recursive: true });

    const result = await writeSocialAnalytics({ repoRoot: scratch });
    if (!result.ok) {
      console.log(`[Analytics] would NOT write: ${result.error}`);
      for (const f of result.failures || []) {
        console.log(`[Analytics]     ${f.platform}/${f.account} ${f.endpoint}: ${f.reason}`);
      }
      process.exit(0);
    }

    console.log(`[Analytics] would write ${relPath} — ${result.collected} post(s) collected`);
    for (const line of summarise(result.doc)) console.log(`[Analytics]   ${line}`);
    for (const s of result.sources) {
      console.log(`[Analytics]   ${s.ok ? "ok  " : "FAIL"} ${s.platform}/${s.account} ${s.endpoint} — ${s.ok ? `${s.rows} row(s), ${s.collected} collected` : s.reason}`);
    }

    // The first few rows in full, so a human can check the mapping against what
    // the platforms actually show rather than trusting the summary.
    console.log("\n[Analytics] sample of what would be written:");
    console.log(JSON.stringify(
      { ...result.doc, recent_posts: result.doc.recent_posts.slice(0, 3) },
      null, 2
    ));
    process.exit(0);
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`\n[Analytics] === Attempt ${attempt}/${MAX_ATTEMPTS} ===`);

    try {
      run("git fetch origin main", { allowFail: true });
      run("git reset --hard origin/main");
      console.log("[Analytics] Reset to origin/main");

      // Written AFTER the reset so the merge reads what is on main right now.
      const result = await writeSocialAnalytics({ repoRoot });

      if (!result.ok) {
        // Not a failure of this job — a failure of the API, already reported
        // honestly by leaving the previous file alone.
        console.log(`[Analytics] ⚠️  not written: ${result.error}`);
        for (const f of result.failures || []) {
          console.log(`[Analytics]     ${f.platform}/${f.account} ${f.endpoint}: ${f.reason}`);
        }
        console.log("[Analytics] Previous reading left in place. Nothing to commit.");
        process.exit(0);
      }

      console.log(`[Analytics] Collected ${result.collected} post(s) this run; ${result.total} in the merged file`);
      for (const line of summarise(result.doc)) console.log(`[Analytics]   ${line}`);
      for (const s of result.sources.filter((x) => !x.ok)) {
        console.log(`[Analytics]   source down — ${s.platform}/${s.account} ${s.endpoint}: ${s.reason}`);
      }

      const abs = join(repoRoot, relPath);
      if (!existsSync(abs)) throw new Error(`writer reported success but ${relPath} is not on disk`);

      run(`git add "${abs}"`);

      const staged = runStatus("git diff --cached --quiet");
      if (staged.ok) {
        console.log("[Analytics] No diff — the numbers have not moved since the last run.");
        process.exit(0);
      }

      run(`git commit -m "📊 social analytics ${new Date().toISOString().slice(0, 10)}"`);

      const push = runStatus("git push origin HEAD:main");
      if (push.ok) {
        const localSha = run("git rev-parse HEAD").trim();
        const remoteSha = runStatus("git ls-remote origin refs/heads/main").output.split(/\s+/)[0] || "";
        if (remoteSha && remoteSha !== localSha) {
          console.log(`[Analytics] Push reported success but remote is at ${remoteSha.slice(0, 8)} — retrying`);
        } else {
          console.log(`[Analytics] ✓ Pushed on attempt ${attempt} (remote at ${localSha.slice(0, 8)})`);
          process.exit(0);
        }
      } else {
        console.log(`[Analytics] Push FAILED on attempt ${attempt} (exit ${push.code}): ${push.output.trim().slice(0, 300)}`);
      }
    } catch (err) {
      console.error(`[Analytics] Error on attempt ${attempt}: ${err.message}`);
    }

    if (attempt < MAX_ATTEMPTS) {
      const backoff = attempt * 3;
      console.log(`[Analytics] Waiting ${backoff}s before retry...`);
      await new Promise((r) => setTimeout(r, backoff * 1000));
    }
  }

  console.error("::error::Social analytics could not be pushed after every attempt.");
  process.exit(1);
}

main();
