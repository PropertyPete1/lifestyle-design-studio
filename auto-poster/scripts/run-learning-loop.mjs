#!/usr/bin/env node
/**
 * run-learning-loop.mjs — the weekly learn step.
 *
 * Reads posted-log.json (what was posted, with the variation engine's decision
 * tags) and status/social_analytics.json (what the posts actually did — the
 * nightly collector's output, absent-not-zero), then per brand:
 *
 *   1. builds the "what's working" brief   → src/learn.js buildBrief()
 *   2. writes learning/brief-<brand>.json  → read by src/variation.js at
 *                                            generation time (70% exploit /
 *                                            30% explore, kill list enforced)
 *   3. commits the brief to main           → same reset-retry loop the
 *                                            analytics collector uses
 *   4. emails the one-page brief to Peter  → [WEEKLY BRIEF] via the repo's
 *                                            own Gmail path
 *
 * FAILURE POLICY. The brief COMMIT failing exits 1 — an unwritten brief means
 * generation keeps steering on stale data and someone should know. The EMAIL
 * failing does not fail the run: the brief is on main either way, and the
 * degradation is announced through the annotation channel that needs no token.
 *
 * READ-ONLY AGAINST EVERYTHING EXTERNAL. No Metricool call, no post, no
 * upload. Its inputs are two files already committed to the repo.
 *
 * PER-BRAND BY CONSTRUCTION: BRANDS lists every brand that learns; each gets
 * its own brief file, so a future brand (the LDT accounts) learns from its own
 * posts and never inherits this brand's winners.
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBrief, renderBriefEmail } from "../src/learn.js";
import { briefPath, LEARNING_DIR, DEFAULT_BRAND } from "../src/variation.js";
import { loadLog } from "../src/state.js";
import { sendOwnerEmail, MAIL_PREFIX } from "../src/delivery.js";
import { getAccessToken } from "../src/drive.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = join(__dirname, "..");
const MAX_ATTEMPTS = 5;
const DRY_RUN = process.env.DRY_RUN === "true";

/**
 * Every brand that learns. Each entry names the brand's brief and, for
 * brands beyond the first, will name its own log/analytics scope. Today there
 * is one: the whole pipeline posts one brand's content.
 */
const BRANDS = [DEFAULT_BRAND];

function run(cmd, opts = {}) {
  return execSync(cmd, { cwd: REPO_DIR, encoding: "utf-8", stdio: "pipe", ...opts });
}

function runStatus(cmd, opts = {}) {
  try {
    return { ok: true, code: 0, output: run(cmd, opts) || "" };
  } catch (e) {
    return { ok: false, code: e.status ?? 1, output: `${e.stdout || ""}${e.stderr || ""}` };
  }
}

function loadAnalytics() {
  const repoRoot = run("git rev-parse --show-toplevel").trim();
  const path = join(repoRoot, "status", "social_analytics.json");
  if (!existsSync(path)) {
    throw new Error(`status/social_analytics.json not found at ${path} — has the Social Analytics workflow ever run?`);
  }
  return JSON.parse(readFileSync(path, "utf-8"));
}

async function main() {
  const log = loadLog();
  const analytics = loadAnalytics();

  mkdirSync(LEARNING_DIR, { recursive: true });

  const briefs = [];
  for (const brand of BRANDS) {
    const brief = buildBrief({ brand, log, analytics });
    const path = briefPath(brand);
    writeFileSync(path, JSON.stringify(brief, null, 2) + "\n");
    briefs.push({ brand, brief, path });
    console.log(
      `[Learn] ${brand}: ${brief.sample.posts_scored} posts scored, ` +
      `${brief.kill_list.length} kill-list entries, ` +
      `top style: ${Object.entries(brief.hook_styles).find(([, r]) => r.verdict === "winner")?.[0] || "(none ranked)"}`
    );
  }

  if (DRY_RUN) {
    console.log("[Learn] DRY RUN — briefs written locally, no commit, no email.");
    for (const { brief } of briefs) {
      console.log("\n" + renderBriefEmail(brief));
    }
    return;
  }

  // ── Commit the briefs, reset-retry style (see collect-social-analytics) ────
  // The brief files are copied out, the tree is reset to origin/main, and the
  // copies land on top — so a posting run's concurrent push never conflicts.
  const copies = briefs.map(({ path }) => ({ path, content: readFileSync(path, "utf-8") }));

  let committed = false;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS && !committed; attempt++) {
    try {
      run("git fetch origin main");
      run("git reset --hard origin/main");
      mkdirSync(LEARNING_DIR, { recursive: true });
      for (const { path, content } of copies) writeFileSync(path, content);
      for (const { path } of copies) run(`git add "${path}"`);

      const staged = runStatus("git diff --cached --quiet");
      if (staged.ok) {
        console.log("[Learn] No diff — the brief is unchanged since the last run.");
        committed = true;
        break;
      }

      run(`git commit -m "🧠 weekly learning brief ${new Date().toISOString().slice(0, 10)}"`);
      const push = runStatus("git push origin HEAD:main");
      if (push.ok) {
        console.log(`[Learn] ✓ Brief committed and pushed (attempt ${attempt})`);
        committed = true;
      } else {
        console.log(`[Learn] Push failed on attempt ${attempt}: ${push.output.trim().slice(0, 200)}`);
      }
    } catch (err) {
      console.error(`[Learn] Commit attempt ${attempt} errored: ${err.message}`);
    }
    if (!committed && attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, attempt * 3000));
    }
  }

  if (!committed) {
    console.log("::error title=Learning brief NOT committed::The weekly brief could not be pushed to main — generation will keep using the previous brief.");
    process.exit(1);
  }

  // ── Email the brief. Non-fatal: the brief is already on main. ─────────────
  for (const { brand, brief } of briefs) {
    try {
      const token = await getAccessToken();
      if (!token) throw new Error("no Google access token available");
      const sent = await sendOwnerEmail(token, {
        subject: `What's working — ${brand} — ${brief.generated_at.slice(0, 10)}`,
        body: renderBriefEmail(brief),
        prefix: MAIL_PREFIX.BRIEF,
      });
      if (sent?.ok) {
        console.log(`[Learn] ✓ Brief for "${brand}" emailed`);
      } else {
        throw new Error(sent?.lastError?.message || "unknown send failure");
      }
    } catch (err) {
      console.log(
        `::error title=Weekly brief email failed::The ${brand} brief is committed to main but could not be emailed (${err.message}). ` +
        `Read it at auto-poster/learning/brief-${brand}.json.`
      );
    }
  }
}

main().catch((err) => {
  console.error("[Learn] Fatal:", err);
  console.log(`::error title=Learning loop FAILED::${String(err.message || err).slice(0, 300)}`);
  process.exit(1);
});
