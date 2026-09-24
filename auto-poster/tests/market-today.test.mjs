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
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chicagoDay, marketForDay, MARKET_LABELS, DAILY_SLOT } from "../src/cadence.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "market-today.mjs");

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
