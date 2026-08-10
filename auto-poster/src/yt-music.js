/**
 * yt-music.js — the music bed, fetched and licensed by the pipeline itself.
 *
 * Same shape as the stock layer, and for the same reason: Drive auth is
 * GitHub-secrets-only, so there is no human step where somebody drops an mp3 in
 * a folder. The pipeline acquires its own bed or ships without one.
 *
 * WHY INCOMPETECH AND NOT PIXABAY, WHICH THE PHASE 0 DOC PREFERRED
 *
 * Phase 0 ranked Pixabay first because CC0-style terms remove the attribution
 * failure mode. That reasoning is still right about USE and says nothing about
 * ACQUISITION, which is the half that binds a pipeline that fetches for itself.
 * Two facts settle it, both verified 2026-08-10 against the live pages:
 *
 *   1. Pixabay's API serves images and videos. There is no music endpoint, so
 *      there is no authorised programmatic path to a Pixabay track.
 *   2. Their full Terms — not the licence summary, which is silent on this —
 *      prohibit "the use of programs or robots for automatic data collection
 *      and/or extraction of digital data on the Service" for unauthorised
 *      purposes, and prohibit "bulk, large-scale or systematic copying".
 *
 * So a build that fetched Pixabay music would satisfy the licence on the track
 * and break the terms it obtained the track under. That is precisely the split
 * STOCK-LICENSING.md found between Pexels' content licence and its API
 * guidelines, arriving a second time. Pixabay music remains fine for a HUMAN to
 * place in the Drive folder, and this module will happily use whatever is
 * already cached there — it just may not go and get it.
 *
 * Incompetech is CC-BY 4.0. The licence is itself a grant from the rights holder
 * to reproduce and share the work, which is the authorisation Pixabay's terms
 * withhold, and incompetech's own pages carry no automated-access clause. The
 * cost is an attribution line, which the description already emits for Pexels.
 *
 * CONTENT ID IS A LIVE RISK AND THE CREDIT LINE IS THE MITIGATION.
 *
 * The widely repeated claim that YouTube whitelisted MacLeod's catalogue and
 * false claims "dropped to zero" traces to a blog post from 2015. His CURRENT
 * Content ID page says the opposite: "It is becoming increasingly difficult to
 * challenge all of the false claims people are filing", and a claim "can take
 * months to unwind". The instruction that matters to us is procedural —
 *
 *   "Be sure to add credits BEFORE YOU DISPUTE THE CLAIM."
 *
 * — and a disputed claim releases within 72 hours. So the credit block is not
 * only the licence obligation: it is the precondition for clearing a claim
 * quickly. That is why it is emitted automatically rather than left to a human
 * to remember on the day it matters.
 */

import { join } from "path";
import { existsSync, readFileSync, writeFileSync, statSync } from "fs";

import { MUSIC_ENABLED, MUSIC_DB, MUSIC_LIFT_DB } from "./yt-config.js";
import { assertNoReelsReach } from "./yt-footage-source.js";

/** Where a fetched bed is cached, so the second build does not refetch. */
export const MUSIC_FOLDER = process.env.YT_MUSIC_FOLDER || "1m5ls5m2CE-3FajnU4JG1V9SmJ2zmIX9y";

const DOWNLOAD_BASE = "https://incompetech.com/music/royalty-free/mp3-royaltyfree/";

/** An mp3 smaller than this is an error page wearing an .mp3 extension. */
const MIN_TRACK_BYTES = 512 * 1024;

/**
 * The vendored catalogue. VERIFIED BY HAND, NOT DISCOVERED AT BUILD TIME.
 *
 * The pipeline fetches these exact files and never crawls, searches or reads an
 * index. That is a deliberate licensing property rather than an implementation
 * convenience: "fetch four known files once and cache them" is not the
 * systematic collection that a catalogue walk would be, whatever the source's
 * terms happen to say about robots.
 *
 * Every field was read off incompetech's own catalogue on 2026-08-10 and every
 * URL was confirmed to return 200 with an audio payload. `seconds` is the
 * catalogue's stated length.
 *
 * ALL FOUR RUN LONGER THAN ANY VIDEO THIS PIPELINE PRODUCES (10-15 minutes),
 * and that is a selection criterion, not a coincidence. Incompetech's licence
 * lets you "chop, splice, compress, lengthen" provided the credit makes clear
 * which parts are yours — a bed that had to LOOP to cover twelve minutes would
 * be lengthening the work and would owe a more careful disclosure. A bed that
 * is simply longer than the video is only ever trimmed, which is the mildest
 * form of the clause and the easiest to state honestly.
 *
 * Sparse, slow and melodically undemanding throughout. A bed under narration
 * competes with speech for the same attention, so the selection favours texture
 * over tune — an instrument list of "Synths, Electric Piano" is doing the job
 * that "Guitar, Bass, Kit" would fight.
 */
export const TRACKS = [
  {
    id: "concentration",
    title: "Concentration",
    file: "Concentration.mp3",
    isrc: "USUAN1700022",
    seconds: 1793,
    feel: "Calming, Relaxed",
    instruments: "Synths, Electric Piano",
  },
  {
    id: "ambiment",
    title: "Ambiment",
    file: "Ambiment.mp3",
    isrc: "USUAN1100630",
    seconds: 1373,
    feel: "Calming, Mystical, Relaxed",
    instruments: "Piano, Synths",
  },
  {
    id: "almost-in-f",
    title: "Almost in F",
    file: "Almost in F.mp3",
    isrc: "USUAN1100394",
    seconds: 1962,
    feel: "Calming, Mystical, Relaxed",
    instruments: "Piano, Basses",
  },
  {
    id: "ever-mindful",
    title: "Ever Mindful",
    file: "Ever Mindful.mp3",
    isrc: "USUAN1700033",
    seconds: 1599,
    feel: "Relaxed, Bright, Calming",
    instruments: "Cellos, Basses, Violas, Violins, Choir, Flutes, Clarinets",
  },
];

/** Every track here is under one licence, so the terms live once. */
export const LICENCE = {
  name: "Creative Commons Attribution 4.0",
  url: "https://creativecommons.org/licenses/by/4.0/",
  licensor: "Kevin MacLeod",
  source: "incompetech.com",
  attributionRequired: true,
};

export function trackUrl(track) {
  return `${DOWNLOAD_BASE}${encodeURIComponent(track.file)}`;
}

export function cacheKey(track) {
  return `incompetech-${track.id}.mp3`;
}

/**
 * Which track this video gets.
 *
 * DETERMINISTIC IN THE SCRIPT, so a rebuild of the same video produces the same
 * bed. The cold-run determinism check compares two builds of one script, and a
 * bed that rotated on wall-clock time would fail it for a reason that has
 * nothing to do with the thing being checked. Different scripts land on
 * different tracks, which is all the variety a weekly channel needs.
 */
export function pickTrack(seed = "", tracks = TRACKS) {
  if (tracks.length === 0) return null;
  const s = String(seed);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return tracks[h % tracks.length];
}

/**
 * The credit, carrying the modification disclosure the licence actually asks for.
 *
 * Incompetech's terms permit chopping and lengthening but require that the
 * credit "make it clear in the credits which parts are yours, and which parts
 * are mine". The pipeline trims the track to the runtime and rides its level
 * under the narration, so the line says so. Ducking on its own would not need
 * this — that is playback automation, not a modification — but the trim is.
 */
export function creditLine(track) {
  return (
    `"${track.title}" by ${LICENCE.licensor} (${LICENCE.source}) — ` +
    `licensed under ${LICENCE.name}: ${LICENCE.url}. ` +
    `Used as an edited background bed: trimmed to length and mixed under the narration. ` +
    `The recording is Kevin MacLeod's; the edit and the mix are ours.`
  );
}

/**
 * The description block. Empty string when there is no bed, so a video that
 * shipped without music carries no dangling "Music" header.
 */
export function musicCreditsBlock(track) {
  if (!track) return "";
  return ["Music", `• ${creditLine(track)}`].join("\n");
}

export function musicEnabled() {
  return MUSIC_ENABLED;
}

// ─── levels ─────────────────────────────────────────────────────────────────

/** dB to linear gain, which is what ffmpeg's volume filter wants. */
export function dbToGain(db) {
  return Math.round(Math.pow(10, db / 20) * 10000) / 10000;
}

/**
 * The bed's volume envelope across the whole video.
 *
 * Two jobs in one expression. The BASE level is where the bed sits under
 * speech — `YT_MUSIC_DB`, hard under by default, with the sidechain compressor
 * in yt-assemble.js pulling it further down on every syllable. The LIFT is the
 * energy change Peter asked for: the bed comes up under the hook, drops back for
 * the body, and comes up again for the close.
 *
 * Ramped rather than switched. A volume filter that steps from one gain to
 * another between frames produces a click, and a click in an otherwise clean
 * twelve-minute mix is the kind of defect that reads as amateur rather than as a
 * bug. Two seconds of linear ramp is inaudible as a transition and unmistakable
 * as a lift.
 *
 * DEGRADES TO A FLAT BED, deliberately. A video too short to hold a hook, a
 * body and a close without the ramps overlapping gets one constant level rather
 * than an envelope that folds back on itself — a 40-second test render should
 * sound quiet and boring, not broken.
 */
export function bedEnvelope({ seconds, hookSeconds = 15, closeSeconds = 20, ramp = 2, db = MUSIC_DB, liftDb = MUSIC_LIFT_DB } = {}) {
  const body = dbToGain(db);
  const lift = dbToGain(db + liftDb);
  const closeAt = seconds - closeSeconds;

  // The four boundaries must stay in order with a ramp's room between them, or
  // the piecewise expression describes a shape that does not exist.
  const hasRoom = seconds > 0 && hookSeconds + ramp < closeAt - ramp && closeAt > 0;
  if (!hasRoom) return { expr: String(body), body, lift, shaped: false };

  const h = round(hookSeconds);
  const c = round(closeAt);
  const r = Math.max(0.2, ramp);
  // if t < h              : lift        (the hook)
  // if t < h + r          : ramp down   (into the body)
  // if t < c - r          : body
  // if t < c              : ramp up     (into the close)
  // else                  : lift        (the close)
  const expr =
    `if(lt(t,${h}),${lift},` +
    `if(lt(t,${h + r}),${lift}+(${body}-${lift})*(t-${h})/${r},` +
    `if(lt(t,${c - r}),${body},` +
    `if(lt(t,${c}),${body}+(${lift}-${body})*(t-${c - r})/${r},${lift}))))`;

  return { expr, body, lift, shaped: true, hookSeconds: h, closeAt: c, ramp: r };
}

// ─── acquisition ────────────────────────────────────────────────────────────

/**
 * Fetch the bed, or return why there isn't one.
 *
 * FAILS OPEN, unlike the stock layer's vision check, and the asymmetry is the
 * same argument run the other way. A wrong stock clip puts an agency watermark
 * on screen for years; a missing music bed makes the video quieter. So every
 * failure here returns a reason and the render proceeds with narration only —
 * renderTimeline already treats a null musicPath as an ordinary state.
 *
 * The cache is checked before the network in both directions: local first (a
 * rebuild in the same job), then Drive (a rebuild in a later job). Only a miss
 * on both reaches incompetech, so the steady state is one fetch per track ever.
 */
export async function fetchMusicBed({
  track,
  dir,
  fetchImpl = fetch,
  driveGet = null,
  drivePut = null,
} = {}) {
  if (!musicEnabled()) return { path: null, track: null, reason: "YT_MUSIC is off" };
  if (!track) return { path: null, track: null, reason: "no track selected" };

  // The music folder is not a reels folder, but every Drive reach in the
  // long-form pipeline goes through the same guard rather than through a
  // convention about which ids are safe.
  assertNoReelsReach(MUSIC_FOLDER, "the music bed cache");

  const name = cacheKey(track);
  const local = join(dir, name);

  if (existsSync(local) && statSync(local).size >= MIN_TRACK_BYTES) {
    return { path: local, track, source: "local-cache", reason: null };
  }

  if (driveGet) {
    try {
      const buf = await driveGet(name);
      if (buf && buf.length >= MIN_TRACK_BYTES) {
        writeFileSync(local, buf);
        return { path: local, track, source: "drive-cache", reason: null };
      }
    } catch (err) {
      console.warn(`[Music] Drive cache read failed for ${name}: ${err.message}`);
    }
  }

  let buf;
  try {
    const res = await fetchImpl(trackUrl(track));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    return { path: null, track: null, reason: `download failed: ${err.message}` };
  }
  if (!buf || buf.length < MIN_TRACK_BYTES) {
    return { path: null, track: null, reason: `downloaded file is too small (${buf ? buf.length : 0} bytes)` };
  }

  writeFileSync(local, buf);
  if (drivePut) {
    try {
      await drivePut(name, buf);
    } catch (err) {
      // A cache write that fails costs one refetch next build and nothing else.
      console.warn(`[Music] could not write ${name} to the Drive cache: ${err.message}`);
    }
  }
  return { path: local, track, source: "fetched", reason: null };
}

/**
 * Everything the build report needs to say about the bed, in one object.
 *
 * Including the licence evidence. An obligation you cannot audit is one you
 * cannot show you met — the same argument that put the Pexels credits into the
 * log, and it matters more here because the failure mode is a Content ID claim
 * where the credit is the evidence.
 */
export function musicReport(result) {
  if (!result?.track) {
    return { used: false, reason: result?.reason || "no bed", track: null, credit: null };
  }
  return {
    used: true,
    reason: null,
    track: {
      title: result.track.title,
      id: result.track.id,
      isrc: result.track.isrc,
      seconds: result.track.seconds,
      url: trackUrl(result.track),
    },
    source: result.source,
    licence: LICENCE,
    credit: creditLine(result.track),
    // A bed longer than the video is only ever trimmed. Recorded because it is
    // the fact the modification disclosure rests on.
    loops: false,
  };
}

function round(n) {
  return Math.round(n * 100) / 100;
}
