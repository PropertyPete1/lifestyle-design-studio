/**
 * merge-log-push must land the log on main from ANY checkout.
 *
 * THE BUG THIS EXISTS FOR.
 *
 * The push was `git push origin main`, which needs a local ref called `main`.
 * A workflow_dispatch on a branch checks out only that branch, so the push died
 * on "src refspec main does not match any" — five times, then:
 *
 *   ::error::🚨 CRITICAL: All push attempts failed. Log entry is LOST. Double-post risk!
 *
 * A real trial variant was generated, delivered to Drive and the dashboard, and
 * then forgotten, because the only step that records it cannot run off main.
 * For the city pipelines the same path loses a record of something already
 * posted to social, which is where "double-post risk" stops being rhetorical.
 *
 * These run real git against a local bare remote — the failure was in git ref
 * resolution, so a mock would have reproduced nothing.
 */
import { test, describe } from "node:test";
import assert from "node:assert";
import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, cpSync } from "fs";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

const AUTOPOSTER = join(dirname(fileURLToPath(import.meta.url)), "..");

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: "pipe" });
}

/**
 * A bare remote with one commit on main, plus a working clone. `checkoutBranch`
 * reproduces the actions/checkout shape for a dispatch on a branch: that branch
 * present, no local main.
 */
function sandbox({ checkoutBranch }) {
  const root = mkdtempSync(join(tmpdir(), "merge-push-"));
  const remote = join(root, "remote.git");
  const work = join(root, "work");

  mkdirSync(remote);
  git(remote, "init", "--bare", "--initial-branch=main");

  const seed = join(root, "seed");
  mkdirSync(seed);
  git(seed, "init", "--initial-branch=main");
  git(seed, "config", "user.email", "t@t.t");
  git(seed, "config", "user.name", "T");
  mkdirSync(join(seed, "auto-poster"));
  writeFileSync(
    join(seed, "auto-poster", "trial-variants.json"),
    JSON.stringify({ variants: [{ date: "2026-08-09", window: "pm", generatedAt: "2026-08-09T00:00:00Z" }] }, null, 2)
  );
  git(seed, "add", "-A");
  git(seed, "commit", "-m", "seed");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "origin", "main");

  if (checkoutBranch !== "main") {
    git(seed, "checkout", "-b", checkoutBranch);
    git(seed, "push", "origin", checkoutBranch);
  }

  // Reproduce the runner's ref shape for a dispatch on a branch: the remote
  // tracking ref origin/main IS resolvable (the real run's `reset --hard
  // origin/main` succeeded), but there is no LOCAL branch called main — which
  // is the only thing `git push origin main` needs and cannot find.
  // A clone creates a LOCAL branch only for the one it checks out, so cloning
  // --branch feat/... already leaves no local `main` while origin/main stays
  // resolvable — exactly the shape that broke the push.
  execFileSync("git", ["clone", "--branch", checkoutBranch, remote, work], { stdio: "pipe" });
  git(work, "config", "user.email", "bot@t.t");
  git(work, "config", "user.name", "Bot");

  const repoDir = join(work, "auto-poster");
  // The script imports its strategies from alongside itself.
  for (const f of ["merge-log-push.mjs", "merge-strategies.mjs"]) {
    cpSync(join(AUTOPOSTER, f), join(repoDir, f));
  }
  // …and src/, WHOLESALE rather than the one file it used to need.
  //
  // This was `cpSync(src/social-telemetry.js)` — the single src/ module
  // merge-log-push imported at the time. That made the sandbox a hand-kept
  // list of the script's transitive dependencies, and the first time one was
  // added (approvals-retention.js, which merge-strategies now shares with
  // yt-approvals) every test in this file died with ERR_MODULE_NOT_FOUND on a
  // change that was correct. A sandbox that has to be updated whenever the code
  // under test grows an import is a sandbox that fails for reasons that are not
  // about the thing being tested.
  cpSync(join(AUTOPOSTER, "src"), join(repoDir, "src"), { recursive: true });

  return { root, remote, work, repoDir };
}

function remoteTrialVariants(remote, root) {
  const out = join(root, "verify");
  execFileSync("git", ["clone", "--branch", "main", "--single-branch", remote, out], { stdio: "pipe" });
  return JSON.parse(readFileSync(join(out, "auto-poster", "trial-variants.json"), "utf-8"));
}

function runMergePush(repoDir) {
  try {
    const out = execFileSync("node", ["merge-log-push.mjs", "TRIAL", "true"], {
      cwd: repoDir,
      encoding: "utf-8",
      stdio: "pipe",
    });
    return { ok: true, output: out };
  } catch (e) {
    return { ok: false, output: `${e.stdout || ""}${e.stderr || ""}` };
  }
}

/** Append a variant the way trial-variant-main.js does, then push it. */
function addVariantAndPush(s) {
  const path = join(s.repoDir, "trial-variants.json");
  const data = JSON.parse(readFileSync(path, "utf-8"));
  data.variants.push({
    date: "2026-08-10",
    window: "pm",
    hookAngle: "feature_callout",
    trigger: "manual",
    generatedAt: "2026-08-10T15:09:16.000Z",
  });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
  return runMergePush(s.repoDir);
}

describe("the trial log reaches main from any checkout", () => {
  test("from a branch checkout — the case that lost a real variant", () => {
    const s = sandbox({ checkoutBranch: "feat/trial-pipeline-hardening" });
    const res = addVariantAndPush(s);

    assert.ok(
      !res.output.includes("src refspec main does not match any"),
      `push must not depend on a local main ref:\n${res.output}`
    );
    assert.ok(
      !res.output.includes("Log entry is LOST"),
      `the variant was delivered; losing its record is the double-post path:\n${res.output}`
    );
    assert.ok(res.ok, `merge-log-push should exit 0:\n${res.output}`);

    const remote = remoteTrialVariants(s.remote, s.root);
    assert.ok(
      remote.variants.some((v) => v.date === "2026-08-10" && v.window === "pm"),
      "the entry must exist on main, not just in the runner's working tree"
    );
  });

  test("from main — unchanged behaviour", () => {
    const s = sandbox({ checkoutBranch: "main" });
    const res = addVariantAndPush(s);
    assert.ok(res.ok, `merge-log-push should exit 0 on main:\n${res.output}`);

    const remote = remoteTrialVariants(s.remote, s.root);
    assert.ok(remote.variants.some((v) => v.date === "2026-08-10" && v.window === "pm"));
  });

  test("branch code cannot ride along to main", () => {
    // The reset-to-origin/main means only merge-managed JSON moves. If a branch
    // dispatch could carry source changes onto main, pushing HEAD would be a far
    // worse bug than the one it fixes.
    const s = sandbox({ checkoutBranch: "feat/trial-pipeline-hardening" });
    writeFileSync(join(s.repoDir, "smuggled.js"), "module.exports = 'should never reach main';");
    git(s.work, "add", "-A");
    git(s.work, "commit", "-m", "branch-only change");

    addVariantAndPush(s);

    const out = join(s.root, "verify-smuggle");
    execFileSync("git", ["clone", "--branch", "main", "--single-branch", s.remote, out], { stdio: "pipe" });
    let found = true;
    try {
      readFileSync(join(out, "auto-poster", "smuggled.js"), "utf-8");
    } catch {
      found = false;
    }
    assert.equal(found, false, "a branch-only file must never arrive on main");
  });
});
