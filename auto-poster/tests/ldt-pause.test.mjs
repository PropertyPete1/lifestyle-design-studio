/**
 * The LDT pause switch — acceptance tests.
 *
 * The lane was paused on 2026-09-04 by operator request: no automated posting
 * to @lifestyledesigntechnologies (Instagram), @lifestyledesigntech (TikTok)
 * or the Lifestyle Design Technologies Facebook Page, on any slot.
 *
 * Three things have to be true, and each is expensive to get wrong:
 *
 *   1. A PAUSED LANE POSTS NOTHING AND EXITS GREEN. Not "posts nothing
 *      because the cron is off" — the runner itself has to refuse, so a
 *      stray dispatch, a re-run of an old job, or a restored schedule is
 *      safe. Proven end-to-end below by running src/ldt-main.js as a real
 *      subprocess with global fetch replaced by a recorder that throws:
 *      zero network calls, exit 0, and none of the downstream stage markers
 *      in its output. A gate asserted only against source text would pass
 *      while sitting below the code it was meant to guard.
 *
 *   2. REALTY IS UNTOUCHED. The trap: realty is `discovery: "unclaimed"` —
 *      it posts to every Metricool profile no other brand claims. So if
 *      pausing a brand ALSO dropped its claim, the LDT Instagram, TikTok and
 *      Facebook Page would fall into realty's fan-out and start receiving
 *      realty reels within the hour, autoPublish:true. Pausing a lane must
 *      never be the thing that hands its accounts to another brand. The
 *      claim path is pinned here, behaviourally and structurally.
 *
 *   3. MANUAL DRY RUN STILL WORKS. The operator kept a way to exercise the
 *      lane while it rests. A dry run publishes nothing (uploadToBrand is
 *      skipped; createSingleBrandPost and applyLdtVoiceover both return
 *      before their network calls), so it is the one path allowed through
 *      the gate — and only ever by a human choosing it on a dispatch.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  loadBrandRegistry, brandPostingEnabled, brandIsPaused,
  profileClaimedBy, claimingBrandKey, excludeClaimedProfiles, findBrandProfiles,
} from "../src/brands.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const POSTER_ROOT = join(HERE, "..");
const SRC = join(POSTER_ROOT, "src");
const WORKFLOWS = join(POSTER_ROOT, "..", ".github", "workflows");

const registry = loadBrandRegistry();
const ldt = registry.brands.ldt;
const realty = registry.brands.realty;

// The Metricool profile shape: ONE row per Metricool brand, carrying every
// connected network as a field. That is why pausing the lane stops Facebook
// too — the Page is a field on the same row the IG handle identifies.
const LDT_PROFILE = {
  id: 4242, label: "Lifestyle Design Technologies",
  instagram: "lifestyledesigntechnologies", tiktok: "lifestyledesigntech",
  facebook: "LifestyleDesignTechnologies",
};
const REALTY_PROFILE = {
  id: 1111, label: "Lifestyle Design Realty",
  instagram: "lifestyledesignrealty", tiktok: "lifestyledesignrealty",
};

// ── The subprocess harness ──────────────────────────────────────────────────
// Runs the real entrypoint with global fetch replaced by a recorder that
// refuses and logs. Any network attempt is therefore both BLOCKED (no live
// call escapes a test run) and VISIBLE (the URL lands in a file we assert on).
function runLane(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ldt-pause-"));
  const calls = join(dir, "calls.log");
  const preload = join(dir, "no-network.mjs");
  writeFileSync(preload, `
import { appendFileSync } from "node:fs";
globalThis.fetch = (url, ...rest) => {
  appendFileSync(${JSON.stringify(calls)}, String(url) + "\\n");
  throw new Error("NETWORK BLOCKED IN TEST: " + String(url));
};
`);
  writeFileSync(calls, "");
  let stdout = "", status = 0;
  try {
    stdout = execFileSync(process.execPath, ["--import", preload, join(SRC, "ldt-main.js")], {
      cwd: POSTER_ROOT,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
      // env -i: no secrets, no inherited config. A paused lane must not need any.
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    });
  } catch (err) {
    status = err.status ?? 1;
    stdout = (err.stdout || "") + (err.stderr || "");
  }
  const network = readFileSync(calls, "utf-8").split("\n").filter(Boolean);
  return { stdout, status, network };
}

// Every log marker that only appears once the lane has started doing work.
// If a paused run prints any of these, the gate is sitting too low.
const WORK_MARKERS = [
  "Target brand resolved",      // Metricool profile listing happened
  "Postable platforms",         // cadence/gap evaluated
  "Trying clip:",               // Drive download started
  "Self-made plan for this slot",
  "Uploading",                  // media upload
  "Cadence guard",
  "Min-gap guard",
];

describe("LDT pause switch — config", () => {
  test("the ldt brand is paused in brands.json", () => {
    assert.equal(ldt.enabled, false, 'brands.ldt.enabled must be exactly false');
    assert.equal(brandIsPaused(ldt), true);
    assert.equal(brandPostingEnabled(ldt), false);
  });

  test("pausing is one key — the lane keeps everything it needs to come back", () => {
    // The reversibility contract. A pause that stripped the handles, cadence
    // or claims file would be a deletion wearing a pause's clothes, and
    // turning the lane back on would be a rewrite rather than one edit.
    assert.deepEqual(ldt.handles.instagram, ["lifestyledesigntechnologies"]);
    assert.deepEqual(ldt.handles.tiktok, ["lifestyledesigntech"]);
    assert.ok(ldt.cadence && Object.keys(ldt.cadence).length >= 2, "cadence survives the pause");
    assert.ok(ldt.minGapHours > 0, "min-gap survives the pause");
    assert.ok(ldt.labelPatterns?.length, "label patterns survive the pause");
    assert.equal(ldt.claimsFile, "ldt-claims.json");
  });

  test("realty has no enabled key at all, and reads as enabled", () => {
    // The flag is opt-in to pausing: absent means running. That is what keeps
    // its introduction a no-op for every brand that did not ask for it.
    assert.equal("enabled" in realty, false, "realty must not have gained an enabled key");
    assert.equal(brandPostingEnabled(realty), true);
    assert.equal(brandIsPaused(realty), false);
  });

  test("only an explicit true keeps a lane running once the key is present", () => {
    // Fail toward silence: the costly mistake is a lane that keeps publishing
    // because the value meant to stop it was mistyped.
    assert.equal(brandPostingEnabled({}), true, "no key = enabled");
    assert.equal(brandPostingEnabled({ enabled: true }), true);
    for (const bad of [false, "false", "true", 0, 1, null, undefined, "", "yes"]) {
      assert.equal(brandPostingEnabled({ enabled: bad }), false,
        `enabled: ${JSON.stringify(bad)} must read as paused, not as running`);
    }
    assert.equal(brandPostingEnabled(null), false);
  });

  test("the built-in fallback registry carries the pause too", () => {
    // brands.json going missing or unparseable is not consent to resume: the
    // fallback is what the loader uses then, and it must be paused as well.
    const src = readFileSync(join(SRC, "brands.js"), "utf-8");
    const fallback = /const FALLBACK_REGISTRY = \{[\s\S]*?\n\};/.exec(src);
    assert.ok(fallback, "FALLBACK_REGISTRY still exists");
    const ldtBlock = fallback[0].slice(fallback[0].indexOf("ldt:"));
    assert.match(ldtBlock, /enabled:\s*false/,
      "the fallback ldt brand must be paused — a corrupt config must not restart the lane");
  });
});

describe("LDT pause switch — realty is untouched", () => {
  test("a PAUSED brand still claims its Metricool profiles", () => {
    // THE load-bearing assertion of this whole change. Realty posts to every
    // profile nobody claims; an unclaimed LDT profile is an LDT account
    // receiving realty reels.
    assert.equal(profileClaimedBy(LDT_PROFILE, ldt), true,
      "a paused brand must still claim its profiles");
    assert.equal(claimingBrandKey(LDT_PROFILE, registry), "ldt",
      "the pause must not make the LDT profile look unclaimed");
  });

  test("the realty fan-out still excludes the paused brand's profiles", () => {
    const kept = excludeClaimedProfiles([REALTY_PROFILE, LDT_PROFILE], registry, () => {});
    assert.deepEqual(kept, [REALTY_PROFILE],
      "realty must never inherit the LDT accounts because the LDT lane is resting");
    assert.equal(kept.includes(LDT_PROFILE), false);
  });

  test("every LDT network is excluded from realty, Facebook Page included", () => {
    // The Page has no entry in brands.json handles — it is claimed because it
    // is a FIELD on the same profile row the IG handle identifies. Pinned
    // per-network so a future refactor of profileClaimedBy cannot quietly
    // drop the Page and leave it exposed to the realty fan-out.
    for (const only of [
      { id: 1, label: "x", instagram: "lifestyledesigntechnologies" },
      { id: 2, label: "x", tiktok: "lifestyledesigntech" },
      { id: 3, label: "Lifestyle Design Technologies" },
      { id: 4, label: "LDT" },
    ]) {
      assert.equal(excludeClaimedProfiles([only], registry, () => {}).length, 0,
        `profile ${JSON.stringify(only)} must stay claimed by the paused ldt brand`);
    }
  });

  test("realty-only discovery is byte-identical — the pause changed nothing for it", () => {
    const profiles = [REALTY_PROFILE, { id: 9, label: "Some Other Realty Brand", instagram: "another" }];
    const kept = excludeClaimedProfiles(profiles, registry, () => {});
    assert.deepEqual(kept, profiles, "with no LDT profile present, discovery is the input unchanged");
    assert.equal(kept[0], profiles[0], "same object identity, not a copy");
    assert.equal(kept[1], profiles[1]);
  });

  test("the LDT lane can still FIND its profiles while paused", () => {
    // Resolution is unchanged; only posting stopped. This is what makes the
    // restore a config flip rather than a debugging session.
    assert.deepEqual(findBrandProfiles([REALTY_PROFILE, LDT_PROFILE], ldt), [LDT_PROFILE]);
  });

  test("structural: the claim path never consults the pause flag", () => {
    // Behavioural tests above prove today's code. This proves the NEXT edit:
    // the moment someone teaches claimingBrandKey to skip disabled brands,
    // the LDT accounts become realty's. Read the claim functions' bodies and
    // require that none of them mention the flag.
    const src = readFileSync(join(SRC, "brands.js"), "utf-8");
    for (const fn of ["profileClaimedBy", "claimingBrandKey", "excludeClaimedProfiles", "findBrandProfiles"]) {
      const start = src.indexOf(`export function ${fn}(`);
      assert.notEqual(start, -1, `${fn} exists`);
      const next = src.indexOf("\nexport function ", start + 1);
      const body = src.slice(start, next === -1 ? undefined : next);
      assert.equal(/brandPostingEnabled|brandIsPaused|\.enabled\b/.test(body), false,
        `${fn} must NOT read the pause flag — a paused brand that stops claiming its profiles hands them to the realty fan-out`);
    }
  });

  test("the realty entrypoint does not import the pause helper", () => {
    // Nothing about realty's own run should have changed.
    const main = readFileSync(join(SRC, "main.js"), "utf-8");
    assert.equal(/brandIsPaused|brandPostingEnabled/.test(main), false,
      "src/main.js (realty) must be untouched by the LDT pause");
  });
});

describe("LDT pause switch — the runner refuses, end to end", () => {
  test("a scheduled-shape run exits GREEN and says why", () => {
    const { stdout, status } = runLane();
    assert.equal(status, 0, `paused lane must exit 0, got ${status}. Output:\n${stdout}`);
    assert.match(stdout, /brand is paused — no posting/,
      "the operator asked for this exact line");
    assert.match(stdout, /enabled/, "the log must name the switch that stopped it");
    assert.match(stdout, /uncomment the schedule/i, "the log must say how to bring it back");
  });

  test("a paused run makes ZERO network calls", () => {
    // The strongest form of "posts nothing": it never reaches the wire at
    // all — no Metricool profile listing, no Drive, no Anthropic, no
    // ElevenLabs. Nothing to publish with and nothing spent.
    const { network, stdout } = runLane();
    assert.deepEqual(network, [],
      `a paused lane must not touch the network, attempted: ${network.join(", ")}\n${stdout}`);
  });

  test("a paused run reaches none of the working stages", () => {
    const { stdout } = runLane();
    for (const marker of WORK_MARKERS) {
      assert.equal(stdout.includes(marker), false,
        `paused run printed "${marker}" — the gate is below work it should be above`);
    }
  });

  test("it stays paused on every slot, mode and pin", () => {
    // "No posts on any slot": the gate is above MODE, above the intake
    // folder, above the FORCE pin — there is no dispatch shape that posts.
    for (const env of [
      {}, { MODE: "auto" }, { MODE: "clip" }, { MODE: "selfmade" }, { MODE: "promo" },
      { FORCE_VIDEO_ID: "1AbCdEfGhIjKlMnOpQrStUv", MODE: "clip" },
      { LDT_INTAKE_FOLDER_ID: "some-folder-id" },
      { METRICOOL_API_TOKEN: "t", METRICOOL_BLOG_ID: "1", METRICOOL_USER_ID: "2" },
      { DRY_RUN: "false" },
      { DRY_RUN: "TRUE" },   // not the literal "true" — must NOT open the gate
      { DRY_RUN: "1" },
    ]) {
      const { status, network, stdout } = runLane(env);
      const shape = JSON.stringify(env);
      assert.equal(status, 0, `${shape} must exit green, got ${status}:\n${stdout}`);
      assert.match(stdout, /brand is paused — no posting/, `${shape} must hit the pause gate`);
      assert.deepEqual(network, [], `${shape} must make no network calls`);
    }
  });

  test("the FORCE pin cannot punch through the pause", () => {
    // A pin normally exits RED when it cannot post, on purpose. While the
    // lane is paused it must exit GREEN instead: the lane is off, which is
    // not the pin failing, and a red run here would page the operator for a
    // state they chose.
    const { status, stdout, network } = runLane({ FORCE_VIDEO_ID: "1AbCdEfGhIjKlMnOpQrStUv" });
    assert.equal(status, 0, `a pin on a paused lane must exit green, got ${status}:\n${stdout}`);
    assert.deepEqual(network, []);
    assert.equal(stdout.includes("FORCE_VIDEO_ID dispatch refused"), false,
      "the pin should meet the pause gate, not the cadence refusal below it");
  });

  test("the gate sits above every cost in main()", () => {
    // Structural backstop for the behavioural tests: inside main(), the pause
    // check must precede the claims load, the cadence resolve, the posted-log
    // read and the Metricool listing. Ordering is the whole property here.
    const src = readFileSync(join(SRC, "ldt-main.js"), "utf-8");
    const main = src.slice(src.indexOf("async function main()"));
    const gate = main.indexOf("brandIsPaused(brand)");
    assert.notEqual(gate, -1, "main() must consult brandIsPaused");
    for (const after of ["loadLdtClaims(", "resolveCadence(", "loadLog(", "await listProfiles(", "findBrandProfiles("]) {
      const at = main.indexOf(after);
      assert.notEqual(at, -1, `${after} still exists in main()`);
      assert.ok(gate < at, `the pause gate must run BEFORE ${after}`);
    }
  });
});

describe("LDT pause switch — manual dry run still works", () => {
  test("an explicit DRY_RUN dispatch is let through the gate", () => {
    const { stdout } = runLane({ DRY_RUN: "true" });
    assert.match(stdout, /brand is paused/, "it still announces the pause");
    assert.match(stdout, /Continuing anyway because this is an explicit DRY RUN/,
      "a dry run must not be blocked — the operator kept it for testing");
    // It got past the gate and went to work: the Metricool listing is the
    // first thing below, and our harness blocks it. Reaching the wire at all
    // is the proof the gate opened.
    const { network } = runLane({ DRY_RUN: "true", METRICOOL_USER_ID: "1", METRICOOL_API_TOKEN: "t" });
    assert.ok(network.length > 0, "a dry run should proceed to the work below the gate");
  });

  test("a dry run cannot publish, which is why it is allowed through", () => {
    // The premise the carve-out rests on. If any of these three lost their
    // dryRun short-circuit, letting dry runs past the pause would stop being
    // safe — so they are pinned here, next to the exception they justify.
    const metricool = readFileSync(join(SRC, "metricool.js"), "utf-8");
    const post = metricool.slice(metricool.indexOf("export async function createSingleBrandPost("));
    const guard = post.indexOf("if (dryRun)");
    const wire = post.indexOf("await fetch(");
    assert.ok(guard !== -1 && guard < wire, "createSingleBrandPost must return on dryRun before its fetch");

    const ldtMain = readFileSync(join(SRC, "ldt-main.js"), "utf-8");
    assert.match(ldtMain, /if \(!DRY_RUN\) \{\s*\n\s*const sha256b64[\s\S]*?uploadToBrand\(/,
      "the clip upload must be inside a !DRY_RUN branch");

    const vo = readFileSync(join(SRC, "ldt-voiceover.js"), "utf-8");
    assert.match(vo, /if \(dryRun\)/, "applyLdtVoiceover must short-circuit on dryRun");
  });
});

describe("LDT pause switch — the workflow fires no slot", () => {
  const yml = readFileSync(join(WORKFLOWS, "ldt-post.yml"), "utf-8");

  test("no live cron remains", () => {
    const live = yml.split("\n").filter(l => /^\s*- cron:/.test(l));
    assert.deepEqual(live, [], "a paused lane must have no live schedule");
  });

  test("the schedule key itself is commented, not merely emptied", () => {
    // `schedule:` with no entries is not valid workflow syntax — it has to go
    // too, or the file stops parsing and every dispatch fails with it.
    assert.equal(/^\s*schedule:\s*$/m.test(yml), false, "the live schedule: key must be gone");
    assert.match(yml, /^\s*#\s*schedule:\s*$/m, "the commented schedule: key must remain for the restore");
  });

  test("the crons are preserved as comments so restoring is an uncomment", () => {
    const commented = yml.split("\n").filter(l => /^\s*#\s*- cron:/.test(l));
    const perDay = Math.max(...Object.values(ldt.cadence));
    assert.equal(commented.length, perDay,
      "every slot of the configured cadence must still be in the file, commented out");
  });

  test("the lane is still dispatchable, with dry_run", () => {
    assert.match(yml, /^\s*workflow_dispatch:/m, "manual dispatch must survive the pause");
    assert.match(yml, /^\s+dry_run:/m, "the dry_run input must survive the pause");
    assert.match(yml, /node src\/ldt-main\.js/, "and it still runs the real entrypoint");
  });

  test("the file says how to turn the lane back on", () => {
    assert.match(yml, /TO RESUME/i, "the restore steps belong next to the switch they undo");
  });
});
