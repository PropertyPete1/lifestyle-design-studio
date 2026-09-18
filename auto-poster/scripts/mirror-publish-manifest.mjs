#!/usr/bin/env node
/**
 * mirror-publish-manifest.mjs — publish the manifest to Drive, on demand.
 *
 * The posting run mirrors after every publish. This is the same write, callable
 * by hand, for the two cases a posting run does not cover:
 *
 *   SEEDING. The analyser runs on Sundays and Thursdays; a posting run happens
 *   about twice a day. Without this, the first mirror waits for the next
 *   publish, and if that lands after the analyser's run the file is a week late
 *   to a question that was asked three runs ago.
 *
 *   A DAY WITH NO PUBLISH. The cadence gate stands slots down once the daily
 *   target is met, and a stood-down slot exits long before the mirror. Flagship
 *   hand-posts are confirmed on those days too, so resolution keeps improving
 *   while nothing is being written.
 *
 * Usage:
 *   node scripts/mirror-publish-manifest.mjs            # write it
 *   node scripts/mirror-publish-manifest.mjs --dry-run  # print what it would say
 *
 * Needs the Google OAuth credentials (GOOGLE_CLIENT_ID / _SECRET /
 * _REFRESH_TOKEN) and, unless --no-metricool, the Metricool ones — the flagship
 * post ids are recognised in that account's analytics.
 */

import { loadLog } from "../src/state.js";
import { mirrorToDrive } from "../src/manifest-mirror.js";
import { getRecentIgPosts } from "../src/metricool.js";

const dryRun = process.argv.includes("--dry-run");
const skipMetricool = process.argv.includes("--no-metricool");

async function main() {
  const log = loadLog();
  const posts = log?.posts || [];

  let igPosts = [];
  if (skipMetricool) {
    // Worth being loud about: with no flagship post list, EVERY row resolves to
    // ig_post_id: null, which reads exactly like "nothing has been hand-posted"
    // rather than "we did not look".
    console.warn("[Mirror] --no-metricool: no flagship posts will be examined, so no flagship IG post id can be resolved");
  } else {
    try {
      igPosts = await getRecentIgPosts(30);
      console.log(`[Mirror] Flagship posts available to match against: ${igPosts.length}`);
    } catch (err) {
      console.warn(`[Mirror] Could not read the flagship's posts (${err.message}) — writing without flagship resolution`);
    }
  }

  const result = await mirrorToDrive({ posts, igPosts, dryRun });
  if (!result.ok) {
    console.error(`[Mirror] FAILED: ${result.reason}`);
    process.exit(1);
  }
  const c = result.mirror?.coverage;
  if (c) {
    console.log(
      `[Mirror] ${c.publishes} publish(es); ${c.with_flagship_ig_post_id} carry a flagship IG post id, ` +
      `${c.without_flagship_ig_post_id} do not; ${c.inferred_matches} inferred match(es) for the pre-manifest history.`
    );
  }
}

main().catch((err) => {
  console.error("[Mirror] Unexpected failure:", err);
  process.exit(1);
});
