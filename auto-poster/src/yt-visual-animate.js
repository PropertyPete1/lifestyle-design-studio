/**
 * yt-visual-animate.js — turning a card into something that happens.
 *
 * A rendered card is a still. Revision 2 pushed slowly across it and called that
 * a motion graphic; under a twelve-minute explainer it is a slide with a camera
 * move, and the eye finishes reading it in two seconds and then waits. What
 * makes a graphic teach is that its information ARRIVES while it is being
 * described — the row strikes as it is named, the figure counts, the spine
 * grows.
 *
 * HOW IT WORKS, AND WHY IT IS STEPPED RATHER THAN INTERPOLATED
 * Each reveal state is a full rasterise of the card at 2560x1440, which costs
 * real time. Rendering every frame of a 9-second clip is 270 rasterises and
 * minutes per graphic, on a runner that has a dozen of them to build. So the
 * animation is a small number of KEY STATES held for their natural duration,
 * with two frames of overshoot on each reveal so it lands with weight instead of
 * popping, and a single continuous camera push underneath the whole thing.
 *
 * The push matters more than it looks. It is what keeps the frame alive between
 * reveals when the narration dwells, and it is the reason the ~2s static rule
 * can be satisfied honestly rather than by inventing content the script never
 * mentions.
 *
 * NOTHING HERE TRUSTS ITSELF. `assertAnimated` re-reads the finished clip and
 * proves both that no window is frozen AND that the reveals actually changed the
 * picture at the times they were planned for. This codebase has already shipped
 * one zoom expression that was a constant and produced 180 identical frames with
 * no error, so a render that reports success is not evidence of anything.
 */

import { join } from "path";

import { renderCardPng, revealLabels } from "./yt-card-render.js";
import { frameDifference } from "./yt-visual-qc.js";
import { planReveals, MAX_STATIC_SECONDS } from "./yt-reveal-timing.js";

/** How long the overshoot on a landing reveal lasts. */
const LAND_SECONDS = 0.14;

/** Frames per second for generated graphic clips. Matches the timeline. */
export const GRAPHIC_FPS = 30;

/**
 * How far the continuous push travels across the whole graphic.
 *
 * DELIBERATELY SMALL, and the number was set by measurement rather than taste.
 *
 * At 0.10 — revision 2's value, inherited from the ken-burns still — the push
 * moves every edge in the frame, and a single row arriving moves a few hundred
 * pixels. Measured on the tax table: the push contributed 1.35 mean absolute
 * difference over a third of a second and a reveal contributed 1.28-2.1, so the
 * camera was doing more visible work than the content. That is revision 2's
 * complaint stated as a number, and no verification could have separated the
 * two at that ratio.
 *
 * At 0.045 the push is still clearly not a freeze, and the reveals are the
 * loudest thing in the frame — which is both the correct look and the thing
 * that makes the reveal check able to tell the difference.
 */
const PUSH_TRAVEL = 0.045;

/** CALLOUT counts up over this long, in this many steps. */
const COUNT_SECONDS = 1.6;
const COUNT_STEPS = 12;

/**
 * The sequence of states to rasterise, with when each begins.
 *
 * Every state carries an explicit `until` so the concat list can be written
 * without re-deriving durations, and so a state that would render for zero
 * frames can be dropped here rather than becoming a silent ffmpeg no-op.
 */
export function buildStates({ type, labels, reveals, beats, seconds }) {
  const states = [];
  const push = (at, s) => states.push({ at: round(Math.max(0, Math.min(seconds, at))), ...s });

  if (type === "CALLOUT") {
    // One continuous value rather than a sequence. The count starts at the
    // reveal and eases into the figure; after that the card holds, and the push
    // is what keeps it alive.
    const start = reveals[0]?.at ?? 0;
    push(0, { visible: 1, current: 0, pulse: 0, progress: 0 });
    for (let i = 1; i <= COUNT_STEPS; i++) {
      push(start + (COUNT_SECONDS * i) / COUNT_STEPS, { visible: 1, current: 0, pulse: 0, progress: i / COUNT_STEPS });
    }
  } else {
    // Open on the empty frame — header and furniture, no content. The first
    // reveal then has something to land ON, which is what makes it read as an
    // arrival rather than as the card simply existing.
    push(0, { visible: 0, current: -1, pulse: 0 });
    reveals.forEach((r, i) => {
      push(r.at, { visible: i + 1, current: i, pulse: 1 });
      push(r.at + LAND_SECONDS, { visible: i + 1, current: i, pulse: 0 });
    });
  }

  // Motion beats: the narration dwells and nothing new is due. Re-pulse the
  // element that is current so the picture changes without inventing content.
  for (const b of beats) {
    const priorCount = reveals.filter((r) => r.at <= b.at).length;
    if (priorCount === 0) continue;
    push(b.at, { visible: priorCount, current: priorCount - 1, pulse: 0.6, beat: true, progress: 1 });
    push(b.at + LAND_SECONDS, { visible: priorCount, current: priorCount - 1, pulse: 0, beat: true, progress: 1 });
  }

  // SETTLE. The last thing on screen is the finished card with every element at
  // full strength — no row left dimmed, nothing still mid-pulse. Without this
  // the graphic leaves on whatever transient state happened to be last, and the
  // still that a viewer pausing the video sees is a half-emphasised table.
  const settleAt = Math.max(0, seconds - Math.max(0.5, seconds * 0.08));
  push(settleAt, { visible: Infinity, current: -1, pulse: 0, progress: 1, settle: true });

  states.sort((a, b) => a.at - b.at);

  // Collapse states that begin at the same moment (a beat landing on a reveal,
  // a settle landing on the tail). Last one wins — it is the one the sort put
  // latest and therefore the one the viewer would have ended on anyway.
  const merged = [];
  for (const s of states) {
    const prev = merged[merged.length - 1];
    if (prev && Math.abs(prev.at - s.at) < 1 / GRAPHIC_FPS) merged[merged.length - 1] = { ...s, at: prev.at };
    else merged.push(s);
  }

  return merged.map((s, i) => ({
    ...s,
    until: round(i + 1 < merged.length ? merged[i + 1].at : seconds),
  })).filter((s) => s.until > s.at);
}

/**
 * Render one animated graphic to an mp4.
 *
 * @returns {{ path, states, reveals, syncedCount, source, seconds }}
 */
export async function renderAnimatedGraphic({
  type,
  spec,
  seconds,
  words = null,
  dir,
  index = 0,
  fps = GRAPHIC_FPS,
  ffmpeg,
  writeFileSync,
  renderPng = renderCardPng,
}) {
  const labels = revealLabels(type, spec);
  const timing = planReveals({ labels, words, seconds });
  const states = buildStates({ type, labels, reveals: timing.reveals, beats: timing.beats, seconds });

  const stem = `anim-${String(index).padStart(3, "0")}-${String(type).toLowerCase()}`;
  const framePaths = [];
  for (let i = 0; i < states.length; i++) {
    const png = await renderPng(type, spec, states[i]);
    const p = join(dir, `${stem}-s${String(i).padStart(3, "0")}.png`);
    writeFileSync(p, png);
    framePaths.push(p);
  }

  // The concat demuxer wants the final entry repeated with no duration, or it
  // drops the last state's hold entirely — a graphic that ends one state early
  // and does it silently.
  const listPath = join(dir, `${stem}.txt`);
  const lines = states.map((s, i) => `file '${framePaths[i]}'\nduration ${round(s.until - s.at)}`);
  lines.push(`file '${framePaths[framePaths.length - 1]}'`);
  writeFileSync(listPath, lines.join("\n"));

  // THE CONTENT CHECK, on the source renders, before a single frame is encoded.
  //
  // Independent of the camera push and therefore independent of the signal
  // problem that makes the clip-level reveal check delicate: if two consecutive
  // states rasterise to the same pixels, the reveal did not draw, full stop.
  // This is the check that catches a broken `at()` or a spec whose items all
  // collapsed to the same row, and it costs nothing because the PNGs already
  // exist. It cannot catch a concat that dropped a state — that is what the
  // clip-level checks are for — so both exist and neither is redundant.
  // The predicate is narrow ON PURPOSE. Only two things MUST move the pixels:
  // a change in how many items are drawn, and — for CALLOUT alone — a change in
  // the counting figure. Pulse and beat states are emphasis garnish, and a
  // beat that happens to rasterise identically is harmless; demanding a visible
  // change there reported two dead states on a graphic where every reveal drew
  // correctly, because `progress` moves for beats on a type that never reads it.
  const readsProgress = type === "CALLOUT";
  const stateDiffs = [];
  for (let i = 1; i < framePaths.length; i++) {
    const mustChange = states[i].visible !== states[i - 1].visible
      || (readsProgress && states[i].progress !== states[i - 1].progress);
    if (!mustChange) continue;
    const d = await frameDifference(framePaths[i - 1], framePaths[i]);
    stateDiffs.push({ from: i - 1, to: i, visible: states[i].visible, diff: round(d) });
  }
  const deadStates = stateDiffs.filter((d) => d.diff < 0.02);

  const out = join(dir, `${stem}.mp4`);
  ffmpeg(concatArgs(listPath, out, { seconds, fps }));

  return {
    path: out,
    states,
    stateDiffs,
    deadStates,
    stateCount: states.length,
    reveals: timing.reveals,
    syncedCount: timing.syncedCount,
    source: timing.source,
    beats: timing.beats,
    seconds: round(seconds),
  };
}

/**
 * ffmpeg arguments for the state sequence plus the continuous push.
 *
 * `fps` BEFORE zoompan, deliberately. The concat demuxer emits one frame per
 * still with a duration attached, so without an explicit rate conversion
 * zoompan sees a handful of frames rather than a stream, and `on` — the frame
 * counter the whole push depends on — advances about six times across nine
 * seconds. The clip renders, is the right length, and the push is a staircase.
 */
export function concatArgs(listPath, output, { seconds, fps = GRAPHIC_FPS }) {
  const frames = Math.max(1, Math.round(seconds * fps));
  const z = `1+${PUSH_TRAVEL}*on/${frames}`;
  return [
    "-y",
    "-f", "concat", "-safe", "0", "-i", listPath,
    "-vf",
    `fps=${fps},zoompan=z='${z}':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1920x1080:fps=${fps},format=yuv420p,setsar=1`,
    "-t", String(seconds),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-an",
    output,
  ];
}

/**
 * Prove the finished clip actually animates.
 *
 * TWO separate claims, because they fail separately and only one of them is
 * caught by looking at the file:
 *
 *   1. NOT FROZEN — no window longer than ~2s where the picture does not
 *      change. This is the rule Peter set and the one a stuck render violates.
 *   2. REVEALS LANDED — the picture changed MORE at each planned reveal than it
 *      does while merely pushing. This is the one that matters, because a clip
 *      whose reveals silently did not render still passes (1): the camera push
 *      alone makes every frame differ from the last. Without this check the
 *      static test would wave through a nine-second slow zoom over a finished
 *      table and report a fully animated graphic.
 *
 * @returns {{ ok, failures, samples, revealDiffs, ambient }}
 */
export async function assertAnimated(clipPath, { seconds, reveals = [], maxStatic = MAX_STATIC_SECONDS, dir, ffmpeg, index = 0 }) {
  const failures = [];
  const stem = join(dir, `check-${String(index).padStart(3, "0")}`);

  const grab = (t, tag) => {
    const p = `${stem}-${tag}.png`;
    ffmpeg(["-y", "-ss", String(round(Math.max(0, Math.min(seconds - 0.05, t)))), "-i", clipPath, "-frames:v", "1", "-q:v", "2", p]);
    return p;
  };

  // ── 1. no frozen window ──────────────────────────────────────────────────
  const step = maxStatic / 2;
  const samples = [];
  for (let t = 0.05; t < seconds; t += step) samples.push({ t: round(t), path: grab(t, `t${samples.length}`) });

  const diffs = [];
  for (let i = 1; i < samples.length; i++) {
    const d = await frameDifference(samples[i - 1].path, samples[i].path);
    diffs.push({ from: samples[i - 1].t, to: samples[i].t, diff: round(d) });
  }

  // A pure camera push over this interval moves every edge in the frame and
  // scores well above this. A frozen frame scores ~0. The floor sits between,
  // near the noise level of x264 on a static picture.
  const STATIC_FLOOR = 0.12;
  for (const d of diffs) {
    if (d.diff < STATIC_FLOOR) {
      failures.push(`frozen between ${d.from}s and ${d.to}s (frame difference ${d.diff}, floor ${STATIC_FLOOR})`);
    }
  }

  // ── 2. the reveals are visible in the pixels ─────────────────────────────
  //
  // AMBIENT MUST BE MEASURED OVER THE SAME INTERVAL AS A REVEAL. The camera
  // push accumulates difference with elapsed time, so a one-second window
  // scores roughly three times a third-of-a-second one. Comparing a 0.32s
  // reveal probe against a 1s ambient sample says every reveal failed, on a
  // clip where all five landed correctly — measured, not guessed: ambient 3.05
  // against reveals of 1.3-2.1, every one a false accusation.
  //
  // So ambient is sampled with the identical probe width, at moments chosen to
  // be clear of any reveal, and the two numbers are then comparable.
  // As TIGHT as the reveal allows. A reveal is a step change and contributes
  // its full magnitude however narrow the window; the push contributes in
  // proportion to elapsed time. Narrowing the probe therefore costs the reveal
  // nothing and starves the push, which is the entire signal-to-noise problem
  // in one constant.
  const PROBE_GAP = LAND_SECONDS + 0.04;
  const clearOf = (t) => reveals.every((r) => Math.abs(r.at - t) > 0.6);
  const ambientSamples = [];
  for (let t = 0.2; t < seconds - PROBE_GAP - 0.1 && ambientSamples.length < 6; t += Math.max(0.7, seconds / 8)) {
    if (!clearOf(t)) continue;
    const a = grab(t, `amb${ambientSamples.length}a`);
    const b = grab(t + PROBE_GAP, `amb${ambientSamples.length}b`);
    ambientSamples.push(round(await frameDifference(a, b)));
  }
  // With no clear moment to sample (a dense little graphic), fall back to
  // scaling a static-window diff down to the probe width rather than to zero —
  // a zero ambient would pass every reveal unconditionally, which is the same
  // as not having the check.
  const ambient = ambientSamples.length > 0
    ? median(ambientSamples)
    : (diffs.length ? median(diffs.map((d) => d.diff)) * (PROBE_GAP / step) : 0);

  const REVEAL_MARGIN = 1.35;
  const revealDiffs = [];
  for (let i = 0; i < reveals.length; i++) {
    const r = reveals[i];
    if (r.at < 0.15 || r.at > seconds - 0.15) continue;
    const before = grab(r.at - 0.02, `r${i}a`);
    const after = grab(r.at + LAND_SECONDS + 0.04, `r${i}b`);
    const d = round(await frameDifference(before, after));
    revealDiffs.push({ at: r.at, label: r.label, diff: d, landed: d > ambient * REVEAL_MARGIN });
  }

  // THE VERDICT IS ON THE POPULATION, NOT ON EACH REVEAL, and that is a
  // measured decision rather than a softened one.
  //
  // One row arriving in a four-row table repaints a small percentage of the
  // frame. Depending on where it lands and how much ink it carries, its diff
  // sits either side of the push's contribution — measured across a real card,
  // individual reveals scored 0.95 to 1.48 against an ambient of 0.82. Failing
  // a render because reveal #2 scored 0.95 would reject correct graphics
  // constantly, and raising the push to separate them is exactly the mistake
  // revision 2 made.
  //
  // What IS reliable is the aggregate: if the reveals rendered, the moments
  // they occur at are collectively busier than the moments they do not. If they
  // did not render, the clip is a uniform push and the two populations are
  // identical. That distinction is large and stable, and it is the one that
  // separates "animated" from "a slow zoom over a finished table".
  //
  // Per-reveal `landed` is kept as the reported sync-coverage figure. It is
  // useful as information and unreliable as a gate.
  // MEASURED SEPARATION, on the tax-table card at 11s:
  //   reveals rendered      ratio 1.38
  //   push over a finished card  ratio 0.69
  // The threshold sits between them with room on both sides — 20% of headroom
  // under a real graphic and a factor of 1.7 above the failure case. Tightening
  // it to split the difference more finely would buy nothing and start failing
  // sparse cards, whose reveals are genuinely smaller.
  const landed = revealDiffs.filter((r) => r.landed).length;
  if (revealDiffs.length > 0 && ambient > 0) {
    const revealMedian = median(revealDiffs.map((r) => r.diff));
    const ratio = revealMedian / ambient;
    if (ratio < 1.15) {
      failures.push(
        `reveal moments are no busier than the rest of the clip (median ${round(revealMedian)} vs ambient ${round(ambient)}, ` +
          `ratio ${round(ratio)}) — the graphic is moving but its content is not arriving`
      );
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    samples: diffs,
    revealDiffs,
    ambient: round(ambient),
    landed,
    revealRatio: revealDiffs.length && ambient > 0 ? round(median(revealDiffs.map((r) => r.diff)) / ambient) : null,
  };
}

function median(xs) {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}
