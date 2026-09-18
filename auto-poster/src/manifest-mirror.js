/**
 * manifest-mirror.js — put the publish manifest where the analyser can read it.
 *
 * THE GAP, stated plainly. #126 writes one row per publish to
 * auto-poster/publish-manifest.json and merge-log-push.mjs commits it. That is
 * a file in a private GitHub repository. The scheduled task that writes the
 * posting decision has a Drive connector and a Metricool connector and nothing
 * else — it cannot see this repository at all. So for three runs it has
 * reported "No publish manifest exists mapping Instagram post ids to source
 * video files" while the manifest existed, complete, with 18 rows and 54
 * verified permalinks, in a place it was never able to look.
 *
 * This module publishes that same data to Drive, next to the decision file, in
 * the folder the task already reads from.
 *
 * ─── IT IS A MIRROR, NOT A SECOND RECORD ────────────────────────────────────
 *
 * Every field is derived, on every write, from publish-manifest.json and
 * posted-log.json. Nothing is stored here that is not stored there, so the two
 * cannot drift into disagreement — the worst that can happen is that the Drive
 * copy is older than the repo's, which its own generated_at makes visible.
 *
 * ─── WHAT IS FACT AND WHAT IS INFERENCE ─────────────────────────────────────
 *
 * The file separates them, because the analyser's whole objection is that it
 * was being asked to guess:
 *
 *   publishes[]        Fact. Written at publish time by the code that did the
 *                      publishing: which Drive file, which Metricool brands,
 *                      which permalinks came back verified. Each row also
 *                      carries a `flagship` block whose ig_post_id is the one
 *                      inferred part, and it states its own method and
 *                      confidence (see manifest-flagship.js).
 *
 *   inferred_matches[] Inference, and labelled as such. Perceptual-hash pairs
 *                      from video-matches.json, which is the caption-reuse
 *                      cache: it answers "which EARLIER post used this
 *                      footage", which is a different question from "which post
 *                      did this publish create". That makes it the right tool
 *                      for exactly the thing the manifest cannot help with —
 *                      the POST list's winners are all from May to July, before
 *                      the manifest existed. Measured on 2026-09-18, it can
 *                      name a Drive file for 3 of the 19 post ids the decision
 *                      file itself cites as winning examples, one of them at
 *                      hash distance 0. Every pair carries its distance so a
 *                      reader can set its own bar; the backfill that seeded
 *                      this cache recorded that 66 of 86 raw matches were false
 *                      positives above distance 10.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadManifest } from "./publish-manifest.js";
import { resolveFlagshipPosts, attachFlagship } from "./manifest-flagship.js";
import { CONTENT_FOLDER_ID } from "./drive.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The Drive file the analyser reads. Looked up by NAME in the content folder. */
export const MIRROR_FILENAME = "publish_manifest_latest.json";

/**
 * The folder the decision files live in, so the manifest lands beside them —
 * CONTENT_FOLDER_ID, defined once in drive.js and shared with the reader on the
 * other side of it. Overridable via MANIFEST_FOLDER_ID, independently of the
 * reader's own override.
 */
export const DEFAULT_MANIFEST_FOLDER_ID = CONTENT_FOLDER_ID;

export const MIRROR_SCHEMA_VERSION = 1;

/** Hash distance above which the seeding backfill called its matches junk. */
export const PHASH_MAX_DISTANCE = 10;

/**
 * Prose that travels WITH the data.
 *
 * The consumer is a language model reading a JSON file in a Drive folder, with
 * no access to this repository and no memory of previous runs. Field names
 * alone cannot tell it that `ig_post_id` under `flagship` is inferred while
 * `reel_urls` is verified, and getting that distinction wrong in either
 * direction is expensive: treat inference as fact and a video is credited with
 * another video's numbers; treat fact as inference and the file is useless.
 */
const ABOUT = [
  "Written by the lifestyle-design-studio auto-poster at publish time. It maps each published video back to the Google Drive file it was made from.",
  "publishes[] is a record of fact: the pipeline wrote each row as it published, and reel_urls are permalinks it read back from Metricool and verified.",
  "publishes[].flagship.ig_post_id is the ONE inferred field. The flagship Instagram account is posted by hand, so its post id is recognised afterwards by caption and time, never recorded. method='caption' means exactly one flagship post in the window opens with this caption; method='caption+time' means several did and one was inside the 6-hour window. A row that could not be resolved carries ig_post_id: null and a reason. Never treat a null as a match.",
  "inferred_matches[] is NOT fact. It is perceptual-hash similarity between a Drive video and an Instagram post's thumbnail, taken from the pipeline's caption-reuse cache, and it usually points at an EARLIER posting of the same footage. It is the only evidence available for posts published before this manifest began. hash_distance 0 is an identical thumbnail; the backfill that seeded this cache found most matches above distance 10 to be false positives.",
  "The three satellite Instagram accounts are posted automatically and their permalinks are in reel_urls. The flagship account is not posted by this pipeline at all.",
].join(" ");

/** Read video-matches.json, the perceptual-hash caption-reuse cache. */
export function loadVideoMatches(path = join(__dirname, "..", "video-matches.json")) {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Flatten the hash cache into one row per (drive file, instagram post) pair,
 * keeping the BEST (lowest) distance when a pair appears more than once.
 */
export function inferredMatches(videoMatches, { maxDistance = PHASH_MAX_DISTANCE } = {}) {
  const best = new Map();
  for (const [driveFileId, arr] of Object.entries(videoMatches || {})) {
    if (!Array.isArray(arr)) continue;
    for (const m of arr) {
      const igPostId = m?.igPostId ? String(m.igPostId) : null;
      if (!igPostId) continue;
      const distance = Number.isFinite(m.hashDistance)
        ? m.hashDistance
        : Number.isFinite(m.confidence)
          ? Math.round((1 - m.confidence) * 64)
          : null;
      if (distance === null || distance > maxDistance) continue;
      const key = `${driveFileId}:${igPostId}`;
      const prior = best.get(key);
      if (prior && prior.hash_distance <= distance) continue;
      best.set(key, {
        drive_file_id: driveFileId,
        ig_post_id: igPostId,
        hash_distance: distance,
        method: m.matchMethod || "perceptual_hash",
        // The cache's own job is finding an EARLIER post of this footage, so a
        // pair here is not evidence that this publish created that post.
        relationship: "same_footage_as_an_earlier_post",
      });
    }
  }
  return [...best.values()].sort((a, b) => a.hash_distance - b.hash_distance || a.drive_file_id.localeCompare(b.drive_file_id));
}

/**
 * Build the mirror payload. PURE — no fs, no network, no clock but `now`.
 */
export function buildMirror({ manifest, posts = [], igPosts = [], videoMatches = {}, now = new Date() } = {}) {
  const publishes = Array.isArray(manifest?.publishes) ? manifest.publishes : [];
  const { resolved, unresolved } = resolveFlagshipPosts({ posts, igPosts });
  const rows = attachFlagship(publishes, { resolved, unresolved });
  const withFlagship = rows.filter((r) => r.flagship?.ig_post_id).length;

  return {
    schema_version: MIRROR_SCHEMA_VERSION,
    generated_at: now.toISOString(),
    generated_by: "lifestyle-design-studio auto-poster",
    about: ABOUT,
    flagship_account: {
      handle: "lifestyledesignrealtytexas",
      posted_by: "hand",
      note: "This pipeline never posts Instagram to the flagship (mainBrandSkipIG). Its post ids are inferred after the fact — see publishes[].flagship.",
    },
    coverage: {
      publishes: rows.length,
      with_flagship_ig_post_id: withFlagship,
      without_flagship_ig_post_id: rows.length - withFlagship,
      flagship_posts_examined: igPosts.length,
      inferred_matches: 0, // replaced below, once the list is built
      earliest_publish: rows.length ? rows[0].posted_at : null,
      latest_publish: rows.length ? rows[rows.length - 1].posted_at : null,
    },
    publishes: rows,
    inferred_matches: [],
    // Grouped, not dumped. "No hand-post yet", "ambiguous" and "contested" are
    // different problems with different owners, and 100 raw rows of mostly the
    // first one buries the other two. Counts by code, then a few real examples.
    unresolved_flagship: summariseUnresolved(unresolved),
  };
}

/** Counts by code, with a handful of examples. See buildMirror. */
export function summariseUnresolved(unresolved = []) {
  const by_code = {};
  for (const u of unresolved || []) by_code[u.code || "unknown"] = (by_code[u.code || "unknown"] || 0) + 1;
  const seen = new Set();
  const examples = [];
  for (const u of unresolved || []) {
    const code = u.code || "unknown";
    if (seen.has(code)) continue;
    seen.add(code);
    examples.push({ code, drive_file_id: u.drive_file_id ?? null, receipt_at: u.receipt_at ?? null, why: u.why });
  }
  return {
    total: (unresolved || []).length,
    by_code,
    meaning: {
      no_publish_for_receipt: "a hand-post receipt whose delivered-copy id matches no publish still in the log — almost always a receipt older than the log's retention",
      no_caption_match: "no post in the flagship's 30-day analytics window opens with this caption — usually a video published before that window, or a caption edited by hand",
      ambiguous: "several flagship posts open with the same caption and the clock could not single one out — the boilerplate caption problem, inside the join",
      contested: "two different videos both matched one flagship post, so neither was given it",
      no_caption: "the receipt carried no caption text",
    },
    examples,
  };
}

/** buildMirror + the inference list, which needs the cache. */
export function buildFullMirror(opts = {}) {
  const mirror = buildMirror(opts);
  mirror.inferred_matches = inferredMatches(opts.videoMatches || {});
  mirror.coverage.inferred_matches = mirror.inferred_matches.length;
  return mirror;
}

/**
 * Write the mirror to Drive. Never throws.
 *
 * Same contract as recordPublish: by the time this runs the post has gone out,
 * and losing the mirror for one run must not turn a successful publish into a
 * red run. It logs loudly instead — and says the file id, so a run log can be
 * used to find what the analyser will read.
 */
export async function mirrorToDrive({
  folderId = process.env.MANIFEST_FOLDER_ID || DEFAULT_MANIFEST_FOLDER_ID,
  manifest = loadManifest(),
  posts = [],
  igPosts = [],
  videoMatches = loadVideoMatches(),
  now = new Date(),
  upsert,
  dryRun = false,
} = {}) {
  let mirror;
  try {
    mirror = buildFullMirror({ manifest, posts, igPosts, videoMatches, now });
  } catch (err) {
    console.warn(`[Manifest] FAILED to build the Drive mirror: ${err.message}`);
    return { ok: false, reason: `build failed: ${err.message}` };
  }

  const { publishes, with_flagship_ig_post_id: flagged, inferred_matches: inferred } = mirror.coverage;
  if (dryRun) {
    console.log(`[Manifest] DRY RUN — would mirror ${publishes} publish(es), ${flagged} with a flagship IG post id, ${inferred} inferred match(es) to ${MIRROR_FILENAME}`);
    return { ok: true, dryRun: true, mirror };
  }

  try {
    const write = upsert || (await import("./drive.js")).upsertTextInFolder;
    const { id, created } = await write(folderId, MIRROR_FILENAME, JSON.stringify(mirror, null, 2));
    console.log(
      `[Manifest] Mirrored to Drive ${created ? "(created)" : "(updated in place)"} id=${id} — ` +
      `${publishes} publish(es), ${flagged} with a flagship IG post id, ${inferred} inferred match(es)`
    );
    return { ok: true, id, created, mirror };
  } catch (err) {
    console.warn(`[Manifest] FAILED to mirror to Drive: ${err.message}`);
    return { ok: false, reason: err.message };
  }
}
