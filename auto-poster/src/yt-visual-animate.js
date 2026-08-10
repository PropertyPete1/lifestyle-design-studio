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
import sharp from "sharp";

import { renderCardPng, revealLabels, countUp } from "./yt-card-render.js";
import { renderMapPng, mapRevealLabels, highlightedRoadIds } from "./yt-map-render.js";
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

/**
 * How long a road takes to draw itself, and in how many states.
 *
 * 0.7s is about the length of a spoken road name ("Loop sixteen-oh-four"), which
 * is the point: the road finishes arriving as Peter finishes naming it. Five
 * states is the fewest that reads as drawing rather than as growing in jumps —
 * measured against the 1604 ring, which is the longest geometry here at 351
 * points and therefore the least forgiving.
 */
const ROAD_DRAW_SECONDS = 0.7;
const ROAD_DRAW_STEPS = 5;

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
export function buildStates({ type, labels, reveals, beats, seconds, roadIds = [], spec = null }) {
  const states = [];
  const push = (at, s) => states.push({ at: round(Math.max(0, Math.min(seconds, at))), ...s });

  if (type === "MAP") {
    // A MAP reveals in two currencies. A road ARRIVES over time — it draws
    // itself along its own length — so one reveal becomes several states. A
    // place LANDS instantly, marker and label together.
    //
    // roadIds is the highlighted roads in the order mapRevealLabels emitted
    // them, so reveal i < roadIds.length is a road and the rest are places.
    // Roads that have finished stay finished: progress accumulates rather than
    // being recomputed, or an earlier road would vanish as the next one drew.
    const drawn = {};
    for (const id of roadIds) drawn[id] = 0;
    let placesShown = 0;

    push(0, { roadProgress: { ...drawn }, places: 0, visible: 0, pulse: 0 });

    reveals.forEach((r, i) => {
      if (i < roadIds.length) {
        const id = roadIds[i];
        for (let k = 1; k <= ROAD_DRAW_STEPS; k++) {
          const t = k / ROAD_DRAW_STEPS;
          drawn[id] = t;
          // Eased so the tip decelerates into place instead of stopping dead.
          push(r.at + (ROAD_DRAW_SECONDS * k) / ROAD_DRAW_STEPS, {
            roadProgress: { ...drawn },
            places: placesShown,
            visible: i + 1,
            pulse: k === ROAD_DRAW_STEPS ? 1 : 0,
          });
        }
      } else {
        placesShown++;
        push(r.at, { roadProgress: { ...drawn }, places: placesShown, visible: i + 1, pulse: 1 });
        push(r.at + LAND_SECONDS, { roadProgress: { ...drawn }, places: placesShown, visible: i + 1, pulse: 0 });
      }
    });

    // Motion beats. The narration dwells on a map more than on a card — "and
    // everything north of that line is Comal ISD" is four seconds with nothing
    // new to draw — so the halo re-blooms on the last landed place rather than
    // the frame going still. Nothing is invented: the emphasis moves, the
    // content does not.
    for (const b of beats) {
      const landedRoads = Math.min(roadIds.length, reveals.filter((r, i) => i < roadIds.length && r.at + ROAD_DRAW_SECONDS <= b.at).length);
      const landedPlaces = reveals.filter((r, i) => i >= roadIds.length && r.at <= b.at).length;
      if (landedRoads === 0 && landedPlaces === 0) continue;
      const at = {};
      roadIds.forEach((id, i) => { at[id] = i < landedRoads ? 1 : (drawn[id] ?? 0); });
      push(b.at, { roadProgress: at, places: landedPlaces, visible: landedRoads + landedPlaces, pulse: 0.6, beat: true });
      push(b.at + LAND_SECONDS, { roadProgress: at, places: landedPlaces, visible: landedRoads + landedPlaces, pulse: 0, beat: true });
    }

    // Settle on the finished map: every road complete, every label placed, no
    // halo left glowing on whichever place happened to be last.
    const settleAt = Math.max(0, seconds - Math.max(0.5, seconds * 0.08));
    const allDrawn = {};
    for (const id of roadIds) allDrawn[id] = 1;
    push(settleAt, { roadProgress: allDrawn, places: labels.length - roadIds.length, visible: Infinity, pulse: 0, settle: true });

    return finish(states, seconds);
  }

  if (type === "CALLOUT") {
    // One continuous value rather than a sequence. The count starts at the
    // reveal and eases into the figure; after that the card holds, and the push
    // is what keeps it alive.
    //
    // ONLY STEPS THAT ACTUALLY CHANGE THE FIGURE ARE EMITTED.
    //
    // Twelve evenly-spaced steps assumes the figure has twelve distinguishable
    // values, and a small one does not: "$3" eased over twelve steps rounds to
    // 1,1,2,2,3,3,3,3,3,3,3,3 — four distinct frames and nine identical pairs.
    // A value with no digits at all ("Free") is one frame repeated twelve times.
    //
    // That is not merely wasteful. The dead-state check compares consecutive
    // states that should differ and rejects the graphic when they do not, so on
    // the first live build a perfectly good CALLOUT was thrown away with
    // "2 reveal state(s) rendered identically" and the segment fell back to
    // typography. The check was right; the state list was wrong.
    //
    // Steps inside the label's fade band are kept regardless, because there the
    // label opacity is what changes even when the digits have settled.
    const start = reveals[0]?.at ?? 0;
    const value = labels[0] ?? "";
    // Keeping steps in the label's fade band only helps if there IS a label.
    // Without one those steps render identically — nothing in the frame reads
    // `progress` once the digits have settled — and the dead-state check
    // rejected the graphic for it, which is how revision 4 lost a CALLOUT to
    // typography a second time after the first dedupe fix.
    const hasLabel = Boolean(String(spec?.label ?? "").trim());

    // A FIGURE WITH NO DIGITS CANNOT COUNT, so it arrives instead.
    //
    // "Free", "N/A", "Exempt" are legitimate CALLOUT values and countUp returns
    // them unchanged at every progress. Counting them produces a first and last
    // state that rasterise identically — and with no label there is nothing else
    // in the frame reading progress, so the dead-state check rejects the graphic
    // and the segment loses its visual. Revision 4 lost a CALLOUT this way, and
    // the first fix for it (deduping the count) did not help: deduping a
    // sequence whose every entry is the same leaves the two endpoints, which are
    // still the same. The reveal has to change KIND, not resolution.
    //
    // So: an empty frame, then the figure landing on it. Measured at 0.12 mean
    // absolute difference, six times the dead-state floor.
    if (!/\d/.test(value)) {
      push(0, { visible: 0, current: -1, pulse: 0, progress: 0 });
      push(start, { visible: 1, current: 0, pulse: 1, progress: 1 });
      push(start + LAND_SECONDS, { visible: 1, current: 0, pulse: 0, progress: 1 });
      for (const b of beats) {
        if (b.at <= start) continue;
        push(b.at, { visible: 1, current: 0, pulse: 0.6, progress: 1, beat: true });
        push(b.at + LAND_SECONDS, { visible: 1, current: 0, pulse: 0, progress: 1, beat: true });
      }
      const settleAt = Math.max(0, seconds - Math.max(0.5, seconds * 0.08));
      push(settleAt, { visible: Infinity, current: -1, pulse: 0, progress: 1, settle: true });
      return finish(states, seconds);
    }

    push(0, { visible: 1, current: 0, pulse: 0, progress: 0 });
    let lastShown = countUp(value, 0);
    for (let i = 1; i <= COUNT_STEPS; i++) {
      const progress = i / COUNT_STEPS;
      const shown = countUp(value, progress);
      const inLabelFade = hasLabel && progress > 0.6 && progress < 0.95;
      if (shown === lastShown && !inLabelFade && i !== COUNT_STEPS) continue;
      lastShown = shown;
      push(start + (COUNT_SECONDS * i) / COUNT_STEPS, { visible: 1, current: 0, pulse: 0, progress });
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

  return finish(states, seconds);
}

/**
 * Sort, collapse coincident states, and give each one its hold.
 *
 * Shared by the card path and the map path because the concat list has the same
 * requirements either way: strictly increasing starts, and no state that would
 * render for zero frames.
 */
function finish(states, seconds) {
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
  // MAP is the one type whose renderer and label set live elsewhere: its reveal
  // unit is geometry, not a row of text, so both come from yt-map-render.js.
  const isMap = type === "MAP";
  const roadIds = isMap ? highlightedRoadIds(spec) : [];
  const labels = isMap ? mapRevealLabels(spec) : revealLabels(type, spec);
  const draw = isMap ? (t, sp, st) => renderMapPng(sp, st) : renderPng;

  const timing = planReveals({ labels, words, seconds });
  const states = buildStates({ type, labels, reveals: timing.reveals, beats: timing.beats, seconds, roadIds, spec });

  const stem = `anim-${String(index).padStart(3, "0")}-${String(type).toLowerCase()}`;
  const framePaths = [];
  for (let i = 0; i < states.length; i++) {
    const png = await draw(type, spec, states[i]);
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
  // What MUST move the pixels, per type. For a card it is the number of items
  // drawn; for CALLOUT the counting figure; for a MAP either a road advancing or
  // a place landing, which `mapMotion` folds into one comparable number.
  const readsProgress = type === "CALLOUT";
  const mapMotion = (st) =>
    `${Object.values(st.roadProgress || {}).map((v) => v.toFixed(2)).join(",")}|${st.places ?? 0}`;
  const stateDiffs = [];
  for (let i = 1; i < framePaths.length; i++) {
    // SETTLE AND BEAT STATES ARE EXEMPT, and this is what the predicate below
    // has always meant to say.
    //
    // A settle exists to clear a pulse and undim anything held back, so on a card
    // whose previous state was already unpulsed and fully visible it is
    // legitimately identical. A beat is emphasis garnish over content that has
    // not changed — the header of this check said so in words while the code
    // demanded otherwise, because beat states carry no `figure` and so compared
    // as different from the real figure preceding them. That cost s3t5 its
    // CALLOUT on the revision-5 build: every count state was fine and a beat two
    // thirds of the way through was called dead.
    if (states[i].settle || states[i].beat) continue;
    const mustChange = isMap
      ? mapMotion(states[i]) !== mapMotion(states[i - 1])
      : states[i].visible !== states[i - 1].visible
        // FIGURE, not progress. Comparing progress asserted that two moments
        // showing the identical figure must nonetheless differ in pixels — true
        // of any small value, which reaches its final digits early and then
        // holds. That demanded motion the design never promised and rejected
        // sound CALLOUTs for it.
        || (readsProgress && states[i].figure !== states[i - 1].figure);
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
    // Kept so verifyStateSequence can compare the encoded clip against the
    // exact pixels each moment was supposed to show.
    framePaths,
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
 * Render a kinetic typography segment to an mp4.
 *
 * Same machinery as the graphics — a state sequence, a concat, a push — but the
 * states come from phrase cards and the unit of reveal is a WORD.
 *
 * NO FAILURE PATH. This is the layer everything else falls back TO, so it takes
 * whatever narration it is given and produces something. An empty text is the
 * only input it cannot serve, and the caller checks that before choosing it.
 */
export async function renderTypographyClip({
  text,
  words = null,
  seconds,
  eyebrow = null,
  dir,
  index = 0,
  fps = GRAPHIC_FPS,
  ffmpeg,
  writeFileSync,
  renderPng,
}) {
  const { planTypography, typographyPng } = await import("./yt-typography-render.js");
  const render = renderPng || typographyPng;

  const plan = planTypography({ text, words, seconds, eyebrow });
  if (plan.cards.length === 0) return null;

  // One state per word arrival, plus a settle at the end of each card so the
  // finished phrase is readable before it is replaced.
  const states = [];
  for (const card of plan.cards) {
    card.times.forEach((t, i) => {
      states.push({ at: round(t), card, visible: i + 1, current: i, pulse: 1 });
      states.push({ at: round(t + LAND_SECONDS), card, visible: i + 1, current: i, pulse: 0 });
    });
  }
  states.sort((a, b) => a.at - b.at);

  const merged = [];
  for (const s of states) {
    const prev = merged[merged.length - 1];
    if (prev && Math.abs(prev.at - s.at) < 1 / fps) merged[merged.length - 1] = { ...s, at: prev.at };
    else merged.push(s);
  }
  const seq = merged
    .map((s, i) => ({ ...s, until: round(i + 1 < merged.length ? merged[i + 1].at : seconds) }))
    .filter((s) => s.until > s.at && s.at < seconds);
  if (seq.length === 0) return null;

  // A first state at t>0 would leave the opening moments black. Back the first
  // card up to zero rather than padding with a blank, which would be the one
  // thing this layer exists to prevent.
  if (seq[0].at > 0) seq[0] = { ...seq[0], at: 0 };

  const stem = `typo-${String(index).padStart(3, "0")}`;
  const framePaths = [];
  for (let i = 0; i < seq.length; i++) {
    const png = await render({ words: seq[i].card.words, eyebrow: seq[i].card.eyebrow }, { visible: seq[i].visible, current: seq[i].current, pulse: seq[i].pulse });
    const p = join(dir, `${stem}-s${String(i).padStart(3, "0")}.png`);
    writeFileSync(p, png);
    framePaths.push(p);
  }

  const listPath = join(dir, `${stem}.txt`);
  const lines = seq.map((s, i) => `file '${framePaths[i]}'\nduration ${round(s.until - s.at)}`);
  lines.push(`file '${framePaths[framePaths.length - 1]}'`);
  writeFileSync(listPath, lines.join("\n"));

  const out = join(dir, `${stem}.mp4`);
  ffmpeg(concatArgs(listPath, out, { seconds, fps }));

  return {
    path: out,
    seconds: round(seconds),
    cards: plan.cards.map((c) => ({ text: c.words.join(" "), start: c.start, seconds: c.seconds, anchored: c.anchoredCount })),
    cardCount: plan.cards.length,
    stateCount: seq.length,
    synced: plan.synced,
    source: plan.source,
    // Every word arrival is a reveal, so the clip-level animation check has the
    // same anchors to probe as a graphic does.
    reveals: seq.filter((s) => s.pulse === 1).map((s) => ({ at: s.at, label: s.card.words[s.current] || "" })),
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
 * Prove the clip shows the STATES THAT WERE PLANNED, by comparing it against
 * the state renders themselves.
 *
 * This is the check that actually catches "the content never arrived", and it
 * works where the statistical one did not, because it has ground truth: the
 * exact pixels each moment is supposed to look like already exist on disk.
 *
 * For a sample of states, grab the clip at the middle of the state's hold and
 * ask which state render it most resembles. Content differences — three rows
 * versus five, a figure at $2,100 versus $4,200 — dwarf the 4.5% camera push,
 * so the nearest match is unambiguous when the concat is right and wrong when
 * it is not. A clip that is a push over a finished card matches the LAST state
 * everywhere, which is exactly the signature we want to name.
 *
 * @returns {{ ok, failures, matches, checked }}
 */
export async function verifyStateSequence(clipPath, { states, framePaths, seconds, dir, ffmpeg, index = 0, sample = 6 }) {
  const failures = [];
  const matches = [];
  if (!states?.length || !framePaths?.length) return { ok: true, failures, matches, checked: 0 };

  // THE REFERENCE MUST BE ZOOMED TO MATCH THE MOMENT IT IS COMPARED AGAINST.
  //
  // The clip has the push baked in; the state renders do not. Comparing them
  // raw makes the score a measure of how far the push has travelled rather than
  // of what the card is showing — every sampled frame matched state 0, with
  // scores climbing steadily from 0.54 to 3.62 across the clip. That is the
  // zoom, read as content.
  //
  // Applying the same centre-crop the push applies at time t removes it from
  // the comparison and leaves the thing we actually care about: which rows are
  // on screen.
  const W = 480;
  const H = 270;
  const zoomAt = (t) => 1 + PUSH_TRAVEL * (t / Math.max(0.001, seconds));

  const grey = (pipeline) => pipeline.resize(W, H, { fit: "fill" }).greyscale().raw().toBuffer();
  const zoomedRef = async (src, zoom) => {
    const meta = await sharp(src).metadata();
    const cw = Math.max(2, Math.round(meta.width / zoom));
    const ch = Math.max(2, Math.round(meta.height / zoom));
    return grey(
      sharp(src).extract({
        left: Math.floor((meta.width - cw) / 2),
        top: Math.floor((meta.height - ch) / 2),
        width: cw,
        height: ch,
      })
    );
  };

  const step = Math.max(1, Math.floor(states.length / sample));
  for (let i = 0; i < states.length; i += step) {
    const s = states[i];
    const mid = s.at + (s.until - s.at) / 2;
    if (mid <= 0.05 || mid >= seconds - 0.05) continue;

    const grabbed = join(dir, `seq-${String(index).padStart(3, "0")}-${i}.png`);
    ffmpeg(["-y", "-ss", String(round(mid)), "-i", clipPath, "-frames:v", "1", "-q:v", "2", grabbed]);
    const actual = await grey(sharp(grabbed));

    const zoom = zoomAt(mid);
    let best = -1;
    let bestScore = Infinity;
    for (let ri = 0; ri < framePaths.length; ri++) {
      const ref = await zoomedRef(framePaths[ri], zoom);
      if (ref.length !== actual.length) continue;
      let sum = 0;
      for (let k = 0; k < ref.length; k += 3) sum += Math.abs(ref[k] - actual[k]);
      const score = sum / Math.ceil(ref.length / 3);
      if (score < bestScore) { bestScore = score; best = ri; }
    }

    matches.push({ state: i, at: round(mid), matched: best, score: round(bestScore) });
  }

  // The clip must not collapse onto a single state. That is the push-over-a-
  // finished-card signature, and it is the failure this function exists for.
  const distinct = new Set(matches.map((m) => m.matched));
  if (matches.length >= 3 && distinct.size === 1) {
    failures.push(
      `every sampled moment matches the same state (${[...distinct][0]}) — the clip is not stepping through its reveals`
    );
  }

  // And it must move FORWARD. A concat that shuffled or dropped states shows up
  // as a match sequence that does not increase.
  const matched = matches.map((m) => m.matched);
  const regressions = matched.filter((v, i) => i > 0 && v < matched[i - 1] - 1).length;
  if (regressions > Math.max(1, Math.floor(matched.length / 3))) {
    failures.push(`the clip does not step through its states in order: matched ${JSON.stringify(matched)}`);
  }

  return { ok: failures.length === 0, failures, matches, checked: matches.length };
}

/**
 * Prove the finished clip actually animates.
 *
 * NOT FROZEN — no window longer than ~2s where the picture does not change.
 * This is Peter's rule and the one a stuck render violates.
 *
 * The reveal measurements are also taken here and REPORTED. They are not a
 * gate; see the note at the bottom of this function for why the ratio between
 * them was demoted, and use `verifyStateSequence` for the claim it was trying
 * to make.
 *
 * @returns {{ ok, failures, samples, revealDiffs, ambient, revealRatio }}
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
  if (revealDiffs.length > 0) {
    const revealMedian = median(revealDiffs.map((r) => r.diff));

    // A REVEAL MUST MOVE PIXELS. This much is robust and is a gate.
    const REVEAL_FLOOR = 0.05;
    if (revealMedian < REVEAL_FLOOR) {
      failures.push(
        `reveals do not change the picture at all (median ${round(revealMedian)}, floor ${REVEAL_FLOOR}) — ` +
          `the graphic's content is not arriving`
      );
    }

    // THE RATIO IS REPORTED, NOT ENFORCED, and that demotion was earned.
    //
    // The idea was sound: if reveals rendered, the moments they occur at are
    // busier than the moments they do not. The measurement is not. x264 over a
    // near-static source does not distribute its error evenly — it updates some
    // frames and coasts through others — so the difference between two frames
    // 0.18s apart depends on where the encoder chose to spend bits as much as
    // on what the picture is doing.
    //
    // Measured on the same push-over-a-finished-card clip, which contains no
    // reveals whatsoever, the ratio came out 0.69 with one set of probe
    // positions and 1.368 with another. A gate that swings either side of its
    // threshold on sampling position is not measuring the thing it names, and
    // shipping it would have meant a build that fails on encoder noise and
    // passes on the failure it was written to catch.
    //
    // What replaced it is `verifyStateSequence`, which compares the clip
    // against the state renders themselves. Ground truth beats a proxy.
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
