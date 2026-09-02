import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const WF_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".github", "workflows");
const WORKFLOW = join(WF_DIR, "youtube-longform.yml");
const DAILY_WORKFLOW = join(WF_DIR, "post.yml");

/**
 * Split the workflow into jobs, keeping each job's raw text.
 *
 * Deliberately crude — a YAML parser is not a dependency worth adding to assert
 * one env var, and the question here is textual: does this job's block mention
 * the variable at all.
 */
function jobs(WORKFLOW_PATH = WORKFLOW) {
  const WORKFLOW = WORKFLOW_PATH;
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

  test("micro-punches stay OFF — this week's A/B layers are thumbnails and teasers", () => {
    // Peter's discipline: one experimental layer at a time. MICRO_PUNCHES_ENABLED
    // is opt-in (yt-config reads === "true"), so the pin is that no job opts in.
    const all = jobs();
    for (const [name, body] of Object.entries(all)) {
      assert.ok(!/YT_MICRO_PUNCHES:\s*['"]?true/.test(body), `${name} must not switch micro-punches on`);
    }
  });

  test("the teaser-backfill job can reach Drive, and commits what it records", () => {
    const all = jobs();
    assert.ok(all["teaser-backfill"], "the backfill job exists");
    assert.match(all["teaser-backfill"], /GOOGLE_REFRESH_TOKEN:/, "take recovery reads Drive");
    assert.match(all["teaser-backfill"], /merge-log-push\.mjs/, "an uncommitted teaser record is a cut nobody delivers");
    assert.match(all["teaser-backfill"], /group:\s*youtube-longform-approvals/, "must queue behind the crons, not race them");
  });

  test("the record-decision job commits what it records, and queues behind the crons", () => {
    // The job exists to repair a dropped dashboard write-back. A recorded
    // decision that is not committed is the same stall wearing a green run,
    // and a write racing the crons over yt-approvals.json is the one hazard
    // the shared group exists for.
    const all = jobs();
    assert.ok(all["record-decision"], "the record-decision job exists");
    assert.match(all["record-decision"], /record-decision\.mjs/, "must run the validated script, not an inline edit");
    assert.match(all["record-decision"], /merge-log-push\.mjs/, "an uncommitted decision is still a stall");
    assert.match(all["record-decision"], /group:\s*youtube-longform-approvals/, "must queue behind the crons, not race them");
    assert.match(all["record-decision"], /cancel-in-progress:\s*false/, "must queue, not kill a build mid-upload");
  });

  test("the reconcile sweep is hourly, read-only against the dashboard, and commits only its alert stamp", () => {
    // Its one invariant check needs the passcode wall's secret and Gmail for
    // the alarm. It used to hold contents: read and commit nothing — and it
    // ran daily, which is how the 2026-08-31 card was flagged 23 hours after
    // it went out. Hourly detection needs a memory of what it already mailed
    // (reconcileAlertedAt, merge group of its own), so the job now holds
    // write permission for exactly that: the commit step is gated on the
    // sweep having stamped something, and the sweep itself still clicks and
    // posts nothing on the dashboard.
    const text = readFileSync(join(WF_DIR, "decision-reconcile.yml"), "utf-8");
    assert.match(text, /cron:\s*'15 \* \* \* \*'/, "must sweep hourly — daily found the Aug 31 card a day late");
    assert.match(text, /contents:\s*write/, "the alert stamp has to land, or hourly detection is hourly mail");
    assert.match(text, /reconcile-waiting\.mjs/, "the cheap pre-check must gate the browser install");
    assert.match(text, /if:\s*steps\.precheck\.outputs\.waiting == 'true'[\s\S]*playwright install/, "Chromium only when something is waiting");
    assert.match(text, /if:\s*always\(\) && steps\.sweep\.outputs\.stamped == 'true'[\s\S]*merge-log-push\.mjs RECONCILE/, "commit only on a run that stamped, and after a red sweep too");
    assert.match(text, /DASHBOARD_PASS:/, "cannot get past the passcode wall without it");
    assert.match(text, /GOOGLE_REFRESH_TOKEN:/, "the alert mail needs the Gmail token");
    assert.match(text, /reconcile\.mjs/, "must run the sweep script");
  });

  test("the pipeline job carries the YouTube token's OWN OAuth client pair", () => {
    // The token is minted against project "Youtube Auto Post"; a refresh
    // token only exchanges against the client that minted it, so a job with
    // the token but not the pair falls back to the Drive client and dies
    // with invalid_grant on every sweep.
    const all = jobs();
    assert.match(all.pipeline, /YT_CLIENT_ID:/, "the sweep would exchange against the wrong OAuth client");
    assert.match(all.pipeline, /YT_CLIENT_SECRET:/, "the sweep would exchange against the wrong OAuth client");
  });

  test("the cron collision is covered: brief and pipeline share a queueing group", () => {
    const all = jobs();
    for (const name of ["brief", "pipeline"]) {
      assert.match(all[name], /group:\s*youtube-longform-approvals/, `${name} must share the approvals group`);
      assert.match(all[name], /cancel-in-progress:\s*false/, `${name} must queue, not kill a build mid-upload`);
    }
  });
});

/**
 * THE DAILY WORKFLOW GETS THE SAME GUARD THE LONG-FORM ONE HAS.
 *
 * Everything above was written after YT_NARRATION_MODE and YT_REFRESH_TOKEN
 * drifted, and it was pointed at youtube-longform.yml only. post.yml — which
 * runs five jobs a day, every day — had no guard at all, and drifted in exactly
 * the same way: voiceover.js reads ELEVENLABS_VOICE_ID and NOT ONE JOB SET IT.
 *
 * The consequence was not theoretical. The unset variable meant the hardcoded
 * Professional voice was always used; on 2026-07-27 the account lost the tier
 * that voice requires; and because the override never reached the runtime, the
 * only available fix was a code change. Fourteen days of failed runs.
 */
describe("the daily workflow's credentials reach the jobs that need them", () => {
  const daily = jobs(DAILY_WORKFLOW);

  const VOICEOVER_JOBS = ["post-san-antonio", "post-austin", "post-dallas", "trial-variant"];

  test("the daily workflow is parseable into its five jobs", () => {
    for (const j of [...VOICEOVER_JOBS, "post-carousel"]) {
      assert.ok(daily[j], `no ${j} job found in post.yml`);
    }
  });

  test("every job that narrates sets ELEVENLABS_VOICE_ID", () => {
    const missing = VOICEOVER_JOBS.filter((j) => !/ELEVENLABS_VOICE_ID:/.test(daily[j] || ""));
    assert.deepEqual(missing, [], `narrating jobs without the voice override: ${missing.join(", ")}`);
  });

  test("every job that narrates also has the key to call ElevenLabs at all", () => {
    const missing = VOICEOVER_JOBS.filter((j) => !/ELEVENLABS_API_KEY:/.test(daily[j] || ""));
    assert.deepEqual(missing, [], `narrating jobs without the API key: ${missing.join(", ")}`);
  });

  /**
   * The guard has teeth: it must be pointed at jobs that actually run a script
   * importing voiceover.js, not at a hand-written list that could rot.
   */
  test("the narrating jobs are exactly the jobs that run a voiceover entry point", () => {
    const VOICEOVER_ENTRIES = ["src/main.js", "src/trial-variant-main.js"];
    const detected = Object.entries(daily)
      .filter(([, b]) => VOICEOVER_ENTRIES.some((s) => b.includes(s)))
      .map(([n]) => n)
      .sort();
    assert.deepEqual(detected, [...VOICEOVER_JOBS].sort(), `detected: ${detected.join(", ")}`);
  });

  /**
   * The carousel does not narrate, and giving it the voice knob would teach the
   * next person to paste every secret into every job — which is how the real
   * drift becomes invisible.
   */
  test("the carousel job is NOT given voiceover credentials it never uses", () => {
    assert.ok(!/ELEVENLABS/.test(daily["post-carousel"] || ""), "the carousel job should not carry ElevenLabs secrets");
  });

  /**
   * The live LinkedIn duplicate check reads the posted-log through the GitHub
   * API. Without a token it fails open — which is precisely the state that let
   * four days of duplicate posts through.
   */
  test("the job that posts LinkedIn can read the live log", () => {
    assert.match(daily["post-san-antonio"], /GITHUB_TOKEN:/, "the SA job runs the LinkedIn block and needs GITHUB_TOKEN for the live duplicate check");
  });

  test("every daily job can send its own failure alert", () => {
    // notifyDailyFailure emails through the Google token. A job without the
    // OAuth trio can annotate but cannot reach a human inbox.
    const missing = Object.keys(daily).filter(
      (j) => !/GOOGLE_REFRESH_TOKEN:/.test(daily[j]) || !/GOOGLE_CLIENT_ID:/.test(daily[j])
    );
    assert.deepEqual(missing, [], `jobs that cannot email an alert: ${missing.join(", ")}`);
  });
});

describe("no workflow env block repeats a key", () => {
  /**
   * GitHub rejects a workflow with duplicate env keys AT DISPATCH TIME — the
   * file merges fine, every text-level test passes, and then every cron and
   * every manual dispatch fails with HTTP 422 until someone notices. That is
   * how an invalid youtube-longform.yml shipped through two reviewed PRs and
   * a launch audit: two sequential patches each inserted the same env pair
   * after different anchors that landed in one block. Found only when the
   * first real build was dispatched.
   */
  test("every env block in every workflow has unique keys", () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".github", "workflows");
    const problems = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".yml"))) {
      const lines = readFileSync(join(dir, file), "utf-8").split("\n");
      let keys = null;
      let indent = 0;
      lines.forEach((line, i) => {
        const start = line.match(/^(\s+)env:\s*$/);
        if (start) { keys = new Map(); indent = start[1].length + 2; return; }
        if (keys === null) return;
        const kv = line.match(new RegExp(`^\\s{${indent}}([A-Za-z_][A-Za-z0-9_]*):`));
        if (kv) {
          if (keys.has(kv[1])) problems.push(`${file}:${i + 1} duplicates ${kv[1]} (first at ${keys.get(kv[1])})`);
          keys.set(kv[1], i + 1);
        } else if (line.trim() && !line.startsWith(" ".repeat(indent))) {
          keys = null;
        }
      });
    }
    assert.deepEqual(problems, [], problems.join("; "));
  });
});
