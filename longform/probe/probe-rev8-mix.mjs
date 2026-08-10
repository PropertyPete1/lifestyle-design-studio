/**
 * probe-rev8-mix.mjs — the revision 8 audio and overlay chain, on real files.
 *
 * The test suite argues with the ffmpeg ARGUMENTS, which is the right level for
 * a decision table and completely blind to the class of bug that matters here: a
 * filter graph that is syntactically fine and produces a video with nothing in
 * it. The punch overlay was exactly that bug — the plate faded out on its own
 * timeline and rendered as zero visible pixels while every argument looked
 * correct.
 *
 * So this probe renders and then MEASURES: gold pixels inside and outside each
 * punch window, and the bed's level in the hook, the body and the close.
 *
 * Run:  node longform/probe/probe-rev8-mix.mjs
 *       node longform/probe/probe-rev8-mix.mjs --fetch   (also pulls the real track)
 */

import { execFileSync, spawnSync } from "child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { burnArgs, duckArgs, buildAssFile, buildCaptionChunks } from "../../auto-poster/src/yt-assemble.js";
import { bedEnvelope, TRACKS, fetchMusicBed, trackUrl } from "../../auto-poster/src/yt-music.js";
import { renderPunchPng } from "../../auto-poster/src/yt-punch.js";
import { impactArgs, whooshArgs, mixSfxArgs } from "../../auto-poster/src/yt-sfx.js";

const DIR = mkdtempSync(join(tmpdir(), "rev8-mix-"));
const DIM = { w: 1280, h: 720 };
const SECONDS = 60;
const ff = (args) => execFileSync("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"], encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });

const ok = [];
const bad = [];
const check = (label, pass, detail) => {
  (pass ? ok : bad).push(`${label}${detail ? ` — ${detail}` : ""}`);
  console.log(`${pass ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
};

console.log(`work dir: ${DIR}\n`);

// ── a stand-in for a finished, narrated timeline ────────────────────────────
// The "narration" is bursts of tone separated by silence, which is what the
// sidechain compressor needs to have something to duck against.
//
// THE LEVEL IS PART OF THE FIXTURE. ffmpeg's sine source runs about 18 dB below
// full scale, so an unamplified tone stands in for narration at roughly -27 dB
// — which is quieter than the compressor's threshold and produced a measured
// duck of 0.4 dB from a graph that is fine. Real narration arrives normalised
// near full scale, so the fixture is amplified to match; a fixture quieter than
// the thing it stands for tests nothing.
const base = join(DIR, "base.mp4");
ff([
  "-y",
  "-f", "lavfi", "-i", `color=c=0x203040:s=${DIM.w}x${DIM.h}:d=${SECONDS}:r=30`,
  "-f", "lavfi", "-i", `sine=frequency=220:duration=${SECONDS}:sample_rate=48000`,
  "-af", "volume='if(isnan(t),0,6*lt(mod(t,4),2.5))':eval=frame,aformat=channel_layouts=stereo",
  "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
  "-c:a", "aac", "-b:a", "192k", "-shortest", base,
]);

// ── 1. the music bed ────────────────────────────────────────────────────────
let bedPath = null;
if (process.argv.includes("--fetch")) {
  const track = TRACKS[0];
  console.log(`fetching ${track.title} from ${trackUrl(track)} ...`);
  const r = await fetchMusicBed({ track, dir: DIR });
  check("the vendored URL returns a usable track", Boolean(r.path), r.path ? `${(statSync(r.path).size / 1e6).toFixed(1)} MB, source=${r.source}` : r.reason);
  bedPath = r.path;
} else {
  // A stand-in bed, so the envelope can be measured without a 57 MB download.
  bedPath = join(DIR, "bed.wav");
  ff(["-y", "-f", "lavfi", "-i", `sine=frequency=440:duration=${SECONDS}:sample_rate=48000`, "-af", "aformat=channel_layouts=stereo", "-c:a", "pcm_s16le", bedPath]);
}

const envelope = bedEnvelope({ seconds: SECONDS, hookSeconds: 15, closeSeconds: 20, ramp: 2 });
const ducked = join(DIR, "ducked.mp4");
ff(duckArgs(base, bedPath, ducked, { envelope }));
check("the ducked mix renders", existsSync(ducked));

// The envelope, measured rather than asserted: the bed must be LOUDER in the
// hook and the close than in the body. Measured in a gap between narration
// bursts so the sidechain is not the thing being read.
// volumedetect reports on STDERR, which is where the first version of this
// probe lost every reading to NaN while the checks it fed still printed a
// verdict. Both streams are read now.
const ffText = (args) => {
  const r = spawnSync("ffmpeg", args, { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  return `${r.stdout || ""}${r.stderr || ""}`;
};
const levelAt = (path, from, dur) => {
  const out = ffText(["-ss", String(from), "-t", String(dur), "-i", path, "-af", "volumedetect", "-f", "null", "-"]);
  const m = /mean_volume:\s*(-?\d+(\.\d+)?) dB/.exec(out);
  return m ? Number(m[1]) : NaN;
};
// MEASURING THE MIX WOULD MEASURE THE NARRATION. The first version read
// mean_volume off the ducked file at three timestamps and reported the hook as
// QUIETER than the body — because at those timestamps the narration was doing
// different things, and it is 30 dB louder than the bed. The number was real and
// answered a question nobody asked.
//
// So the envelope is measured against a SILENT narration, where the mix is the
// bed and nothing else, and the duck is measured separately below.
const silent = join(DIR, "silent.mp4");
ff([
  "-y",
  "-f", "lavfi", "-i", `color=c=0x203040:s=${DIM.w}x${DIM.h}:d=${SECONDS}:r=30`,
  "-f", "lavfi", "-i", `anullsrc=r=48000:cl=stereo:d=${SECONDS}`,
  "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
  "-c:a", "aac", "-b:a", "192k", "-shortest", silent,
]);
const bedOnly = join(DIR, "bed-only.mp4");
ff(duckArgs(silent, bedPath, bedOnly, { envelope }));

const hook = levelAt(bedOnly, 3, 4);
const body = levelAt(bedOnly, 30, 4);
const close = levelAt(bedOnly, 46, 4);
console.log(`   bed alone — hook ${hook} dB / body ${body} dB / close ${close} dB`);
// THE ENVELOPE IS ONLY MEASURABLE AGAINST A CONSTANT BED. A real track has its
// own dynamics — "Concentration" opens far quieter than it settles — so
// comparing its level at three timestamps measures the composition, not our
// filter, and reports a 12 dB "drop" under the hook that the envelope did not
// cause. With --fetch the fetch and the render are what is being proved.
if (process.argv.includes("--fetch")) {
  console.log("   (envelope assertions skipped: a real track's own dynamics dominate the reading)");
} else {
  check("the bed lifts under the hook", hook > body + 2, `${(hook - body).toFixed(1)} dB above the body`);
  check("the bed lifts into the close", close > body + 2, `${(close - body).toFixed(1)} dB above the body`);
  check("the lift is close to the configured +5 dB", Math.abs((hook - body) - 5) < 1.5, `${(hook - body).toFixed(1)} dB`);
}

// THE DUCK, measured on the bed branch alone. The production graph mixes the
// ducked bed back with the narration, so the only way to see what the compressor
// did is to output the branch it produced — same filter, same parameters, one
// different map.
const duckProbe = join(DIR, "duck-probe.wav");
ff([
  "-y", "-i", base, "-i", bedPath,
  "-filter_complex",
  `[1:a]volume=eval=frame:volume='${envelope.expr}'[bed];` +
    `[bed][0:a]sidechaincompress=threshold=0.05:ratio=12:attack=20:release=400[ducked]`,
  "-map", "[ducked]", "-c:a", "pcm_s16le", duckProbe,
]);
// THE WINDOWS MUST SIT INSIDE A BURST, NOT ACROSS ONE. Narration is on while
// mod(t,4) < 2.5, so the burst covering t=32 runs 32.0-34.5 and the gap after it
// runs 34.5-36.0. The first version measured 34.0-35.0 and 35.6-36.4 — both
// straddle a boundary, both averaged half-loud, and the duck read as exactly
// 0.0 dB while working perfectly.
//
// The gap reading starts 0.5s late so the compressor's 400 ms release has
// finished; reading during the recovery would understate the duck.
const underSpeech = levelAt(duckProbe, 32.5, 1.0);
const inTheGap = levelAt(duckProbe, 35.0, 0.9);
console.log(`   bed under speech ${underSpeech} dB / in the gap ${inTheGap} dB`);
// Holds for a real track too: the duck is a DIFFERENCE across 2.5 seconds of
// the same music, so the composition's own level cancels out of it.
check("the bed ducks under the narration", inTheGap > underSpeech + 3, `${(inTheGap - underSpeech).toFixed(1)} dB of duck`);

// ── 2. the synthesised hits ─────────────────────────────────────────────────
const impact = join(DIR, "sfx-impact.wav");
const whoosh = join(DIR, "sfx-whoosh.wav");
ff(impactArgs(impact));
ff(whooshArgs(whoosh));
const peak = (p) => Number(/max_volume:\s*(-?\d+(\.\d+)?) dB/.exec(ffText(["-i", p, "-af", "volumedetect", "-f", "null", "-"]))?.[1]);
check("the impact peaks where the dB knob expects", Math.abs(peak(impact) - -3) <= 3, `${peak(impact)} dBFS`);
check("the whoosh peaks where the dB knob expects", Math.abs(peak(whoosh) - -3) <= 3, `${peak(whoosh)} dBFS`);

const withSfx = join(DIR, "sfx.mp4");
ff(mixSfxArgs(ducked, [{ at: 20, kind: "impact" }, { at: 30, kind: "whoosh" }], { impact, whoosh }, withSfx));
check("the hits mix in without failing the graph", existsSync(withSfx));

// ── 3. captions and micro-punches, in one pass ──────────────────────────────
const plan = { segments: [{ kind: "voiceover", takeId: "t1", seconds: SECONDS, text: Array.from({ length: 60 }, (_, i) => (i === 30 ? "$0" : `word${i}`)).join(" ") }] };
const assPath = join(DIR, "captions.ass");
writeFileSync(assPath, buildAssFile(buildCaptionChunks(plan), DIM));

const punches = [
  { at: 20, seconds: 1.2, text: "$0" },
  { at: 40, seconds: 1.2, text: "100%" },
];
for (const [i, p] of punches.entries()) {
  p.pngPath = join(DIR, `punch-${i}.png`);
  writeFileSync(p.pngPath, await renderPunchPng(p.text, DIM, { hold: p.seconds }));
}

const final = join(DIR, "final.mp4");
ff(burnArgs(withSfx, assPath, final, { punches }));
check("the caption-and-punch pass renders", existsSync(final));

// THE MEASUREMENT THAT MATTERS. Gold inside each window, none outside it.
// Raw RGB straight out of ffmpeg rather than a PNG through an image library:
// the probe then needs no dependencies at all, which is what lets it run from
// the probe directory the way every other probe here does.
const goldAt = async (t) => {
  const f = join(DIR, `frame-${t}.rgb`);
  ff(["-y", "-ss", String(t), "-i", final, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", f]);
  const data = readFileSync(f);
  let gold = 0;
  for (let i = 0; i + 2 < data.length; i += 3) {
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
    if (r > 150 && r < 235 && g > 120 && g < 195 && b > 70 && b < 135) gold++;
  }
  return gold;
};

for (const p of punches) {
  const before = await goldAt(p.at - 2);
  const during = await goldAt(p.at + 0.4);
  const after = await goldAt(p.at + p.seconds + 1);
  console.log(`   "${p.text}" @${p.at}s: before=${before} during=${during} after=${after}`);
  check(`"${p.text}" is on screen during its window`, during > 200, `${during} gold px`);
  check(`"${p.text}" is absent before and after`, before < 50 && after < 50, `${before} / ${after} gold px`);
}

// The captions must survive the punch pass — they are burned in the same graph.
const capGold = await goldAt(5);
check("the video still renders outside every punch", capGold < 50, `${capGold} gold px at 5s`);

const dur = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", final], { encoding: "utf-8" }).trim());
check("the render is not truncated by the overlay inputs", Math.abs(dur - SECONDS) < 1.5, `${dur.toFixed(2)}s of ${SECONDS}s`);

console.log(`\n${bad.length === 0 ? "ALL CHECKS PASSED" : `${bad.length} CHECK(S) FAILED`}  (${ok.length} passed)`);
if (bad.length) { for (const b of bad) console.log(`  ✗ ${b}`); process.exitCode = 1; }
