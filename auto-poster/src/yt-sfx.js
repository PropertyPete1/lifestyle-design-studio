/**
 * yt-sfx.js — the impact and the whoosh, synthesised rather than licensed.
 *
 * THE STANDING DECISION WAS TO SHIP WITHOUT SFX RATHER THAN STRETCH THE
 * LICENSING BAR, and this module exists because there turned out to be a third
 * option neither side of that decision considered.
 *
 * The clean-license sound-effect sources really are thin. The ones with usable
 * terms either have no API for audio at all — Pixabay's API serves images and
 * videos, and their full terms prohibit robotic collection outside it — or gate
 * downloads behind an OAuth flow that a GitHub-secrets-only pipeline cannot
 * complete. Every remaining path involved either a weaker licence than this
 * project accepts or a human step that does not exist.
 *
 * So nothing is fetched. A soft impact is a low sine with a fast decay; a whoosh
 * is filtered noise with a swell. ffmpeg generates both from its own
 * oscillators, which means the sounds are ours outright: no licence, no
 * attribution, no Content ID surface, and nothing to re-verify when a source
 * changes its terms. The knob stays because the sounds might still be wrong for
 * the channel — but "wrong for the channel" is a taste question, which is the
 * only kind of question that should be left open here.
 *
 * DETERMINISTIC. Same arguments, same samples, every build — so the kit is
 * cached per work directory and the cold-run comparison stays byte-identical.
 */

import { join } from "path";
import { existsSync } from "fs";

import { PUNCH_SFX_ENABLED, PUNCH_SFX_DB } from "./yt-config.js";

/** The most hits one video may carry, whatever the edit asks for. */
export const MAX_SFX_EVENTS = 40;

const IMPACT_SECONDS = 0.45;
const WHOOSH_SECONDS = 0.5;

/**
 * Makeup gain, so the dB knob means what it says.
 *
 * MEASURED, NOT CHOSEN. ffmpeg's `sine` source does not emit at full scale — it
 * came out at -18.1 dBFS — and the mono-to-stereo conversion costs another 3 dB
 * on top. Left alone, a hit peaked at -21 dBFS BEFORE `YT_PUNCH_SFX_DB` applied
 * its own -20, putting the impact 41 dB down and inaudible under narration. The
 * knob would have read as broken rather than as quiet.
 *
 * These two constants bring each sound to roughly -3 dBFS, which is where the
 * knob's number becomes the hit's actual level. They are verified by a test
 * rather than trusted: an ffmpeg release that changes either source's amplitude
 * would otherwise silently move the mix.
 */
const IMPACT_MAKEUP = 8;
const WHOOSH_MAKEUP = 4.5;

/** What the synthesised sounds must peak at, and how far off is acceptable. */
export const TARGET_PEAK_DB = -3;
export const PEAK_TOLERANCE_DB = 3;

/**
 * A soft impact: a low sine, dropped fast.
 *
 * 70 Hz with an exponential decay is a chest thump rather than a drum — it
 * reads as weight under a word, which is what a punch needs, instead of as a
 * percussion hit, which would read as a different video's edit. The decay is an
 * expression rather than an `afade` because afade's curves are shaped for
 * material seconds long and this is over in under half of one.
 */
export function impactArgs(output, { seconds = IMPACT_SECONDS } = {}) {
  return [
    "-y",
    "-f", "lavfi", "-i", `sine=frequency=70:duration=${seconds}:sample_rate=48000`,
    "-af",
    // The decay envelope, and a gentle high cut so the click at the attack does
    // not read as a pop on small speakers.
    //
    // `isnan(t)` IS NOT DEFENSIVE PADDING. ffmpeg hands the volume filter a NaN
    // timestamp on any frame whose time it does not know, the expression
    // evaluates to NaN, and the filter substitutes zero — so the guard is the
    // difference between a hit and a hole where the hit should be. It logged
    // "Invalid value NaN for volume, setting to 0" and produced audio anyway,
    // which is the kind of warning that gets scrolled past.
    `volume=${IMPACT_MAKEUP},volume='if(isnan(t),1,exp(-t*11))':eval=frame,lowpass=f=220,` +
      `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo`,
    "-c:a", "pcm_s16le",
    output,
  ];
}

/**
 * A subtle whoosh: pink noise, swelled and rolled off.
 *
 * Not a swept filter — ffmpeg's bandpass takes a fixed frequency, so a true
 * sweep would need a chain of them, and the difference is inaudible at the level
 * this sits at. A swell on filtered noise is what a whoosh is at -20 dB.
 */
export function whooshArgs(output, { seconds = WHOOSH_SECONDS } = {}) {
  return [
    "-y",
    "-f", "lavfi", "-i", `anoisesrc=d=${seconds}:c=pink:a=0.7:r=48000`,
    "-af",
    // Up and back down across the half second, with the bottom and the very top
    // taken out so it moves air without hissing. The NaN guard resolves to
    // silence here rather than to full level: an unknown timestamp in a swell
    // should contribute nothing, not a burst of noise at full scale.
    `volume=${WHOOSH_MAKEUP},volume='if(isnan(t),0,sin(3.14159*t/${seconds}))':eval=frame,highpass=f=300,lowpass=f=5000,` +
      `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo`,
    "-c:a", "pcm_s16le",
    output,
  ];
}

/**
 * Render the two sounds once per build. Returns null if either will not make.
 *
 * Null rather than a throw: no SFX is a fine video, and a synthesiser that
 * failed is not a reason to lose twelve minutes of render.
 */
export function ensureSfxKit(dir, ffmpeg) {
  if (!PUNCH_SFX_ENABLED) return null;
  const impact = join(dir, "sfx-impact.wav");
  const whoosh = join(dir, "sfx-whoosh.wav");
  try {
    if (!existsSync(impact)) ffmpeg(impactArgs(impact));
    if (!existsSync(whoosh)) ffmpeg(whooshArgs(whoosh));
  } catch (err) {
    console.warn(`[SFX] could not synthesise the kit: ${err.message} — the video ships silent of hits`);
    return null;
  }
  return { impact, whoosh };
}

/**
 * Where the hits go: one impact per micro-punch, one whoosh per punch-in cut.
 *
 * THE CUTS ARE THINNED RATHER THAN TRUNCATED when there are more than the
 * ceiling allows. An on-camera take re-frames every three seconds, so a
 * twelve-minute video can hold well over a hundred cuts — taking the first forty
 * would put a whoosh on every cut in the first two minutes and none after, which
 * sounds like the effect broke halfway through. Evenly dropping them keeps the
 * texture across the whole video, which is what "subtle" has to mean here.
 */
export function punchSfxTimeline(plan, punches = [], { max = MAX_SFX_EVENTS, enabled = PUNCH_SFX_ENABLED } = {}) {
  if (!enabled) return [];

  const events = (punches || []).map((p) => ({ at: p.at, kind: "impact" }));

  // Every seam the retention edit created, in absolute video time.
  const cuts = [];
  let elapsed = 0;
  for (const seg of plan?.segments || []) {
    const seconds = seg.seconds || 0;
    if (seg.kind === "on_camera" && seg.editPlan?.pieces?.length > 1) {
      let within = 0;
      for (const piece of seg.editPlan.pieces.slice(0, -1)) {
        within += piece.seconds ?? piece.duration ?? 0;
        // The very first frame of a take is a cut the viewer already hears as a
        // scene change; a whoosh on it doubles what the edit is doing.
        if (within > 0.4 && within < seconds - 0.4) cuts.push({ at: round(elapsed + within), kind: "whoosh" });
      }
    }
    elapsed += seconds;
  }

  const room = Math.max(0, max - events.length);
  if (cuts.length > room) {
    const step = cuts.length / room;
    for (let i = 0; room > 0 && i < room; i++) events.push(cuts[Math.floor(i * step)]);
  } else {
    events.push(...cuts);
  }

  return events.filter((e) => Number.isFinite(e.at) && e.at >= 0).sort((a, b) => a.at - b.at);
}

/**
 * Mix the hits into the finished audio.
 *
 * One `adelay` per event into a single `amix`, which is why the ceiling exists:
 * this is one filter graph and one pass, and an unbounded event list would build
 * a graph with hundreds of inputs.
 *
 * `amix` divides by the input count, so a video with forty hits would have its
 * narration attenuated forty-fold. `normalize=0` turns that off and the levels
 * are set explicitly instead — the narration stays where it was and each hit
 * arrives at PUNCH_SFX_DB.
 */
export function mixSfxArgs(videoIn, events, kit, output, { db = PUNCH_SFX_DB } = {}) {
  const gain = Math.round(Math.pow(10, db / 20) * 10000) / 10000;
  const inputs = [];
  const chains = [];
  const labels = ["[0:a]"];

  events.forEach((e, i) => {
    inputs.push("-i", e.kind === "whoosh" ? kit.whoosh : kit.impact);
    const ms = Math.max(0, Math.round(e.at * 1000));
    chains.push(`[${i + 1}:a]adelay=${ms}|${ms},volume=${gain}[s${i}]`);
    labels.push(`[s${i}]`);
  });

  chains.push(
    `${labels.join("")}amix=inputs=${labels.length}:duration=first:normalize=0:dropout_transition=0[aout]`
  );

  return [
    "-y", "-i", videoIn, ...inputs,
    "-filter_complex", chains.join(";"),
    "-map", "0:v", "-map", "[aout]",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
    output,
  ];
}

function round(n) {
  return Math.round(n * 100) / 100;
}
