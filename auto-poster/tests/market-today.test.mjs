/**
 * scripts/market-today.mjs — the usher that tells post.yml which city to run as.
 *
 * Run as a real child process, the way the workflow runs it, with the Google
 * credentials stripped from the environment: the rotation path must need
 * nothing but the clock, and the dispatch path must need nothing at all. The
 * gate in main.js is the law; this script only has to agree with it, and these
 * tests hold it to the same two rules (cadence.js resolveMarket).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chicagoDay, marketForDay, MARKET_LABELS, DAILY_SLOT } from "../src/cadence.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "market-today.mjs");
const POST_YML = join(ROOT, "..", ".github", "workflows", "post.yml");

/** An environment with no way to reach Drive. */
function bareEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^GOOGLE_|^DECISION_FOLDER_ID$/.test(k)) continue;
    env[k] = v;
  }
  return env;
}

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, env: bareEnv(), encoding: "utf-8" });
}

function parse(stdout) {
  return Object.fromEntries(stdout.trim().split("\n").filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)));
}

function keys(lines) {
  return lines.trim().split("\n").map((l) => l.split("=")[0]);
}

/**
 * The cron path as production runs it: credentials present, so the token
 * refresh SUCCEEDS and the decision-file search runs. bareEnv() never gets that
 * far — the read dies on the missing credentials before drive.js logs a thing.
 * Global fetch is a preloaded stub: the token endpoint hands back a token, Drive
 * finds no files. Each host it is asked for is recorded, so a test can prove
 * the Drive path really ran rather than passing because it was skipped.
 */
function runWithDrive() {
  const dir = mkdtempSync(join(tmpdir(), "market-today-"));
  const calls = join(dir, "calls.log");
  const preload = join(dir, "fake-google.mjs");
  writeFileSync(calls, "");
  writeFileSync(preload, `
import { appendFileSync } from "node:fs";
globalThis.fetch = async (url) => {
  const { host } = new URL(String(url));
  appendFileSync(${JSON.stringify(calls)}, host + "\\n");
  const body = host === "oauth2.googleapis.com" ? { access_token: "test-access-token" } : { files: [] };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
};
`);
  const env = {
    ...bareEnv(),
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
    GOOGLE_REFRESH_TOKEN: "test-refresh-token",
  };
  try {
    const r = spawnSync(process.execPath, ["--import", preload, SCRIPT], { cwd: ROOT, env, encoding: "utf-8" });
    return { ...r, hosts: readFileSync(calls, "utf-8").split("\n").filter(Boolean) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * post.yml's own "Resolve today's market" shell, run the way the runner runs
 * it — `bash -e`, no pipefail — with a preload that puts two stray lines on the
 * script's stdout: the 2026-09-24 log line, and a key=value line that is not
 * one of the four. Returns the step's exit status and what reached the file.
 */
function runMarketStep({ event, city = "dallas" }) {
  const yml = readFileSync(POST_YML, "utf-8");
  const step = yml.slice(yml.indexOf("- name: Resolve today's market"));
  const block = step.match(/^ {8}run: \|\n((?: {10}.*\n)+)/m);
  assert.ok(block, "no `run: |` block found under post.yml's Resolve today's market step");
  const body = block[1].replace(/^ {10}/gm, "");
  const values = { "github.event_name": event, "github.event.inputs.city": city, "github.event.inputs.slot || 'am'": "am" };
  const script = body.replace(/\$\{\{\s*(.+?)\s*\}\}/g, (_, expr) => {
    assert.ok(expr in values, `the step reads an expression this test does not model: ${expr}`);
    return values[expr];
  });
  const dir = mkdtempSync(join(tmpdir(), "market-step-"));
  const output = join(dir, "github_output");
  const stray = join(dir, "stray-stdout.mjs");
  writeFileSync(output, "");
  writeFileSync(stray, `process.stdout.write("[Drive] Access token refreshed successfully\\nrefreshed=true\\n");\n`);
  try {
    const r = spawnSync("bash", ["-e", "-c", script], {
      cwd: ROOT,
      encoding: "utf-8",
      env: {
        ...bareEnv(),
        PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
        NODE_OPTIONS: `--import=${stray}`,
        GITHUB_OUTPUT: output,
      },
    });
    return { status: r.status, stderr: r.stderr, output: readFileSync(output, "utf-8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the cron path", () => {
  test("with no credentials it falls back to the rotation for TODAY (Chicago), exits 0, and says so on stderr", () => {
    const r = run([]);
    assert.equal(r.status, 0, r.stderr);
    const out = parse(r.stdout);
    const today = chicagoDay(new Date());
    assert.equal(out.city, marketForDay(today));
    assert.equal(out.label, MARKET_LABELS[out.city]);
    assert.equal(out.slot, DAILY_SLOT);
    assert.equal(out.market_source, "rotation");
    assert.match(r.stderr, /decision file not usable/);
    assert.match(r.stderr, new RegExp(`${today} \\(CT\\)`));
  });

  test("stdout carries ONLY the four GITHUB_OUTPUT lines", () => {
    // Anything else on stdout lands in $GITHUB_OUTPUT and breaks the step.
    const r = run([]);
    assert.deepEqual(r.stdout.trim().split("\n").map((l) => l.split("=")[0]), ["city", "label", "slot", "market_source"]);
  });

  test("stdout stays the four lines once Drive answers — the token refresh logs to stderr", () => {
    // The test above has no credentials, so it never reaches the line that
    // broke production: drive.js logging "[Drive] Access token refreshed
    // successfully" after a refresh that WORKED. On stdout it landed in
    // $GITHUB_OUTPUT, and from 2026-09-24 every scheduled run failed the step
    // with "Invalid format" while dispatches, which never read Drive, posted.
    const r = runWithDrive();
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.hosts, ["oauth2.googleapis.com", "www.googleapis.com"], "the token refresh and the Drive search must both have run");
    assert.match(r.stderr, /no ig_posting_decision_latest\.json in Drive/);
    assert.deepEqual(keys(r.stdout), ["city", "label", "slot", "market_source"]);
  });
});

describe("the dispatch path", () => {
  test("echoes the chosen city in the same shape, normalised, with its label", () => {
    const out = parse(execFileSync(process.execPath, [SCRIPT, "--city", "dallas"], { cwd: ROOT, env: bareEnv(), encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }));
    assert.deepEqual(out, { city: "dallas", label: "DFW", slot: "am", market_source: "dispatch" });
  });

  test("the slot on the form is passed through — the gate, not this script, retires it", () => {
    const out = parse(execFileSync(process.execPath, [SCRIPT, "--city", "San Antonio", "--slot", "pm"], { cwd: ROOT, env: bareEnv(), encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }));
    assert.equal(out.city, "san_antonio");
    assert.equal(out.slot, "pm");
  });

  test("a city the law does not know fails the step rather than inventing a market", () => {
    const r = run(["--city", "houston"]);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /not a market/);
  });
});

describe("post.yml's Resolve today's market step", () => {
  // The script's stdout is only as clean as everything it imports, so the step
  // filters as well: only the four keys reach $GITHUB_OUTPUT, whatever else a
  // module prints. Run against the step's own shell, not a copy of it.
  for (const event of ["schedule", "workflow_dispatch"]) {
    test(`${event}: stray stdout lines never reach $GITHUB_OUTPUT`, () => {
      const r = runMarketStep({ event });
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(keys(r.output), ["city", "label", "slot", "market_source"]);
    });
  }

  test("a city the law does not know still fails the step", () => {
    // Under `bash -e` without pipefail a pipeline's status is its LAST
    // command's, so this holds only because grep finds nothing to pass.
    const r = runMarketStep({ event: "workflow_dispatch", city: "houston" });
    assert.notEqual(r.status, 0);
    assert.equal(r.output, "");
  });
});
