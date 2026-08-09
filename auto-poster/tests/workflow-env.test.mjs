import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const WORKFLOW = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".github", "workflows", "youtube-longform.yml");

/**
 * Split the workflow into jobs, keeping each job's raw text.
 *
 * Deliberately crude — a YAML parser is not a dependency worth adding to assert
 * one env var, and the question here is textual: does this job's block mention
 * the variable at all.
 */
function jobs() {
  const text = readFileSync(WORKFLOW, "utf-8");
  const out = {};
  const re = /\n {2}([a-zA-Z0-9_-]+):\n/g;
  const starts = [];
  let m;
  while ((m = re.exec(text))) starts.push({ name: m[1], at: m.index });
  const jobsStart = text.indexOf("\njobs:");
  for (let i = 0; i < starts.length; i++) {
    if (starts[i].at < jobsStart) continue;
    const end = i + 1 < starts.length ? starts[i + 1].at : text.length;
    out[starts[i].name] = text.slice(starts[i].at, end);
  }
  return out;
}

describe("workflow environment stays consistent", () => {
  const all = jobs();

  test("the workflow is parseable into jobs", () => {
    assert.ok(Object.keys(all).length >= 4, `found ${Object.keys(all).length} jobs`);
    assert.ok(all.pipeline, "no pipeline job");
    assert.ok(all["dry-run"], "no dry-run job");
  });

  /**
   * Peter records every take, on-camera AND voiceover. That is a standing
   * choice, not a per-run flag, and three things key off it: the recording kit
   * (what he is asked to shoot), the ingest (what counts as missing), and the
   * PIP (which needs his own recording to composite).
   */
  /**
   * The scripts whose BEHAVIOUR changes with the narration mode.
   *
   * Not "every script that runs" — brief, reoutline and send-test-approval all
   * run node and none of them touch takesToRecord, buildKit or the timeline, so
   * requiring the variable there would be noise that teaches people to add it
   * everywhere without knowing why.
   *
   * Verified by what they import: takesToRecord / buildKit / planTimeline.
   */
  const NARRATION_DEPENDENT = ["yt-pipeline-main.js", "resend-kit.mjs", "dry-run-build.mjs"];

  test("every job running a narration-dependent script sets YT_NARRATION_MODE", () => {
    const missing = [];
    for (const [name, block] of Object.entries(all)) {
      const runs = NARRATION_DEPENDENT.filter((s) => block.includes(s));
      if (runs.length === 0) continue;
      if (!/YT_NARRATION_MODE:/.test(block)) missing.push(`${name} (runs ${runs.join(", ")})`);
    }
    assert.deepEqual(missing, [], `narration-dependent jobs without the mode: ${missing.join("; ")}`);
  });

  test("the guard actually finds the jobs it is meant to guard", () => {
    // A guard that matched nothing would pass forever while checking nothing —
    // the failure mode this codebase keeps paying for. Assert it has teeth.
    const guarded = Object.entries(all)
      .filter(([, b]) => NARRATION_DEPENDENT.some((s) => b.includes(s)))
      .map(([n]) => n);
    assert.ok(guarded.includes("pipeline"), "the pipeline job was not detected");
    assert.ok(guarded.includes("dry-run"), "the dry-run job was not detected");
    assert.equal(guarded.length, 3, `expected 3 guarded jobs, found: ${guarded.join(", ")}`);
  });

  test("it is set to peter everywhere it appears", () => {
    for (const [name, block] of Object.entries(all)) {
      for (const m of block.matchAll(/YT_NARRATION_MODE:\s*(\S+)/g)) {
        assert.equal(m[1], "peter", `${name} sets it to "${m[1]}"`);
      }
    }
  });

  /**
   * The dry run exists to predict the real build. If they disagree about how
   * many takes are expected, it passes while the build fails — which is exactly
   * what happened: the dry run wanted 12 on-camera takes and the build wanted
   * all 36, so a run with every voiceover take missing looked clean.
   */
  test("the dry run and the pipeline agree on the narration mode", () => {
    const modeOf = (block) => (block.match(/YT_NARRATION_MODE:\s*(\S+)/) || [])[1] || null;
    assert.equal(modeOf(all["dry-run"]), modeOf(all.pipeline), "the dry run would predict a different build");
    assert.equal(modeOf(all["dry-run"]), "peter");
  });
});

describe("the distribution sweep's credentials reach the job that runs it", () => {
  test("the pipeline job sets YT_REFRESH_TOKEN", () => {
    // The sweep runs inside yt-pipeline-main. Its token was set on the PROBE
    // workflow and not here — so accessToken() threw on every scheduled run,
    // the sweep skipped itself with a log warning, and distribution would
    // silently never have happened. Same drift class as YT_NARRATION_MODE.
    const all = jobs();
    assert.match(all.pipeline, /YT_REFRESH_TOKEN:/, "the sweep cannot authenticate without it");
  });

  test("the cron collision is covered: brief and pipeline share a queueing group", () => {
    const all = jobs();
    for (const name of ["brief", "pipeline"]) {
      assert.match(all[name], /group:\s*youtube-longform-approvals/, `${name} must share the approvals group`);
      assert.match(all[name], /cancel-in-progress:\s*false/, `${name} must queue, not kill a build mid-upload`);
    }
  });
});
