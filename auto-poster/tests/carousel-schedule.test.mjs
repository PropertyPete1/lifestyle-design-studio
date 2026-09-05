import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

/**
 * The carousel is retired from the schedule (2026-09-04).
 *
 * It underperformed and every run spent claude-opus-5 tokens on a deck, so the
 * `0 14 * * *` cron came out of post.yml. The JOB stayed: a one-off carousel is
 * still worth having, and — more to the point — carousel-render.js is the shared
 * design library that every YouTube long-form renderer, the LDT lane and
 * reel-variant.js draw from, so nothing here may be deleted.
 *
 * That makes this a schedule-shaped guarantee, not a code-shaped one, and the
 * only thing standing between "retired" and "quietly back on a cron" is a test
 * that reads the workflow. Two ways it could come back:
 *
 *   1. someone re-adds `- cron: '0 14 * * *'` to post.yml, or
 *   2. someone adds a `github.event.schedule` clause to post-carousel's `if`,
 *      binding it to a cron that already exists for another city.
 *
 * Both are checked below, and the other four jobs are pinned so that removing
 * the carousel cannot quietly change a reel slot on the way past.
 */

const WF_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".github", "workflows");
const DAILY = join(WF_DIR, "post.yml");

/** Same crude job splitter workflow-env.test.mjs uses — textual, on purpose. */
function jobs(path) {
  const text = readFileSync(path, "utf-8");
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

/**
 * The YAML with every `#` comment line dropped.
 *
 * Every check here asks what the workflow DOES, and a comment saying the words
 * is not the workflow doing them — this file's own "no github.event.schedule
 * clause" note tripped the schedule check before this existed.
 */
function code(text) {
  return text
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
}

/** Every cron in the `on: schedule:` block, in file order. */
function crons(path) {
  const text = readFileSync(path, "utf-8");
  const block = text.slice(text.indexOf("\non:"), text.indexOf("\njobs:"));
  return [...code(block).matchAll(/-\s*cron:\s*'([^']+)'/g)].map((m) => m[1]);
}

/**
 * Which jobs a given cron can reach.
 *
 * GitHub matches `github.event.schedule` against the cron string LITERALLY, so
 * a job is schedule-reachable exactly when its `if:` quotes that string.
 */
function jobsReachableByCron(all, cron) {
  return Object.entries(all)
    .filter(([, body]) => code(body).includes(`'${cron}'`))
    .map(([name]) => name)
    .sort();
}

describe("the carousel is off the schedule", () => {
  const all = jobs(DAILY);
  const scheduled = crons(DAILY);

  test("post.yml has no 14:00 UTC cron", () => {
    assert.ok(
      !scheduled.includes("0 14 * * *"),
      `the daily carousel cron is back in post.yml: ${scheduled.join(", ")}`
    );
  });

  test("no cron in post.yml reaches the carousel job", () => {
    const reached = scheduled.flatMap((c) => jobsReachableByCron(all, c));
    assert.ok(
      !reached.includes("post-carousel"),
      `post-carousel is schedule-reachable again via: ${scheduled
        .filter((c) => jobsReachableByCron(all, c).includes("post-carousel"))
        .join(", ")}`
    );
  });

  test("the carousel job carries no github.event.schedule clause at all", () => {
    // Cheaper than the cron cross-product above and catches a binding to a cron
    // that has not been added to the schedule block yet.
    assert.ok(all["post-carousel"], "no post-carousel job in post.yml");
    assert.ok(
      !/github\.event\.schedule/.test(code(all["post-carousel"])),
      "post-carousel gates on github.event.schedule — it is meant to be manual only"
    );
  });

  test("the scheduled job set is exactly the four non-carousel lanes", () => {
    const reached = [...new Set(scheduled.flatMap((c) => jobsReachableByCron(all, c)))].sort();
    assert.deepEqual(reached, ["post-austin", "post-dallas", "post-san-antonio", "trial-variant"]);
  });

  /**
   * The house pause pattern, copied from ldt-post.yml (#124, four days before
   * this): the retired cron stays in the file as a comment so restoring the
   * lane is an uncomment rather than a rewrite. ldt-workflow-env.test.mjs holds
   * that lane to the same rule — "the schedule to restore has been lost, not
   * paused" is the failure it exists to prevent — and a deleted cron is exactly
   * how the next person restores the carousel to the wrong time.
   */
  test("the retired cron is preserved as a comment, not deleted", () => {
    const text = readFileSync(DAILY, "utf-8");
    const head = text.slice(0, text.indexOf("\njobs:"));
    assert.match(
      head,
      /^\s*#\s*-\s*cron:\s*'0 14 \* \* \*'/m,
      "the carousel's 14:00 UTC cron is gone entirely — restore it as a comment so the schedule to resume to is not lost"
    );
  });

  test("a one-off carousel is still one dispatch away", () => {
    // Retiring the lane must not amount to deleting it: Peter can still ask for
    // a carousel, and the workflow_dispatch city choice is how he does it.
    assert.match(
      all["post-carousel"],
      /github\.event_name == 'workflow_dispatch' && github\.event\.inputs\.city == 'carousel'/,
      "the manual carousel path is gone"
    );
    const text = readFileSync(DAILY, "utf-8");
    const dispatch = text.slice(text.indexOf("workflow_dispatch:"), text.indexOf("\njobs:"));
    assert.match(dispatch, /^\s+- carousel$/m, "carousel is no longer a city option on the dispatch form");
  });
});

describe("nothing else about the daily schedule moved", () => {
  const all = jobs(DAILY);

  /**
   * The full cron list, pinned. Deleting the carousel line is a one-line edit in
   * the middle of this block, which is exactly the shape of edit that takes a
   * neighbour with it — a dropped `30` backup would go unnoticed for weeks.
   */
  test("the reel and trial crons are untouched", () => {
    assert.deepEqual(crons(DAILY), [
      "0 16 * * *", "30 16 * * *",   // SA am + backup
      "0 17 * * *", "30 17 * * *",   // ATX am + backup
      "0 19 * * *", "30 19 * * *",   // SA pm + backup
      "0 20 * * *", "30 20 * * *",   // ATX pm + backup
      "0 21 * * *", "30 21 * * *",   // DFW pm + backup
      "15 13 * * *", "45 23 * * *",  // trial variant am/pm
    ]);
  });

  test("post.yml still holds all five jobs", () => {
    // The carousel job is RETIRED, not removed. Deleting it would strand the
    // shared design library it sits next to and break the long-form renderers.
    assert.deepEqual(Object.keys(all).sort(), [
      "post-austin", "post-carousel", "post-dallas", "post-san-antonio", "trial-variant",
    ]);
  });

  test("each city job still answers to exactly its own two crons", () => {
    const expected = {
      "post-san-antonio": ["0 16 * * *", "30 16 * * *", "0 19 * * *", "30 19 * * *"],
      "post-austin": ["0 17 * * *", "30 17 * * *", "0 20 * * *", "30 20 * * *"],
      "post-dallas": ["0 21 * * *", "30 21 * * *"],
      "trial-variant": ["15 13 * * *", "45 23 * * *"],
    };
    for (const [job, wanted] of Object.entries(expected)) {
      const bound = crons(DAILY).filter((c) => code(all[job]).includes(`'${c}'`));
      assert.deepEqual(bound, wanted, `${job} is bound to the wrong crons`);
    }
  });
});

describe("no other workflow puts a carousel on a cron", () => {
  /**
   * The point of the exercise was "no SCHEDULED run generates, renders or
   * delivers a carousel" — which post.yml alone cannot promise. Any workflow
   * that both runs on a schedule and invokes a carousel entry point would put
   * the lane straight back on a timer somewhere else in the directory.
   */
  const CAROUSEL_ENTRYPOINTS = [
    "src/carousel-main.js",
    "scripts/generate-samples.mjs",      // calls runCarousel()
    "scripts/rescore-logged.mjs",        // re-scores decks through the critic
    "scripts/replay-carousel-webhook.mjs",
  ];

  /**
   * A job is schedule-reachable unless its own `if:` rules the schedule out.
   * No `if:` at all means every trigger runs it, which includes the crons — so
   * "has no gate" is the dangerous case, not the safe one.
   */
  function scheduleReachable(raw) {
    const body = code(raw);
    const gate = /\n\s+if:\s*(>-|>|\|-?)?\s*\n?((?:.|\n)*?)\n\s{4}[a-z-]+:/.exec(body);
    if (!gate) return true;
    const cond = gate[2];
    if (/github\.event\.schedule/.test(cond)) return true;
    // Gated on dispatch (or push, or anything else) and never on schedule.
    if (/github\.event_name/.test(cond)) return false;
    return true;
  }

  test("no scheduled job in any workflow runs a carousel entry point", () => {
    const offenders = [];
    for (const file of readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f))) {
      const path = join(WF_DIR, file);
      const text = readFileSync(path, "utf-8");
      const cut = text.indexOf("\njobs:");
      const head = text.slice(0, cut === -1 ? text.length : cut);
      // An UNCOMMENTED `- cron:` in the trigger block. ldt-post.yml's crons are
      // commented out (that lane is paused) and must stay out of this set.
      if (!/^\s*-\s*cron:/m.test(code(head))) continue;
      for (const [name, body] of Object.entries(jobs(path))) {
        if (!scheduleReachable(body)) continue;
        const hit = CAROUSEL_ENTRYPOINTS.find((e) => code(body).includes(e));
        if (hit) offenders.push(`${file}:${name} runs ${hit}`);
      }
    }
    assert.deepEqual(offenders, [], `scheduled jobs reaching carousel code: ${offenders.join("; ")}`);
  });
});
