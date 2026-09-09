/**
 * publish-manifest.js — one row per publish, written at publish time.
 *
 * WHY THIS EXISTS. Nothing in this pipeline ties a published reel back to the
 * Drive file it came from. analytics.js and learn.js contain no reference to
 * driveFileId or fileName; they key on reel URL and hook style. So a video's
 * performance is measurable, and a video's identity is knowable, and no record
 * joins the two. The consequence, measured on 2026-09-09: of the top ten July
 * performers, three could not be resolved to a Drive file at all, and of the
 * seven that could, only four resolved unambiguously — and those came from
 * video-matches.json, a perceptual-hash dedupe cache whose own backfill commit
 * (a050a49) records "86 matches, but 66 were at distance 10-17 (false
 * positives)". Guessing which file produced a winner is the state of the art
 * here. This file ends that, going forward.
 *
 * IT DOES NOT HELP THE BACKLOG. Rows are written at publish time and only at
 * publish time. Everything already posted stays unresolvable by these means;
 * Metricool's analytics window is 30 days (social-analytics.js:78), so the
 * history cannot be re-derived either. This is a forward fix.
 *
 * WRITE-BACK. auto-poster/publish-manifest.json is committed by
 * merge-log-push.mjs, which takes its file list from
 * `MERGE_FILES = Object.keys(MERGE_STRATEGIES)` (merge-strategies.mjs). A file
 * with no registered strategy is written locally and then silently discarded by
 * the `git reset --hard origin/main` in that script — it would look written on
 * every run and never appear in the repo. `mergePublishManifest` is registered
 * alongside this module for exactly that reason.
 *
 * ROW IDENTITY. `posted_at` (ms-precision ISO, stamped once per publish) plus
 * `drive_file_id`. posted-log dedupes on timestamp alone, which is sound there
 * because recordPost writes exactly one row per post; here a composite costs
 * nothing and removes the question.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(__dirname, "..", "publish-manifest.json");

/** Bumped only when a row's shape changes in a way a reader must notice. */
export const MANIFEST_SCHEMA_VERSION = 1;

/** Captions are for identifying the post, not reproducing it. */
const CAPTION_LIMIT = 500;

/**
 * Load the manifest, tolerating every way the file can be unusable.
 *
 * A posting run must never die because an audit file is malformed — the same
 * contract loadSkipList() keeps (state.js). A corrupt manifest costs us the
 * trace for one run; a throw here costs a post.
 */
export function loadManifest(path = MANIFEST_PATH) {
  if (!existsSync(path)) return { schema_version: MANIFEST_SCHEMA_VERSION, publishes: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.publishes)) {
      return { schema_version: MANIFEST_SCHEMA_VERSION, publishes: [] };
    }
    return parsed;
  } catch {
    return { schema_version: MANIFEST_SCHEMA_VERSION, publishes: [] };
  }
}

export function saveManifest(manifest, path = MANIFEST_PATH) {
  writeFileSync(path, JSON.stringify(manifest, null, 2));
}

/**
 * Build one manifest row. Pure — no fs, no clock unless `postedAt` is omitted.
 *
 * Missing values are null, never invented. `community` in particular comes from
 * an OCR pass over the source frames (main.js readVideoOverlays) and is absent
 * far more often than it is present; a row that guessed a community from the
 * city would be worse than one that admits it does not know.
 */
export function buildManifestRow({
  driveFileId,
  fileName = null,
  market = null,
  community = null,
  caption = null,
  slot = null,
  runId = null,
  brands = [],
  postedAt = new Date().toISOString(),
}) {
  if (!driveFileId) throw new Error("[Manifest] buildManifestRow requires driveFileId");

  const targets = (Array.isArray(brands) ? brands : [])
    .filter((b) => b && b.ok)
    .map((b) => ({
      label: b.label ?? null,
      blog_id: b.blogId ?? null,
      // The Metricool SCHEDULER id, which is not an Instagram media id. The
      // media id arrives later, on the permalink, once reel-verify has read
      // the post's status. Both are kept: the scheduler id is what identifies
      // the row to Metricool, the permalink is what joins to analytics.
      post_id: b.postId && b.postId !== "unknown" ? b.postId : null,
      networks: Array.isArray(b.providers) ? b.providers : (b.networks ?? null),
    }));

  return {
    schema_version: MANIFEST_SCHEMA_VERSION,
    posted_at: postedAt,
    drive_file_id: driveFileId,
    file_name: fileName,
    market,
    community,
    caption: typeof caption === "string" ? caption.slice(0, CAPTION_LIMIT) : null,
    slot,
    run_id: runId,
    targets,
    // Filled by recordPublishVerification() once reel-verify resolves
    // permalinks. Empty until then — and empty is the honest state, because a
    // scheduler acceptance is not a publication.
    reel_urls: [],
  };
}

/**
 * Append a row and persist. Returns the row.
 *
 * Never throws on a write failure: the post has already gone out by the time
 * this runs, and losing the audit row must not turn a successful publish into
 * a red run. It logs loudly instead — a silent miss here is how you end up
 * believing you have a trace you do not have.
 */
export function recordPublish(entry, { path = MANIFEST_PATH } = {}) {
  const row = buildManifestRow(entry);
  try {
    const manifest = loadManifest(path);
    manifest.schema_version = MANIFEST_SCHEMA_VERSION;
    manifest.publishes.push(row);
    saveManifest(manifest, path);
    const named = row.targets.filter((t) => t.post_id).length;
    console.log(
      `[Manifest] Recorded ${row.drive_file_id} (${row.market ?? "?"}) — ` +
      `${row.targets.length} target(s), ${named} with a scheduler id`
    );
  } catch (err) {
    console.warn(`[Manifest] FAILED to record publish for ${row.drive_file_id}: ${err.message}`);
  }
  return row;
}

/**
 * Attach resolved permalinks to the most recent row for a Drive file.
 *
 * Called after reel-verify produces distribution rows. Only rows carrying a
 * `publicUrl` are recorded, and only Instagram ones are shortcode-parsed —
 * TikTok and YouTube URLs are kept whole because nothing joins on them today.
 */
export function recordPublishVerification(driveFileId, distribution, { path = MANIFEST_PATH } = {}) {
  const urls = (Array.isArray(distribution) ? distribution : [])
    .filter((r) => r && r.publicUrl)
    .map((r) => ({
      network: r.network ?? null,
      label: r.label ?? null,
      url: r.publicUrl,
      shortcode: instagramShortcode(r.publicUrl),
      verified: r.verified === true,
    }));
  if (urls.length === 0) return null;

  try {
    const manifest = loadManifest(path);
    for (let i = manifest.publishes.length - 1; i >= 0; i--) {
      if (manifest.publishes[i].drive_file_id === driveFileId) {
        manifest.publishes[i].reel_urls = urls;
        saveManifest(manifest, path);
        console.log(`[Manifest] Attached ${urls.length} permalink(s) to ${driveFileId}`);
        return manifest.publishes[i];
      }
    }
    console.warn(`[Manifest] No row to attach permalinks to for ${driveFileId}`);
  } catch (err) {
    console.warn(`[Manifest] FAILED to attach permalinks for ${driveFileId}: ${err.message}`);
  }
  return null;
}

/**
 * `instagram.com/reel/Dcr3FtyiuBZ/` -> `Dcr3FtyiuBZ`.
 *
 * This is the join key to status/social_analytics.json, whose rows carry the
 * same permalink in `url` alongside the IG media id in `post_id`. Resolving a
 * shortcode there yields the media id, and the media id is what every views
 * figure is keyed by. Returns null for anything that is not an IG reel/post URL
 * rather than guessing at a shape.
 */
export function instagramShortcode(url) {
  if (typeof url !== "string") return null;
  const m = url.match(/instagram\.com\/(?:reel|reels|p)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

export { MANIFEST_PATH };
