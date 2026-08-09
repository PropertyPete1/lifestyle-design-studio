#!/usr/bin/env node
/**
 * probe-full-chain.mjs — the whole build path, three times cold, then broken
 * on purpose at every seam that can be broken locally.
 *
 * Part E of the pre-launch block. The per-module matrices prove the pieces;
 * every expensive bug so far lived BETWEEN them — the thumbnail no stage
 * generated, the retention edit no stage fed, the dry run that stopped
 * predicting the build. So this exercises the chain end to end through the
 * dry-run chassis, which since the parity fix runs the same stage functions as
 * the real pipeline: synthesize -> transcribe (real Whisper) -> match -> plan
 * -> visuals -> opening -> retention edit + PIP + cadence -> render -> verify
 * the mp4 with ffprobe.
 *
 * EVERY RUN IS A SUBPROCESS WITH A FRESH WORK DIR — cold by construction, no
 * state crossing runs. Every assertion is on the artifact or the chassis's
 * reported behaviour, never on "it exited 0" alone.
 *
 * WHAT THIS DELIBERATELY DOES NOT COVER, and where that lives instead:
 *   - Metricool upload seams ........ probe-upload-preflight / probe-multipart
 *   - post read-back providers[].id . known-unknowns register (needs video 1)
 *   - thumbnails.set / playlists .... yt-distribute tests + known-unknowns
 *   - approve-twice idempotency ..... yt-approvals unit tests
 *   - dashboard/poster write races .. merge-strategies unit tests
 * The launch audit maps every scenario to its covering evidence; this probe is
 * the chain-shaped piece of that map.
 *
 *   node longform/probe/probe-full-chain.mjs            # everything
 *   PROBE_ONLY=e1 node longform/probe/probe-full-chain.mjs
 */

import { execFileSync, spawnSync, execSync } from "child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, copyFileSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const POSTER = join(HERE, "..", "..", "auto-poster");
const CHASSIS = join(POSTER, "scripts", "dry-run-build.mjs");
const OUT = process.env.PROBE_OUT_DIR || join(tmpdir(), `full-chain-${Date.now()}`);
mkdirSync(OUT, { recursive: true });

const results = [];
let current = null;
const scenario = (name) => { current = { name, checks: [], failures: [] }; results.push(current); };
const check = (label, cond, detail = "") => {
  current.checks.push(label);
  if (!cond) current.failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
};

/** Run the chassis once, cold. Returns exit code + full output + artifact facts. */
function runChain(name, { scriptPath = null, recordingsDir = null, env = {}, expectFail = false } = {}) {
  const work = join(OUT, name);
  rmSync(work, { recursive: true, force: true });
  const args = [CHASSIS, "--work", work];
  if (recordingsDir) args.push("--recordings", recordingsDir, "--broll", syntheticBroll());
  else args.push("--synthetic");
  if (scriptPath) args.push("--script", scriptPath);

  const res = spawnSync("node", args, {
    cwd: POSTER,
    encoding: "utf-8",
    timeout: 20 * 60_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, YT_NARRATION_MODE: "peter", ...env },
  });
  const output = `${res.stdout || ""}\n${res.stderr || ""}`;

  const finalPath = join(work, "render", "final.mp4");
  let duration = 0;
  if (existsSync(finalPath)) {
    try {
      duration = parseFloat(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", finalPath], { encoding: "utf-8" }).trim()) || 0;
    } catch { /* stays 0 — an unreadable file is not a rendered video */ }
  }
  return { code: res.status, output, work, finalPath, rendered: existsSync(finalPath), duration };
}

/** A synthesized recording of one line — real speech (say/espeak) on real frames. */
function speakTake(dir, id, text, { seconds = 8 } = {}) {
  mkdirSync(dir, { recursive: true });
  const wav = join(dir, `${id}.wav`);
  const mp4 = join(dir, `${id}.mp4`);
  try {
    execFileSync("say", ["-o", wav, "--data-format=LEI16@22050", text], { timeout: 120_000 });
  } catch {
    execFileSync("espeak", ["-w", wav, text], { timeout: 120_000 });
  }
  execFileSync("ffmpeg", ["-y", "-v", "error",
    "-f", "lavfi", "-i", `testsrc2=size=640x360:rate=30:duration=${seconds}`,
    "-i", wav, "-map", "0:v", "-map", "1:a",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest", mp4], { stdio: ["pipe", "pipe", "pipe"] });
  rmSync(wav, { force: true });
  return mp4;
}

/** The three-take script the injection scenarios run against. */
const SMALL_SCRIPT = {
  title: "Moving to San Antonio: the injection fixture",
  hook: "Your first bill here has a line nobody warned you about.",
  promise: "By the end you will know which line it is.",
  sections: [
    {
      title: "The line",
      boundaryPull: "The next number decides whether it applies to you.",
      takes: [
        { id: "s1t1", mode: "ON_CAMERA", text: "The first tax bill in this county carries a line that surprises nearly every buyer who moves here from out of state.", direction: "hook" },
        { id: "s1t2", mode: "VOICEOVER", text: "That line is an assessment for the utility district that built the pipes and the roads under the subdivision, and it lands on newer construction north and east of the city almost every single time you go looking at one of those houses.", direction: "over footage", visualIntent: "FOOTAGE" },
        // Sits well past the 15-second protected opening — a graphic inside
        // that window is correctly suppressed, which the first fixture
        // discovered by accident when its CALLOUT landed at second fourteen.
        { id: "s1t3", mode: "VOICEOVER", text: "The number itself changes by neighborhood, and the difference between the low end and the high end of that range is a great deal larger than most people moving here from out of state would ever expect it to be.", direction: "over footage", visualIntent: { type: "CALLOUT", spec: { value: "41 days", label: "median time on market" } } },
      ],
    },
  ],
  softCta: { mode: "ON_CAMERA", text: "Drop the neighborhood you are looking at in the comments and I will reply with which district it sits in.", direction: "light" },
  close: { mode: "ON_CAMERA", text: "Text me at the number on the screen and I will run the actual numbers on the exact house you are considering.", direction: "direct" },
};

/**
 * Recordings-mode runs need a --broll dir — the chassis refuses to invent
 * footage outside --synthetic. The probe's first pass missed this, and the
 * cost was worse than the two visibly failing scenarios: the two "passing"
 * failure scenarios were passing FOR THE WRONG REASON, dying on the missing
 * B-roll dir before ever reaching the injected fault. A scenario that fails
 * for a different reason than the one injected proves nothing.
 */
function syntheticBroll() {
  const dir = join(OUT, "broll");
  if (existsSync(join(dir, "b0.mp4"))) return dir;
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 4; i++) {
    execFileSync("ffmpeg", ["-y", "-v", "error",
      "-f", "lavfi", "-i", `testsrc2=size=640x360:rate=30:duration=20`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p", "-an",
      join(dir, `b${i}.mp4`)], { stdio: ["pipe", "pipe", "pipe"] });
  }
  return dir;
}

const scriptPath = join(OUT, "small-script.json");
writeFileSync(scriptPath, JSON.stringify(SMALL_SCRIPT, null, 1));

/** Synthesize the full recording set for SMALL_SCRIPT into a fresh dir. */
function fullRecordings(name) {
  const dir = join(OUT, name);
  rmSync(dir, { recursive: true, force: true });
  const takes = [
    ...SMALL_SCRIPT.sections[0].takes,
    { id: "cta", ...SMALL_SCRIPT.softCta },
    { id: "close", ...SMALL_SCRIPT.close },
  ];
  for (const t of takes) speakTake(dir, t.id, t.text);
  return dir;
}

// ═══ E1 — three complete cold runs, three different scripts ═════════════════

if (!process.env.PROBE_ONLY || process.env.PROBE_ONLY === "e1") {
  const fixtures = [
    ["default", null],
    ["intents", scriptPath],
  ];
  // The third script: longer takes, forcing punch-in subdivision through the chain.
  const longScript = {
    ...SMALL_SCRIPT,
    title: "Moving to San Antonio: the long-take fixture",
    sections: [{
      title: "One long block",
      boundaryPull: "The next part is the half nobody prices in.",
      takes: [
        { id: "s1t1", mode: "ON_CAMERA", text: "The first tax bill in this county carries a line that surprises nearly every buyer who moves here, and the reason it surprises them is that no listing anywhere shows it, no lender quotes it, and the sales office has no reason at all to bring it up while you are standing in the model home admiring the kitchen island and the ten foot ceilings they built specifically to be admired.", direction: "long hook" },
        { id: "s1t2", mode: "VOICEOVER", text: "That line is an assessment for the utility district that built the pipes under the subdivision, and it lands on newer construction north and east of the city almost every single time you look at one.", direction: "over footage", visualIntent: "FOOTAGE" },
      ],
    }],
  };
  const longPath = join(OUT, "long-script.json");
  writeFileSync(longPath, JSON.stringify(longScript, null, 1));
  fixtures.push(["long-takes", longPath]);

  const runs = [];
  for (const [name, sp] of fixtures) {
    scenario(`E1 cold run: ${name}`);
    const r = runChain(`e1-${name}`, { scriptPath: sp });
    runs.push({ name, ...r });
    check("chain exits clean", r.code === 0, `exit ${r.code}: ${r.output.split("\n").filter((l) => /error|Error/.test(l)).slice(-2).join(" | ")}`);
    check("final.mp4 exists and ffprobe reads it", r.rendered && r.duration > 10, `${r.duration}s`);
    check("the retention edit ran", /Retention edit:/.test(r.output));
    check("the assembler consumed the edit", /piece\(s\).*dead air removed/.test(r.output), "no per-take edit line in the RENDER output");
    check("PIP reached a verdict on every narrated take", /PIP: \d+ segment/.test(r.output));
    check("the cadence audit ran", /Cadence:/.test(r.output));
    check("captions were burned", /caption chunks/.test(r.output));
    check("visuals stage reported its split", /% graphic \/ \d+% footage/.test(r.output));
  }

  scenario("E1 determinism: the same script twice is the same video");
  const again = runChain("e1-default-again", {});
  const first = runs.find((r) => r.name === "default");
  check("both runs rendered", again.rendered && first.rendered);
  check(
    "durations agree within a tenth of a second",
    Math.abs(again.duration - first.duration) < 0.1,
    `${first.duration}s vs ${again.duration}s — nondeterminism between identical cold runs is itself a finding`
  );

  scenario("E1 difference: different scripts produce different videos");
  const intents = runs.find((r) => r.name === "intents");
  check("the intents fixture rendered a different video", Math.abs(intents.duration - first.duration) > 1, "identical output from different scripts — the --script flag is being ignored again");
  check("the intents run spliced a graphic", /\d+ rendered/.test(intents.output) && !/ 0 rendered/.test(intents.output), "the CALLOUT intent never became pixels");
}

// ═══ E2 — break each seam, expect loud and correct ══════════════════════════

if (!process.env.PROBE_ONLY || process.env.PROBE_ONLY === "e2") {
  scenario("E2: an on-camera take was never recorded");
  {
    const dir = fullRecordings("rec-missing-oncam");
    rmSync(join(dir, "s1t1.mp4"), { force: true });
    const r = runChain("e2-missing-oncam", { recordingsDir: dir, scriptPath });
    check("the build does NOT produce a final video", !r.rendered, "a video rendered around a missing on-camera take");
    check("it fails FOR THE MISSING TAKE, not something else", /on-camera take\(s\)|missing.*s1t1|s1t1.*missing/i.test(r.output),
      `the failure is not about the take: ${r.output.split("\n").filter((l) => /FAILED|Error/.test(l)).slice(0, 1).join("")}`);
  }

  scenario("E2: a voiceover take missing in peter mode — the clone fills it, disclosure fires");
  {
    const dir = fullRecordings("rec-missing-vo");
    rmSync(join(dir, "s1t3.mp4"), { force: true });
    const r = runChain("e2-missing-vo", { recordingsDir: dir, scriptPath });
    check("the build completes — voiceover is fillable", r.code === 0 && r.rendered, `exit ${r.code}`);
    check("the fill is visible in the output", /offline narration|narrated \d+ voiceover/.test(r.output), "the clone filling a take must never be silent");
  }

  scenario("E2: a clip that matches no script line");
  {
    const dir = fullRecordings("rec-stray");
    speakTake(dir, "stray", "This sentence belongs to no take in the script and talks about fishing boats on a calm lake at dawn.");
    const r = runChain("e2-stray", { recordingsDir: dir, scriptPath });
    check("the build completes", r.code === 0 && r.rendered);
    check("the stray is reported, not silently ignored", /stray|unmatched/i.test(r.output));
  }

  scenario("E2: a corrupt recording");
  {
    const dir = fullRecordings("rec-corrupt");
    writeFileSync(join(dir, "s1t1.mp4"), Buffer.from("this is not a video file at all"));
    const r = runChain("e2-corrupt", { recordingsDir: dir, scriptPath });
    check("the corrupt file does not become a rendered video with a hole", !r.rendered || /missing|s1t1|transcription (failed|error)/i.test(r.output), "a corrupt on-camera take must surface, not vanish");
  }

  scenario("E2: PIP disabled by the per-video flag");
  {
    const r = runChain("e2-pip-off", { scriptPath, env: { YT_PIP_ENABLED: "false" } });
    check("the build completes", r.code === 0 && r.rendered);
    check("PIP reports disabled rather than silently absent", /PIP: disabled/.test(r.output));
    check("no cutouts were produced", !existsSync(join(r.work, "retention")) || readdirSync(join(r.work, "retention")).every((f) => !f.startsWith("cutout-")));
  }

  scenario("E2: jump cuts disabled leaves runtime intact");
  {
    const r = runChain("e2-cuts-off", { scriptPath, env: { YT_JUMP_CUTS: "false" } });
    check("the build completes", r.code === 0 && r.rendered);
    check("no dead air was removed", /0s of dead air removed|0 of \d+ on-camera take\(s\) edited/.test(r.output), "with jump cuts off nothing should be cut");
  }
}

// ─── report ─────────────────────────────────────────────────────────────────

console.log(`\n${"=".repeat(74)}\nFULL-CHAIN PROBE\n${"=".repeat(74)}\n`);
let checks = 0, failures = 0;
for (const r of results) {
  checks += r.checks.length;
  failures += r.failures.length;
  console.log(`${r.failures.length ? "FAIL" : "PASS"}  ${r.name}  (${r.checks.length} checks)`);
  for (const f of r.failures) console.log(`      ✗ ${f}`);
}
const empty = results.filter((r) => r.checks.length === 0);
console.log(`\n${results.length} scenarios, ${checks} checks, ${failures} failures${empty.length ? `, ${empty.length} VACUOUS` : ""}`);
console.log(`artifacts in ${OUT}`);
console.log(failures === 0 && empty.length === 0 ? "\nZERO FAILURES\n" : "\nFAILURES PRESENT\n");
process.exit(failures === 0 && empty.length === 0 ? 0 : 1);
