/**
 * content-hash.js — content-level fingerprint for videos.
 *
 * WHY THIS EXISTS (incident 2026-07-31):
 * Austin published the same footage twice in one day. The two Drive files were
 * separate uploads — different driveFileId AND different fileName — so both the
 * id guard and the fileName guard passed correctly. Nothing on the posting path
 * compared the actual PICTURES, so identical footage sailed through.
 *
 * This fingerprints what the video LOOKS like, not what it is called:
 * perceptual hashes of frames sampled at fixed percentage offsets. Two uploads
 * of the same tour produce near-identical hashes even when the bytes, filename,
 * Drive id, container, and bitrate all differ.
 *
 * Note this is a DIFFERENT job from matcher.js. That module matches a Drive
 * video against Instagram post thumbnails (Drive -> IG). This one matches a
 * Drive video against our own posting history (Drive -> Drive).
 */

import { execSync } from "child_process";
import { existsSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { computePhash, hammingDistance } from "./matcher.js";
import { validPosts } from "./state.js";

/** Sample points across the clip. Spread out so a shared intro can't alone cause a match. */
export const CONTENT_HASH_OFFSETS = [0.1, 0.3, 0.5, 0.7, 0.9];

/**
 * Max average Hamming distance (per 64-bit frame hash) for two videos to count
 * as the same footage.
 *
 * Calibrated on the REAL incident files plus 5 other Austin tours
 * (scripts/calibrate-content-hash.mjs, 2026-07-31):
 *
 *   SAME footage
 *     the incident pair, two separate Drive uploads ..........  0.00
 *     after a freshness re-encode (CRF 18) ...................  4.00
 *     after freshness + burned captions ......................  4.00
 *                                              worst case:      4.00
 *   DIFFERENT property tours
 *     20 distinct pairings ................................... 18.60 – 30.20
 *                                               best case:     18.60
 *
 * 10 sits almost exactly midway (margin 14.60), so it absorbs the pipeline's own
 * re-encodes with 6 points to spare while staying 8.6 points clear of the
 * closest genuinely-different pair.
 *
 * Notably the incident pair scored 0.00 — the two uploads are perceptually
 * identical, so this guard would have blocked the second post outright.
 */
export const CONTENT_DUP_THRESHOLD = 10;

/** Frames whose hash failed to compute are skipped; below this many usable frames we refuse to judge. */
export const MIN_COMPARABLE_FRAMES = 3;

const FRAME_DIR = join(tmpdir(), "content-hash-frames");

/**
 * Compute a content fingerprint for a video.
 * Returns a colon-joined string of per-frame hex hashes, or null on failure.
 * Never throws — a fingerprint failure must degrade to "no comparison", not a
 * crashed posting run.
 */
export async function computeContentHash(videoPath, durationSec) {
  if (!existsSync(videoPath)) return null;
  const duration = Number(durationSec);
  if (!Number.isFinite(duration) || duration <= 0) return null;

  try {
    mkdirSync(FRAME_DIR, { recursive: true });
  } catch {}

  const id = createHash("md5").update(videoPath + Date.now()).digest("hex").slice(0, 8);
  const hashes = [];

  for (let i = 0; i < CONTENT_HASH_OFFSETS.length; i++) {
    const ts = (duration * CONTENT_HASH_OFFSETS[i]).toFixed(2);
    const outPath = join(FRAME_DIR, `ch_${id}_${i}.png`);
    try {
      // -ss before -i = fast seek. Downscale: pHash only needs 8x8, and full-res
      // frames on a 175MB 4K clip are needlessly slow to decode.
      execSync(
        `ffmpeg -y -ss ${ts} -i "${videoPath}" -frames:v 1 -vf "scale='min(720,iw)':-2" -q:v 2 "${outPath}"`,
        { timeout: 20_000, stdio: "pipe" }
      );
      if (existsSync(outPath)) {
        // cropToSquare=false: both sides are our own full-frame video, so unlike
        // the IG-thumbnail matcher there is no aspect mismatch to correct for.
        const h = await computePhash(outPath, false);
        if (h) hashes.push(h);
        try { unlinkSync(outPath); } catch {}
      }
    } catch {
      try { unlinkSync(outPath); } catch {}
    }
  }

  if (hashes.length < MIN_COMPARABLE_FRAMES) return null;
  return hashes.join(":");
}

/** Split a stored fingerprint back into per-frame hashes. */
export function parseContentHash(stored) {
  if (typeof stored !== "string" || !stored.trim()) return [];
  return stored.split(":").filter(Boolean);
}

/**
 * Average per-frame Hamming distance between two fingerprints.
 * Returns Infinity when they cannot be meaningfully compared, so callers can
 * treat "unknown" as "not a duplicate" without special-casing null.
 */
export function contentHashDistance(a, b) {
  const ha = parseContentHash(a);
  const hb = parseContentHash(b);
  const n = Math.min(ha.length, hb.length);
  if (n < MIN_COMPARABLE_FRAMES) return Infinity;

  let total = 0;
  for (let i = 0; i < n; i++) total += hammingDistance(ha[i], hb[i]);
  return total / n;
}

/**
 * Find a post from the last N days whose content matches this fingerprint.
 *
 * Scans EVERY city on purpose: all three city runs fan out to the same
 * Metricool brands, so the same footage under a different city is still a
 * repost to the same accounts. Same reasoning as the cross-city id/fileName
 * guards in state.js.
 *
 * Entries predating this feature have no content_hash. They are skipped rather
 * than treated as matches — backfill is impossible without re-downloading every
 * historical video, so the guard simply gets stronger as new posts accumulate.
 *
 * Returns the matching post (annotated with _distance) or null.
 */
export function findContentDuplicate(log, contentHash, opts = {}) {
  const { days = 30, threshold = CONTENT_DUP_THRESHOLD, now = Date.now() } = opts;
  if (!contentHash) return null;

  const cutoff = now - days * 24 * 60 * 60 * 1000;
  let best = null;

  for (const p of validPosts(log)) {
    if (!p.content_hash) continue;                       // pre-feature entry
    const ts = new Date(p.timestamp).getTime();
    if (!Number.isFinite(ts) || ts <= cutoff) continue;

    const dist = contentHashDistance(contentHash, p.content_hash);
    if (dist <= threshold && (!best || dist < best._distance)) {
      best = { ...p, _distance: dist };
    }
  }
  return best;
}
