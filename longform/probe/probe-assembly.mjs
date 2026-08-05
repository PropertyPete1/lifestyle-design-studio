#!/usr/bin/env node
/**
 * probe-assembly.mjs — Phase 0, question 3. Renders nothing to any platform.
 *
 * Question: can a GitHub Actions runner assemble a 10-15 minute long-form video
 * out of the pieces this format needs — an avatar segment, B-roll from the Drive
 * library, a music bed ducked under narration, and burned captions — at 1080p or
 * 4K, inside the job limits?
 *
 * The only honest way to answer that is to build one and time it, on the runner,
 * from the real footage. Synthetic test patterns encode nothing like drone and
 * walkthrough footage, so this pulls actual clips out of the Drive library.
 *
 * WHAT IT MEASURES, per resolution:
 *   - wall-clock for each stage (normalise, concat, duck, caption-burn),
 *   - total wall-clock against the 6-hour job ceiling,
 *   - output size against the 100MB Metricool ceiling and YouTube's 256GB,
 *   - peak working-directory bytes against the runner's free disk.
 *
 * The avatar segment is stood in for by a locally generated 1080p clip: HeyGen
 * hands back an ordinary 16:9 mp4, and what we are timing is OUR encode cost,
 * not theirs. Substituting the real thing later changes none of these numbers.
 */

import { execSync, execFileSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync, readdirSync, statSync, rmSync } from "fs";
import { join } from "path";
import { listCityVideos, downloadVideo } from "../../auto-poster/src/drive.js";

const WORK = process.env.PROBE_WORK_DIR || "/tmp/longform-probe";
const TARGET_MINUTES = Number(process.env.PROBE_TARGET_MINUTES || 12);
const RESOLUTIONS = (process.env.PROBE_RESOLUTIONS || "1080p").split(",").map(s => s.trim());
const CITY = process.env.PROBE_CITY || "san_antonio";
const BROLL_CLIPS = Number(process.env.PROBE_BROLL_CLIPS || 6);

const DIMS = {
  "1080p": { w: 1920, h: 1080 },
  "4k": { w: 3840, h: 2160 },
};

function sh(cmd, timeoutMs = 3 * 3600_000) {
  return execSync(cmd, { timeout: timeoutMs, stdio: ["pipe", "pipe", "pipe"], encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
}

function timed(label, fn) {
  const t0 = Date.now();
  process.stdout.write(`  ${label} ... `);
  try {
    const out = fn();
    const secs = (Date.now() - t0) / 1000;
    console.log(`${secs.toFixed(1)}s`);
    return { ok: true, seconds: secs, out };
  } catch (err) {
    const secs = (Date.now() - t0) / 1000;
    console.log(`FAILED after ${secs.toFixed(1)}s`);
    console.log(`    ${String(err.stderr || err.message).slice(-600)}`);
    return { ok: false, seconds: secs, error: String(err.stderr || err.message).slice(-600) };
  }
}

function mb(bytes) { return (bytes / 1024 / 1024).toFixed(1); }

function dirBytes(dir) {
  let total = 0;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    const st = statSync(p);
    total += st.isDirectory() ? dirBytes(p) : st.size;
  }
  return total;
}

function probeDuration(path) {
  return parseFloat(sh(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${path}"`, 60_000).trim());
}

function probeStreams(path) {
  const out = sh(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate,codec_name -of csv=p=0 "${path}"`, 60_000).trim();
  return out;
}

function reportEnvironment() {
  console.log("=== RUNNER ===");
  try { console.log(`  cpus: ${sh("nproc", 10_000).trim()}`); } catch { console.log(`  cpus: ${sh("sysctl -n hw.ncpu", 10_000).trim()}`); }
  try { console.log(`  mem:  ${sh("free -h | awk '/Mem:/{print $2\" total, \"$7\" available\"}'", 10_000).trim()}`); } catch {}
  try { console.log(`  disk: ${sh(`df -h ${WORK.startsWith("/tmp") ? "/tmp" : WORK} | tail -1 | awk '{print $2\" total, \"$4\" free\"}'`, 10_000).trim()}`); } catch {}
  console.log(`  ffmpeg: ${sh("ffmpeg -version | head -1", 10_000).trim()}`);
  const enc = sh("ffmpeg -hide_banner -encoders 2>/dev/null | grep -E ' (libx264|libx265|h264_nvenc|h264_vaapi) ' || true", 30_000).trim();
  console.log(`  encoders:\n${enc.split("\n").map(l => `    ${l.trim()}`).join("\n")}`);
}

/** Stand-in for a HeyGen segment: a 16:9 talking-head-shaped clip with speech-like audio. */
function makeAvatarStandIn(path, seconds, dim) {
  sh(
    `ffmpeg -y -f lavfi -i "testsrc2=size=${dim.w}x${dim.h}:rate=30:duration=${seconds}" ` +
    `-f lavfi -i "sine=frequency=220:duration=${seconds}" ` +
    `-c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -c:a aac -b:a 192k -shortest "${path}"`,
    600_000
  );
}

/** A music bed. Real beds are licensed mp3s; for timing, any continuous stereo track is equivalent. */
function makeMusicBed(path, seconds) {
  sh(
    `ffmpeg -y -f lavfi -i "anoisesrc=color=brown:duration=${seconds}:amplitude=0.3" ` +
    `-af "aformat=channel_layouts=stereo" -c:a aac -b:a 192k "${path}"`,
    600_000
  );
}

/** Narration stand-in with gaps, so the ducking has something to actually duck around. */
function makeNarration(path, seconds) {
  sh(
    `ffmpeg -y -f lavfi -i "sine=frequency=300:duration=${seconds}" ` +
    `-af "aformat=channel_layouts=stereo,tremolo=f=0.2:d=0.9" -c:a aac -b:a 192k "${path}"`,
    600_000
  );
}

/** Captions across the full runtime, at the density the existing pipeline produces. */
function makeAssFile(path, totalSeconds, dim) {
  const fontSize = Math.round(dim.h * 0.055);
  const lines = [];
  const CHUNK = 2.2; // seconds per caption chunk, matching groupWordsIntoChunks output
  const samples = [
    "this is the part everyone gets wrong",
    "the payment is not the price",
    "new construction under three hundred",
    "here is what that actually costs",
    "san antonio versus austin",
  ];
  for (let t = 0, i = 0; t < totalSeconds; t += CHUNK, i++) {
    const start = new Date(t * 1000).toISOString().substr(11, 11).replace(/^0/, "");
    const end = new Date(Math.min(t + CHUNK, totalSeconds) * 1000).toISOString().substr(11, 11).replace(/^0/, "");
    lines.push(`Dialogue: 0,${start},${end},Default,,0,0,0,,${samples[i % samples.length].toUpperCase()}`);
  }
  const header =
`[Script Info]
ScriptType: v4.00+
PlayResX: ${dim.w}
PlayResY: ${dim.h}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,${fontSize},&H00FFFFFF,&H00000000,&H80000000,-1,1,3,1,2,60,60,${Math.round(dim.h * 0.08)},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  writeFileSync(path, header + lines.join("\n") + "\n");
  return lines.length;
}

async function fetchBroll(dir) {
  console.log("\n=== B-ROLL FROM THE DRIVE LIBRARY ===");
  const videos = await listCityVideos(CITY);
  console.log(`  ${videos.length} clips in the ${CITY} folder`);
  const picked = videos.slice(0, BROLL_CLIPS);
  const paths = [];
  for (const v of picked) {
    const dest = join(dir, `broll_${paths.length}.mp4`);
    const buf = await downloadVideo(v.id, v.name);
    writeFileSync(dest, buf);
    const size = statSync(dest).size;
    console.log(`  ${v.name.slice(0, 50).padEnd(50)} ${mb(size).padStart(7)} MB  ${probeStreams(dest)}  ${probeDuration(dest).toFixed(1)}s`);
    paths.push(dest);
  }
  return paths;
}

function runAssembly(label, dim, brollPaths, dir) {
  console.log(`\n=== ASSEMBLY @ ${label} (${dim.w}x${dim.h}), target ${TARGET_MINUTES} min ===`);
  const stages = {};
  const totalSeconds = TARGET_MINUTES * 60;
  // ~30% avatar screen time, per the brief.
  const avatarSeconds = Math.round(totalSeconds * 0.3);
  const brollSeconds = totalSeconds - avatarSeconds;
  const perClip = brollSeconds / brollPaths.length;
  console.log(`  ${avatarSeconds}s avatar + ${brollSeconds}s B-roll across ${brollPaths.length} clips (${perClip.toFixed(1)}s each)`);

  const out = p => join(dir, `${label}_${p}`);

  // Stage 1 — normalise every source to one canvas, fps and SAR. Drive footage is
  // vertical phone/drone video at mixed resolutions; long-form is 16:9, so each
  // clip is scaled to fit and pillarboxed. This is the expensive stage.
  stages.normalise = timed("normalise sources", () => {
    makeAvatarStandIn(out("avatar.mp4"), avatarSeconds, dim);
    const segs = [out("avatar.mp4")];
    brollPaths.forEach((src, i) => {
      const dst = out(`norm_${i}.mp4`);
      sh(
        `ffmpeg -y -stream_loop -1 -i "${src}" -t ${perClip.toFixed(2)} ` +
        `-vf "scale=${dim.w}:${dim.h}:force_original_aspect_ratio=decrease,` +
        `pad=${dim.w}:${dim.h}:(ow-iw)/2:(oh-ih)/2:color=black,fps=30,setsar=1" ` +
        `-c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -an "${dst}"`
      );
      segs.push(dst);
    });
    writeFileSync(out("concat.txt"), segs.map(s => `file '${s}'`).join("\n"));
    return segs.length;
  });
  if (!stages.normalise.ok) return { label, stages, fatal: "normalise" };

  // Stage 2 — concat. Same codec and canvas throughout, so this is a stream copy.
  stages.concat = timed("concat segments", () => {
    sh(`ffmpeg -y -f concat -safe 0 -i "${out("concat.txt")}" -c copy "${out("silent.mp4")}"`);
    return probeDuration(out("silent.mp4"));
  });
  if (!stages.concat.ok) return { label, stages, fatal: "concat" };

  const actualSeconds = stages.concat.out;
  console.log(`    timeline is ${(actualSeconds / 60).toFixed(1)} min`);

  // Stage 3 — music bed ducked under narration with sidechaincompress, then muxed.
  stages.duck = timed("duck music under narration", () => {
    makeMusicBed(out("music.m4a"), actualSeconds);
    makeNarration(out("vo.m4a"), actualSeconds);
    sh(
      `ffmpeg -y -i "${out("silent.mp4")}" -i "${out("vo.m4a")}" -i "${out("music.m4a")}" ` +
      `-filter_complex "[2:a]volume=0.25[bed];[1:a]asplit=2[vo1][vo2];` +
      `[bed][vo1]sidechaincompress=threshold=0.05:ratio=12:attack=20:release=400[ducked];` +
      `[vo2][ducked]amix=inputs=2:duration=first:dropout_transition=0[aout]" ` +
      `-map 0:v -map "[aout]" -c:v copy -c:a aac -b:a 192k -movflags +faststart "${out("mixed.mp4")}"`
    );
    return statSync(out("mixed.mp4")).size;
  });
  if (!stages.duck.ok) return { label, stages, fatal: "duck" };

  // Stage 4 — burn captions. A full re-encode of the whole runtime; on a short
  // Reel this is cheap, and it is the stage most likely to blow up at length.
  stages.captions = timed("burn captions (full re-encode)", () => {
    const n = makeAssFile(out("captions.ass"), actualSeconds, dim);
    sh(
      `ffmpeg -y -i "${out("mixed.mp4")}" -vf "ass=${out("captions.ass")}" ` +
      `-c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -c:a copy -movflags +faststart "${out("final.mp4")}"`
    );
    return n;
  });
  if (!stages.captions.ok) return { label, stages, fatal: "captions" };

  const finalBytes = statSync(out("final.mp4")).size;
  const totalWall = Object.values(stages).reduce((a, s) => a + s.seconds, 0);

  console.log(`\n  RESULT @ ${label}`);
  console.log(`    caption chunks:  ${stages.captions.out}`);
  console.log(`    runtime:         ${(actualSeconds / 60).toFixed(1)} min`);
  console.log(`    final size:      ${mb(finalBytes)} MB`);
  console.log(`    total wall:      ${(totalWall / 60).toFixed(1)} min`);
  console.log(`    realtime factor: ${(totalWall / actualSeconds).toFixed(2)}x (wall seconds per second of video)`);
  console.log(`    vs 6h job limit: ${((totalWall / 21600) * 100).toFixed(1)}% used`);
  console.log(`    peak work dir:   ${mb(dirBytes(dir))} MB`);
  console.log(`    stream:          ${probeStreams(out("final.mp4"))}`);

  return { label, stages, finalBytes, actualSeconds, totalWall, ok: true };
}

async function main() {
  console.log("PHASE 0 PROBE — long-form ffmpeg assembly on the runner\n");
  reportEnvironment();

  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });

  const broll = await fetchBroll(WORK);
  if (broll.length === 0) {
    console.log("No B-roll available — cannot run a representative assembly.");
    process.exitCode = 1;
    return;
  }

  const results = [];
  for (const label of RESOLUTIONS) {
    const dim = DIMS[label];
    if (!dim) { console.log(`\nUnknown resolution "${label}" — skipping`); continue; }
    const dir = join(WORK, label);
    mkdirSync(dir, { recursive: true });
    results.push(runAssembly(label, dim, broll, dir));
    // Free the intermediates before the next resolution so disk is measured per-run.
    for (const f of readdirSync(dir)) {
      if (!f.endsWith("final.mp4")) rmSync(join(dir, f), { force: true });
    }
  }

  console.log("\n=== VERDICT ===");
  for (const r of results) {
    if (!r.ok) { console.log(`  ${r.label}: FAILED at stage "${r.fatal}"`); continue; }
    const hours = r.totalWall / 3600;
    const fits = r.totalWall < 21600 * 0.5; // half the ceiling, so a slow runner still lands
    console.log(
      `  ${r.label}: ${(r.totalWall / 60).toFixed(1)} min wall for ${(r.actualSeconds / 60).toFixed(1)} min video, ` +
      `${mb(r.finalBytes)} MB — ${fits ? "FITS Actions comfortably" : hours < 6 ? "fits but with little headroom" : "DOES NOT FIT: needs a bigger runner"}`
    );
  }
}

main().catch(err => {
  console.error(`\nPROBE ERROR: ${err?.stack || err}`);
  process.exitCode = 1;
});
