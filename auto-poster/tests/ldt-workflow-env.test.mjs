/**
 * ldt-post.yml env guard — same doctrine as workflow-env.test.mjs: a missing
 * env key in a workflow file is a silent runtime failure two weeks later, so
 * the required keys are pinned here as text assertions (no YAML parser, by
 * the same reasoning documented in workflow-env.test.mjs).
 *
 * The cron-count pin is this file's one novel guard: the workflow fires the
 * lane, the lane's cadence guard enforces the per-day budget — but a workflow
 * with six crons and a cadence of two would burn four Actions runs a day on
 * green no-ops. Two crons = the default 2/day cadence; changing the cadence
 * legitimately means changing both, together, in one PR.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const WORKFLOWS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".github", "workflows");
const ldtYml = readFileSync(join(WORKFLOWS_DIR, "ldt-post.yml"), "utf-8");

// The text of the "Run LDT brand lane" step only — env keys must live on the
// step that runs the code, not merely appear somewhere in the file.
function runStepBlock() {
  const start = ldtYml.indexOf("- name: Run LDT brand lane");
  assert.notEqual(start, -1, "the run step exists");
  const rest = ldtYml.slice(start + 1);
  const next = rest.indexOf("- name:");
  return rest.slice(0, next === -1 ? undefined : next);
}

const REQUIRED_ENV = [
  "GITHUB_TOKEN",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN",
  "METRICOOL_API_TOKEN",
  "METRICOOL_BLOG_ID",
  "METRICOOL_USER_ID",
  "ANTHROPIC_API_KEY",
  "LDT_INTAKE_FOLDER_ID",
];

describe("ldt-post.yml", () => {
  test("teeth: the job this guard covers actually exists", () => {
    // A guard that matched nothing would pass forever.
    assert.ok(ldtYml.includes("post-ldt:"), "job post-ldt is present");
    assert.ok(ldtYml.includes("node src/ldt-main.js"), "runs the LDT entrypoint");
  });

  for (const key of REQUIRED_ENV) {
    test(`env key ${key} is wired on the run step itself`, () => {
      // Scoped to the run step: a key moved to another step's env (or lost
      // entirely) fails here even though it still appears in the file.
      assert.ok(new RegExp(`^\\s+${key}: \\$\\{\\{`, "m").test(runStepBlock()), `${key} missing from the Run LDT brand lane step env`);
    });
  }

  test("exactly two LIVE schedule crons — matching the 2/day default cadence", () => {
    // Count only uncommented cron lines, so a commented-out example can
    // never stand in for a deleted live schedule.
    const crons = ldtYml.split("\n").filter(l => /^\s*- cron:/.test(l) && !/^\s*#/.test(l));
    assert.equal(crons.length, 2, "cadence and cron count must change together");
  });

  test("has its own concurrency group, never queued behind a realty job", () => {
    assert.ok(/group: autopost-ldt/.test(ldtYml));
    assert.ok(/cancel-in-progress: false/.test(ldtYml));
  });

  test("commits state through merge-log-push like every other posting job", () => {
    assert.ok(/merge-log-push\.mjs LDT/.test(ldtYml));
  });

  test("the LDT brief path is what the learn workflow commits", async () => {
    // The brief is committed by the learning-loop workflow's own push loop
    // (not merge-log-push), so what matters is that the variation engine
    // reads the exact file the learn step writes: briefPath is the single
    // seam both sides share, per brand.
    const { briefPath } = await import("../src/variation.js");
    const { basename } = await import("node:path");
    assert.equal(basename(briefPath("ldt")), "brief-ldt.json");
  });
});
