/**
 * ldt-post.yml env guard — same doctrine as workflow-env.test.mjs: a missing
 * env key in a workflow file is a silent runtime failure two weeks later, so
 * the required keys are pinned here as text assertions (no YAML parser, by
 * the same reasoning documented in workflow-env.test.mjs).
 *
 * The schedule guards are this file's novel ones: the workflow fires the
 * lane, the lane's cadence guard enforces the per-day budget — but a workflow
 * with six crons and a cadence of two would burn four Actions runs a day on
 * green no-ops, and a cadence of three with two crons leaves the third post
 * unreachable. So the cron count is derived from brands.json rather than
 * hardcoded: changing one without the other fails here.
 *
 * The spacing guard is the second half of that contract. The lane skips —
 * silently and green — any slot inside minGapHours of the last post, so
 * slots bunched tighter than the gap would schedule runs that can never
 * post. Both are checked against the real config, so this file stays correct
 * across cadence changes instead of needing an edit each time.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBrandRegistry, brandIsPaused } from "../src/brands.js";

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
  // The voiceover step (ldt-voiceover.js) reuses the realty pipeline's
  // ElevenLabs voice — missing keys would silently fall back to posting
  // every clip silent, which is exactly the failure this guard exists for.
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_VOICE_ID",
];

/**
 * The schedule, split by whether each cron line is LIVE or COMMENTED OUT.
 *
 * `/^\s*- cron:/` cannot match a commented line — `#` is not whitespace — so
 * the two sets are disjoint and a commented example can never stand in for a
 * live schedule.
 */
function scheduleCrons() {
  const lines = ldtYml.split("\n");
  return {
    live: lines.filter(l => /^\s*- cron:/.test(l)),
    commented: lines.filter(l => /^\s*#\s*- cron:/.test(l)),
  };
}

function cronMinutes(lines) {
  return lines
    .map(l => {
      const m = /'(\d+)\s+(\d+)\s/.exec(l);
      assert.ok(m, `cron line is a plain minute/hour schedule: ${l.trim()}`);
      return Number(m[2]) * 60 + Number(m[1]);
    })
    .sort((a, b) => a - b);
}

describe("ldt-post.yml", () => {
  test("teeth: the job this guard covers actually exists", () => {
    // A guard that matched nothing would pass forever.
    assert.ok(ldtYml.includes("post-ldt:"), "job post-ldt is present");
    assert.ok(ldtYml.includes("node src/ldt-main.js"), "runs the LDT entrypoint");
  });

  test("tesseract is installed on the runner", () => {
    // The OCR script path (ldt-voiceover.js) needs the tesseract CLI; a
    // runner without it would quietly post every sidecar-less clip silent.
    assert.ok(/apt-get install[^\n]*tesseract-ocr/.test(ldtYml), "ldt-post.yml must apt-get install tesseract-ocr");
  });

  for (const key of REQUIRED_ENV) {
    test(`env key ${key} is wired on the run step itself`, () => {
      // Scoped to the run step: a key moved to another step's env (or lost
      // entirely) fails here even though it still appears in the file.
      assert.ok(new RegExp(`^\\s+${key}: \\$\\{\\{`, "m").test(runStepBlock()), `${key} missing from the Run LDT brand lane step env`);
    });
  }

  test("THE TWO SWITCHES AGREE — the lane is all the way on, or all the way off", () => {
    // Both halves of the pause, asserted together, in both directions —
    // because a half-applied change is the failure neither half catches
    // alone:
    //
    //   paused but a cron still live  → the lane still fires, and only the
    //                                   runner's gate stands between it and a
    //                                   post. The schedule was the point.
    //   enabled but crons still       → THE RESUME HOLE. The lane reads as
    //   commented                       "on", fires never, and CI is green
    //                                   the whole time. This is the one that
    //                                   costs a week of "why has LDT not
    //                                   posted?"
    //
    // One contract rather than two conditional tests, so neither direction
    // can be satisfied vacuously.
    const { live, commented } = scheduleCrons();
    const perDay = Math.max(...Object.values(loadBrandRegistry().brands.ldt.cadence));

    if (brandIsPaused(loadBrandRegistry().brands.ldt)) {
      assert.equal(live.length, 0,
        `the ldt brand is paused in brands.json but ldt-post.yml still has ${live.length} live cron(s) — the lane would still fire`);
      assert.equal(commented.length, perDay,
        `a paused lane keeps its whole schedule commented out so the restore is an uncomment — expected ${perDay} commented cron(s), found ${commented.length}`);
      return;
    }

    assert.equal(live.length, perDay,
      `the ldt brand is ENABLED in brands.json but ldt-post.yml has ${live.length} live cron(s) against a cadence of ${perDay}/day` +
      (commented.length
        ? ` — ${commented.length} cron(s) are still COMMENTED OUT. The lane was turned back on without restoring its schedule: it will never fire.`
        : " — cadence and cron count must change together"));
    assert.equal(commented.length, 0,
      `the lane is enabled but ${commented.length} cron line(s) are still commented out — finish the restore or delete them`);
  });

  test("the slots are SPREAD across the day, never bunched under the min-gap", () => {
    // The guard this pins: the lane skips — silently and green — any slot
    // that lands within minGapHours of the previous post. Crons closer
    // together than the gap would therefore schedule runs that can never
    // post. Checked on the real UTC cron minutes, which is also what makes
    // the answer DST-proof: the spacing lives in UTC, only the CT labels move.
    const brand = loadBrandRegistry().brands.ldt;
    // Live crons while running, the commented ones while paused: the spacing
    // of the schedule this lane RESTORES to has to be right too, or the pause
    // becomes a place for a bad schedule to hide until the day it is needed.
    const { live, commented } = scheduleCrons();
    const minutes = cronMinutes(live.length ? live : commented);
    assert.ok(minutes.length > 0,
      "ldt-post.yml has no cron lines at all, live or commented — the schedule to restore has been lost, not paused");

    // Gaps around the 24h clock, so the last slot vs the next day's first is
    // checked too — a late-night slot that crowds the next morning counts.
    const gaps = minutes.map((m, i) =>
      i === 0 ? m + 1440 - minutes[minutes.length - 1] : m - minutes[i - 1]);
    const minGapMinutes = brand.minGapHours * 60;
    for (const [i, gap] of gaps.entries()) {
      assert.ok(gap >= minGapMinutes,
        `slot gap ${gap}min is under the ${minGapMinutes}min min-gap — that slot would always be skipped (gaps: ${gaps.join(", ")})`);
    }
    // Slack beyond the bare minimum: schedule triggers run late, and a slot
    // delayed relative to its neighbour eats into the gap. Require a full
    // hour of headroom so an ordinary delay cannot turn into a skipped slot.
    assert.ok(Math.min(...gaps) >= minGapMinutes + 60,
      `tightest gap ${Math.min(...gaps)}min leaves under an hour of slack over the ${minGapMinutes}min min-gap`);
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
