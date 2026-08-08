/**
 * yt-cadence.js — nothing holds the screen for more than ten seconds.
 *
 * A viewer leaves during a stretch where nothing changes. Not because the
 * content got worse — because the picture stopped giving them a reason to keep
 * looking. Ten seconds is roughly where a static frame starts reading as a
 * held shot rather than a shot.
 *
 * WHAT COUNTS AS A CHANGE
 * Anything the eye registers as a new state: a cut to a different clip, a
 * framing change from a punch-in, a graphic appearing or being replaced, the
 * PIP bubble arriving or moving corner. This module does not create any of
 * those — the edit list, the visual planner and the PIP compositor already do.
 * It AUDITS the finished plan and reports what still sits too long.
 *
 * WHY AUDIT RATHER THAN FIX
 * Because the fixes are not interchangeable and the module cannot know which is
 * right. A 30-second B-roll stretch could be cut into more clips (needs library
 * headroom), given a graphic (needs the writer to have asked for one), or given
 * a PIP (needs a recorded narration take and a clean matte). Silently inventing
 * one would produce a video nobody chose. Reporting it puts the decision where
 * it belongs and makes the failure visible instead of invisible.
 */

/** The longest any single visual state may hold. */
export const MAX_STATIC_SECONDS = 10;

/**
 * Every visual state in the finished plan, in order.
 *
 * One entry per thing the viewer sees, with what would break it up. Flattens
 * across segment boundaries because the viewer does not see segments — a
 * voiceover take with one 8-second clip followed by another take with one
 * 6-second clip is two states, not one 14-second one.
 */
export function buildStateTimeline(segments = []) {
  const states = [];
  let elapsed = 0;

  for (const seg of segments) {
    const seconds = seg.seconds || 0;

    if (seg.kind === "on_camera") {
      // An edited take is already several states: every piece is a cut, and a
      // punch-in changes framing at each one.
      const pieces = seg.editPieces || [];
      if (pieces.length > 0) {
        for (const p of pieces) {
          states.push({
            at: round(elapsed),
            seconds: round(p.seconds),
            kind: "on_camera",
            takeId: seg.takeId,
            detail: p.push ? "face, push-in" : `face, framing ${p.scale}`,
            varied: true,
          });
          elapsed += p.seconds;
        }
        continue;
      }
      states.push({ at: round(elapsed), seconds: round(seconds), kind: "on_camera", takeId: seg.takeId, detail: "face, uncut", varied: false });
      elapsed += seconds;
      continue;
    }

    // Voiceover: each B-roll clip or generated visual is its own state.
    const clips = seg.broll || [];
    if (clips.length === 0) {
      states.push({ at: round(elapsed), seconds: round(seconds), kind: "empty", takeId: seg.takeId, detail: "no picture", varied: false });
      elapsed += seconds;
      continue;
    }
    for (const c of clips) {
      states.push({
        at: round(elapsed),
        seconds: round(c.seconds),
        kind: c.generated ? "graphic" : "footage",
        takeId: seg.takeId,
        detail: c.generated ? `${c.kind} graphic` : `clip ${c.fileName || c.driveFileId}`,
        // A PIP bubble over a held visual is itself a change, and it moves.
        varied: Boolean(seg.pip),
        pip: Boolean(seg.pip),
      });
      elapsed += c.seconds;
    }
  }

  return states;
}

/**
 * Find every state that holds too long.
 *
 * A state with a PIP over it is judged more leniently: the bubble is a second
 * moving element and it changes corner, so the frame is not static even when
 * the background is. It still cannot run forever, hence the multiplier rather
 * than an exemption.
 */
export function auditCadence(segments, { maxSeconds = MAX_STATIC_SECONDS } = {}) {
  const states = buildStateTimeline(segments);
  const violations = [];

  for (const s of states) {
    const limit = s.pip ? maxSeconds * 1.5 : maxSeconds;
    if (s.seconds > limit) {
      violations.push({
        at: s.at,
        seconds: s.seconds,
        kind: s.kind,
        takeId: s.takeId,
        detail: s.detail,
        overBy: round(s.seconds - limit),
        // Naming the available remedy is the point of the report.
        remedy: remedyFor(s),
      });
    }
  }

  const longest = states.reduce((max, s) => Math.max(max, s.seconds), 0);
  return {
    ok: violations.length === 0,
    violations,
    stats: {
      stateCount: states.length,
      longestStateSeconds: round(longest),
      averageStateSeconds: states.length ? round(states.reduce((n, s) => n + s.seconds, 0) / states.length) : 0,
      maxSeconds,
    },
    states,
  };
}

function remedyFor(state) {
  if (state.kind === "on_camera") {
    return state.detail === "face, uncut"
      ? "the take was not edited — check that silence detection ran and that it is over the punch-in threshold"
      : "shorten the punch-in interval for this take";
  }
  if (state.kind === "footage") {
    return "cut this take's B-roll into more clips, ask the writer for a graphic here, or record the narration so a PIP can carry it";
  }
  if (state.kind === "graphic") {
    return "split the narration across two graphics, or hand part of it back to footage";
  }
  return "this segment has no picture at all — the B-roll allocator ran dry";
}

function round(n) {
  return Math.round(n * 100) / 100;
}
