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
 * HOW IT WORKS: MOTION IS INTERPOLATED, STILLNESS IS NOT
 * Each state is a full rasterise of the card at 2560x1440, which costs real time
 * — 137ms for a map — so rendering every frame of every clip would be minutes
 * per graphic on a runner that has a dozen to build. The resolution is that only
 * the passages where something MOVES are expanded to the delivery frame rate: a
 * road drawing, a figure counting, the beat's arcs travelling. A card holding
 * still between two reveals is one rasterise however long it holds, because a
 * still frame repeated is still a still frame.
 *
 * That distinction was missing until revision 9. Motion was rendered at five to
 * twelve states per transition — about 7fps — and the wordless beat advanced
 * 2.5 times a second across more than half the runtime. Encoded at 30fps and
 * held for four frames each, which is exactly what "the whole video feels laggy"
 * described.
 *
 * Reveals still LAND rather than tween: an arrival is a cut, and two frames of
 * overshoot give it weight. A single continuous camera push runs underneath all
 * of it in the encoder, where it has always been per-frame and smooth.
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

import { renderCardPng, revealLabels, countUp, renderBeatPng } from "./yt-card-render.js";
import { renderMapPng, mapRevealLabels, mapRevealTargets, highlightedRoadIds } from "./yt-map-render.js";
import { frameDifference } from "./yt-visual-qc.js";
import { planReveals, planMapReveals, MAX_STATIC_SECONDS } from "./yt-reveal-timing.js";
import { GRAPHIC_TWEEN_FPS, BEAT_MAX_FRAMES } from "./yt-config.js";

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
 * How fast the beat's geometry travels, in phase units per second.
 *
 * 92.5 is exactly what the old code did — 37 units per state at one state every
 * 0.4 seconds — kept so the beat looks the same as the one Peter has been
 * reviewing and only its smoothness changes.
 */
const BEAT_PHASE_PER_SECOND = 92.5;

/**
 * How long a road takes to draw itself.
 *
 * 0.7s is about the length of a spoken road name ("Loop sixteen-oh-four"), which
 * is the point: the road finishes arriving as Peter finishes naming it.
 */
const ROAD_DRAW_SECONDS = 0.7;

/**
 * THE STEP COUNTS ARE DERIVED FROM THE FRAME RATE NOW, NOT CHOSEN.
 *
 * They were 5 and 12. A road drew in 5 states across 0.7s and a counter ran 12
 * across 1.6s, which is motion at about 7 frames a second — encoded into a 30fps
 * clip, so every drawing was held for four frames and then jumped. That is what
 * "the whole video feels laggy" was: not the encode rate, which was always 30,
 * but the rate at which the PICTURE changed.
 *
 * Tying them to the delivery rate makes stepping impossible by construction: one
 * new drawing per output frame, so there is nothing left to hold. The cost is
 * rasterising — measured at 137ms for a map frame — which is why only the
 * MOVING passages are expanded. A road drawing for 0.7s costs 21 frames instead
 * of 5, about three seconds of extra work; the still holds between reveals stay
 * one frame each however long they last.
 */
const ROAD_DRAW_STEPS = Math.max(5, Math.round(ROAD_DRAW_SECONDS * GRAPHIC_TWEEN_FPS));

/** CALLOUT counts up over this long, at the same rate everything else moves. */
const COUNT_SECONDS = 1.6;
const COUNT_STEPS = Math.max(12, Math.round(COUNT_SECONDS * GRAPHIC_TWEEN_FPS));

/**
 * Ease-out for a drawing tip, so it decelerates into place.
 *
 * The old comment claimed the road was "eased so the tip decelerates into place
 * instead of stopping dead" and the code stepped it linearly — at five steps the
 * difference was invisible, so the claim went unchallenged. At twenty-one it is
 * plainly visible, and the easing the comment always described is now real.
 */
function easeOut(t) {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * The sequence of states to rasterise, with when each begins.
 *
 * Every state carries an explicit `until` so the concat list can be written
 * without re-deriving durations, and so a state that would render for zero
 * frames can be dropped here rather than becoming a silent ffmpeg no-op.
 */
export function buildStates({ type, labels, reveals, beats, seconds, roadIds = [], spec = null, established = new Set() }) {
  const states = [];
  // MILLISECONDS, NOT CENTISECONDS. State times used to round to 0.01s while the
  // collapse below discards anything closer together than a frame (0.0333s at
  // 30fps). A tween frame is spaced exactly one frame apart, so rounding walked
  // successive states to 0.03 and 0.04 gaps and the 0.03 ones were eaten as
  // "coincident" — roughly every other frame of every draw. Measured: a draw
  // asking for 30 drawings a second delivered 18.
  const push = (at, s) => states.push({ at: roundTime(Math.max(0, Math.min(seconds, at))), ...s });

  if (type === "MAP") {
    // A MAP reveals in two currencies. A road ARRIVES over time — it draws
    // itself along its own length — so one reveal becomes several states. A
    // place LANDS instantly, marker and label together.
    //
    // roadIds is the highlighted roads in the order mapRevealLabels emitted
    // them, so reveal i < roadIds.length is a road and the rest are places.
    // Roads that have finished stay finished: progress accumulates rather than
    // being recomputed, or an earlier road would vanish as the next one drew.
    // BASE ROADS ARE ALREADY ON SCREEN when a previous map in this video
    // established them. `established` is the session's memory: the second map of
    // a video does not re-perform the rings, it starts from them.
    const drawn = {};
    for (const id of roadIds) drawn[id] = established.has(id) ? 1 : 0;
    let placesShown = 0;
    let revealed = 0;

    push(0, { roadProgress: { ...drawn }, places: 0, visible: 0, pulse: 0 });

    // KEYED BY r.index, NOT BY POSITION. With narration ordering the reveals no
    // longer arrive in label order — that is the whole point of it — so the
    // position in this list says nothing about WHAT is being revealed. Using `i`
    // here animated whichever road happened to be i-th while labelling it with a
    // different name.
    let placeOrder = 0;
    // Context reveals share at:0 and are one instant, so the running counters
    // still work — each simply lands in the same state as the ones beside it and
    // finish() collapses them.
    reveals.forEach((r, i) => {
      // Positional FALLBACK, not zero. planReveals always sets `index`, but
      // defaulting a missing one to 0 made every reveal animate roadIds[0] — one
      // road drawn three times, and its progress running backwards on each pass.
      const idx = r.index ?? i;
      if (idx < roadIds.length) {
        const id = roadIds[idx];
        // Already established by an earlier map: nothing to draw, so no states.
        if (established.has(id)) return;
        for (let k = 1; k <= ROAD_DRAW_STEPS; k++) {
          const t = k / ROAD_DRAW_STEPS;
          drawn[id] = easeOut(t);
          // Eased so the tip decelerates into place instead of stopping dead.
          push(r.at + (ROAD_DRAW_SECONDS * k) / ROAD_DRAW_STEPS, {
            roadProgress: { ...drawn },
            places: placesShown,
            visible: ++revealed,
            pulse: k === ROAD_DRAW_STEPS ? 1 : 0,
            // EVERY FRAME OF THE DRAW EXCEPT THE LAST IS A TWEEN.
            //
            // The dead-state check asks whether a state that must differ from
            // its predecessor actually rasterised differently. Adjacent frames
            // of a 21-step eased draw differ by a fraction of a road — and under
            // easeOut the final frames move least of all — so comparing them
            // pairwise would report a correct, smooth draw as a wall of dead
            // states and reject the graphic. The check compares KEY states, and
            // the key here is the finished road.
            tween: k < ROAD_DRAW_STEPS,
          });
        }
      } else {
        placesShown++;
        placeOrder++;
        push(r.at, { roadProgress: { ...drawn }, places: placesShown, visible: ++revealed, pulse: 1 });
        push(r.at + LAND_SECONDS, { roadProgress: { ...drawn }, places: placesShown, visible: revealed, pulse: 0 });
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
    //
    // A CLOCK TIME ARRIVES TOO. countUp eases DIGITS, and digits are only a
    // quantity when the value is one: "Tuesday, 7:15 AM" counted up put
    // "Tuesday, 0:15 AM" on screen for real — card 11, 4:12, a time of day
    // that was never true, rendered mid-ease. A time is an identity, not an
    // amount; it lands whole. Token shape, not topic knowledge: any value
    // containing digit:digit is a time wherever the script is about.
    if (!/\d/.test(value) || /\d{1,2}:\d{2}/.test(value)) {
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
    // HALF A FRAME, not a whole one. Two states a full frame apart are two
    // frames and must both survive; only states closer than half a frame are
    // genuinely the same instant (a beat landing on a reveal).
    if (prev && Math.abs(prev.at - s.at) < 0.5 / GRAPHIC_FPS) merged[merged.length - 1] = { ...s, at: prev.at };
    else merged.push(s);
  }

  return merged.map((s, i) => ({
    ...s,
    until: roundTime(i + 1 < merged.length ? merged[i + 1].at : seconds),
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
  session = null,
  push = true,
}) {
  // MAP is the one type whose renderer and label set live elsewhere: its reveal
  // unit is geometry, not a row of text, so both come from yt-map-render.js.
  const isMap = type === "MAP";
  const roadIds = isMap ? highlightedRoadIds(spec) : [];
  const labels = isMap ? mapRevealLabels(spec) : revealLabels(type, spec);
  const draw = isMap ? (t, sp, st) => renderMapPng(sp, st) : renderPng;

  // MAP reveals in NARRATION order — subject first — because nothing about a map
  // requires its roads to arrive before its places. Cards keep the given order:
  // a table fills top-down whatever sequence its rows are named in.
  // MAP has its own planner: its labels split into things the take names and
  // things it shows for orientation, and only the first population is a reveal.
  const timing = isMap
    ? planMapReveals({ targets: mapRevealTargets(spec), words, seconds })
    : planReveals({ labels, words, seconds });

  // The session's already-drawn roads, and whether this map is even in the same
  // region as the last one.
  const established = isMap && session ? session.establishedFor(spec) : new Set();
  const states = buildStates({ type, labels, reveals: timing.reveals, beats: timing.beats, seconds, roadIds, spec, established });
  if (isMap && session) session.record(spec);

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
  // The index of the last state that was NOT a tween, so a motion is compared
  // across its whole travel rather than frame to frame.
  let lastKey = 0;
  for (let i = 1; i < framePaths.length; i++) {
    // A TWEEN IS NOT A CLAIM ABOUT PIXELS. It is one frame of a motion that is
    // asserted at its endpoints, and two adjacent frames of a 21-step eased draw
    // legitimately differ by almost nothing. Checking them pairwise would reject
    // every smooth animation in the file for being smooth.
    if (states[i].tween) continue;
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
    if (states[i].settle || states[i].beat) { lastKey = i; continue; }
    const prev = lastKey;
    const mustChange = isMap
      ? mapMotion(states[i]) !== mapMotion(states[prev])
      : states[i].visible !== states[prev].visible
        // FIGURE, not progress. Comparing progress asserted that two moments
        // showing the identical figure must nonetheless differ in pixels — true
        // of any small value, which reaches its final digits early and then
        // holds. That demanded motion the design never promised and rejected
        // sound CALLOUTs for it.
        || (readsProgress && states[i].figure !== states[prev].figure);
    if (!mustChange) { lastKey = i; continue; }
    const d = await frameDifference(framePaths[prev], framePaths[i]);
    stateDiffs.push({ from: prev, to: i, visible: states[i].visible, diff: round(d) });
    lastKey = i;
  }
  const deadStates = stateDiffs.filter((d) => d.diff < 0.02);

  const out = join(dir, `${stem}.mp4`);
  ffmpeg(concatArgs(listPath, out, { seconds, fps, push }));

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
    baseRoadsReused: established.size,
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
export function concatArgs(listPath, output, { seconds, fps = GRAPHIC_FPS, push = true }) {
  const frames = Math.max(1, Math.round(seconds * fps));
  const z = `1+${PUSH_TRAVEL}*on/${frames}`;
  // `push: false` RENDERS THE SAME STATES THROUGH THE SAME ENCODE, WITHOUT THE
  // CAMERA. It exists for measurement and is never used by a build.
  //
  // The push moves every pixel a little on every frame, which is the point of it
  // — and it means a frame-to-frame difference is never zero even when the
  // CONTENT is a held still. The first artifact-level motion check was defeated
  // by exactly that: it reported a 2.5fps slideshow as "0.0% held" and passed
  // its own negative control, because the drifting camera answered the question
  // instead of the drawing.
  //
  // With the camera off, a held still is bit-identical to the one before it and
  // stepping becomes unambiguous rather than statistical. Same state list, same
  // concat, same encoder — one variable removed.
  const vf = push
    ? `fps=${fps},zoompan=z='${z}':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1920x1080:fps=${fps},format=yuv420p,setsar=1`
    : `fps=${fps},scale=1920:1080,format=yuv420p,setsar=1`;
  return [
    "-y",
    "-f", "concat", "-safe", "0", "-i", listPath,
    "-vf", vf,
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

/**
 * Prove a generated clip is the length it claims and is not one frame in a
 * trench coat.
 *
 * THE BEAT ENTERED THE TIMELINE ON TRUST AND CARD 11 PRICED THE TRUST: the
 * artifact spent 84 seconds frozen, and the QC gate that finally said so runs
 * fifty minutes after the clip that could have been checked in half a second
 * here. This is the half-second version: ffprobe says the file really has
 * ~`seconds` of video ON ITS VIDEO STREAM (a container duration is the max of
 * its streams and hides a short picture), and two frames from different
 * moments actually differ. Every failure names itself; the caller decides
 * whether a failed clip costs the build or falls to another layer.
 *
 * @returns {{ ok, failures, videoSeconds }}
 */
export async function assertClipCovers(clipPath, { seconds, dir, ffmpeg, index = 0, tolerance = 0.15 }) {
  const failures = [];
  let videoSeconds = null;
  try {
    const { execFileSync } = await import("child_process");
    const out = execFileSync("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=duration", "-of", "csv=p=0", clipPath,
    ], { encoding: "utf-8" });
    videoSeconds = Number.parseFloat(String(out).trim());
  } catch (err) {
    return { ok: false, failures: [`ffprobe could not read ${clipPath}: ${err.message}`], videoSeconds };
  }
  if (!Number.isFinite(videoSeconds)) {
    failures.push(`the video stream reports no duration — the encode produced no usable picture`);
  } else if (videoSeconds < seconds - tolerance) {
    failures.push(`the video stream is ${round(videoSeconds)}s against a ${round(seconds)}s slot — the picture would run out and freeze or loop`);
  }

  // Two frames, apart in time, must differ. A clip of one repeated frame is
  // exactly what the frozen tails looked like from inside a piece.
  if (failures.length === 0 && seconds >= 0.8) {
    const a = join(dir, `cover-${String(index).padStart(3, "0")}-a.png`);
    const b = join(dir, `cover-${String(index).padStart(3, "0")}-b.png`);
    try {
      ffmpeg(["-y", "-ss", String(round(seconds * 0.2)), "-i", clipPath, "-frames:v", "1", "-q:v", "2", a]);
      ffmpeg(["-y", "-ss", String(round(seconds * 0.8)), "-i", clipPath, "-frames:v", "1", "-q:v", "2", b]);
      const d = await frameDifference(a, b);
      if (d < 0.02) {
        failures.push(`frames at 20% and 80% are identical (difference ${round(d)}) — the clip is a still`);
      }
    } catch (err) {
      failures.push(`could not extract frames to verify motion: ${err.message}`);
    }
  }

  return { ok: failures.length === 0, failures, videoSeconds: Number.isFinite(videoSeconds) ? round(videoSeconds) : null };
}

function median(xs) {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** State times are frame-accurate, so they round to milliseconds. */
function roundTime(n) {
  return Math.round(n * 1000) / 1000;
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}

/**
 * A wordless brand beat, animated.
 *
 * Replaces renderTypographyClip as the floor. Same contract — one mp4 of exactly
 * `seconds` — and deliberately far cheaper: the geometry is a function of phase,
 * so there is no transcript to read, no phrase to window, and nothing that could
 * ever contradict the caption underneath it.
 */
export async function renderBeatClip({ seconds, dir, index = 0, fps = GRAPHIC_FPS, ffmpeg, writeFileSync, startPhase = 0, push = true }) {
  const total = Math.max(0.2, Number(seconds) || 0);
  // THE BEAT MOVED AT 2.5 FRAMES A SECOND, and it carried more than half the
  // runtime. One state per 0.4s was chosen so "a long beat does not cost more
  // rasterises than a real graphic" — a sound instinct about cost applied to
  // the one layer that was on screen most, so the video's dominant visual was
  // also its jerkiest. Four arcs each rotating at their own rate, advancing
  // twice a second, is the largest single contributor to "the whole video feels
  // laggy".
  //
  // Now it moves at the delivery rate like everything else. The cost is bounded
  // from the other end instead: the beat is a BRIDGE now, capped at a couple of
  // seconds by the fallback chain, so full-rate motion is affordable precisely
  // because there is not much of it. BEAT_MAX_FRAMES is the backstop if that
  // ever regresses — a steppier beat is a much cheaper failure than twenty
  // minutes of rasterising.
  const wanted = Math.max(2, Math.round(total * GRAPHIC_TWEEN_FPS));
  const count = Math.min(wanted, BEAT_MAX_FRAMES);
  const stem = `beat-${String(index).padStart(3, "0")}`;
  const framePaths = [];

  // PHASE ADVANCES PER SECOND, NOT PER FRAME, and this is the line that makes
  // raising the frame rate a smoothness change instead of a speed change. It was
  // `i * 37` — 37 units per state at one state per 0.4s, so 92.5 units a second.
  // Left alone at 30fps the same expression would spin the arcs twelve times
  // faster, which is not a smoother beat, it is a different and much worse one.
  const perFrame = (BEAT_PHASE_PER_SECOND * total) / count;
  for (let i = 0; i < count; i++) {
    const png = await renderBeatPng(startPhase + i * perFrame);
    const p = join(dir, `${stem}-s${String(i).padStart(3, "0")}.png`);
    writeFileSync(p, png);
    framePaths.push(p);
  }

  const listPath = join(dir, `${stem}.txt`);
  const per = round(total / count);
  const lines = framePaths.map((f) => `file '${f}'\nduration ${per}`);
  lines.push(`file '${framePaths[framePaths.length - 1]}'`);
  writeFileSync(listPath, lines.join("\n"));

  const out = join(dir, `${stem}.mp4`);
  ffmpeg(concatArgs(listPath, out, { seconds: total, fps, push }));
  return { path: out, seconds: round(total), stateCount: count };
}
